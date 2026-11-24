// S2-1.4(강사 쪽 해제 요청) — 강사가 소속 학원에 「소속을 끝내고 싶어요」를 요청한다.
//   계약: _workspace/03_contracts/11-instructor.md §3-3 「소속 해제 요청 (강사 시작)」 · §12 알림 표(release_requested)
//   데이터: data-model §8-3 affiliation_release_requests · §8-2 instructor_affiliations.release_requested_at
//   요구: FR-082(강사 소속 해제 처리)의 강사 쪽 · FR-185(감사 기록) · 보드 I28·I28B(해제 확인 시트)
//
// 경로 하나(권한은 instructor 역할 + 본인 소속. 강사 앱이라 2단계는 묻지 않는다 — 소속 신청 경로와 같다):
//   POST /api/instructor/affiliations/{id}/release-requests   헤더 Idempotency-Key 필수
//     본문 { sessionChoices: [{sessionId, action}], privateLessonChoices: [{passId, action}], note }
//     → 201 { requestId, status: "requested", requestedAt, remainingSessionCount }
//
// 이 경로는 「요청 기록만」 만든다(Task S2-1.4, 계약 11 열린 점 ①).
//   소속은 그대로 active 이고, 실제 해제는 대표가 계약 11 §9 의 release 로 끝낸다(S1-2.12 · S2-3).
//   강사가 고른 회차·수강권 처리는 대표 화면(W3b·O39)의 선택칸에 미리 채워 줄 「의향」일 뿐이다 — 대체 강사도 대표가 정한다.
//
// 한 트랜잭션에 쓰는 것: 요청 1행 → 소속 행의 release_requested_at → 대표 알림 release_requested → 감사 1행.
//   알림과 요청이 따로 커밋되면 「요청은 있는데 대표가 모른다」가 생길 수 있어서 같이 묶는다.
import { z } from "zod";

import { RELEASE_PASS_ACTIONS, RELEASE_SESSION_ACTIONS } from "../../domain/constants";
import type { Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, parseJsonBody, readIdempotencyKey, withRoute } from "../http";
import { listRemainingWorkFromDb, RELEASE_HAS_REMAINING_SESSIONS } from "./affiliation-release-sessions";
import { readDisplayName } from "./instructor-invite-accept";
import type { Tx } from "./staff-signup";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

export const RELEASE_REQUEST_CREATED_AUDIT_ACTION = "release_request.created";

/** 이 소속에 이미 대기 중인 해제 요청이 있을 때의 409 코드(계약 11 §3-3) */
export const RELEASE_REQUEST_OPEN = "RELEASE_REQUEST_OPEN";

/** 강사가 남기는 한마디의 최대 글자 수 — 계약에 없어 정한 **추천값**(소속 신청 한마디와 같은 200자, DB ck_release_req_note) */
export const RELEASE_NOTE_MAX = 200;

/** 대표 알림을 누르면 가는 곳 — 대표 앱·관리자 웹의 강사 관리(소속 신청 알림과 같은 화면, 처리 화면은 S2-3) */
const OWNER_RELEASE_LINK = "/staff/instructors?releaseRequested=1";

