// S2-3.13(소속 해제 요청 목록·거절·취소 API) — 강사가 낸 소속 해제 요청(S2-1.4)의 뒷일 셋.
//   계약: _workspace/03_contracts/11-instructor.md §3-3(강사 쪽 withdraw) · §9(대표 쪽 목록·거절) · §12 알림 표(release_declined)
//   데이터: data-model §8-3 affiliation_release_requests(status: requested · completed · withdrawn · declined)
//           · §8-2 instructor_affiliations.release_requested_at(「열린 요청 있음」 표시)
//   요구: FR-082(강사 소속 해제 처리) · FR-185(감사 기록) · 보드 O21B·O37(대표) · I28(강사)
//
// 경로 셋:
//   GET  /api/academies/{academyId}/affiliation-release-requests?status=requested   (owner + 관리자 웹 2단계)
//     → 200 { items: [{ requestId, affiliationId, instructor, remainingSessionCount, sessionChoices, privateLessonChoices, note, requestedAt }] }
//   POST /api/academies/{academyId}/affiliation-release-requests/{requestId}/decline (owner + 관리자 웹 2단계)
//     본문 { reason }(1~200자) → 200 { requestId, status: "declined", declinedAt, reason }
//   POST /api/instructor/affiliation-release-requests/{requestId}/withdraw          (instructor 본인 요청, 강사 앱)
//     → 200 { requestId, status: "withdrawn", withdrawnAt }
//
// 왜 이렇게 했나:
//   - 거절·취소 모두 「요청 행만 닫는다」. 소속은 그대로 active 이고, 회차도 건드리지 않는다(해제는 대표의 release 만 한다).
//   - 두 번 눌러도 안전하게(멱등) 요청 행을 FOR UPDATE 로 잠그고 상태를 본다. 이미 같은 상태면 아무것도 쓰지 않고
//     처음과 같은 본문을 준다(계약 「이미 declined 면 200 같은 본문」). 이미 해제가 끝났으면(completed) 409.
//   - 거절 사유는 요청 표에 칸이 없다(data-model §8-3). 그래서 감사 `release_request.declined` 의 after 와
//     강사 알림 payload 에 남긴다 — 다시 부를 때도 감사 기록에서 처음 사유를 읽어 같은 본문을 만든다.
import { z } from "zod";

import { RELEASE_PASS_ACTIONS, RELEASE_SESSION_ACTIONS } from "../../domain/constants";
import type { Clock } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, parseJsonBody, withRoute } from "../http";
import { listRemainingWorkFromDb } from "./affiliation-release-sessions";
import type { Tx } from "./staff-signup";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

export const RELEASE_REQUEST_DECLINED_AUDIT_ACTION = "release_request.declined";
export const RELEASE_REQUEST_WITHDRAWN_AUDIT_ACTION = "release_request.withdrawn";

/** 거절 사유의 최대 글자 수(계약 11 §9 「1~200자」) */
export const RELEASE_DECLINE_REASON_MAX = 200;

/** 요청 상태 값(data-model §8-7) — 목록의 ?status= 로 고를 수 있는 값 */
export const RELEASE_REQUEST_STATUSES = ["requested", "completed", "withdrawn", "declined"] as const;

/** 강사 알림을 누르면 가는 곳 — 강사 앱 「내 소속」(I27B). 해제 완료 알림과 같은 곳 */
const INSTRUCTOR_AFFILIATIONS_LINK = "/instructor/affiliations";

