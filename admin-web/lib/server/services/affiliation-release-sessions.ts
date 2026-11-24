// S2-3.6(소속 해제의 남은 회차 처리와 받는 회원 수) — 해제할 강사의 「남은 회차」를 읽고, 대표가 고른 처리(대체·휴강·폐강)를
// 미리 계산하거나 실제로 적용한다. 경로(route)는 academy-affiliation-release.ts(대표) · affiliation-release-preview.ts(미리 보기)에 있다.
//   계약: _workspace/03_contracts/11-instructor.md §9-1(release-preview) · §9-2(release) · §3-3(강사 쪽 요청도 같은 「남은 회차」)
//   데이터: data-model §8-5(session_changes — 같은 batch_id) · §8-7(알림 instructor_changed)
//   수용: S2-3 ⑤ 「받는 회원 M명」= 회차별 예약 회원의 중복 제거 수 · 세 회차를 예약한 회원도 알림 1건
//
// 흐름 한눈에:
//   readRemainingSessions  이 학원에서 이 강사가 맡은 「시작 전 · 예정」 회차 + 회차마다 결제 확정 예약 회원(이름)
//   checkDecisions         고른 처리와 남은 회차를 맞춘다(모르는 회차 422 · 대체 강사 소속·장르 아님 422)
//   buildReleasePreview    확인 창 숫자(묶음별 회원 · 합계 · undecided · canRelease) — 쓰지 않는다
//   applyReleaseDecisions  한 트랜잭션 안에서 회차마다 처리 → 변경 기록(같은 batch_id) → 대체 강사에게 배정 알림 → 회원마다 알림 1건
// 미리 보기와 실제 해제가 같은 읽기·같은 순수 함수(lib/domain/affiliation-release.ts)를 쓴다 — 창의 M명과 실제 알림 행 수가 같게.
//
// S2-3.7(대체 강사 배정 알림): 대체를 고른 회차마다 그 강사에게 substitute_assigned 1건을 같은 트랜잭션에 쓴다(수용 ⑥).
//   그 강사의 캘린더(일정)는 따로 행을 쓰지 않는다 — 일정은 회차의 담당 강사 칸(class_sessions.instructor_account_id)에서 읽으므로
//   회차의 강사를 바꾸는 순간 대체 강사의 일정에 들어가고 원래 강사의 일정에서 빠진다(계약 11 §9-2 · §13).
// 개인 레슨 수강권의 남은 회차는 S2-4(개인 레슨)가 표를 만든 뒤 더한다 — 지금은 늘 빈 목록이다(계약 §9-1).
import { z } from "zod";

import {
  bundleByAction,
  countDistinctMembers,
  findUndecided,
  groupByMember,
  RELEASE_CLOSE_REASON,
  RELEASE_SESSION_ACTIONS,
  releaseBundlePreview,
  releaseMemberMessage,
  substituteAssignedMessage,
  type DecidedSession,
  type ReleaseNoticeItem,
  type ReleaseSessionAction,
} from "../../domain/affiliation-release";
import { RELEASE_PASS_ACTIONS } from "../../domain/constants";
import { closureChoiceDeadline } from "../../domain/session-change";
import { HttpError } from "../http";
import { lockScheduleOwners } from "./class-schedule-conflicts";
import { closeClassIfEmpty } from "./session-changes";
import { computeCandidates, readSessionInfo } from "./substitute-request-queries";
import type { Tx } from "./staff-signup";
import type { Db } from "../../../prisma/db";

type Dbx = Db | Tx;

/** 남은 회차가 있을 때의 409 코드(계약 08 §5 · 11 §9 같은 코드) */
export const RELEASE_HAS_REMAINING_SESSIONS = "RELEASE_HAS_REMAINING_SESSIONS";
/** 고른 대체 강사에게 그 시간에 일정이 있다(계약 11 §9-2) */
export const SUBSTITUTE_UNAVAILABLE = "SUBSTITUTE_UNAVAILABLE";