const DETAIL = {
  forbidden: "강사 계정으로만 소속 해제를 요청할 수 있어요",
  notFound: "소속을 찾을 수 없어요",
  notActive: "소속 중인 학원에만 해제를 요청할 수 있어요",
  open: "이 학원에 이미 해제를 요청했어요. 대표가 처리할 때까지 기다려 주세요",
  undecided: "남은 수업 회차를 어떻게 할지 모두 정해야 요청할 수 있어요",
  unknownItem: "이 소속의 남은 회차·수강권이 아니에요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청·응답 계약(11 §3-3) ------------------------------------------------------------------

/** 같은 회차·수강권을 두 번 고르면 어느 쪽이 의향인지 알 수 없다 — id 가 겹치면 422 */
const noDuplicateIds = <T>(pick: (item: T) => string) => (items: T[]) => new Set(items.map(pick)).size === items.length;

/**
 * 해제 요청 본문. 모르는 칸은 받지 않는다(strictObject) — 클라이언트가 status 같은 값을 정하지 못하게.
 * 남은 회차가 없으면 두 배열은 비워(또는 빼고) 보낸다. 한마디는 비우면 null 로 저장한다.
 */
export const releaseRequestBodySchema = z.strictObject({
  sessionChoices: z
    .array(z.strictObject({ sessionId: z.uuid(), action: z.enum(RELEASE_SESSION_ACTIONS) }))
    .refine(noDuplicateIds((c: { sessionId: string }) => c.sessionId), "같은 회차를 두 번 골랐어요")
    .default([]),
  privateLessonChoices: z
    .array(z.strictObject({ passId: z.uuid(), action: z.enum(RELEASE_PASS_ACTIONS) }))
    .refine(noDuplicateIds((c: { passId: string }) => c.passId), "같은 수강권을 두 번 골랐어요")
    .default([]),
  note: z
    .string()
    .trim()
    .max(RELEASE_NOTE_MAX)
    .nullish()
    .transform((value) => (value === undefined || value === null || value === "" ? null : value)),
});
export type ReleaseRequestBody = z.output<typeof releaseRequestBodySchema>;

export const createdReleaseRequestSchema = z.strictObject({
  requestId: z.uuid(),
  status: z.literal("requested"),
  requestedAt: z.iso.datetime({ offset: true }),
  /** 요청 때 남아 있던 이 강사의 이후 회차 수(대표 알림 카드의 숫자와 같다) */
  remainingSessionCount: z.number().int().min(0),
});
export type CreatedReleaseRequest = z.infer<typeof createdReleaseRequestSchema>;

// ---- 바깥에서 끼우는 「남은 일 목록」 ----------------------------------------------------------

/** 이 학원에서 이 강사가 앞으로 맡은 회차 id 와 남은 개인 레슨 수강권 id */
export type RemainingWork = { readonly sessionIds: readonly string[]; readonly passIds: readonly string[] };

/**
 * 남은 일 목록을 읽는 함수. 소속 행을 잠근 뒤 같은 트랜잭션(tx)으로 읽게 한다.
 * S1-2.12 의 countRemainingWork 와 같은 생각이다 — 여기서는 「몇 개」가 아니라 「어느 것」이 필요하다
 * (어느 회차를 안 골랐는지 undecided 로 알려 줘야 하므로).
 */
export type ListRemainingWork = (
  tx: Tx,
  input: { academyId: string; instructorAccountId: string; nowIso: string },
) => Promise<RemainingWork>;

/**
 * 기본값 — 대표의 해제 확인 창(S2-3.6)과 같은 읽기로 「이 학원에서 이 강사가 맡은 시작 전 · 예정 회차」를 돌려준다.
 * 같은 읽기를 써야 강사가 고른 의향과 대표 화면의 회차 목록이 같다. 개인 레슨 수강권은 S2-4 전이라 빈 목록.
 * 테스트는 회차를 돌려주는 가짜를 끼워 409 RELEASE_HAS_REMAINING_SESSIONS 와 의향 저장을 확인한다.
 */
export const listRemainingWorkDefault: ListRemainingWork = listRemainingWorkFromDb;

export type ReleaseRequestDeps = GuardDeps & {
  readonly clock: Clock;
  /** 빼면 기본값(DB 의 남은 회차)을 쓴다 */
  readonly listRemainingWork?: ListRemainingWork;
};

type IdParams = { params: Promise<{ id: string }> };

// ---- 도우미 ------------------------------------------------------------------------------------

/** DB 시각 글자(마이크로초 6자리) → 다른 응답과 같은 ISO 모양 */
function toIso(dbText: string): string {
  return Temporal.Instant.from(dbText).toString();
}

/**
 * 같은 강사가 같은 Idempotency-Key 로 이미 낸 요청. 있으면 처음 응답을 그대로 다시 만든다.
 * 남은 회차 수는 저장한 sessionChoices 의 길이다 — 요청이 받아들여졌다면 남은 회차를 빠짐없이,
 * 그리고 그것만 골랐으므로(아래 checkChoices) 두 수가 같다.
 */
async function findByIdempotencyKey(tx: Tx, instructorId: string, key: string): Promise<CreatedReleaseRequest | undefined> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT id,
                      to_char(requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS requested_at,
                      json_array_length(session_choices) AS session_count
               FROM affiliation_release_requests
               WHERE requested_by_account_id = ${instructorId}::uuid AND idempotency_key = ${key}`
      .returnsRow({ id: "pg/uuid@1", requested_at: "pg/text@1", session_count: "pg/int4@1" })
      .build(),
  );
  if (row === undefined) return undefined;
  return { requestId: row.id, status: "requested", requestedAt: toIso(row.requested_at), remainingSessionCount: row.session_count };
}

/** 내 소속 행을 잠그고 읽는다. 남의 소속·없는 id 는 undefined — 남의 소속이 있다는 사실도 알리지 않는다 */
async function lockMyAffiliation(tx: Tx, affiliationId: string, instructorId: string) {
  const [row] = await tx.query(
    tx.raw.sql`SELECT academy_id, status FROM instructor_affiliations
               WHERE id = ${affiliationId}::uuid AND instructor_account_id = ${instructorId}::uuid
               FOR UPDATE`
      .returnsRow({ academy_id: "pg/uuid@1", status: "pg/text@1" })
      .build(),
  );
  return row;
}

/**
 * 강사가 고른 처리와 실제 남은 일을 맞춰 본다(I28 「정하기 전엔 해제 못 해요」).
 *   - 남은 일이 아닌 id 를 골랐다 → 422 VALIDATION_FAILED(다른 학원 회차·이미 지난 회차를 의향에 섞지 않게)
 *   - 남은 일 중 고르지 않은 것이 있다 → 409 RELEASE_HAS_REMAINING_SESSIONS + undecided(id 목록)
 */
function checkChoices(body: ReleaseRequestBody, remaining: RemainingWork): void {
  const sessionSet = new Set(remaining.sessionIds);
  const passSet = new Set(remaining.passIds);
  const unknown = [
    ...body.sessionChoices.flatMap((c, i) => (sessionSet.has(c.sessionId) ? [] : [{ path: `sessionChoices.${i}.sessionId`, message: DETAIL.unknownItem }])),
    ...body.privateLessonChoices.flatMap((c, i) => (passSet.has(c.passId) ? [] : [{ path: `privateLessonChoices.${i}.passId`, message: DETAIL.unknownItem }])),
  ];
  if (unknown.length > 0) throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", { fields: unknown });

  const chosenSessions = new Set(body.sessionChoices.map((c) => c.sessionId));
  const chosenPasses = new Set(body.privateLessonChoices.map((c) => c.passId));
  const undecided = [
    ...remaining.sessionIds.filter((id) => !chosenSessions.has(id)),
    ...remaining.passIds.filter((id) => !chosenPasses.has(id)),
  ];
  if (undecided.length > 0) throw HttpError.conflict(RELEASE_HAS_REMAINING_SESSIONS, DETAIL.undecided, { undecided });
}

/**
 * 그 학원 대표에게 알림 `release_requested` 1건(category approval, 계약 11 §3-3 · §12).
 * 열쇠 `release:<requestId>:requested` 가 있어 같은 요청으로 두 번 생기지 않는다.
 * 휴대폰 발송은 S7-1 이 이 행(delivery_status = pending)을 읽어 보낸다.
 */
async function notifyOwnerReleaseRequested(
  tx: Tx,
  input: { academyId: string; affiliationId: string; requestId: string; instructorName: string; remainingSessionCount: number; note: string | null },
): Promise<void> {
  const payload = JSON.stringify({
    requestId: input.requestId,
    affiliationId: input.affiliationId,
    instructorName: input.instructorName,
    remainingSessionCount: input.remainingSessionCount,
    note: input.note,
    title: `${input.instructorName} 강사가 소속 해제를 요청했어요`,
    body:
      input.remainingSessionCount > 0
        ? `남은 회차 ${input.remainingSessionCount}개를 어떻게 할지 정하고 해제해 주세요`
        : "남은 회차가 없어요. 확인하고 해제해 주세요",
    actionLabel: "확인하고 처리",
    link: OWNER_RELEASE_LINK,
  });
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               SELECT uuidv7(), o.staff_account_id, o.academy_id, 'approval', 'release_requested',
                      ${`release:${input.requestId}:requested`}, ${payload}::jsonb
               FROM academy_owners o
               WHERE o.academy_id = ${input.academyId}::uuid AND o.status = 'active'
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

/**
 * `POST /api/instructor/affiliations/{id}/release-requests` — 강사가 소속 해제를 요청한다(I28 · I28B).
 * 순서: 같은 키로 낸 요청이 있나(있으면 200 처음 것) → 내 소속 잠금(없으면 404, active 아니면 409)
 *       → 남은 일과 고른 처리 맞추기 → 요청 1행(열린 요청이 있으면 409) → release_requested_at → 대표 알림 → 감사.
 */
export function createReleaseRequestRoute(deps: ReleaseRequestDeps) {
  const guards = createGuards(deps);
  const listRemainingWork = deps.listRemainingWork ?? listRemainingWorkDefault;

  return withRoute<IdParams>(async (request, context) => {
    const staff = await guards.requireStaffAccount(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    const instructorId = staff.staffAccountId;

    const parsedId = z.uuid().safeParse((await context.params).id);
    if (!parsedId.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const affiliationId = parsedId.data;
    const key = readIdempotencyKey(request, { required: true });
    const body = await parseJsonBody(request, releaseRequestBodySchema);
    const now = deps.clock();
    const instructorName = await readDisplayName(deps.db, instructorId);

    const outcome = await deps.db.transaction(async (tx): Promise<{ created: boolean; body: CreatedReleaseRequest }> => {
      // ① 같은 키로 다시 왔으면 아무것도 쓰지 않고 처음 결과를 준다(계약 11 §0 「같은 키 → 200 + 처음 결과」)
      const replay = await findByIdempotencyKey(tx, instructorId, key);
      if (replay !== undefined) return { created: false, body: replay };

      // ② 내 소속 행을 잠근다 — 대표가 같은 순간에 해제(release)해도 둘 중 하나가 뒤로 줄 선다
      const affiliation = await lockMyAffiliation(tx, affiliationId, instructorId);
      if (affiliation === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
      if (affiliation.status !== "active") throw HttpError.conflict("AFFILIATION_STATE_CONFLICT", DETAIL.notActive);

      // ③ 남은 회차·수강권을 모두 정했나
      const remaining = await listRemainingWork(tx, {
        academyId: affiliation.academy_id,
        instructorAccountId: instructorId,
        nowIso: now.toString(),
      });
      checkChoices(body, remaining);

      // ④ 요청 1행. 열린 요청(uq_release_req_open)이나 같은 키(uq_release_req_idem)에 걸리면 DO NOTHING → 0행.
      //    먼저 SELECT 로 확인하지 않는 이유: 확인과 INSERT 사이에 두 번째 요청이 끼어들 수 있다. 유니크 제약이 유일한 판정이다
      const [row] = await tx.query(
        tx.raw.sql`INSERT INTO affiliation_release_requests
                     (id, affiliation_id, requested_by_account_id, status, session_choices, private_lesson_choices, note, requested_at, idempotency_key)
                   VALUES (uuidv7(), ${affiliationId}::uuid, ${instructorId}::uuid, 'requested',
                           ${JSON.stringify(body.sessionChoices)}::json, ${JSON.stringify(body.privateLessonChoices)}::json,
                           NULLIF(${body.note ?? ""}, ''), ${now.toString()}::timestamptz, ${key})
                   ON CONFLICT DO NOTHING
                   RETURNING id`
          .returnsRow({ id: "pg/uuid@1" })
          .build(),
      );
      if (row === undefined) {
        // 같은 키의 두 요청이 동시에 왔다면 먼저 들어간 쪽의 결과를 준다. 아니면 열린 요청이 이미 있는 것이다
        const raced = await findByIdempotencyKey(tx, instructorId, key);
        if (raced !== undefined) return { created: false, body: raced };
        throw HttpError.conflict(RELEASE_REQUEST_OPEN, DETAIL.open);
      }

      // ⑤ 소속 행에 「열린 요청 있음」 표시(비정규 칸 — 대표 소속 목록이 표를 다시 뒤지지 않고 보게)
      await tx.execute(
        tx.raw.sql`UPDATE instructor_affiliations
                   SET release_requested_at = ${now.toString()}::timestamptz, updated_at = ${now.toString()}::timestamptz
                   WHERE id = ${affiliationId}::uuid`
          .affectedCount()
          .build(),
      );

      const remainingSessionCount = remaining.sessionIds.length;
      await notifyOwnerReleaseRequested(tx, {
        academyId: affiliation.academy_id,
        affiliationId,
        requestId: row.id,
        instructorName,
        remainingSessionCount,
        note: body.note,
      });

      // ⑥ 감사 1행 — data-model 이 이 표를 「감사 ○」로 두었다. 강사 본인이 한 일이다
      const after = JSON.stringify({
        status: "requested",
        affiliationId,
        sessionChoices: body.sessionChoices,
        privateLessonChoices: body.privateLessonChoices,
      });
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, academy_id, action, target_table, target_id, before, after)
                   VALUES (uuidv7(), 'staff', ${instructorId}::uuid, ${affiliation.academy_id}::uuid, ${RELEASE_REQUEST_CREATED_AUDIT_ACTION},
                           'affiliation_release_requests', ${row.id}::uuid, NULL, ${after}::json)`
          .affectedCount()
          .build(),
      );

      return {
        created: true,
        body: { requestId: row.id, status: "requested", requestedAt: now.toString(), remainingSessionCount },
      };
    });

    return Response.json(outcome.body, { status: outcome.created ? 201 : 200, headers: NO_STORE });
  });
}
