// S2-3.12(공개 뒤 수업 수정 요청 API) — 공개된 수업을 고칠 때 「어떤 값이 어느 갈래로 가나」와 「회차를 어떻게 옮기나」(DB 없이 도는 순수 코드).
//   계약: _workspace/03_contracts/11-instructor.md §5(공개 뒤 수업 수정 — 값의 세 갈래 · 규칙) · 열린 점 ⑬(회차 수가 달라지는 수정)
//   요구: FR-050a(수업 등록 승인) · Q38(수업 수정 제한, 임시 확정) · FR-099d(환불 마감일은 늦추기만)
//
// 값의 세 갈래(계약 11 §5 표):
//   ① 바로 바뀌는 값    — 소개 문구(introText) · 포스터(posterFileId). 승인 없이 지금 쓴다
//   ② 대표 재승인 값    — 금액 · 요일·시간·기간(schedule) · 정원 · 환불 마감일. 요청 행(pending)만 만들고, 승인 전까지 회원에게는 옛 값이 보인다
//   ③ 바꿀 수 없는 값   — 학원 · 장르·세부 장르·종목 · 수업 구분. 422 CLASS_FIELD_LOCKED(「다른 수업이 돼요, 새로 등록해 주세요」)
// 이 파일은 갈래를 나누고, 일정 변경이 회차에 어떻게 닿는지를 계산만 한다. 쓰기·잠금·알림은 서비스(class-edit-requests.ts)가 한다.
import { z } from "zod";

import {
  CLASS_INTRO_MAX,
  classScheduleSchema,
  isEventClassKind,
  planSessions,
  timeIssues,
  type ClassPayload,
  type ClassSchedule,
  type PlannedSession,
} from "./class-registration";
import type { ClassKind } from "./constants";
import { MAX_RECURRING_SESSIONS } from "./recurring-schedule";
import { parseKstDate } from "./time";

/** ③ 공개 뒤에는 바꿀 수 없는 칸 — 바꾸면 다른 수업이 된다(Q38 임시 확정) */
export const LOCKED_EDIT_FIELDS = ["academyId", "genre", "subGenre", "discipline", "classKind"] as const;
/** ① 바로 바뀌는 칸 */
export const IMMEDIATE_EDIT_FIELDS = ["introText", "posterFileId"] as const;
/** ② 대표 재승인이 필요한 칸 */
export const APPROVAL_EDIT_FIELDS = ["priceAmount", "schedule", "capacity", "refundDeadlineOn"] as const;

export type ImmediateField = (typeof IMMEDIATE_EDIT_FIELDS)[number];
export type ApprovalField = (typeof APPROVAL_EDIT_FIELDS)[number];

const seatCount = z.int();

/**
 * 요청의 changes 모양(잠긴 칸은 이 스키마 앞에서 따로 걸러 422 CLASS_FIELD_LOCKED 로 돌려준다).
 * strictObject 라 그 밖의 모르는 칸(title 등)은 422 VALIDATION_FAILED — 계약 표에 없는 칸을 조용히 버리면
 * 「고쳤다고 생각했는데 안 바뀐」 일이 생긴다. 숫자 범위(정원 하한·금액 상한)는 S2-3.3 의 판정이 본다.
 */
export const editChangesSchema = z.strictObject({
  introText: z.string().max(CLASS_INTRO_MAX).nullable().optional(),
  posterFileId: z.uuid().nullable().optional(),
  priceAmount: z.int().optional(),
  capacity: z.strictObject({ male: seatCount.optional(), female: seatCount.optional(), any: seatCount.optional() }).optional(),
  schedule: classScheduleSchema.optional(),
  refundDeadlineOn: z.iso.date().optional(),
});
export type EditChanges = z.infer<typeof editChangesSchema>;

/** 재승인 갈래만 — class_edit_requests.changes 에 그대로 저장한다(보낸 칸만) */
export type ApprovalChanges = Pick<EditChanges, ApprovalField>;
/** 바로 바뀌는 갈래만 */
export type ImmediateChanges = Pick<EditChanges, ImmediateField>;

