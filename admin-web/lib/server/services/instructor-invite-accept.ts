// S1-2.5(초대 링크 수락 API — 승인 대기) — 강사가 대표에게 받은 초대 링크를 연다.
//   계약: _workspace/03_contracts/08-owner-staff.md §2 「강사 쪽 서버 경로」 · 수용 시나리오 1·2
//   데이터: data-model §7-5 instructor_invites(한 문장 조건부 갱신) · instructor_affiliations(uq_affiliations_open)
//   요구: FR-011(소속 승인 — 결정 3: 초대 링크로 들어와도 승인 대기) · FR-071(1회용 링크) · FR-185(감사 기록)
//
// 경로 하나:
//   POST /api/instructor/invites/{token}/accept → 201 { affiliationId, academyId, status: "pending", source: "invite", requestedAt }
//   오류: 404 NOT_FOUND(없는 토큰) · 409 INVITE_ALREADY_USED · 410 INVITE_EXPIRED(기한 지남·대표가 폐기) · 409 AFFILIATION_ALREADY_OPEN
//
// 왜 「바로 소속」이 아니라 「승인 대기」인가(결정 3):
//   링크는 단톡방에 잘못 올라가거나 다른 사람에게 넘어갈 수 있다. 링크만으로 소속이 되면 모르는 사람이 학원 명단에 들어온다.
//   그래서 링크는 「신청서를 대신 써 주는 것」까지만 하고, 소속(active)은 대표가 비율을 넣고 승인해야 된다(S1-2 의 다른 Task).
//
// 같은 링크를 두 사람이 동시에 누르면?
//   토큰 쓰기는 `UPDATE … WHERE token_hash=… AND used_at IS NULL AND …` 한 문장이다. PostgreSQL 은 같은 행을 고치는
//   두 문장을 줄 세우고, 뒤에 온 문장은 앞 문장이 끝난 행을 다시 보고 조건(used_at IS NULL)이 깨졌으니 0행이 된다.
//   그래서 잠금을 따로 걸지 않아도 한 사람만 이긴다. 진 쪽은 이유를 다시 읽어 409·410 을 가른다.
import { z } from "zod";

