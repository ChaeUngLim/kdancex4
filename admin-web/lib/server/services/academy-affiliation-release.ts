// S1-2.12(소속 해제 API — 남은 회차 0) + S2-3.6(소속 해제의 남은 회차 처리) — 대표가 소속 강사를 학원에서 내보낸다.
//   계약: _workspace/03_contracts/08-owner-staff.md §5 「소속 해제」 · 11-instructor.md §9(같은 경로의 S2-3 완성형)
//   데이터: data-model §7-5 instructor_affiliations(released_at·release_initiated_by) · instructor_delegations(「지금 켜진 위임」만)
//   요구: FR-082(강사 소속 해제 처리)의 대표 쪽 · FR-185(감사 기록)
//
// 경로 하나(권한은 owner + 관리자 웹 2단계 — 위임 강사는 못 쓴다):
//   POST /api/academies/{academyId}/affiliations/{id}/release   헤더 Idempotency-Key 필수
//     본문 { sessionDecisions, privateLessonDecisions, ownerNote } — 남은 회차가 0 이면 비우거나 {} (08 §5 의 M1 모양)
//     → 200 { status: "released", releasedAt, sessions: {substituted, cancelled, closed}, notified: {memberCount, notificationCount} }
//     → 409 RELEASE_HAS_REMAINING_SESSIONS + { remainingSessions, undecided } — 처리를 정하지 않은 남은 회차가 있으면
//     → 409 SUBSTITUTE_UNAVAILABLE + { sessionId } · 422 VALIDATION_FAILED(대체 강사 없음·후보 아님·남은 회차 아님)
//
// 남은 회차 처리(대체·휴강·폐강 · 회원마다 알림 1건)는 S2-3.6 이 affiliation-release-sessions.ts 의 applyReleaseDecisions 로 더했다.
// 그 함수는 deps 로 바꿔 끼울 수 있다 — 기존 S1-2.12 테스트가 남은 회차 409 를 가짜로 확인한다.
//
// 두 번 눌러도 안전한 이유(멱등):
//   소속 행을 FOR UPDATE 로 잠그고 상태를 본다. 이미 released 면 아무것도 쓰지 않고 처음과 같은 본문(같은 releasedAt)을 준다.
//   그래서 같은 Idempotency-Key 든 다른 키든 결과가 하나다 — 키는 모양만 검사한다(취소 경로처럼 키 저장 표가 필요 없다).
import { z } from "zod";

import type { Clock } from "../../domain/time";
import {
  applyReleaseDecisions,
  isInstructorOverlap,
  RELEASE_HAS_REMAINING_SESSIONS,
  releaseBodySchema,
  SUBSTITUTE_UNAVAILABLE,
  type ApplyResult,
} from "./affiliation-release-sessions";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseWith, readIdempotencyKey } from "../http";
import type { Tx } from "./staff-signup";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

export const AFFILIATION_RELEASED_AUDIT_ACTION = "affiliation.released";

/** 남은 회차가 있을 때의 409 코드(계약 08 §5 · 11 §9 같은 코드) — 원본은 affiliation-release-sessions.ts */
export { RELEASE_HAS_REMAINING_SESSIONS };
/** 해제 요청을 끝냈다는 감사 action(계약 11 §9-2) */
export const RELEASE_REQUEST_COMPLETED_AUDIT_ACTION = "release_request.completed";

/** 강사 알림을 누르면 가는 곳 — 강사 앱 「내 소속」(I27B). 승인·위임 알림과 같은 곳 */
const INSTRUCTOR_AFFILIATIONS_LINK = "/instructor/affiliations";

