// S2-3.4(대타 요청 흐름) — 요청(I14) → 후보가 수락(I14C) → 대표 확인(O21B) → 수강생 공지 순으로 대타가 정해진다.
//   계약: _workspace/03_contracts/11-instructor.md §7(알림 종류) · §8(대타) — 경로 8개를 이 파일 하나가 만든다
//   데이터: data-model §8-5(substitute_requests · substitute_request_candidates · session_changes) · §8-7(알림 종류)
//   요구: FR-060(대타 요청) · I-10(정산은 실제로 수업한 강사 — 대표 확인 때 회차의 담당 강사 칸이 바뀐다)
//   수용: 플랜 S2-3 ① 같은 시간에 일정이 있는 강사는 후보로 고를 수 없다 ② 먼저 수락한 강사로 정해지고 대표 확인 전에는 취소할 수 있다
//
// 상태 흐름(substitute_requests.status):
//   open ──수락(먼저 온 한 명)──▶ accepted ──대표 확인──▶ confirmed
//    │                              │
//    └──요청한 강사가 취소──────────┴──▶ cancelled       (시작 시각이 지나면 expired — S2-3.11 시간 작업)
//
// 「먼저 온 한 명」은 잠금 없이 한 문장으로 정한다:
//   UPDATE substitute_requests SET status='accepted', … WHERE id=$1 AND status='open'
//   두 후보가 동시에 눌러도 PostgreSQL 이 같은 행 갱신을 줄 세우므로, 뒤에 온 쪽은 이미 accepted 인 행을 보고 0행이 된다 → 409.
//
// 이 파일이 하지 않는 것: 시작 시각이 지난 요청 expired 처리(S2-3.11) · 앱 화면(S2-3.8) · 대표 앱 O21B 화면(S2-3.10) ·
//   소속 해제 때 대표가 바로 배정하는 대체 강사(§9, S2-3.6·S2-3.7 — 후보 판정 computeCandidates 는 같이 쓸 수 있다).
import { z } from "zod";

import { SUBSTITUTE_REQUEST_STATUSES } from "../../domain/constants";
import {
  SUBSTITUTE_MESSAGE_MAX,
  SUBSTITUTE_STEPS,
  instructorChangedMessage,
  substituteAcceptedMessage,
} from "../../domain/substitute-request";
import { systemClock, type Clock } from "../../domain/time";
import { createGuards, type GuardDeps, type StaffAccountContext } from "../guards";
import { HttpError, parseJsonBody, readIdempotencyKey, withRoute } from "../http";
import { createClassAccess } from "./class-registration";
import { lockScheduleOwners, toScheduleConflictFromDb } from "./class-schedule-conflicts";
import {
  computeCandidates,
  displayNameOf,
  listRequests,
  lockSession,
  memberCountOf,
  readCandidateStatus,
  readCandidates,
  readRequest,
  readSessionInfo,
  substituteRequestListSchema,
  type RequestRow,
  type SessionInfo,
} from "./substitute-request-queries";
import type { Tx } from "./staff-signup";
import type { Db } from "../../../prisma/db";

// ---- 사람이 읽는 문장 --------------------------------------------------------------------------