const DETAIL = {
  validation: "입력값을 확인해 주세요",
  unknownSession: "해제할 강사의 남은 회차가 아니에요",
  needSubstitute: "대체 강사를 골라 주세요",
  notCandidate: "이 학원 소속이고 같은 장르인 강사만 대체 강사로 고를 수 있어요",
  unavailable: "고른 대체 강사에게 그 시간에 일정이 있어요",
  remaining: "아직 처리를 정하지 않은 남은 회차가 있어 해제할 수 없어요",
  privateLesson: "남은 개인 레슨 수강권이 아니에요",
  sessionMoved: "그 사이 회차가 바뀌었어요. 다시 확인해 주세요",
} as const;

// ---- 요청 본문(계약 11 §9-1 · §9-2) ----------------------------------------------------------

/** 한 번에 정할 수 있는 회차 수 상한 — 강사 한 명의 남은 회차가 이보다 많을 일은 없다(요청 크기 방어) */
const MAX_DECISIONS = 500;
/** 대표가 회원 알림 끝에 덧붙이는 한 줄(계약 §9-1 ownerNote) — 200자(해제 요청 한마디와 같은 길이) */
export const OWNER_NOTE_MAX = 200;

export const sessionDecisionSchema = z.strictObject({
  sessionId: z.uuid(),
  action: z.enum(RELEASE_SESSION_ACTIONS),
  /** substitute 일 때만 쓴다. 미리 보기에서는 비워도 되지만(canRelease=false) 해제에서는 422 */
  substituteAccountId: z.uuid().optional(),
});
export type SessionDecision = z.infer<typeof sessionDecisionSchema>;

export const privateLessonDecisionSchema = z.strictObject({
  passId: z.uuid(),
  action: z.enum(RELEASE_PASS_ACTIONS),
});

const decisionsShape = {
  sessionDecisions: z
    .array(sessionDecisionSchema)
    .max(MAX_DECISIONS)
    .default([])
    // 같은 회차를 두 번 정하면 어느 처리가 맞는지 알 수 없다
    .refine((list) => new Set(list.map((d) => d.sessionId)).size === list.length, { message: "같은 회차를 두 번 정했어요" }),
  privateLessonDecisions: z.array(privateLessonDecisionSchema).max(MAX_DECISIONS).default([]),
};

/** release-preview 본문 — 빈 본문({})이면 남은 것 목록만 받는다 */
export const releasePreviewBodySchema = z.strictObject(decisionsShape);
export type ReleasePreviewBody = z.output<typeof releasePreviewBodySchema>;

/** release 본문 — 남은 회차가 0 이면 비우거나 {} 로 보내도 된다(08 §5 의 M1 모양 그대로) */
export const releaseBodySchema = z.strictObject({
  ...decisionsShape,
  ownerNote: z.string().trim().min(1).max(OWNER_NOTE_MAX).optional(),
});
export type ReleaseBody = z.output<typeof releaseBodySchema>;

// ---- 응답 모양(계약 11 §9-1) ----------------------------------------------------------------

const payKindSchema = z.enum(["paid", "pass"]);

export const releasePreviewSchema = z.strictObject({
  affiliationId: z.string(),
  instructor: z.strictObject({ accountId: z.string(), displayName: z.string() }),
  remaining: z.strictObject({
    sessions: z.array(
      z.strictObject({
        sessionId: z.string(),
        classId: z.string(),
        classTitle: z.string(),
        startsAt: z.string(),
        endsAt: z.string(),
        roomName: z.string(),
        memberCount: z.number().int().nonnegative(),
        decision: z
          .strictObject({
            action: z.enum(RELEASE_SESSION_ACTIONS),
            substituteAccountId: z.string().nullable(),
            substituteName: z.string().nullable(),
            substituteAvailable: z.boolean().nullable(),
          })
          .nullable(),
      }),
    ),
    privateLessonPasses: z.array(z.never()),
  }),
  bundles: z.array(
    z.strictObject({
      action: z.enum(RELEASE_SESSION_ACTIONS),
      sessionCount: z.number().int().positive(),
      memberCount: z.number().int().nonnegative(),
      messagePreview: z.string(),
      members: z.array(z.strictObject({ displayName: z.string(), payKind: payKindSchema })),
    }),
  ),
  totals: z.strictObject({ memberCount: z.number().int().nonnegative(), notificationCount: z.number().int().nonnegative() }),
  undecided: z.array(z.string()),
  canRelease: z.boolean(),
});
export type ReleasePreview = z.infer<typeof releasePreviewSchema>;