const DETAIL = {
  academyNotFound: "학원을 찾을 수 없어요",
  notFound: "소속 강사를 찾을 수 없어요",
  notActive: "소속 중인 강사만 해제할 수 있어요",
  unavailable: "고른 대체 강사에게 그 시간에 일정이 있어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청·응답 계약(08 §5) --------------------------------------------------------------------

/**
 * 요청 본문 — 남은 회차마다 처리(sessionDecisions)와 회원 알림 끝 한 줄(ownerNote). 남은 회차가 0 이면 비우거나 `{}`.
 * 모르는 칸은 422 로 막는다(조용히 버리면 대표가 고른 처리가 사라진다).
 */
export const releaseAffiliationRequestSchema = releaseBodySchema;

export const releasedAffiliationSchema = z.strictObject({
  status: z.literal("released"),
  /** 해제된 시각. 이미 해제된 소속을 다시 부르면 처음 해제 시각 그대로 */
  releasedAt: z.iso.datetime({ offset: true }),
  sessions: z.strictObject({ substituted: z.number().int(), cancelled: z.number().int(), closed: z.number().int() }),
  notified: z.strictObject({ memberCount: z.number().int(), notificationCount: z.number().int() }),
});
export type ReleasedAffiliation = z.infer<typeof releasedAffiliationSchema>;

// ---- 바깥에서 끼우는 「남은 회차 처리」 --------------------------------------------------------

/** 남은 회차 처리 함수의 모양 — 소속 행을 잠근 같은 트랜잭션(tx)으로 부른다 */
export type ApplyDecisions = typeof applyReleaseDecisions;

// ---- 도우미 ------------------------------------------------------------------------------------

export type AffiliationReleaseDeps = GuardDeps & {
  readonly clock: Clock;
  /** 빼면 진짜 처리(applyReleaseDecisions)를 쓴다. 테스트가 가짜를 끼울 때만 넣는다 */
  readonly applyDecisions?: ApplyDecisions;
};

type ReleaseParams = { params: Promise<{ academyId: string; id: string }> };

/** 경로 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다) */
function parsePathId(raw: string, detail: string): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new HttpError("NOT_FOUND", detail);
  return parsed.data;
}

/** 본문 읽기 — 비어 있으면 {} 로 본다. JSON 이 아니면 400, 모르는 칸이 있으면 422 */
async function readReleaseBody(request: Request): Promise<z.output<typeof releaseAffiliationRequestSchema>> {
  const text = await request.text();
  if (text.trim() === "") return parseWith(releaseAffiliationRequestSchema, {});
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
  }
  const checked = releaseAffiliationRequestSchema.safeParse(raw);
  // 실패 응답 모양(422 + fields)은 다른 경로와 같게 parseWith 로 만든다
  return checked.success ? checked.data : parseWith(releaseAffiliationRequestSchema, raw);
}

/** DB 시각 글자(마이크로초 6자리) → 다른 응답과 같은 ISO 모양 */
function toIso(dbText: string): string {
  return Temporal.Instant.from(dbText).toString();
}

/**
 * 이 학원의 그 소속 행을 잠그고 읽는다. 없거나 다른 학원 것이면 undefined —
 * 남의 학원에 그 강사가 「있는지」 알리지 않는다(승인·거절·위임 경로와 같은 규칙).
 */
async function lockAffiliation(tx: Tx, academyId: string, affiliationId: string) {
  const [row] = await tx.query(
    tx.raw.sql`SELECT status, instructor_account_id,
                      (SELECT display_name FROM staff_accounts WHERE id = instructor_account_id) AS instructor_name,
                      (SELECT name FROM academies WHERE id = academy_id) AS academy_name,
                      COALESCE(to_char(released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS released_at
               FROM instructor_affiliations
               WHERE id = ${affiliationId}::uuid AND academy_id = ${academyId}::uuid
               FOR UPDATE`
      .returnsRow({
        status: "pg/text@1",
        instructor_account_id: "pg/uuid@1",
        instructor_name: "pg/text@1",
        academy_name: "pg/text@1",
        released_at: "pg/text@1",
      })
      .build(),
  );
  return row;
}

/** 위임 행을 모두 지운다 — 지우기 전 권한 목록을 돌려줘 감사 before 에 남긴다 */
async function deleteDelegations(tx: Tx, affiliationId: string): Promise<string[]> {
  const rows = await tx.query(
    tx.raw.sql`DELETE FROM instructor_delegations WHERE affiliation_id = ${affiliationId}::uuid RETURNING permission`
      .returnsRow({ permission: "pg/text@1" })
      .build(),
  );
  return rows.map((r) => r.permission).sort();
}

