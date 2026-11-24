// S1-2.4(초대 링크 만들기·목록·폐기 API) — 대표가 강사에게 보낼 1회용 초대 링크를 다룬다.
//   계약: _workspace/03_contracts/08-owner-staff.md §1 「초대 링크 — 권한 owner」 · 열린 점 ③(위임 강사는 못 만든다)
//   데이터: data-model §7-5 instructor_invites(token_hash 는 sha256, 원문은 저장하지 않음)
//   요구: FR-071(소속 강사 관리 — 유효기간 7일·1회용은 추천값) · FR-011(초대 링크도 승인 대기, 결정 3) · FR-185(감사 기록)
//
// 경로 셋:
//   POST /api/academies/{academyId}/invites                     → 201 { inviteId, inviteUrl, expiresAt }
//   GET  /api/academies/{academyId}/invites                     → 200 { items: [...] } (상태 = active·used·expired·revoked)
//   POST /api/academies/{academyId}/invites/{inviteId}/revoke   → 200 · 이미 끝난 링크면 409 INVITE_NOT_ACTIVE
//
// 왜 토큰을 해시로만 저장하나:
//   초대 링크는 「가진 사람이 곧 받을 자격」인 비밀번호와 같다. DB 가 새어도 링크를 다시 만들 수 없게
//   원문은 만든 응답에서 딱 한 번만 돌려주고, DB 에는 sha256 해시만 남긴다(수락 S2-1 은 받은 토큰을 해시해 찾는다).
//   그래서 목록(GET)은 링크 주소를 다시 보여 줄 수 없다 — 대표가 잃어버렸으면 폐기하고 새로 만든다.
import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import type { Db } from "../../../prisma/db";
import type { Clock } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError } from "../http";
import type { Tx } from "./staff-signup";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

/** 유효기간 7일 — 계약 08 §1 의 추천값(FR-071 보완). 바꾸면 계약도 고친다 */
export const INVITE_VALID_DAYS = 7;
/** 토큰 원문 길이(바이트). 32바이트 = 256비트라 짐작해서 맞힐 수 없다 */
const TOKEN_BYTES = 32;

export const INVITE_CREATED_AUDIT_ACTION = "invite.created";
export const INVITE_REVOKED_AUDIT_ACTION = "invite.revoked";

export const INVITE_STATUSES = ["active", "used", "expired", "revoked"] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

const DETAIL = {
  notFound: "초대 링크를 찾을 수 없어요",
  academyNotFound: "학원을 찾을 수 없어요",
  notActive: "이미 폐기했거나, 강사가 사용했거나, 기한이 지난 초대 링크예요",
} as const;

// ---- 응답 계약(08 §1) --------------------------------------------------------------------------