/** 저장해 둔 changes(jsonb)를 다시 읽는 모양 — 요청 때 이미 검사한 값이다 */
export const storedApprovalChangesSchema = editChangesSchema.pick({ priceAmount: true, schedule: true, capacity: true, refundDeadlineOn: true });

/** 본문 changes 에 잠긴 칸이 있으면 그 이름들(없으면 빈 배열) */
export function lockedFieldsIn(raw: Record<string, unknown>): string[] {
  return LOCKED_EDIT_FIELDS.filter((field) => Object.hasOwn(raw, field));
}

/** 보낸 칸을 두 갈래로 나눈다. 값이 undefined 인 칸은 「안 보냄」이다 */
export function splitEditChanges(changes: EditChanges): { immediate: ImmediateChanges; approval: ApprovalChanges } {
  const immediate: ImmediateChanges = {};
  const approval: ApprovalChanges = {};
  if (changes.introText !== undefined) immediate.introText = changes.introText;
  if (changes.posterFileId !== undefined) immediate.posterFileId = changes.posterFileId;
  if (changes.priceAmount !== undefined) approval.priceAmount = changes.priceAmount;
  if (changes.schedule !== undefined) approval.schedule = changes.schedule;
  if (changes.capacity !== undefined) approval.capacity = changes.capacity;
  if (changes.refundDeadlineOn !== undefined) approval.refundDeadlineOn = changes.refundDeadlineOn;
  return { immediate, approval };
}

export const changedFieldsOf = (changes: object): string[] => Object.keys(changes);

// ---- 일정 변경 → 회차 옮기기(계약 11 §5 · 열린 점 ⑬) -------------------------------------------------

/** 지금 있는 회차 한 줄 */
export type ExistingSession = {
  sessionId: string;
  seq: number;
  startsAt: Temporal.Instant;
  endsAt: Temporal.Instant;
  status: string;
};

export type SessionMove = {
  sessionId: string;
  seq: number;
  before: { startsAt: Temporal.Instant; endsAt: Temporal.Instant };
  after: { startsAt: Temporal.Instant; endsAt: Temporal.Instant };
};

export type ScheduleMovePlan =
  | { ok: true; plan: PlannedSession[]; moves: SessionMove[]; finalSessions: { startsAt: Temporal.Instant; endsAt: Temporal.Instant }[] }
  | { ok: false; code: "VALIDATION_FAILED" | "EDIT_SESSION_COUNT_CHANGED"; problems: { path: string; message: string }[] };

/**
 * 새 일정 규칙이 지금 회차에 어떻게 닿는지 계산한다(열린 점 ⑬ 임시 확정).
 *   - 새 규칙으로 만든 회차 수가 지금 회차 수와 다르면 거부(EDIT_SESSION_COUNT_CHANGED) — 회차를 늘리거나 줄이는 일은 회차 단위 폐강으로 한다
 *   - 아직 시작하지 않은 「예정」 회차만 같은 seq 의 새 시각으로 옮기고, 지난 회차·휴강 회차는 그대로 둔다
 *   - 옮길 새 시각이 지금보다 앞이면 거부(지난 시각으로 회차를 옮길 수 없다)
 * now 를 받는 순수 함수라 경계(정확히 지금 시작하는 회차)를 테스트로 고정할 수 있다.
 */