/** 감사 1행 — 상태 전후와 지운 위임을 남긴다(누가 언제 내보냈는지) */
async function writeReleaseAudit(
  tx: Tx,
  input: {
    ownerId: string;
    academyId: string;
    affiliationId: string;
    removedPermissions: readonly string[];
    nowIso: string;
    initiatedBy: "owner" | "instructor";
    applied: ApplyResult;
  },
): Promise<void> {
  const before = { status: "active", permissions: input.removedPermissions };
  // 남은 회차 처리 결과도 남긴다 — 같은 소속을 다시 해제하면 이 값으로 처음 응답을 다시 만든다
  const after = {
    status: "released",
    releasedAt: input.nowIso,
    initiatedBy: input.initiatedBy,
    permissions: [],
    sessions: input.applied.sessions,
    notified: input.applied.notified,
  };
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, academy_id, action, target_table, target_id,
                                       before, after, occurred_at)
               VALUES (uuidv7(), 'staff', ${input.ownerId}::uuid, ${input.academyId}::uuid, ${AFFILIATION_RELEASED_AUDIT_ACTION},
                       'instructor_affiliations', ${input.affiliationId}::uuid,
                       ${JSON.stringify(before)}::json, ${JSON.stringify(after)}::json, ${input.nowIso}::timestamptz)`
      .affectedCount()
      .build(),
  );
}

/**
 * 해제된 강사에게 알림 1건(`release_completed`, category `operations`, 계약 11 의 알림 표).
 * 중복 키 `release:<소속id>:completed` — 한 소속은 한 번만 해제되므로 소속 id 로 충분하다.
 */
async function notifyInstructor(
  tx: Tx,
  input: { instructorId: string; academyId: string; affiliationId: string; nowIso: string; initiatedBy: "owner" | "instructor" },
) {
  const [academy] = await tx.query(
    tx.raw.sql`SELECT name FROM academies WHERE id = ${input.academyId}::uuid`.returnsRow({ name: "pg/text@1" }).build(),
  );
  const academyName = academy?.name ?? "";
  const payload = {
    affiliationId: input.affiliationId,
    academyId: input.academyId,
    academyName,
    releasedAt: input.nowIso,
    initiatedBy: input.initiatedBy,
    title: `${academyName} 소속이 해제됐어요`,
    body: "이 학원의 시간표와 공지는 더 이상 보이지 않아요. 지난 정산 내역은 계속 볼 수 있어요.",
    actionLabel: "내 소속 보기",
    link: INSTRUCTOR_AFFILIATIONS_LINK,
  };
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               VALUES (uuidv7(), ${input.instructorId}::uuid, ${input.academyId}::uuid, 'operations', 'release_completed',
                       ${`release:${input.affiliationId}:completed`}, ${JSON.stringify(payload)}::jsonb)
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/**
 * 이 소속에 열린 해제 요청(강사가 시작, §3-3)이 있으면 completed 로 닫고 감사 `release_request.completed` 를 남긴다.
 * 열린 요청이 있었으면 true — 그때 해제의 시작은 강사다(release_initiated_by = instructor).
 */
async function completeOpenRequest(tx: Tx, input: { ownerId: string; academyId: string; affiliationId: string; nowIso: string }): Promise<boolean> {
  const rows = await tx.query(
    tx.raw.sql`UPDATE affiliation_release_requests
               SET status = 'completed', resolved_at = ${input.nowIso}::timestamptz, resolved_by_account_id = ${input.ownerId}::uuid
               WHERE affiliation_id = ${input.affiliationId}::uuid AND status = 'requested'
               RETURNING id::text AS id`
      .returnsRow({ id: "pg/text@1" })
      .build(),
  );
  for (const row of rows) {
    await tx.execute(
      tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, academy_id, action, target_table, target_id, before, after, occurred_at)
                 VALUES (uuidv7(), 'staff', ${input.ownerId}::uuid, ${input.academyId}::uuid, ${RELEASE_REQUEST_COMPLETED_AUDIT_ACTION},
                         'affiliation_release_requests', ${row.id}::uuid, ${JSON.stringify({ status: "requested" })}::json,
                         ${JSON.stringify({ status: "completed" })}::json, ${input.nowIso}::timestamptz)`
        .affectedCount()
        .build(),
    );
  }
  return rows.length > 0;
}