// ---- 남은 회차 읽기 ----------------------------------------------------------------------------

export type RemainingMember = { memberId: string; displayName: string };

/** 해제할 강사의 남은 회차 한 줄. 시각은 「…Z」 글자 */
export type RemainingSession = {
  sessionId: string;
  classId: string;
  academyId: string;
  classTitle: string;
  startsAt: string;
  endsAt: string;
  roomName: string;
  /** 결제 확정(confirmed) 예약 회원 — 결제 대기·취소는 받지 않는다(계약 11 §6-1 과 같은 기준) */
  members: RemainingMember[];
};

export type RemainingQuery = { academyId: string; instructorAccountId: string; nowIso: string };

/**
 * 남은 회차 = 이 학원 수업 중 이 강사가 맡은(class_sessions.instructor_account_id) 「시작 전(starts_at > now) · 예정」 회차(계약 §9-1).
 * forUpdate 면 그 회차 행들을 잠근다 — 해제 중에 강사가 같은 회차를 휴강·변경하면 둘 중 하나가 뒤로 줄 선다.
 */
export async function readRemainingSessions(dbx: Dbx, query: RemainingQuery, forUpdate = false): Promise<RemainingSession[]> {
  const rows = await dbx.query(
    dbx.raw.sql`SELECT s.id::text AS session_id, c.id::text AS class_id, c.academy_id::text AS academy_id, c.title AS class_title,
                       to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                       to_char(s.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
                       COALESCE(r.name, '') AS room_name
                FROM class_sessions s
                JOIN class_offerings o ON o.id = s.offering_id
                JOIN classes c ON c.id = o.class_id
                LEFT JOIN rooms r ON r.id = s.room_id
                WHERE c.academy_id = ${query.academyId}::uuid
                  AND s.instructor_account_id = ${query.instructorAccountId}::uuid
                  AND s.status = 'scheduled'
                  AND s.starts_at > ${query.nowIso}::timestamptz
                ORDER BY s.starts_at, s.id`
      .returnsRow({
        session_id: "pg/text@1",
        class_id: "pg/text@1",
        academy_id: "pg/text@1",
        class_title: "pg/text@1",
        starts_at: "pg/text@1",
        ends_at: "pg/text@1",
        room_name: "pg/text@1",
      })
      .build(),
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.session_id).join(",");
  if (forUpdate) {
    await dbx.query(
      dbx.raw.sql`SELECT id::text AS id FROM class_sessions WHERE id::text = ANY(string_to_array(${ids}, ',')) ORDER BY id FOR UPDATE`
        .returnsRow({ id: "pg/text@1" })
        .build(),
    );
  }
  // 회차마다 받는 회원 — 예약은 판매 단위(offering)에 걸리므로 그 회차가 속한 판매 단위의 확정 예약 회원이다
  const memberRows = await dbx.query(
    dbx.raw.sql`SELECT DISTINCT s.id::text AS session_id, m.id::text AS member_id, m.name
                FROM class_sessions s
                JOIN reservations r ON r.offering_id = s.offering_id AND r.status = 'confirmed'
                JOIN members m ON m.id = r.member_id
                WHERE s.id::text = ANY(string_to_array(${ids}, ','))
                ORDER BY m.name, m.id::text`
      .returnsRow({ session_id: "pg/text@1", member_id: "pg/text@1", name: "pg/text@1" })
      .build(),
  );
  return rows.map((r) => ({
    sessionId: r.session_id,
    classId: r.class_id,
    academyId: r.academy_id,
    classTitle: r.class_title,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    roomName: r.room_name,
    members: memberRows.filter((m) => m.session_id === r.session_id).map((m) => ({ memberId: m.member_id, displayName: m.name })),
  }));
}