export function planScheduleMove(input: {
  schedule: ClassSchedule;
  classKind: ClassKind;
  existing: readonly ExistingSession[];
  now: Temporal.Instant;
}): ScheduleMovePlan {
  const problems: { path: string; message: string }[] = [];
  const wantsSingle = isEventClassKind(input.classKind);
  if (wantsSingle !== (input.schedule.kind === "single")) {
    problems.push({ path: "changes.schedule.kind", message: wantsSingle ? "이 수업 구분은 하루 일정으로 넣어 주세요" : "요일 반복 일정으로 넣어 주세요" });
  }
  for (const message of timeIssues(input.schedule.startTime, input.schedule.endTime)) problems.push({ path: "changes.schedule.endTime", message });
  if (problems.length > 0) return { ok: false, code: "VALIDATION_FAILED", problems };

  let plan: PlannedSession[];
  try {
    plan = planSessions(input.schedule);
  } catch {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      problems: [{ path: "changes.schedule", message: `회차가 1~${MAX_RECURRING_SESSIONS}개가 되게 요일과 기간을 정해 주세요` }],
    };
  }
  const existing = [...input.existing].sort((a, b) => a.seq - b.seq);
  if (plan.length !== existing.length) {
    return {
      ok: false,
      code: "EDIT_SESSION_COUNT_CHANGED",
      problems: [{ path: "changes.schedule", message: `회차 수(${existing.length}회)는 바꿀 수 없어요. 지금은 ${plan.length}회가 돼요` }],
    };
  }

  const moves: SessionMove[] = [];
  const finalSessions = existing.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt }));
  existing.forEach((session, index) => {
    const next = plan[index];
    // 이미 시작한(지난) 회차와 휴강·폐강 회차는 그대로 둔다
    if (next === undefined || session.status !== "scheduled" || Temporal.Instant.compare(session.startsAt, input.now) <= 0) return;
    if (Temporal.Instant.compare(next.startsAt, input.now) <= 0) {
      problems.push({ path: "changes.schedule", message: `${session.seq}회차를 이미 지난 시각으로 옮길 수 없어요` });
      return;
    }
    finalSessions[index] = { startsAt: next.startsAt, endsAt: next.endsAt };
    const same = next.startsAt.equals(session.startsAt) && next.endsAt.equals(session.endsAt);
    if (!same) moves.push({ sessionId: session.sessionId, seq: session.seq, before: { startsAt: session.startsAt, endsAt: session.endsAt }, after: { startsAt: next.startsAt, endsAt: next.endsAt } });
  });
  if (problems.length > 0) return { ok: false, code: "VALIDATION_FAILED", problems };
  return { ok: true, plan, moves, finalSessions };
}

// ---- 환불 마감일 늦추기만(FR-099d) -------------------------------------------------------------

/**
 * 환불 마감일을 바꿀 수 있나. 결제한(또는 결제 중인) 회원이 있으면 앞당기기는 막는다(409 REFUND_DEADLINE_ADVANCE_BLOCKED) —
 * 회원은 「이 날까지 취소하면 돌려받는다」를 보고 샀기 때문이다. 늦추기는 회원에게 유리하니 언제나 된다.
 */
export function judgeRefundDeadlineChange(current: string | null, next: string, reservedCount: number): { ok: true } | { ok: false } {
  if (current === null || reservedCount <= 0) return { ok: true };
  return Temporal.PlainDate.compare(parseKstDate(next), parseKstDate(current)) < 0 ? { ok: false } : { ok: true };
}

// ---- 승인 뒤 저장 값(registration_payload) 합치기 ------------------------------------------------

/**
 * 승인된 값을 수업의 저장 값에 합친다(새 객체를 돌려준다). 정원은 지금 모드(성별 두 칸·한 칸)를 지키며 보낸 칸만 바꾼다.
 * 수업 상세(GET /api/classes/{id})와 목록이 이 값을 읽으므로, 승인 뒤에는 새 값이 보인다.
 */
export function mergeApprovedPayload(payload: ClassPayload, changes: ApprovalChanges): ClassPayload {
  const capacity = payload.capacity;
  const nextCapacity =
    changes.capacity === undefined || capacity === null
      ? capacity
      : capacity.mode === "gender_split"
        ? { ...capacity, male: changes.capacity.male ?? capacity.male, female: changes.capacity.female ?? capacity.female }
        : { ...capacity, any: changes.capacity.any ?? capacity.any };
  return {
    ...payload,
    priceAmount: changes.priceAmount ?? payload.priceAmount,
    schedule: changes.schedule ?? payload.schedule,
    capacity: nextCapacity,
    refundDeadlineOn: changes.refundDeadlineOn ?? payload.refundDeadlineOn,
  };
}