const DETAIL = {
  academyNotFound: "학원을 찾을 수 없어요",
  notFound: "해제 요청을 찾을 수 없어요",
  forbidden: "강사 계정으로만 해제 요청을 취소할 수 있어요",
  alreadyCompleted: "이미 해제가 끝난 요청이에요",
  alreadyClosed: "이미 닫힌 요청이에요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청·응답 계약 ----------------------------------------------------------------------------

/** 목록 쿼리 — status 를 빼면 열린 요청(requested)만. 모르는 값은 422 */
export const releaseRequestListQuerySchema = z.strictObject({
  status: z.enum(RELEASE_REQUEST_STATUSES).default("requested"),
});

const sessionChoiceSchema = z.strictObject({ sessionId: z.uuid(), action: z.enum(RELEASE_SESSION_ACTIONS) });
const passChoiceSchema = z.strictObject({ passId: z.uuid(), action: z.enum(RELEASE_PASS_ACTIONS) });

export const releaseRequestItemSchema = z.strictObject({
  requestId: z.uuid(),
  affiliationId: z.uuid(),
  status: z.enum(RELEASE_REQUEST_STATUSES),
  instructor: z.strictObject({ accountId: z.uuid(), displayName: z.string() }),
  /** 지금 남아 있는 이 강사의 이후 회차 수(요청 뒤 지나간 회차는 빠진다) */
  remainingSessionCount: z.number().int().min(0),
  sessionChoices: z.array(sessionChoiceSchema),
  privateLessonChoices: z.array(passChoiceSchema),
  note: z.string().nullable(),
  requestedAt: z.iso.datetime({ offset: true }),
});
export const releaseRequestListSchema = z.strictObject({ items: z.array(releaseRequestItemSchema) });
export type ReleaseRequestItem = z.infer<typeof releaseRequestItemSchema>;

/** 거절 본문 — 사유 한 줄(앞뒤 공백을 뺀 뒤 1~200자). 모르는 칸은 받지 않는다 */
export const declineReleaseRequestBodySchema = z.strictObject({
  reason: z.string().trim().min(1).max(RELEASE_DECLINE_REASON_MAX),
});

export const declinedReleaseRequestSchema = z.strictObject({
  requestId: z.uuid(),
  status: z.literal("declined"),
  declinedAt: z.iso.datetime({ offset: true }),
  reason: z.string(),
});
export type DeclinedReleaseRequest = z.infer<typeof declinedReleaseRequestSchema>;

export const withdrawnReleaseRequestSchema = z.strictObject({
  requestId: z.uuid(),
  status: z.literal("withdrawn"),
  withdrawnAt: z.iso.datetime({ offset: true }),
});
export type WithdrawnReleaseRequest = z.infer<typeof withdrawnReleaseRequestSchema>;

export type ReleaseRequestDecisionDeps = GuardDeps & { readonly clock: Clock };

type AcademyParams = { params: Promise<{ academyId: string }> };
type AcademyRequestParams = { params: Promise<{ academyId: string; requestId: string }> };
type RequestParams = { params: Promise<{ requestId: string }> };

// ---- 도우미 ------------------------------------------------------------------------------------

/** 경로 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다) */
function parsePathId(raw: string, detail: string): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new HttpError("NOT_FOUND", detail);
  return parsed.data;
}

/** DB 시각 글자(마이크로초 6자리) → 다른 응답과 같은 ISO 모양 */
function toIso(dbText: string): string {
  return Temporal.Instant.from(dbText).toString();
}

const UTC_TEXT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

type LockedRequest = {
  status: string;
  affiliation_id: string;
  academy_id: string;
  instructor_account_id: string;
  academy_name: string;
  resolved_at: string;
};

/**
 * 요청 행을 잠그고 읽는다. 조건(학원 또는 요청한 강사)에 맞지 않으면 undefined —
 * 남의 학원·남의 요청이 「있는지」 알리지 않는다(소속 경로들과 같은 규칙).
 */
async function lockRequest(tx: Tx, requestId: string, scope: { academyId: string } | { instructorId: string }): Promise<LockedRequest | undefined> {
  // 쓰지 않는 조건은 빈 글자로 넘기고 SQL 에서 NULL 로 바꾼다(raw SQL 자리에 null 을 직접 넣을 수 없다)
  const academyId = "academyId" in scope ? scope.academyId : "";
  const instructorId = "instructorId" in scope ? scope.instructorId : "";
  const [row] = await tx.query(
    tx.raw.sql`SELECT r.status, r.affiliation_id::text AS affiliation_id, a.academy_id::text AS academy_id,
                      a.instructor_account_id::text AS instructor_account_id,
                      (SELECT name FROM academies WHERE id = a.academy_id) AS academy_name,
                      COALESCE(to_char(r.resolved_at AT TIME ZONE 'UTC', ${UTC_TEXT}), '') AS resolved_at
               FROM affiliation_release_requests r
               JOIN instructor_affiliations a ON a.id = r.affiliation_id
               WHERE r.id = ${requestId}::uuid
                 AND (${academyId} = '' OR a.academy_id = NULLIF(${academyId}, '')::uuid)
                 AND (${instructorId} = '' OR r.requested_by_account_id = NULLIF(${instructorId}, '')::uuid)
               FOR UPDATE OF r`
      .returnsRow({
        status: "pg/text@1",
        affiliation_id: "pg/text@1",
        academy_id: "pg/text@1",
        instructor_account_id: "pg/text@1",
        academy_name: "pg/text@1",
        resolved_at: "pg/text@1",
      })
      .build(),
  );
  return row;
}