/**
 * 강사 쪽 해제 요청(S2-1.4, 계약 §3-3)이 쓰는 「남은 일 목록」 — 같은 읽기를 써서 강사 의향과 대표 화면의 회차가 같다.
 * 개인 레슨 수강권은 S2-4 전이라 늘 빈 목록.
 */
export async function listRemainingWorkFromDb(tx: Tx, query: RemainingQuery): Promise<{ sessionIds: string[]; passIds: string[] }> {
  const sessions = await readRemainingSessions(tx, query);
  return { sessionIds: sessions.map((s) => s.sessionId), passIds: [] };
}

// ---- 고른 처리 맞추기 ---------------------------------------------------------------------------

const invalid = (path: string, message: string): HttpError =>
  new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path, message }] });

/** 대체 강사 판정 결과 — 소속·장르가 맞으면 이름과 「그 시간이 비었나」 */
type SubstituteJudgement = { displayName: string; available: boolean };

/**
 * 고른 대체 강사가 그 회차의 후보인가(같은 학원 active 소속 · 같은 장르 · 해제할 강사 본인 아님) — 대타 후보 목록(S2-3.4)과 같은 함수.
 * 후보가 아니면 422, 후보면 그 시간의 빈 여부를 돌려준다(겹침 판정은 개인 일정까지 본다).
 */
async function judgeSubstitute(dbx: Dbx, sessionId: string, substituteAccountId: string, releasingId: string, path: string): Promise<SubstituteJudgement> {
  const info = await readSessionInfo(dbx, sessionId);
  if (info === undefined) throw invalid(path, DETAIL.unknownSession);
  const candidate = (await computeCandidates(dbx, info, releasingId)).find((c) => c.accountId === substituteAccountId);
  if (candidate === undefined) throw invalid(path, DETAIL.notCandidate);
  return { displayName: candidate.displayName, available: candidate.available };
}

/**
 * 고른 처리와 남은 회차를 맞춘다.
 *   남은 회차가 아닌 id → 422(다른 학원 회차·이미 지난 회차·남의 회차를 섞지 않게)
 *   남은 개인 레슨 수강권이 아닌 id → 422(S2-4 전에는 수강권이 없으므로 무엇을 보내도 422)
 */
function checkKnownIds(body: ReleasePreviewBody, remaining: readonly RemainingSession[]): void {
  const known = new Set(remaining.map((s) => s.sessionId));
  const bad = body.sessionDecisions.findIndex((d) => !known.has(d.sessionId));
  if (bad >= 0) throw invalid(`sessionDecisions.${bad}.sessionId`, DETAIL.unknownSession);
  if (body.privateLessonDecisions.length > 0) throw invalid("privateLessonDecisions.0.passId", DETAIL.privateLesson);
}

/** 회차마다 정한 처리 + 받는 회원 → 순수 함수가 읽는 모양 */
function toDecided(remaining: readonly RemainingSession[], decisions: readonly SessionDecision[]): DecidedSession[] {
  const byId = new Map(decisions.map((d) => [d.sessionId, d.action] as const));
  return remaining.flatMap((s) => {
    const action = byId.get(s.sessionId);
    return action === undefined ? [] : [{ sessionId: s.sessionId, action, memberIds: s.members.map((m) => m.memberId) }];
  });
}

/** 회차 한 줄 → 문구용 한 줄 */
function noticeItem(session: RemainingSession, action: ReleaseSessionAction, substituteName: string | null): ReleaseNoticeItem {
  return { classTitle: session.classTitle, startsAt: Temporal.Instant.from(session.startsAt), action, substituteName };
}

// ---- 미리 보기(쓰지 않는다) ----------------------------------------------------------------------

export type PreviewInput = {
  affiliationId: string;
  academyId: string;
  instructorAccountId: string;
  instructorName: string;
  body: ReleasePreviewBody;
  now: Temporal.Instant;
};