const DETAIL = {
  sessionNotFound: "회차를 찾을 수 없어요",
  requestNotFound: "대타 요청을 찾을 수 없어요",
  instructorOnly: "강사 계정으로만 대타를 요청·수락할 수 있어요",
  notMySession: "내가 맡은 회차만 대타를 요청할 수 있어요",
  candidatesForbidden: "이 회차의 대타 후보를 볼 권한이 없어요",
  affiliation: "이 학원 소속 강사만 대타를 요청할 수 있어요",
  notCandidate: "이 요청의 후보가 아니에요",
  notRequester: "요청한 강사만 취소할 수 있어요",
  started: "이미 시작한 회차예요",
  notScheduled: "이미 휴강·폐강한 회차예요",
  candidateInvalid: "고를 수 없는 후보가 있어요. 후보 목록을 다시 불러 주세요",
  requestOpen: "이 회차에는 이미 진행 중인 대타 요청이 있어요",
  closed: "다른 강사가 먼저 수락했거나 끝난 요청이에요",
  busy: "그 시간에 일정이 있어요",
  alreadyConfirmed: "대표가 이미 확인한 대타는 취소할 수 없어요",
  notAccepted: "아직 수락한 강사가 없어요",
  unavailable: "대타 강사가 그 시간에 다른 일정이 생겼어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const idSchema = z.uuid();

// ---- 요청 본문 · 응답 모양(계약 11 §8) — 테스트가 이 스키마로 응답을 parse 한다 ---------------------------

export const substituteRequestBodySchema = z.strictObject({
  sessionId: z.uuid(),
  candidateAccountIds: z.array(z.uuid()).min(1, "후보를 한 명 이상 골라 주세요").max(50),
  message: z.string().trim().max(SUBSTITUTE_MESSAGE_MAX, `전할 말은 ${SUBSTITUTE_MESSAGE_MAX}자까지예요`).nullish(),
});
/** 수락·거절·취소·확인은 본문이 비어 있다({}) */
const emptyBodySchema = z.strictObject({});

export const substituteCandidatesSchema = z.strictObject({
  sessionId: z.string(),
  items: z.array(
    z.strictObject({
      accountId: z.string(),
      displayName: z.string(),
      genre: z.string(),
      available: z.boolean(),
      unavailableReason: z.literal("busy").nullable(),
    }),
  ),
});
export const substituteRequestCreatedSchema = z.strictObject({
  requestId: z.string(),
  sessionId: z.string(),
  status: z.string(),
  candidates: z.array(z.strictObject({ accountId: z.string(), displayName: z.string(), status: z.string() })),
  steps: z.array(z.enum(SUBSTITUTE_STEPS)),
});
export const substituteAcceptedSchema = z.strictObject({
  requestId: z.string(),
  status: z.literal("accepted"),
  yourSession: z.strictObject({
    sessionId: z.string(),
    academyId: z.string(),
    classTitle: z.string(),
    startsAt: z.string(),
    endsAt: z.string(),
    roomName: z.string(),
  }),
});
export const substituteStatusSchema = z.strictObject({ requestId: z.string(), status: z.string() });
export const substituteConfirmedSchema = z.strictObject({
  requestId: z.string(),
  status: z.literal("confirmed"),
  session: z.strictObject({ sessionId: z.string(), instructor: z.strictObject({ accountId: z.string(), displayName: z.string() }) }),
  notifiedMemberCount: z.number().int(),
});
export { substituteRequestListSchema };

type Created = z.infer<typeof substituteRequestCreatedSchema>;
type Accepted = z.infer<typeof substituteAcceptedSchema>;
type Confirmed = z.infer<typeof substituteConfirmedSchema>;

// ---- 경로 공장 -----------------------------------------------------------------------------------

export type SubstituteRequestDeps = GuardDeps & { clock?: Clock };

type SessionParams = { params: Promise<{ sessionId: string }> };
type RequestParams = { params: Promise<{ requestId: string }> };
type AcademyParams = { params: Promise<{ academyId: string }> };
type ConfirmParams = { params: Promise<{ academyId: string; requestId: string }> };

export function createSubstituteRequestRoutes(deps: SubstituteRequestDeps) {
  const { readStaff } = createClassAccess(deps);
  const guards = createGuards(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;

  /** 강사 역할이 있는 직원만(대표 계정만 있는 사람은 403) */
  async function readInstructor(request: Request): Promise<StaffAccountContext> {
    const staff = await readStaff(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.instructorOnly);
    return staff;
  }

  /** 앱(Bearer)이면 app 면, 쿠키면 관리자 웹(2단계 필수) — 대표 경로 가드가 면을 보고 판정한다 */
  async function requireOwner(request: Request, academyId: string) {
    if (!idSchema.safeParse(academyId).success) throw new HttpError("NOT_FOUND", DETAIL.requestNotFound);
    const bearer = (request.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer ");
    return guards.requireStaff("owner", { academyId, surface: bearer ? "app" : "web", headers: request.headers });
  }

  async function loadSession(dbx: Db | Tx, sessionId: string): Promise<SessionInfo> {
    if (!idSchema.safeParse(sessionId).success) throw new HttpError("NOT_FOUND", DETAIL.sessionNotFound);
    const session = await readSessionInfo(dbx, sessionId);
    if (session === undefined) throw new HttpError("NOT_FOUND", DETAIL.sessionNotFound);
    return session;
  }

  async function loadRequest(dbx: Db | Tx, requestId: string, forUpdate = false): Promise<RequestRow> {
    if (!idSchema.safeParse(requestId).success) throw new HttpError("NOT_FOUND", DETAIL.requestNotFound);
    const row = await readRequest(dbx, requestId, forUpdate);
    if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.requestNotFound);
    return row;
  }

  /** 예정 상태 · 시작 전인 회차만 대타를 구한다 */
  function assertOpenSession(session: SessionInfo, now: Temporal.Instant): void {
    if (session.status !== "scheduled") throw HttpError.conflict("SESSION_NOT_SCHEDULED", DETAIL.notScheduled);
    if (Temporal.Instant.compare(Temporal.Instant.from(session.starts_at), now) <= 0) {
      throw HttpError.conflict("SESSION_ALREADY_STARTED", DETAIL.started);
    }
  }

  /** 강사가 지금 그 학원 active 소속인가(소속이 끝난 강사가 대타를 부탁하지 못하게) */
  async function assertActiveAffiliation(academyId: string, accountId: string): Promise<void> {
    const [aff] = await db.query(
      db.raw.sql`SELECT id::text AS id FROM instructor_affiliations
                 WHERE academy_id = ${academyId}::uuid AND instructor_account_id = ${accountId}::uuid AND status = 'active'`
        .returnsRow({ id: "pg/text@1" })
        .build(),
    );
    if (aff === undefined) throw HttpError.forbidden("AFFILIATION_REQUIRED", DETAIL.affiliation);
  }

  // ---- §8-1 후보 목록 -------------------------------------------------------------------------

  const candidates = withRoute<SessionParams>(async (request, context) => {
    const staff = await readStaff(request);
    const session = await loadSession(db, (await context.params).sessionId);
    // 그 회차 담당 강사 또는 그 학원 대표만 — 남의 회차 후보 목록(다른 강사의 바쁨 여부)을 엿보지 못하게
    const isOwner = staff.actor.ownedAcademyIds.includes(session.academy_id);
    if (!isOwner && session.instructor_id !== staff.staffAccountId) throw new HttpError("FORBIDDEN", DETAIL.candidatesForbidden);
    if (Temporal.Instant.compare(Temporal.Instant.from(session.starts_at), clock()) <= 0) {
      throw HttpError.conflict("SESSION_ALREADY_STARTED", DETAIL.started);
    }
    const items = await computeCandidates(db, session, session.instructor_id === "" ? null : session.instructor_id);
    return Response.json({ sessionId: session.session_id, items }, { headers: NO_STORE });
  });

  // ---- §8-2 요청 --------------------------------------------------------------------------------

  /** 요청 응답(201) — 처음 만들 때와 같은 키로 다시 보냈을 때 같은 모양 */
  async function createdBody(dbx: Db | Tx, row: Pick<RequestRow, "id" | "session_id" | "status">): Promise<Created> {
    return {
      requestId: row.id,
      sessionId: row.session_id,
      status: row.status,
      candidates: await readCandidates(dbx, row.id),
      steps: [...SUBSTITUTE_STEPS],
    };
  }

  async function findByKey(accountId: string, key: string): Promise<RequestRow | undefined> {
    const [row] = await db.query(
      db.raw.sql`SELECT id::text AS id FROM substitute_requests
                 WHERE requested_by_account_id = ${accountId}::uuid AND idempotency_key = ${key}`
        .returnsRow({ id: "pg/text@1" })
        .build(),
    );
    return row === undefined ? undefined : readRequest(db, row.id);
  }

  const create = withRoute<unknown>(async (request) => {
    const staff = await readInstructor(request);
    const key = readIdempotencyKey(request, { required: true });
    // 같은 키로 다시 왔으면 아무것도 쓰지 않고 처음 결과(README §5 — 본문이 달라도 처음 것)
    const replay = await findByKey(staff.staffAccountId, key);
    if (replay !== undefined) return Response.json(await createdBody(db, replay), { status: 201, headers: NO_STORE });

    const body = await parseJsonBody(request, substituteRequestBodySchema);
    const me = staff.staffAccountId;
    const session = await loadSession(db, body.sessionId);
    if (session.instructor_id !== me) throw new HttpError("FORBIDDEN", DETAIL.notMySession);
    await assertActiveAffiliation(session.academy_id, me);
    const now = clock();
    assertOpenSession(session, now);

    // 후보 자격을 요청 때 검사한다(계약 §8-2) — 같은 학원 소속 · 같은 장르 · 그 시간 비어 있음. 하나라도 아니면 422
    const wanted = [...new Set(body.candidateAccountIds)];
    const eligible = new Set((await computeCandidates(db, session, me)).filter((c) => c.available).map((c) => c.accountId));
    const invalidIds = wanted.filter((id) => !eligible.has(id));
    if (invalidIds.length > 0) {
      throw HttpError.unprocessable("SUBSTITUTE_CANDIDATE_INVALID", DETAIL.candidateInvalid, { accountIds: invalidIds });
    }
    const message = body.message == null || body.message === "" ? null : body.message;
    const members = await memberCountOf(db, session.offering_id);

    const result = await db
      .transaction(async (tx): Promise<Created> => {
        // 회차를 잠그고 다시 본다 — 그 사이 휴강·폐강됐으면 409
        await lockSession(tx, session.session_id);
        const fresh = await loadSession(tx, session.session_id);
        assertOpenSession(fresh, now);
        if (fresh.instructor_id !== me) throw new HttpError("FORBIDDEN", DETAIL.notMySession);

        const [inserted] = await tx.query(
          tx.raw.sql`INSERT INTO substitute_requests (id, session_id, requested_by_account_id, message, idempotency_key, created_at)
                     VALUES (uuidv7(), ${session.session_id}::uuid, ${me}::uuid, NULLIF(${message ?? ""}, ''), ${key}, ${now.toString()}::timestamptz)
                     RETURNING id::text AS id`
            .returnsRow({ id: "pg/text@1" })
            .build(),
        );
        if (inserted === undefined) throw new Error("대타 요청을 쓰지 못했다");
        const requestId = inserted.id;

        // 후보마다 한 줄 + 알림 substitute_requested(회차·수강생 수·전할 말 — 정산은 실제로 수업한 강사 몫)
        for (const candidateId of wanted) {
          await tx.execute(
            tx.raw.sql`INSERT INTO substitute_request_candidates (request_id, candidate_account_id)
                       VALUES (${requestId}::uuid, ${candidateId}::uuid)`
              .affectedCount()
              .build(),
          );
          await insertStaffNotification(tx, {
            recipient: candidateId,
            academyId: session.academy_id,
            category: "operations",
            kind: "substitute_requested",
            dedupeKey: `substitute:${requestId}:${candidateId}:requested`,
            payload: {
              requestId,
              sessionId: session.session_id,
              classId: session.class_id,
              classTitle: session.class_title,
              startsAt: session.starts_at,
              endsAt: session.ends_at,
              roomName: session.room_name,
              memberCount: members.total,
              message,
              settlementNote: "이 회차 정산은 실제로 수업한 강사 몫이에요",
            },
          });
        }
        await insertAudit(tx, me, "instructor", session.academy_id, "substitute.requested", "substitute_requests", requestId, {
          sessionId: session.session_id,
          candidateAccountIds: wanted,
        });
        return createdBody(tx, { id: requestId, session_id: session.session_id, status: "open" });
      })
      .catch(async (error: unknown) => {
        // 회차당 열린 요청은 하나(uq_substitute_active) — 둘째는 409
        if (isUniqueViolation(error, "uq_substitute_active")) throw HttpError.conflict("SUBSTITUTE_REQUEST_OPEN", DETAIL.requestOpen);
        // 같은 키 두 요청이 동시에 왔다 — 먼저 들어간 쪽 결과로 수렴한다
        if (isUniqueViolation(error, "uq_substitute_idem")) {
          const raced = await findByKey(me, key);
          if (raced !== undefined) return createdBody(db, raced);
        }
        throw error;
      });
    return Response.json(result, { status: 201, headers: NO_STORE });
  });

  // ---- §8-2 수락(먼저 온 한 명) ---------------------------------------------------------------------

  function acceptedBody(row: RequestRow, session: SessionInfo): Accepted {
    return {
      requestId: row.id,
      status: "accepted",
      // 그 회차가 내 캘린더 후보로 보이게 하는 값(학원 색은 앱이 academyId 로 고른다)
      yourSession: {
        sessionId: session.session_id,
        academyId: session.academy_id,
        classTitle: session.class_title,
        startsAt: session.starts_at,
        endsAt: session.ends_at,
        roomName: session.room_name,
      },
    };
  }

  const accept = withRoute<RequestParams>(async (request, context) => {
    const staff = await readInstructor(request);
    const me = staff.staffAccountId;
    const row = await loadRequest(db, (await context.params).requestId);
    await parseJsonBody(request, emptyBodySchema);
    if ((await readCandidateStatus(db, row.id, me)) === undefined) throw new HttpError("FORBIDDEN", DETAIL.notCandidate);
    const session = await loadSession(db, row.session_id);

    // 이미 내가 수락한 요청이면 같은 본문(두 번 눌러도 대표 알림이 두 번 가지 않는다)
    if (row.status === "accepted" && row.accepted_by === me) return Response.json(acceptedBody(row, session), { headers: NO_STORE });
    if (row.status !== "open") throw HttpError.conflict("SUBSTITUTE_REQUEST_CLOSED", DETAIL.closed);
    const now = clock();
    assertOpenSession(session, now);

    const result = await db.transaction(async (tx): Promise<Accepted> => {
      // 내 일정 잠금(수업 등록과 같은 열쇠 instructor:<id>) → 그 사이 같은 시간에 일정이 생겼는지 다시 본다
      await lockScheduleOwners(tx, me, null);
      const mine = (await computeCandidates(tx, session, row.requested_by)).find((c) => c.accountId === me);
      if (mine === undefined || !mine.available) {
        // 수락자 본인에게는 이유를 그대로 보인다(계약 §8-2)
        throw HttpError.conflict("SCHEDULE_CONFLICT", DETAIL.busy, { conflicts: [], suggestions: [] });
      }

      // 먼저 온 한 명 — 조건부 갱신 한 문장. 0행이면 다른 후보가 먼저 수락했거나 요청이 끝났다
      const won = await tx.execute(
        tx.raw.sql`UPDATE substitute_requests
                   SET status = 'accepted', accepted_candidate_account_id = ${me}::uuid, accepted_at = ${now.toString()}::timestamptz
                   WHERE id = ${row.id}::uuid AND status = 'open'`
          .affectedCount()
          .build(),
      );
      if (won.affectedRows === 0) {
        const after = await readRequest(tx, row.id);
        if (after !== undefined && after.status === "accepted" && after.accepted_by === me) return acceptedBody(after, session);
        throw HttpError.conflict("SUBSTITUTE_REQUEST_CLOSED", DETAIL.closed);
      }

      // 나는 accepted, 아직 답하지 않은 다른 후보는 closed(그 사람 화면에서 「다른 강사가 먼저 수락했어요」)
      await tx.execute(
        tx.raw.sql`UPDATE substitute_request_candidates
                   SET status = CASE WHEN candidate_account_id = ${me}::uuid THEN 'accepted' ELSE 'closed' END,
                       responded_at = CASE WHEN candidate_account_id = ${me}::uuid THEN ${now.toString()}::timestamptz ELSE responded_at END
                   WHERE request_id = ${row.id}::uuid AND (candidate_account_id = ${me}::uuid OR status = 'invited')`
          .affectedCount()
          .build(),
      );

      // 대표 알림(O21B 「대타」 — 승인 칩). 확인하면 몇 명에게 알림이 가는지 함께 보인다
      const members = await memberCountOf(tx, session.offering_id);
      await insertOwnerNotifications(tx, session.academy_id, {
        category: "approval",
        kind: "substitute_accepted",
        dedupeKey: `substitute:${row.id}:accepted`,
        payload: {
          requestId: row.id,
          sessionId: session.session_id,
          classId: session.class_id,
          classTitle: session.class_title,
          startsAt: session.starts_at,
          substituteAccountId: me,
          body: substituteAcceptedMessage(staff.displayName, members.total),
        },
      });
      await insertAudit(tx, me, "instructor", session.academy_id, "substitute.accepted", "substitute_requests", row.id, { acceptedBy: me });
      const after = await readRequest(tx, row.id);
      if (after === undefined) throw new Error("수락한 요청을 다시 읽지 못했다");
      return acceptedBody(after, session);
    });
    return Response.json(result, { headers: NO_STORE });
  });

  // ---- §8-2 거절 · 취소 ------------------------------------------------------------------------------

  const decline = withRoute<RequestParams>(async (request, context) => {
    const staff = await readInstructor(request);
    const me = staff.staffAccountId;
    const row = await loadRequest(db, (await context.params).requestId);
    await parseJsonBody(request, emptyBodySchema);
    const mine = await readCandidateStatus(db, row.id, me);
    if (mine === undefined) throw new HttpError("FORBIDDEN", DETAIL.notCandidate);
    if (mine === "declined") return Response.json({ requestId: row.id, status: "declined" }, { headers: NO_STORE });
    if (row.status !== "open" || mine !== "invited") throw HttpError.conflict("SUBSTITUTE_REQUEST_CLOSED", DETAIL.closed);
    // 그 후보의 상태만 바꾼다. 모두 거절해도 요청은 open 으로 남는다(요청한 강사가 취소하거나 시작 시각이 지나 expired)
    await db.execute(
      db.raw.sql`UPDATE substitute_request_candidates SET status = 'declined', responded_at = ${clock().toString()}::timestamptz
                 WHERE request_id = ${row.id}::uuid AND candidate_account_id = ${me}::uuid AND status = 'invited'`
        .affectedCount()
        .build(),
    );
    return Response.json({ requestId: row.id, status: "declined" }, { headers: NO_STORE });
  });

  const cancel = withRoute<RequestParams>(async (request, context) => {
    const staff = await readInstructor(request);
    const me = staff.staffAccountId;
    const { requestId } = await context.params;
    const first = await loadRequest(db, requestId);
    await parseJsonBody(request, emptyBodySchema);
    if (first.requested_by !== me) throw new HttpError("FORBIDDEN", DETAIL.notRequester);
    const now = clock();

    const result = await db.transaction(async (tx) => {
      // 대표 확인과 동시에 와도 하나씩 — 요청 행을 잠그고 다시 본다
      const row = await loadRequest(tx, requestId, true);
      if (row.status === "cancelled") return { requestId: row.id, status: "cancelled" };
      // 대표가 확인한 뒤에는 회차 강사가 이미 바뀌고 수강생에게 알림이 갔다 — 되돌리지 않는다(I14B)
      if (row.status === "confirmed") throw HttpError.conflict("SUBSTITUTE_ALREADY_CONFIRMED", DETAIL.alreadyConfirmed);
      if (row.status !== "open" && row.status !== "accepted") throw HttpError.conflict("SUBSTITUTE_REQUEST_CLOSED", DETAIL.closed);
      await tx.execute(
        tx.raw.sql`UPDATE substitute_requests SET status = 'cancelled', cancelled_at = ${now.toString()}::timestamptz
                   WHERE id = ${row.id}::uuid AND status IN ('open', 'accepted')`
          .affectedCount()
          .build(),
      );
      await tx.execute(
        tx.raw.sql`UPDATE substitute_request_candidates SET status = 'closed'
                   WHERE request_id = ${row.id}::uuid AND status IN ('invited', 'accepted')`
          .affectedCount()
          .build(),
      );
      const session = await readSessionInfo(tx, row.session_id);
      await insertAudit(tx, me, "instructor", session?.academy_id ?? null, "substitute.cancelled", "substitute_requests", row.id, {
        before: row.status,
      });
      return { requestId: row.id, status: "cancelled" };
    });
    return Response.json(result, { headers: NO_STORE });
  });

  // ---- §8-2 대표 확인 → 회차 강사 교체 + 수강생 공지 -------------------------------------------------------

  /** 이미 확인된 요청의 응답 — 그때 쓴 변경 기록(session_changes)에서 알린 수강생 수를 읽는다 */
  async function confirmedBody(dbx: Db | Tx, row: RequestRow): Promise<Confirmed> {
    const [change] = await dbx.query(
      dbx.raw.sql`SELECT notified_member_count::int4 AS n FROM session_changes
                  WHERE session_id = ${row.session_id}::uuid AND kind = 'instructor_changed' AND after->>'requestId' = ${row.id}
                  ORDER BY created_at DESC LIMIT 1`
        .returnsRow({ n: "pg/int4@1" })
        .build(),
    );
    return {
      requestId: row.id,
      status: "confirmed",
      session: { sessionId: row.session_id, instructor: { accountId: row.accepted_by, displayName: await displayNameOf(dbx, row.accepted_by) } },
      notifiedMemberCount: change?.n ?? 0,
    };
  }

  const confirm = withRoute<ConfirmParams>(async (request, context) => {
    const { academyId, requestId } = await context.params;
    const owner = await requireOwner(request, academyId);
    const first = await loadRequest(db, requestId);
    await parseJsonBody(request, emptyBodySchema);
    const session = await loadSession(db, first.session_id);
    // 다른 학원의 요청을 이 학원 경로로 부르면 없는 요청으로 본다
    if (session.academy_id !== academyId) throw new HttpError("NOT_FOUND", DETAIL.requestNotFound);
    const ownerId = owner.staffAccountId;
    const now = clock();

    const result = await db
      .transaction(async (tx): Promise<Confirmed> => {
        const row = await loadRequest(tx, requestId, true);
        if (row.status === "confirmed") return confirmedBody(tx, row);
        if (row.status === "open") throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.notAccepted);
        if (row.status !== "accepted") throw HttpError.conflict("SUBSTITUTE_REQUEST_CLOSED", DETAIL.closed);
        const substituteId = row.accepted_by;

        // 대타 강사의 일정 잠금 → 회차 잠금 → 그 사이 일정이 생겼는지 다시 본다(앱 판정). 마지막은 DB EXCLUDE 가 막는다
        await lockScheduleOwners(tx, substituteId, null);
        await lockSession(tx, row.session_id);
        const fresh = await loadSession(tx, row.session_id);
        assertOpenSession(fresh, now);
        const still = (await computeCandidates(tx, fresh, fresh.instructor_id === "" ? null : fresh.instructor_id)).find(
          (c) => c.accountId === substituteId,
        );
        if (still === undefined || !still.available) throw HttpError.conflict("SUBSTITUTE_UNAVAILABLE", DETAIL.unavailable);

        // ① 회차의 담당 강사를 대타 강사로 — 정산(S5-1)은 이 칸을 읽어 「실제로 수업한 강사」 몫으로 잡는다(I-10)
        await tx.execute(
          tx.raw.sql`UPDATE class_sessions SET instructor_account_id = ${substituteId}::uuid
                     WHERE id = ${row.session_id}::uuid AND status = 'scheduled'`
            .affectedCount()
            .build(),
        );
        // ② 요청 확정
        await tx.execute(
          tx.raw.sql`UPDATE substitute_requests
                     SET status = 'confirmed', confirmed_by_account_id = ${ownerId}::uuid, confirmed_at = ${now.toString()}::timestamptz
                     WHERE id = ${row.id}::uuid AND status = 'accepted'`
            .affectedCount()
            .build(),
        );

        // ③ 변경 기록(instructor_changed) — 전후 강사. 알린 수강생 수를 같이 남긴다(같은 요청을 다시 확인하면 이 값을 돌려준다)
        const members = await memberCountOf(tx, fresh.offering_id);
        const substituteName = await displayNameOf(tx, substituteId);
        const beforeJson = JSON.stringify({ instructorAccountId: fresh.instructor_id === "" ? null : fresh.instructor_id });
        const afterJson = JSON.stringify({ instructorAccountId: substituteId, instructorName: substituteName, requestId: row.id });
        const [change] = await tx.query(
          tx.raw.sql`INSERT INTO session_changes (id, class_id, session_id, kind, before, after, changed_by_account_id, notified_member_count, created_at)
                     VALUES (uuidv7(), ${fresh.class_id}::uuid, ${fresh.session_id}::uuid, 'instructor_changed', ${beforeJson}::jsonb,
                             ${afterJson}::jsonb, ${ownerId}::uuid, ${members.total}, ${now.toString()}::timestamptz)
                     RETURNING id::text AS id`
            .returnsRow({ id: "pg/text@1" })
            .build(),
        );
        if (change === undefined) throw new Error("변경 기록을 쓰지 못했다");

        // ④ 그 회차 결제 확정 수강생마다 알림 1건(「이번 회차는 김하나 강사가 진행해요」)
        const memberPayload = JSON.stringify({
          requestId: row.id,
          changeId: change.id,
          classId: fresh.class_id,
          sessionId: fresh.session_id,
          classTitle: fresh.class_title,
          startsAt: fresh.starts_at,
          title: `강사 변경 · ${fresh.class_title}`,
          body: instructorChangedMessage(substituteName),
        });
        await tx.execute(
          tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, dedupe_key, payload)
                     SELECT uuidv7(), m.member_id, ${fresh.academy_id}::uuid, 'instructor_changed', ${`substitute:${row.id}:`} || m.member_id::text,
                            ${memberPayload}::jsonb
                     FROM (SELECT DISTINCT r.member_id FROM reservations r
                           WHERE r.offering_id = ${fresh.offering_id}::uuid AND r.status = 'confirmed') m
                     ON CONFLICT DO NOTHING`
            .affectedCount()
            .build(),
        );

        // ⑤ 요청한 강사 · 대타 강사에게 확정 알림
        for (const recipient of [row.requested_by, substituteId]) {
          await insertStaffNotification(tx, {
            recipient,
            academyId: fresh.academy_id,
            category: "operations",
            kind: "substitute_confirmed",
            dedupeKey: `substitute:${row.id}:confirmed:${recipient}`,
            payload: {
              requestId: row.id,
              sessionId: fresh.session_id,
              classId: fresh.class_id,
              classTitle: fresh.class_title,
              startsAt: fresh.starts_at,
              substituteAccountId: substituteId,
              body: `대표가 대타를 확인했어요 · ${instructorChangedMessage(substituteName)}`,
            },
          });
        }

        // ⑥ 감사 두 줄 — 회차 강사 변경 · 대타 확정
        await insertAudit(tx, ownerId, "owner", fresh.academy_id, "session.instructor_changed", "class_sessions", fresh.session_id, {
          instructorAccountId: substituteId,
        });
        await insertAudit(tx, ownerId, "owner", fresh.academy_id, "substitute.confirmed", "substitute_requests", row.id, {
          substituteAccountId: substituteId,
        });
        return {
          requestId: row.id,
          status: "confirmed",
          session: { sessionId: fresh.session_id, instructor: { accountId: substituteId, displayName: substituteName } },
          notifiedMemberCount: members.total,
        };
      })
      .catch((error: unknown) => {
        // 잠금을 거치지 않은 길과 부딪혀 DB EXCLUDE(ex_sessions_instructor)가 막았다
        if (toScheduleConflictFromDb(error) !== null) throw HttpError.conflict("SUBSTITUTE_UNAVAILABLE", DETAIL.unavailable);
        throw error;
      });
    return Response.json(result, { headers: NO_STORE });
  });

  // ---- 목록 두 개 -----------------------------------------------------------------------------------

  const statusFilter = z.enum(SUBSTITUTE_REQUEST_STATUSES);

  /** GET /api/instructor/substitute-requests?role=requested|received&status= — 내가 한 요청 · 받은 요청(I14B · I14C) */
  const listMine = withRoute<unknown>(async (request) => {
    const staff = await readInstructor(request);
    const params = new URL(request.url).searchParams;
    const query = z
      .object({ role: z.enum(["requested", "received"]).default("requested"), status: statusFilter.optional() })
      .safeParse({ role: params.get("role") ?? undefined, status: params.get("status") ?? undefined });
    if (!query.success) {
      throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", { fields: [{ path: "role", message: "role·status 값을 확인해 주세요" }] });
    }
    const items = await listRequests(db, { kind: query.data.role, accountId: staff.staffAccountId, status: query.data.status ?? null });
    return Response.json({ items }, { headers: NO_STORE });
  });

  /** GET /api/academies/{academyId}/substitute-requests?status=accepted — 대표 확인을 기다리는 대타(O21B) */
  const listAcademy = withRoute<AcademyParams>(async (request, context) => {
    const { academyId } = await context.params;
    await requireOwner(request, academyId);
    const raw = new URL(request.url).searchParams.get("status") ?? "accepted";
    const status = statusFilter.safeParse(raw);
    if (!status.success) {
      throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", { fields: [{ path: "status", message: "status 값을 확인해 주세요" }] });
    }
    const items = await listRequests(db, { kind: "academy", academyId, status: status.data });
    return Response.json({ items }, { headers: NO_STORE });
  });

  return { candidates, create, accept, decline, cancel, confirm, listMine, listAcademy };
}

// ---- 쓰기 도우미 ------------------------------------------------------------------------------

type StaffNotification = {
  recipient: string;
  academyId: string;
  category: "approval" | "operations";
  kind: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
};

/** 직원 한 명에게 알림 1행. 같은 열쇠(dedupe_key)면 두 번 쓰지 않는다. 발송은 커밋 뒤 S7-1 몫(pending 으로 남는다) */
async function insertStaffNotification(tx: Tx, n: StaffNotification): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               VALUES (uuidv7(), ${n.recipient}::uuid, ${n.academyId}::uuid, ${n.category}, ${n.kind}, ${n.dedupeKey},
                       ${JSON.stringify(n.payload)}::jsonb)
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/** 그 학원 active 대표 전원에게 알림 1행씩(대표가 여럿이면 각자의 알림함에) */
async function insertOwnerNotifications(tx: Tx, academyId: string, n: Omit<StaffNotification, "recipient" | "academyId">): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               SELECT uuidv7(), o.staff_account_id, o.academy_id, ${n.category}, ${n.kind}, ${n.dedupeKey}, ${JSON.stringify(n.payload)}::jsonb
               FROM academy_owners o
               WHERE o.academy_id = ${academyId}::uuid AND o.status = 'active'
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

async function insertAudit(
  tx: Tx,
  actorId: string,
  role: "owner" | "instructor",
  academyId: string | null,
  action: string,
  table: string,
  targetId: string,
  after: Record<string, unknown>,
): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, after)
               VALUES (uuidv7(), 'staff', ${actorId}::uuid, ${role}, NULLIF(${academyId ?? ""}, '')::uuid,
                       ${action}, ${table}, ${targetId}::uuid, ${JSON.stringify(after)}::json)`
      .affectedCount()
      .build(),
  );
}

/** 유니크 위반(23505)이 그 제약 때문인가 — 드라이버가 감싼 cause 를 따라 내려간다(제약 이름 끝에 해시가 붙어 앞부분으로 본다) */
function isUniqueViolation(error: unknown, constraintPrefix: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
    const e = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    const text = `${String(e.constraint ?? "")} ${String(e.message ?? "")}`;
    if ((e.code === "23505" || text.includes("duplicate key")) && text.includes(constraintPrefix)) return true;
    current = e.cause;
  }
  return false;
}