/**
 * 열린 요청을 닫는다(requested → declined·withdrawn). 같은 트랜잭션에서 소속 행의 「열린 요청 있음」 표시도 지운다 —
 * 지우지 않으면 대표 소속 목록에 끝난 요청이 계속 「요청 옴」으로 보인다.
 */
async function closeRequest(
  tx: Tx,
  input: { requestId: string; affiliationId: string; status: "declined" | "withdrawn"; actorId: string; nowIso: string },
): Promise<void> {
  await tx.execute(
    tx.raw.sql`UPDATE affiliation_release_requests
               SET status = ${input.status}, resolved_at = ${input.nowIso}::timestamptz, resolved_by_account_id = ${input.actorId}::uuid
               WHERE id = ${input.requestId}::uuid AND status = 'requested'`
      .affectedCount()
      .build(),
  );
  await tx.execute(
    tx.raw.sql`UPDATE instructor_affiliations
               SET release_requested_at = NULL, updated_at = ${input.nowIso}::timestamptz
               WHERE id = ${input.affiliationId}::uuid`
      .affectedCount()
      .build(),
  );
}

/** 감사 1행 — 요청 표는 「감사 ○」(data-model §8-3). 누가 언제 닫았고 거절이면 사유까지 남긴다 */
async function writeAudit(
  tx: Tx,
  input: { actorId: string; academyId: string; requestId: string; action: string; after: Record<string, unknown>; nowIso: string },
): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, academy_id, action, target_table, target_id, before, after, occurred_at)
               VALUES (uuidv7(), 'staff', ${input.actorId}::uuid, ${input.academyId}::uuid, ${input.action},
                       'affiliation_release_requests', ${input.requestId}::uuid, ${JSON.stringify({ status: "requested" })}::json,
                       ${JSON.stringify(input.after)}::json, ${input.nowIso}::timestamptz)`
      .affectedCount()
      .build(),
  );
}

/** 이미 거절한 요청의 처음 사유 — 감사 기록에서 읽는다(요청 표에 사유 칸이 없다) */
async function readDeclineReason(tx: Tx, requestId: string): Promise<string> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT COALESCE(after::json ->> 'reason', '') AS reason FROM audit_logs
               WHERE action = ${RELEASE_REQUEST_DECLINED_AUDIT_ACTION} AND target_id = ${requestId}::uuid
               ORDER BY occurred_at DESC LIMIT 1`
      .returnsRow({ reason: "pg/text@1" })
      .build(),
  );
  return row?.reason ?? "";
}

/**
 * 요청한 강사에게 알림 `release_declined` 1건(category operations, 계약 11 §9 · §12).
 * 열쇠 `release:<requestId>:declined` 가 있어 같은 요청으로 두 번 생기지 않는다. 발송은 S7-1 이 이 행(pending)을 읽어 보낸다.
 */