import type { Db } from "../../../prisma/db";
import type { Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";
import { hashInviteToken, inviteStatusAt } from "./academy-invites";
import type { Tx } from "./staff-signup";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

export const AFFILIATION_REQUESTED_AUDIT_ACTION = "affiliation.requested";

const DETAIL = {
  forbidden: "강사 계정으로만 초대 링크를 받을 수 있어요",
  notFound: "초대 링크를 찾을 수 없어요",
  alreadyUsed: "이미 사용한 초대 링크예요. 대표님께 새 링크를 받아 주세요",
  expired: "기한이 지났거나 대표님이 거둔 초대 링크예요. 새 링크를 받아 주세요",
  alreadyOpen: "이 학원에 이미 소속 신청 중이거나 소속돼 있어요",
} as const;

/** 대표 알림을 누르면 가는 곳 — 강사 관리(W3a)의 승인 대기 탭 */
const OWNER_PENDING_LINK = "/staff/instructors?status=pending";

// ---- 요청·응답 계약(08 §2) --------------------------------------------------------------------

/**
 * 경로의 토큰 — 만들기(S1-2.4)가 32바이트 난수를 base64url 로 쓴 43자다.
 * 모양이 다르면 DB 를 찾지 않고 404(없는 토큰과 같은 답 — 모양으로 무엇을 알려 주지 않는다).
 */
export const inviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** 수락 응답 — 소속은 언제나 승인 대기(pending)로 시작한다 */
export const acceptedAffiliationSchema = z.strictObject({
  affiliationId: z.uuid(),
  academyId: z.uuid(),
  status: z.literal("pending"),
  source: z.literal("invite"),
  requestedAt: z.iso.datetime({ offset: true }),
});
export type AcceptedAffiliation = z.infer<typeof acceptedAffiliationSchema>;

// ---- 토큰 쓰기(조건부 갱신) ----------------------------------------------------------------

/**
 * 유효한 링크면 그 자리에서 「사용함」으로 바꾸고 학원 id 를 돌려준다. 유효하지 않으면 undefined.
 * 유효 = 아직 안 썼고 · 폐기 안 됐고 · 기한 전(data-model §7-5 「상태(칸으로 판정)」).
 */
async function consumeInvite(
  tx: Tx,
  input: { tokenHash: string; instructorId: string; now: Temporal.Instant },
): Promise<{ inviteId: string; academyId: string } | undefined> {
  const [row] = await tx.query(
    tx.raw.sql`UPDATE instructor_invites
               SET used_at = ${input.now.toString()}::timestamptz, used_by_account_id = ${input.instructorId}::uuid
               WHERE token_hash = ${input.tokenHash}
                 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ${input.now.toString()}::timestamptz
               RETURNING id, academy_id`
      .returnsRow({ id: "pg/uuid@1", academy_id: "pg/uuid@1" })
      .build(),
  );
  return row === undefined ? undefined : { inviteId: row.id, academyId: row.academy_id };
}

/**
 * 토큰 쓰기가 0행이었을 때 「왜」를 가른다 — 상태 판정은 목록(S1-2.4)과 같은 inviteStatusAt 를 쓴다.
 *   없음 → 404 · 사용됨 → 409 INVITE_ALREADY_USED · 만료·폐기 → 410 INVITE_EXPIRED
 * 폐기를 410 으로 묶은 이유: 강사에게는 「이 링크로는 다시 해도 안 된다」가 같고,
 * 대표가 거뒀다는 사실을 따로 알릴 까닭이 없다(계약 08 §2 의 오류 목록 안에서 고름).
 */
async function explainUnusableInvite(tx: Tx, tokenHash: string, now: Temporal.Instant): Promise<never> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
                      COALESCE(to_char(used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS used_at,
                      COALESCE(to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS revoked_at
               FROM instructor_invites WHERE token_hash = ${tokenHash}`
      .returnsRow({ expires_at: "pg/text@1", used_at: "pg/text@1", revoked_at: "pg/text@1" })
      .build(),
  );
  if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  const orNull = (raw: string) => (raw === "" ? null : Temporal.Instant.from(raw));
  const status = inviteStatusAt(
    { usedAt: orNull(row.used_at), revokedAt: orNull(row.revoked_at), expiresAt: Temporal.Instant.from(row.expires_at) },
    now,
  );
  if (status === "used") throw HttpError.conflict("INVITE_ALREADY_USED", DETAIL.alreadyUsed);
  // 남은 경우는 expired·revoked 다. active 는 앞 UPDATE 가 잡았을 것이라 여기 오지 않는다 — 와도 같은 410 으로 답한다
  throw HttpError.gone("INVITE_EXPIRED", DETAIL.expired);
}

// ---- 소속 신청 행 · 알림 · 감사 -------------------------------------------------------------

/**
 * 승인 대기 소속 1행. 같은 학원에 이미 대기·소속 행이 있으면 uq_affiliations_open 이 막고
 * ON CONFLICT DO NOTHING 이라 0행 → undefined. (부르는 쪽이 409 를 던져 토큰 쓰기까지 되돌린다)
 */
async function insertPendingAffiliation(
  tx: Tx,
  input: { academyId: string; instructorId: string; inviteId: string; now: Temporal.Instant },
): Promise<string | undefined> {
  const [row] = await tx.query(
    tx.raw.sql`INSERT INTO instructor_affiliations
                 (id, academy_id, instructor_account_id, status, source, invite_id, requested_at, created_at, updated_at)
               VALUES (uuidv7(), ${input.academyId}::uuid, ${input.instructorId}::uuid, 'pending', 'invite', ${input.inviteId}::uuid,
                       ${input.now.toString()}::timestamptz, ${input.now.toString()}::timestamptz, ${input.now.toString()}::timestamptz)
               ON CONFLICT (academy_id, instructor_account_id) WHERE status IN ('pending', 'active') DO NOTHING
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  return row?.id;
}

/**
 * 그 학원 대표에게 알림 `affiliation_requested` 1건(category approval, 계약 08 §2).
 * 초대 수락(S1-2.5)과 직접 신청(S1-2.6) 두 생성 경로가 함께 쓴다 — 알림 모양이 한 곳에서 정해지게.
 * 열쇠 `affiliation:<id>:requested` 가 있어 같은 신청으로 두 번 생기지 않는다.
 * 활동 장르(S2-1.3): 강사 가입(S2-1.2)이 instructor_profiles 에 장르 하나를 남기므로 그 값을 한 칸짜리 배열로 싣는다.
 *   프로필이 없는 계정(가입 경로 밖에서 만든 옛 계정)은 빈 배열 — 대표 알림 카드는 장르 칩만 빼고 그대로 보인다.
 * 초대 링크에는 한마디 칸이 없어 그때 message 는 null 이다.
 * 휴대폰 발송(O5Q)은 S7-1 이 이 행(delivery_status = pending)을 읽어 보낸다.
 */
export async function notifyOwnerAffiliationRequested(
  tx: Tx,
  input: {
    academyId: string;
    affiliationId: string;
    instructorId: string;
    instructorName: string;
    source: "invite" | "application";
    message: string | null;
  },
): Promise<void> {
  const how = input.source === "invite" ? "초대 링크로 " : "";
  const genre = await readActivityGenre(tx, input.instructorId);
  const payload = JSON.stringify({
    affiliationId: input.affiliationId,
    source: input.source,
    instructorName: input.instructorName,
    genres: genre === null ? [] : [genre],
    message: input.message,
    title: `${input.instructorName} 강사가 ${how}소속을 신청했어요`,
    body: "승인해야 소속돼요 · 프리랜서·사업자 강사는 몫 비율을 함께 정해 주세요",
    actionLabel: "확인하고 승인",
    link: OWNER_PENDING_LINK,
  });
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               SELECT uuidv7(), o.staff_account_id, o.academy_id, 'approval', 'affiliation_requested',
                      ${`affiliation:${input.affiliationId}:requested`}, ${payload}::jsonb
               FROM academy_owners o
               WHERE o.academy_id = ${input.academyId}::uuid AND o.status = 'active'
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/** 감사 1행 — 강사 본인이 한 일이다. 토큰·해시는 싣지 않는다. 직접 신청(S1-2.6)은 inviteId 가 null 이다 */
export async function writeAffiliationRequestedAudit(
  tx: Tx,
  input: { instructorId: string; academyId: string; affiliationId: string; source: "invite" | "application"; inviteId: string | null },
): Promise<void> {
  const after = JSON.stringify({ status: "pending", source: input.source, inviteId: input.inviteId });
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, academy_id, action, target_table, target_id, before, after)
               VALUES (uuidv7(), 'staff', ${input.instructorId}::uuid, ${input.academyId}::uuid, ${AFFILIATION_REQUESTED_AUDIT_ACTION},
                       'instructor_affiliations', ${input.affiliationId}::uuid, NULL, ${after}::json)`
      .affectedCount()
      .build(),
  );
}

/**
 * 강사 프로필의 활동 장르 하나(FR-011b). 프로필 행이 없으면 null.
 * (대표의 소속 목록 academy-affiliation-list.ts 는 여러 행을 한 번에 읽어야 해서 같은 표를 JOIN 으로 읽는다)
 */
export async function readActivityGenre(q: Db | Tx, staffAccountId: string): Promise<string | null> {
  const [row] = await q.query(
    q.raw.sql`SELECT activity_genre FROM instructor_profiles WHERE staff_account_id = ${staffAccountId}::uuid`
      .returnsRow({ activity_genre: "pg/text@1" })
      .build(),
  );
  return row?.activity_genre ?? null;
}

export async function readDisplayName(q: Db | Tx, staffAccountId: string): Promise<string> {
  const [row] = await q.query(
    q.raw.sql`SELECT display_name FROM staff_accounts WHERE id = ${staffAccountId}::uuid`
      .returnsRow({ display_name: "pg/text@1" })
      .build(),
  );
  if (row === undefined) throw new Error("가드를 통과한 직원 계정을 다시 읽지 못했다");
  return row.display_name;
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

export type InviteAcceptDeps = GuardDeps & { readonly clock: Clock };

type TokenParams = { params: Promise<{ token: string }> };

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * `POST /api/instructor/invites/{token}/accept` — 강사 역할 + 강사 앱(surface='app', 2단계 인증을 묻지 않음).
 * 한 트랜잭션: ① 토큰 쓰기(조건부 갱신) → ② 승인 대기 소속 1행 → ③ 대표 알림 1건 → ④ 감사 1행.
 * ② 가 이미 열린 소속 때문에 막히면 409 를 던져 ① 까지 되돌린다 — 링크가 헛되이 「사용됨」이 되지 않는다.
 */
export function createAcceptInviteRoute(deps: InviteAcceptDeps) {
  const guards = createGuards(deps);
  return withRoute<TokenParams>(async (request, context) => {
    // ①② 세션 + 켜진 직원 계정. 강사 앱 경로라 2단계(③)는 보지 않는다(FR-303 — 관리자 웹만)
    const staff = await guards.requireStaffAccount(request);
    // 강사 역할이 켜진 계정만. 대표·운영자 계정이 링크를 열어도 소속 신청은 생기지 않는다
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);

    const parsed = inviteTokenSchema.safeParse((await context.params).token);
    if (!parsed.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const tokenHash = hashInviteToken(parsed.data);
    const now = deps.clock();
    const instructorName = await readDisplayName(deps.db, staff.staffAccountId);

    const body = await deps.db.transaction(async (tx): Promise<AcceptedAffiliation> => {
      const invite = await consumeInvite(tx, { tokenHash, instructorId: staff.staffAccountId, now });
      if (invite === undefined) return explainUnusableInvite(tx, tokenHash, now);

      const affiliationId = await insertPendingAffiliation(tx, {
        academyId: invite.academyId,
        instructorId: staff.staffAccountId,
        inviteId: invite.inviteId,
        now,
      });
      if (affiliationId === undefined) throw HttpError.conflict("AFFILIATION_ALREADY_OPEN", DETAIL.alreadyOpen);

      await notifyOwnerAffiliationRequested(tx, {
        academyId: invite.academyId,
        affiliationId,
        instructorId: staff.staffAccountId,
        instructorName,
        source: "invite",
        message: null,
      });
      await writeAffiliationRequestedAudit(tx, {
        instructorId: staff.staffAccountId,
        academyId: invite.academyId,
        affiliationId,
        source: "invite",
        inviteId: invite.inviteId,
      });
      return { affiliationId, academyId: invite.academyId, status: "pending", source: "invite", requestedAt: now.toString() };
    });

    return Response.json(body, { status: 201, headers: NO_STORE });
  });
}