/** 확인 창(W3b · W3b2 · O39 · O39B · I28B)의 숫자를 계산한다. DB 에 아무것도 쓰지 않는다 */
export async function buildReleasePreview(dbx: Dbx, input: PreviewInput): Promise<ReleasePreview> {
  const remaining = await readRemainingSessions(dbx, {
    academyId: input.academyId,
    instructorAccountId: input.instructorAccountId,
    nowIso: input.now.toString(),
  });
  checkKnownIds(input.body, remaining);
  const decisionOf = new Map(input.body.sessionDecisions.map((d) => [d.sessionId, d] as const));

  // 대체 강사 이름·빈 여부 — 회차마다 판정한다(같은 강사라도 회차 시간이 다르면 결과가 다르다)
  const judged = new Map<string, SubstituteJudgement | null>();
  for (const [index, decision] of input.body.sessionDecisions.entries()) {
    if (decision.action !== "substitute" || decision.substituteAccountId === undefined) continue;
    const path = `sessionDecisions.${index}.substituteAccountId`;
    judged.set(decision.sessionId, await judgeSubstitute(dbx, decision.sessionId, decision.substituteAccountId, input.instructorAccountId, path));
  }

  const decided = toDecided(remaining, input.body.sessionDecisions);
  const sessionById = new Map(remaining.map((s) => [s.sessionId, s] as const));
  const nameOf = new Map(remaining.flatMap((s) => s.members.map((m) => [m.memberId, m.displayName] as const)));
  const memberCount = countDistinctMembers(decided.length > 0 ? decided : remaining.map((s) => ({ sessionId: s.sessionId, memberIds: s.members.map((m) => m.memberId) })));

  const bundles = bundleByAction(decided).map((bundle) => {
    const first = decided.find((d) => d.action === bundle.action);
    const firstSession = first === undefined ? undefined : sessionById.get(first.sessionId);
    if (firstSession === undefined) throw new Error("묶음의 첫 회차를 찾지 못했다");
    const substituteName = bundle.action === "substitute" ? (judged.get(firstSession.sessionId)?.displayName ?? null) : null;
    return {
      action: bundle.action,
      sessionCount: bundle.sessionCount,
      memberCount: bundle.memberIds.length,
      messagePreview: releaseBundlePreview(noticeItem(firstSession, bundle.action, substituteName), input.instructorName),
      // 이름만 내려간다(연락처 없음, FR-187). 수강권 결제는 S2-4 전이라 모두 「결제」
      members: bundle.memberIds.map((id) => ({ displayName: nameOf.get(id) ?? "", payKind: "paid" as const })),
    };
  });

  const undecided = findUndecided(
    remaining.map((s) => s.sessionId),
    input.body.sessionDecisions.map((d) => d.sessionId),
  );
  // 해제 버튼: 모두 정했고, 대체를 고른 회차는 대체 강사가 정해져 있고 그 시간이 비어 있을 때만
  const substitutesReady = input.body.sessionDecisions.every((d) => d.action !== "substitute" || judged.get(d.sessionId)?.available === true);

  return {
    affiliationId: input.affiliationId,
    instructor: { accountId: input.instructorAccountId, displayName: input.instructorName },
    remaining: {
      sessions: remaining.map((s) => {
        const decision = decisionOf.get(s.sessionId);
        const judgement = judged.get(s.sessionId) ?? null;
        return {
          sessionId: s.sessionId,
          classId: s.classId,
          classTitle: s.classTitle,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          roomName: s.roomName,
          memberCount: s.members.length,
          decision:
            decision === undefined
              ? null
              : {
                  action: decision.action,
                  substituteAccountId: decision.action === "substitute" ? (decision.substituteAccountId ?? null) : null,
                  substituteName: judgement?.displayName ?? null,
                  substituteAvailable: decision.action === "substitute" ? (judgement?.available ?? null) : null,
                },
        };
      }),
      privateLessonPasses: [],
    },
    bundles,
    // 알림은 회원마다 1건이라 건수 = 회원 수(열린 점 ⑯)
    totals: { memberCount, notificationCount: memberCount },
    undecided,
    canRelease: undecided.length === 0 && substitutesReady,
  };
}

// ---- 실제 적용(트랜잭션 안) ------------------------------------------------------------------------

export type ApplyInput = {
  academyId: string;
  academyName: string;
  affiliationId: string;
  instructorAccountId: string;
  instructorName: string;
  ownerId: string;
  body: ReleaseBody;
  now: Temporal.Instant;
};