/** 만들기 응답 — inviteUrl 에 토큰 원문이 들어 있다. 이 응답이 원문을 볼 수 있는 유일한 자리다 */
export const createdInviteSchema = z.strictObject({
  inviteId: z.uuid(),
  inviteUrl: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type CreatedInvite = z.infer<typeof createdInviteSchema>;

/** 목록 한 줄 — 링크 주소(토큰)는 없다. usedBy 는 사용한 강사의 표시 이름만 */
export const inviteItemSchema = z.strictObject({
  inviteId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  status: z.enum(INVITE_STATUSES),
  usedBy: z.strictObject({ displayName: z.string() }).nullable(),
});
export type InviteItem = z.infer<typeof inviteItemSchema>;

export const inviteListSchema = z.strictObject({ items: z.array(inviteItemSchema) });

// ---- 상태 판정 ---------------------------------------------------------------------------------

type InviteStateFields = {
  usedAt: Temporal.Instant | null;
  revokedAt: Temporal.Instant | null;
  expiresAt: Temporal.Instant;
};

/**
 * 초대 링크 상태 — 칸 셋(used_at·revoked_at·expires_at)으로 판정한다(data-model §7-5 「상태(칸으로 판정)」).
 * 순서가 중요하다: 폐기·사용은 「사람이 한 일」이라 기한보다 먼저 본다.
 * 예) 쓴 뒤 기한이 지난 링크는 「만료」가 아니라 「사용됨」이다 — 대표가 「누가 썼는지」를 봐야 하니까.
 * 만료는 기한 시각 **정각부터**다(유효 조건이 expires_at > now 이므로).
 */
export function inviteStatusAt(invite: InviteStateFields, now: Temporal.Instant): InviteStatus {
  if (invite.revokedAt !== null) return "revoked";
  if (invite.usedAt !== null) return "used";
  if (Temporal.Instant.compare(invite.expiresAt, now) <= 0) return "expired";
  return "active";
}

// ---- 토큰 ------------------------------------------------------------------------------------

/** 토큰 원문 → 저장용 해시(sha256 hex). 수락 경로(S2-1)도 이 함수로 해시해 찾는다 */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 새 토큰 원문 — URL 에 그대로 넣을 수 있게 base64url(43자) */
function newInviteToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** 링크 주소 — `<앱 주소>/invite/<토큰>`. 앱 주소 끝의 / 는 하나로 맞춘다 */
function buildInviteUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/invite/${token}`;
}

// ---- 읽기 ------------------------------------------------------------------------------------

type InviteRow = {
  id: string;
  created_at: string;
  expires_at: string;
  used_at: string;
  revoked_at: string;
  used_by_name: string;
};

const INVITE_ROW = {
  id: "pg/uuid@1",
  created_at: "pg/text@1",
  expires_at: "pg/text@1",
  used_at: "pg/text@1",
  revoked_at: "pg/text@1",
  used_by_name: "pg/text@1",
} as const;

// 시각은 UTC ISO 글자로 읽는다(마이크로초까지). NULL 은 빈 글자로 읽어 행 타입을 단순하게 둔다
const orNull = (raw: string): Temporal.Instant | null => (raw === "" ? null : Temporal.Instant.from(raw));

/** DB 행 → 목록 한 줄. usedBy 는 사용한 링크일 때만 채운다 */
function toInviteItem(row: InviteRow, now: Temporal.Instant): InviteItem {
  const expiresAt = Temporal.Instant.from(row.expires_at);
  const usedAt = orNull(row.used_at);
  const status = inviteStatusAt({ usedAt, revokedAt: orNull(row.revoked_at), expiresAt }, now);
  return {
    inviteId: row.id,
    createdAt: Temporal.Instant.from(row.created_at).toString(),
    expiresAt: expiresAt.toString(),
    status,
    usedBy: status === "used" ? { displayName: row.used_by_name } : null,
  };
}

/** 학원의 초대 링크 전부, 최근에 만든 것부터. 한 학원의 링크 수는 대표가 손으로 만든 만큼이라 쪽 나누기를 두지 않는다 */
async function selectInvites(q: Db | Tx, academyId: string): Promise<InviteRow[]> {
  return q.query(
    q.raw.sql`SELECT i.id,
                     to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                     to_char(i.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
                     COALESCE(to_char(i.used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS used_at,
                     COALESCE(to_char(i.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS revoked_at,
                     COALESCE(s.display_name, '') AS used_by_name
              FROM instructor_invites i
              LEFT JOIN staff_accounts s ON s.id = i.used_by_account_id
              WHERE i.academy_id = ${academyId}::uuid
              ORDER BY i.created_at DESC, i.id DESC`
      .returnsRow(INVITE_ROW)
      .build(),
  );
}

async function selectInvite(q: Db | Tx, academyId: string, inviteId: string): Promise<InviteRow | undefined> {
  const [row] = await q.query(
    q.raw.sql`SELECT i.id,
                     to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                     to_char(i.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
                     COALESCE(to_char(i.used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS used_at,
                     COALESCE(to_char(i.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS revoked_at,
                     COALESCE(s.display_name, '') AS used_by_name
              FROM instructor_invites i
              LEFT JOIN staff_accounts s ON s.id = i.used_by_account_id
              WHERE i.academy_id = ${academyId}::uuid AND i.id = ${inviteId}::uuid`
      .returnsRow(INVITE_ROW)
      .build(),
  );
  return row;
}

// ---- 감사 ------------------------------------------------------------------------------------

/** 감사 1행 — 토큰·해시는 싣지 않는다(감사 기록을 볼 수 있는 사람이 링크를 만들 수 없게) */
async function writeInviteAudit(
  tx: Tx,
  input: { staffAccountId: string; action: string; inviteId: string; before: unknown; after: unknown },
): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, action, target_table, target_id, before, after)
               VALUES (uuidv7(), 'staff', ${input.staffAccountId}::uuid, ${input.action}, 'instructor_invites',
                       ${input.inviteId}::uuid, ${JSON.stringify(input.before)}::json, ${JSON.stringify(input.after)}::json)`
      .affectedCount()
      .build(),
  );
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

export type AcademyInviteDeps = GuardDeps & {
  readonly clock: Clock;
  /** 초대 링크 앞부분(예: https://k-dancex4.kr). 받는 화면 `/invite/<토큰>` 은 S2-1(강사 앱)이 만든다 */
  readonly inviteBaseUrl: string;
};

type AcademyParams = { params: Promise<{ academyId: string }> };
type InviteParams = { params: Promise<{ academyId: string; inviteId: string }> };

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** 경로 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다) */
function parsePathId(raw: string, detail: string): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new HttpError("NOT_FOUND", detail);
  return parsed.data;
}

/** 본문 — 계약상 `{}` 다. 비어 있어도 받고, 칸이 있으면 422(모르는 칸을 조용히 버리지 않는다) */
export const createInviteRequestSchema = z.strictObject({});

async function readCreateBody(request: Request): Promise<void> {
  const text = await request.text();
  if (text.trim() === "") return;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 이 아니에요");
  }
  const parsed = createInviteRequestSchema.safeParse(json);
  if (!parsed.success) {
    throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
      fields: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
    });
  }
}

/**
 * `POST /api/academies/{academyId}/invites` — 대표만(관리자 웹, 2단계 인증). 위임 강사는 못 만든다(08 열린 점 ③).
 * 한 트랜잭션: 초대 행 1개(해시만) + 감사 `invite.created` 1행.
 */
export function createCreateInviteRoute(deps: AcademyInviteDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (request, context, staff) => {
      const academyId = parsePathId((await context.params).academyId, DETAIL.academyNotFound);
      await readCreateBody(request);

      // 만든 시각과 기한을 같은 시계에서 잡는다 — 기한 = 만든 시각 + 7일(ck_invites_expiry 가 기한 > 만든 시각을 지킨다)
      const createdAt = deps.clock();
      const expiresAt = createdAt.add({ hours: 24 * INVITE_VALID_DAYS });
      const token = newInviteToken();

      const inviteId = await deps.db.transaction(async (tx) => {
        const [row] = await tx.query(
          tx.raw.sql`INSERT INTO instructor_invites (id, academy_id, created_by_account_id, token_hash, expires_at, created_at)
                     VALUES (uuidv7(), ${academyId}::uuid, ${staff.staffAccountId}::uuid, ${hashInviteToken(token)},
                             ${expiresAt.toString()}::timestamptz, ${createdAt.toString()}::timestamptz)
                     RETURNING id`
            .returnsRow({ id: "pg/uuid@1" })
            .build(),
        );
        if (row === undefined) throw new Error("초대 행을 만들지 못했다");
        await writeInviteAudit(tx, {
          staffAccountId: staff.staffAccountId,
          action: INVITE_CREATED_AUDIT_ACTION,
          inviteId: row.id,
          before: null,
          after: { status: "active", expiresAt: expiresAt.toString() },
        });
        return row.id;
      });

      const body: CreatedInvite = {
        inviteId,
        inviteUrl: buildInviteUrl(deps.inviteBaseUrl, token),
        expiresAt: expiresAt.toString(),
      };
      // 토큰이 담긴 응답이라 어디에도 캐시하지 않는다
      return Response.json(body, { status: 201, headers: NO_STORE });
    },
  );
}

/** `GET /api/academies/{academyId}/invites` — 대표만. 상태는 요청 시각 기준으로 판정한다 */
export function createListInvitesRoute(deps: AcademyInviteDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (_request, context) => {
      const academyId = parsePathId((await context.params).academyId, DETAIL.academyNotFound);
      const now = deps.clock();
      const rows = await selectInvites(deps.db, academyId);
      return Response.json({ items: rows.map((row) => toInviteItem(row, now)) }, { status: 200, headers: NO_STORE });
    },
  );
}

/**
 * `POST /api/academies/{academyId}/invites/{inviteId}/revoke` — 대표만.
 * 폐기는 한 문장 조건부 UPDATE(아직 유효한 링크만)다. 강사가 같은 순간 링크를 받아도(수락도 조건부 UPDATE)
 * 둘 중 하나만 이긴다 — 영향 0행이면 이유를 다시 읽어 404(이 학원에 없음)·409(이미 끝남)를 가른다.
 */
export function createRevokeInviteRoute(deps: AcademyInviteDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<InviteParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (_request, context, staff) => {
      const params = await context.params;
      const academyId = parsePathId(params.academyId, DETAIL.academyNotFound);
      const inviteId = parsePathId(params.inviteId, DETAIL.notFound);
      const now = deps.clock();

      const item = await deps.db.transaction(async (tx): Promise<InviteItem> => {
        const changed = await tx.query(
          tx.raw.sql`UPDATE instructor_invites SET revoked_at = ${now.toString()}::timestamptz
                     WHERE id = ${inviteId}::uuid AND academy_id = ${academyId}::uuid
                       AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ${now.toString()}::timestamptz
                     RETURNING id`
            .returnsRow({ id: "pg/uuid@1" })
            .build(),
        );
        if (changed.length === 0) {
          // 다른 학원의 링크 id 도 404 — 남의 학원에 그 링크가 「있는지」를 알려 주지 않는다
          const existing = await selectInvite(tx, academyId, inviteId);
          if (existing === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
          throw HttpError.conflict("INVITE_NOT_ACTIVE", DETAIL.notActive);
        }
        await writeInviteAudit(tx, {
          staffAccountId: staff.staffAccountId,
          action: INVITE_REVOKED_AUDIT_ACTION,
          inviteId,
          before: { status: "active" },
          after: { status: "revoked" },
        });
        const after = await selectInvite(tx, academyId, inviteId);
        if (after === undefined) throw new Error("폐기한 초대 행을 다시 읽지 못했다");
        return toInviteItem(after, now);
      });

      return Response.json(item, { status: 200, headers: NO_STORE });
    },
  );
}