async function notifyInstructorDeclined(
  tx: Tx,
  input: { instructorId: string; academyId: string; academyName: string; affiliationId: string; requestId: string; reason: string },
): Promise<void> {
  const payload = {
    requestId: input.requestId,
    affiliationId: input.affiliationId,
    academyId: input.academyId,
    academyName: input.academyName,
    reason: input.reason,
    title: `${input.academyName} 소속 해제 요청이 거절됐어요`,
    body: `사유: ${input.reason}`,
    actionLabel: "내 소속 보기",
    link: INSTRUCTOR_AFFILIATIONS_LINK,
  };
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               VALUES (uuidv7(), ${input.instructorId}::uuid, ${input.academyId}::uuid, 'operations', 'release_declined',
                       ${`release:${input.requestId}:declined`}, ${JSON.stringify(payload)}::jsonb)
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

// ---- 목록 ------------------------------------------------------------------------------------

/**
 * `GET /api/academies/{academyId}/affiliation-release-requests?status=requested` — 대표가 강사의 해제 요청을 본다(O21B · O37).
 * 강사가 고른 의향(sessionChoices·privateLessonChoices)을 그대로 내려 대표 화면(W3b·O39)의 선택칸에 미리 채우게 한다.
 * 남은 회차 수는 저장한 의향의 길이가 아니라 **지금** DB 에서 센다 — 요청 뒤 지나간 회차는 더 처리할 것이 아니다.
 */
export function createListReleaseRequestsRoute(deps: ReleaseRequestDecisionDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (request, context) => {
      const academyId = parsePathId((await context.params).academyId, DETAIL.academyNotFound);
      const url = new URL(request.url);
      const raw = url.searchParams.get("status");
      const parsed = releaseRequestListQuerySchema.safeParse(raw === null ? {} : { status: raw });
      if (!parsed.success) {
        throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
          fields: [{ path: "status", message: "requested · completed · withdrawn · declined 중 하나여야 해요" }],
        });
      }
      const nowIso = deps.clock().toString();

      const items = await deps.db.transaction(async (tx): Promise<ReleaseRequestItem[]> => {
        const rows = await tx.query(
          tx.raw.sql`SELECT r.id::text AS id, r.affiliation_id::text AS affiliation_id, r.status,
                            a.instructor_account_id::text AS instructor_id, s.display_name,
                            r.session_choices::text AS session_choices, r.private_lesson_choices::text AS pass_choices,
                            COALESCE(r.note, '') AS note,
                            to_char(r.requested_at AT TIME ZONE 'UTC', ${UTC_TEXT}) AS requested_at
                     FROM affiliation_release_requests r
                     JOIN instructor_affiliations a ON a.id = r.affiliation_id
                     JOIN staff_accounts s ON s.id = a.instructor_account_id
                     WHERE a.academy_id = ${academyId}::uuid AND r.status = ${parsed.data.status}
                     ORDER BY r.requested_at DESC, r.id DESC`
            .returnsRow({
              id: "pg/text@1",
              affiliation_id: "pg/text@1",
              status: "pg/text@1",
              instructor_id: "pg/text@1",
              display_name: "pg/text@1",
              session_choices: "pg/text@1",
              pass_choices: "pg/text@1",
              note: "pg/text@1",
              requested_at: "pg/text@1",
            })
            .build(),
        );
        const result: ReleaseRequestItem[] = [];
        for (const row of rows) {
          // 열린 요청만 「지금 남은 회차」가 뜻이 있다. 닫힌 요청은 처리할 것이 없으므로 0 으로 둔다
          const remaining =
            row.status === "requested"
              ? await listRemainingWorkFromDb(tx, { academyId, instructorAccountId: row.instructor_id, nowIso })
              : { sessionIds: [], passIds: [] };
          result.push(
            releaseRequestItemSchema.parse({
              requestId: row.id,
              affiliationId: row.affiliation_id,
              status: row.status,
              instructor: { accountId: row.instructor_id, displayName: row.display_name },
              remainingSessionCount: remaining.sessionIds.length,
              sessionChoices: JSON.parse(row.session_choices),
              privateLessonChoices: JSON.parse(row.pass_choices),
              note: row.note === "" ? null : row.note,
              requestedAt: toIso(row.requested_at),
            }),
          );
        }
        return result;
      });

      return Response.json({ items }, { status: 200, headers: NO_STORE });
    },
  );
}

// ---- 거절 ------------------------------------------------------------------------------------

/**
 * `POST /api/academies/{academyId}/affiliation-release-requests/{requestId}/decline` — 대표가 해제 요청을 거절한다(O37).
 * 검사 순서: 권한(가드) → 본문(사유) → 경로 id.
 * 한 트랜잭션: 요청 행 잠금 → 없음·다른 학원 404 / 이미 declined 면 같은 본문 200 / completed·withdrawn 409
 *              → declined 로 닫기 + 소속의 「열린 요청」 표시 지우기 → 감사(사유) → 강사 알림 release_declined(사유).
 * 소속은 그대로 active 다 — 거절은 「지금은 해제하지 않는다」는 뜻이다.
 */