/** 이미 해제된 소속의 처음 응답 — 감사 affiliation.released 의 after 에 남긴 처리 결과로 다시 만든다(옛 M1 기록이면 0) */
async function readReleasedBody(tx: Tx, affiliationId: string, releasedAt: string): Promise<ReleasedAffiliation> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT COALESCE(after::text, '{}') AS after FROM audit_logs
               WHERE action = ${AFFILIATION_RELEASED_AUDIT_ACTION} AND target_id = ${affiliationId}::uuid
               ORDER BY occurred_at DESC LIMIT 1`
      .returnsRow({ after: "pg/text@1" })
      .build(),
  );
  const saved = z
    .object({
      sessions: releasedAffiliationSchema.shape.sessions.catch({ substituted: 0, cancelled: 0, closed: 0 }),
      notified: releasedAffiliationSchema.shape.notified.catch({ memberCount: 0, notificationCount: 0 }),
    })
    .parse(JSON.parse(row?.after ?? "{}"));
  return { status: "released", releasedAt: toIso(releasedAt), ...saved };
}

// ---- 경로 ----------------------------------------------------------------------------------------

/**
 * `POST /api/academies/{academyId}/affiliations/{id}/release` — 대표가 소속 강사를 해제한다(W3b · W3b2 · O39 · O39B).
 * 검사 순서: 권한(가드) → Idempotency-Key → 본문 → 경로 id.
 * 한 트랜잭션: 소속 행 잠금 → 없음·다른 학원 404 / 이미 released 면 같은 본문 200 / active 아님 409
 *              → 남은 회차 처리(정하지 않은 회차가 있으면 409 + undecided · 대체·휴강·폐강 · 회원마다 알림 1건)
 *              → active → released → 위임 행 삭제 → 열린 해제 요청 completed → 감사 `affiliation.released` → 강사 알림 `release_completed`.
 * 하나라도 실패하면 전부 되돌린다 — 회차만 바뀌고 소속은 그대로인 반쪽 상태가 남지 않게.
 */
export function createReleaseAffiliationRoute(deps: AffiliationReleaseDeps) {
  const consoleRoute = createConsoleRoute(deps);
  const applyDecisions = deps.applyDecisions ?? applyReleaseDecisions;
  return consoleRoute<ReleaseParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (request, context, staff) => {
      readIdempotencyKey(request, { required: true });
      const body = await readReleaseBody(request);
      const params = await context.params;
      const academyId = parsePathId(params.academyId, DETAIL.academyNotFound);
      const affiliationId = parsePathId(params.id, DETAIL.notFound);
      const now = deps.clock();
      const nowIso = now.toString();

      const result = await deps.db
        .transaction(async (tx): Promise<ReleasedAffiliation> => {
          const affiliation = await lockAffiliation(tx, academyId, affiliationId);
          if (affiliation === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
          // 이미 해제됨 — 아무것도 쓰지 않고 처음과 같은 본문(두 번 눌러도 기록이 하나)
          if (affiliation.status === "released" && affiliation.released_at !== "") {
            return readReleasedBody(tx, affiliationId, affiliation.released_at);
          }
          // 대기·거절·철회는 해제할 소속이 아니다
          if (affiliation.status !== "active") throw HttpError.conflict("AFFILIATION_STATE_CONFLICT", DETAIL.notActive);

          // 남은 회차를 정한 대로 처리한다 — 정하지 않은 회차가 있으면 409(회원 예약이 걸린 회차를 처리 없이 남기지 않으려는 것)
          const applied = await applyDecisions(tx, {
            academyId,
            academyName: affiliation.academy_name,
            affiliationId,
            instructorAccountId: affiliation.instructor_account_id,
            instructorName: affiliation.instructor_name,
            ownerId: staff.staffAccountId,
            body,
            now,
          });

          // 강사가 먼저 요청했으면 그 요청을 닫고, 해제의 시작을 강사로 남긴다(계약 11 §3-3 → §9)
          const fromRequest = await completeOpenRequest(tx, { ownerId: staff.staffAccountId, academyId, affiliationId, nowIso });
          const initiatedBy = fromRequest ? "instructor" : "owner";
          await tx.execute(
            tx.raw.sql`UPDATE instructor_affiliations
                       SET status = 'released', released_at = ${nowIso}::timestamptz, release_initiated_by = ${initiatedBy},
                           release_requested_at = NULL, updated_at = ${nowIso}::timestamptz
                       WHERE id = ${affiliationId}::uuid`
              .affectedCount()
              .build(),
          );
          // 위임을 남겨 두면 가드가 active 소속만 보더라도 표에 「켜진 권한」이 남는다 — 이 표는 「지금 켜진 위임」만 두는 곳이다
          const removedPermissions = await deleteDelegations(tx, affiliationId);
          await writeReleaseAudit(tx, {
            ownerId: staff.staffAccountId,
            academyId,
            affiliationId,
            removedPermissions,
            nowIso,
            initiatedBy,
            applied,
          });
          await notifyInstructor(tx, { instructorId: affiliation.instructor_account_id, academyId, affiliationId, nowIso, initiatedBy });

          return { status: "released", releasedAt: nowIso, ...applied };
        })
        .catch((error: unknown) => {
          // 앱 판정 뒤 같은 순간에 대체 강사 일정이 생겼으면 DB EXCLUDE 가 막는다 — 같은 409 로 바꾼다
          if (isInstructorOverlap(error)) throw HttpError.conflict(SUBSTITUTE_UNAVAILABLE, DETAIL.unavailable);
          throw error;
        });

      return Response.json(result, { status: 200, headers: NO_STORE });
    },
  );
}