export type ApplyResult = {
  sessions: { substituted: number; cancelled: number; closed: number };
  notified: { memberCount: number; notificationCount: number };
};

const EMPTY_RESULT: ApplyResult = { sessions: { substituted: 0, cancelled: 0, closed: 0 }, notified: { memberCount: 0, notificationCount: 0 } };

/**
 * 남은 회차를 정한 대로 처리한다. 소속 행을 잠근 같은 트랜잭션(tx) 안에서 부른다.
 * 순서: 남은 회차 잠금·읽기 → 맞추기(422 · 409 undecided) → 회차마다 처리 + 변경 기록(같은 batch_id) + 감사
 *       → 폐강한 수업은 남은 예정 회차가 0 이면 닫는다 → 회원마다 알림 1건(instructor_changed, 열쇠 release:<batchId>:<memberId>).
 * 남은 회차가 없으면 아무것도 쓰지 않는다(08 §5 의 M1 경로).
 */
export async function applyReleaseDecisions(tx: Tx, input: ApplyInput): Promise<ApplyResult> {
  const nowIso = input.now.toString();
  const remaining = await readRemainingSessions(
    tx,
    { academyId: input.academyId, instructorAccountId: input.instructorAccountId, nowIso },
    true,
  );
  checkKnownIds(input.body, remaining);
  const undecided = findUndecided(
    remaining.map((s) => s.sessionId),
    input.body.sessionDecisions.map((d) => d.sessionId),
  );
  if (undecided.length > 0) {
    // 08 §5 의 모양(remainingSessions)에 11 §9-2 의 undecided 를 더한다
    throw HttpError.conflict(RELEASE_HAS_REMAINING_SESSIONS, DETAIL.remaining, { remainingSessions: undecided.length, undecided });
  }
  if (remaining.length === 0) return EMPTY_RESULT;

  // 대체를 골랐는데 강사가 비었으면 422(미리 보기와 달리 실제 해제는 다 정해져야 한다)
  const missing = input.body.sessionDecisions.findIndex((d) => d.action === "substitute" && d.substituteAccountId === undefined);
  if (missing >= 0) throw invalid(`sessionDecisions.${missing}.substituteAccountId`, DETAIL.needSubstitute);

  const decisionOf = new Map(input.body.sessionDecisions.map((d) => [d.sessionId, d] as const));
  const indexOf = new Map(input.body.sessionDecisions.map((d, i) => [d.sessionId, i] as const));
  const [batch] = await tx.query(tx.raw.sql`SELECT uuidv7()::text AS id`.returnsRow({ id: "pg/text@1" }).build());
  if (batch === undefined) throw new Error("묶음 id 를 만들지 못했다");
  const batchId = batch.id;
  const decided = toDecided(remaining, input.body.sessionDecisions);
  // 회차마다 쓰는 「알린 회원 수」는 이 해제 전체의 중복 제거 수다(S2-3.2 폐강 묶음과 같은 방식)
  const memberCount = countDistinctMembers(decided);
  // 휴강 회차는 회원이 7일 안에 옮기기·환불을 고른다(§6-2 와 같은 기한 함수)
  const deadline = closureChoiceDeadline(input.now);
  const caller = { accountId: input.ownerId, isOwner: true };

  const counts = { substituted: 0, cancelled: 0, closed: 0 };
  const items = new Map<string, ReleaseNoticeItem>();
  const changeIds: string[] = [];
  const closedClasses = new Map<string, { class_id: string; academy_id: string }>();

  for (const session of remaining) {
    const decision = decisionOf.get(session.sessionId);
    if (decision === undefined) throw new Error("정하지 않은 회차가 남았다");
    let before: Record<string, unknown>;
    let after: Record<string, unknown>;
    let kind: "instructor_changed" | "cancelled" | "closed";
    let substituteName: string | null = null;

    if (decision.action === "substitute") {
      // 대체 강사의 일정 잠금 → 그 시간이 비었는지 다시 본다(앱 판정). 마지막 방어선은 DB EXCLUDE(ex_sessions_instructor)
      const substituteId = decision.substituteAccountId ?? "";
      await lockScheduleOwners(tx, substituteId, null);
      const judgement = await judgeSubstitute(tx, session.sessionId, substituteId, input.instructorAccountId, `sessionDecisions.${indexOf.get(session.sessionId) ?? 0}.substituteAccountId`);
      if (!judgement.available) throw HttpError.conflict(SUBSTITUTE_UNAVAILABLE, DETAIL.unavailable, { sessionId: session.sessionId });
      const moved = await tx.execute(
        tx.raw.sql`UPDATE class_sessions SET instructor_account_id = ${substituteId}::uuid
                   WHERE id = ${session.sessionId}::uuid AND status = 'scheduled' AND instructor_account_id = ${input.instructorAccountId}::uuid`
          .affectedCount()
          .build(),
      );
      if (moved.affectedRows === 0) throw HttpError.conflict("SESSION_NOT_SCHEDULED", DETAIL.sessionMoved);
      substituteName = judgement.displayName;
      // 대체 강사에게 배정 알림 1건(S2-3.7) — 회차 강사 변경과 같은 트랜잭션이라 해제가 거부되면 알림도 남지 않는다.
      // 열쇠는 회차마다(release:<batchId>:<sessionId>:assigned, 계약 11 §12) — 같은 강사가 두 회차를 맡으면 2건이다
      await insertSubstituteAssigned(tx, { input, batchId, session, substituteId, substituteName });
      kind = "instructor_changed";
      before = { instructorAccountId: input.instructorAccountId, instructorName: input.instructorName };
      after = { instructorAccountId: substituteId, instructorName: substituteName, affiliationId: input.affiliationId };
      counts.substituted += 1;
    } else {
      // 휴강(cancel_session) = 이 회차만 cancelled · 폐강(close) = 이 회차 closed — §6-2 와 같은 상태 변경
      kind = decision.action === "cancel_session" ? "cancelled" : "closed";
      const closed = await tx.execute(
        tx.raw.sql`UPDATE class_sessions SET status = ${kind}, cancelled_at = ${nowIso}::timestamptz, cancel_reason = ${RELEASE_CLOSE_REASON}
                   WHERE id = ${session.sessionId}::uuid AND status = 'scheduled'`
          .affectedCount()
          .build(),
      );
      if (closed.affectedRows === 0) throw HttpError.conflict("SESSION_NOT_SCHEDULED", DETAIL.sessionMoved);
      before = { status: "scheduled", startsAt: session.startsAt, endsAt: session.endsAt };
      after = { status: kind, reason: RELEASE_CLOSE_REASON, affiliationId: input.affiliationId };
      if (kind === "cancelled") counts.cancelled += 1;
      else {
        counts.closed += 1;
        closedClasses.set(session.classId, { class_id: session.classId, academy_id: session.academyId });
      }
    }

    const beforeJson = JSON.stringify(before);
    const afterJson = JSON.stringify(after);
    const [change] = await tx.query(
      tx.raw.sql`INSERT INTO session_changes (id, class_id, session_id, kind, batch_id, before, after, reason, changed_by_account_id,
                                              notified_member_count, member_choice_deadline_at, created_at)
                 VALUES (uuidv7(), ${session.classId}::uuid, ${session.sessionId}::uuid, ${kind}, ${batchId}::uuid, ${beforeJson}::jsonb,
                         ${afterJson}::jsonb, NULLIF(${kind === "instructor_changed" ? "" : RELEASE_CLOSE_REASON}, ''),
                         ${input.ownerId}::uuid, ${memberCount},
                         NULLIF(${kind === "cancelled" ? deadline.toString() : ""}, '')::timestamptz, ${nowIso}::timestamptz)
                 RETURNING id::text AS id`
        .returnsRow({ id: "pg/text@1" })
        .build(),
    );
    if (change === undefined) throw new Error("변경 기록을 쓰지 못했다");
    changeIds.push(change.id);
    await tx.execute(
      tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, before, after, reason)
                 VALUES (uuidv7(), 'staff', ${input.ownerId}::uuid, 'owner', ${input.academyId}::uuid, ${`session.${kind}`},
                         'class_sessions', ${session.sessionId}::uuid, ${beforeJson}::json, ${afterJson}::json, 'affiliation.release')`
        .affectedCount()
        .build(),
    );
    items.set(session.sessionId, noticeItem(session, decision.action, substituteName));
  }

  // 폐강으로 그 수업에 예정 회차가 하나도 남지 않으면 수업도 닫는다(§6-2 와 같은 함수)
  for (const row of closedClasses.values()) await closeClassIfEmpty(tx, caller, row);

  // 회원마다 알림 1건 — 세 회차를 예약한 회원도 한 건에 세 줄로 묶는다(수용 ⑤). 발송은 S7-1(delivery_status = pending)
  for (const { memberId, sessionIds } of groupByMember(decided)) {
    const memberItems = sessionIds.flatMap((id) => {
      const item = items.get(id);
      return item === undefined ? [] : [item];
    });
    const message = releaseMemberMessage(memberItems, {
      instructorName: input.instructorName,
      academyName: input.academyName,
      ownerNote: input.body.ownerNote ?? null,
    });
    const hasClosure = memberItems.some((i) => i.action === "cancel_session");
    const payload = JSON.stringify({
      affiliationId: input.affiliationId,
      academyId: input.academyId,
      batchId,
      sessionIds,
      items: sessionIds.map((id) => {
        const s = remaining.find((r) => r.sessionId === id);
        const item = items.get(id);
        return { sessionId: id, classId: s?.classId ?? "", classTitle: s?.classTitle ?? "", startsAt: s?.startsAt ?? "", action: item?.action ?? "", substituteName: item?.substituteName ?? null };
      }),
      memberChoiceDeadlineAt: hasClosure ? deadline.toString() : null,
      ownerNote: input.body.ownerNote ?? null,
      ...message,
    });
    await tx.execute(
      tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, dedupe_key, payload)
                 VALUES (uuidv7(), ${memberId}::uuid, ${input.academyId}::uuid, 'instructor_changed', ${`release:${batchId}:${memberId}`},
                         ${payload}::jsonb)
                 ON CONFLICT DO NOTHING`
        .affectedCount()
        .build(),
    );
  }

  return { sessions: counts, notified: { memberCount, notificationCount: memberCount } };
}