export function createDeclineReleaseRequestRoute(deps: ReleaseRequestDecisionDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<AcademyRequestParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (request, context, staff) => {
      const body = await parseJsonBody(request, declineReleaseRequestBodySchema);
      const params = await context.params;
      const academyId = parsePathId(params.academyId, DETAIL.academyNotFound);
      const requestId = parsePathId(params.requestId, DETAIL.notFound);
      const nowIso = deps.clock().toString();

      const result = await deps.db.transaction(async (tx): Promise<DeclinedReleaseRequest> => {
        const locked = await lockRequest(tx, requestId, { academyId });
        if (locked === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
        // 이미 거절함 — 아무것도 쓰지 않고 처음 사유·시각 그대로(두 번 눌러도 알림·감사가 하나)
        if (locked.status === "declined") {
          return { requestId, status: "declined", declinedAt: toIso(locked.resolved_at), reason: await readDeclineReason(tx, requestId) };
        }
        if (locked.status === "completed") throw HttpError.conflict("AFFILIATION_STATE_CONFLICT", DETAIL.alreadyCompleted);
        // 강사가 이미 취소한 요청은 거절할 것이 없다 — 같은 409 로 알린다(계약에 따로 적힌 코드가 없어 completed 와 같게 둠)
        if (locked.status !== "requested") throw HttpError.conflict("AFFILIATION_STATE_CONFLICT", DETAIL.alreadyClosed);

        await closeRequest(tx, { requestId, affiliationId: locked.affiliation_id, status: "declined", actorId: staff.staffAccountId, nowIso });
        await writeAudit(tx, {
          actorId: staff.staffAccountId,
          academyId,
          requestId,
          action: RELEASE_REQUEST_DECLINED_AUDIT_ACTION,
          after: { status: "declined", reason: body.reason },
          nowIso,
        });
        await notifyInstructorDeclined(tx, {
          instructorId: locked.instructor_account_id,
          academyId,
          academyName: locked.academy_name,
          affiliationId: locked.affiliation_id,
          requestId,
          reason: body.reason,
        });
        return { requestId, status: "declined", declinedAt: nowIso, reason: body.reason };
      });

      return Response.json(result, { status: 200, headers: NO_STORE });
    },
  );
}

// ---- 취소(강사) ------------------------------------------------------------------------------

/**
 * `POST /api/instructor/affiliation-release-requests/{requestId}/withdraw` — 강사가 자기 해제 요청을 거둔다(I28).
 * 권한은 instructor 역할 + 본인 요청(강사 앱이라 2단계는 묻지 않는다 — 요청 경로와 같다). 본문은 받지 않는다.
 * 한 트랜잭션: 내 요청 행 잠금 → 없음·남의 요청 404 / 이미 withdrawn 이면 같은 본문 200 / completed·declined 409
 *              → withdrawn 으로 닫기 + 소속의 「열린 요청」 표시 지우기 → 감사.
 * 대표에게 따로 알림을 보내지 않는다(계약에 없음) — 대표 목록(?status=requested)에서 사라지는 것으로 충분하다.
 */
export function createWithdrawReleaseRequestRoute(deps: ReleaseRequestDecisionDeps) {
  const guards = createGuards(deps);
  return withRoute<RequestParams>(async (request, context) => {
    const staff = await guards.requireStaffAccount(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    const instructorId = staff.staffAccountId;
    const requestId = parsePathId((await context.params).requestId, DETAIL.notFound);
    const nowIso = deps.clock().toString();

    const result = await deps.db.transaction(async (tx): Promise<WithdrawnReleaseRequest> => {
      const locked = await lockRequest(tx, requestId, { instructorId });
      if (locked === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
      if (locked.status === "withdrawn") return { requestId, status: "withdrawn", withdrawnAt: toIso(locked.resolved_at) };
      // 대표가 이미 해제를 끝냈으면 거둘 수 없다(계약 11 §3-3 「이미 completed 면 409」). 거절된 요청도 닫힌 요청이라 같은 409
      if (locked.status === "completed") throw HttpError.conflict("AFFILIATION_STATE_CONFLICT", DETAIL.alreadyCompleted);
      if (locked.status !== "requested") throw HttpError.conflict("AFFILIATION_STATE_CONFLICT", DETAIL.alreadyClosed);

      await closeRequest(tx, { requestId, affiliationId: locked.affiliation_id, status: "withdrawn", actorId: instructorId, nowIso });
      await writeAudit(tx, {
        actorId: instructorId,
        academyId: locked.academy_id,
        requestId,
        action: RELEASE_REQUEST_WITHDRAWN_AUDIT_ACTION,
        after: { status: "withdrawn" },
        nowIso,
      });
      return { requestId, status: "withdrawn", withdrawnAt: nowIso };
    });

    return Response.json(result, { status: 200, headers: NO_STORE });
  });
}