/**
 * 대체 강사 한 명에게 「이 회차를 맡게 됐어요」 알림 1행(kind substitute_assigned, category operations — 계약 11 §12).
 * 같은 열쇠면 두 번 쓰지 않는다(ON CONFLICT DO NOTHING). 발송은 커밋 뒤 S7-1 몫이라 delivery_status 는 pending 으로 남는다.
 * payload 의 sessionId·startsAt·endsAt 로 앱이 그 강사 캘린더의 해당 회차로 바로 이동한다.
 */
async function insertSubstituteAssigned(
  tx: Tx,
  a: { input: ApplyInput; batchId: string; session: RemainingSession; substituteId: string; substituteName: string },
): Promise<void> {
  const { input, session } = a;
  const message = substituteAssignedMessage(noticeItem(session, "substitute", a.substituteName), {
    instructorName: input.instructorName,
    academyName: input.academyName,
  });
  const payload = JSON.stringify({
    affiliationId: input.affiliationId,
    academyId: input.academyId,
    batchId: a.batchId,
    sessionId: session.sessionId,
    classId: session.classId,
    classTitle: session.classTitle,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    releasedInstructorName: input.instructorName,
    ...message,
  });
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               VALUES (uuidv7(), ${a.substituteId}::uuid, ${input.academyId}::uuid, 'operations', 'substitute_assigned',
                       ${`release:${a.batchId}:${session.sessionId}:assigned`}, ${payload}::jsonb)
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/** DB 의 EXCLUDE(ex_sessions_instructor) 위반 — 대체 강사 일정과 겹쳤다. 아니면 false */
export function isInstructorOverlap(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
    const e = current as { constraint?: unknown; message?: unknown; cause?: unknown };
    if (`${String(e.constraint ?? "")} ${String(e.message ?? "")}`.includes("ex_sessions_instructor")) return true;
    current = e.cause;
  }
  return false;
}
