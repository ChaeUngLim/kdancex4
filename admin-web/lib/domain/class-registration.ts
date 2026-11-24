// S2-2.3(수업 등록 API) — 수업 등록 값의 모양과 「승인 요청할 만큼 다 찼나」 판정(DB 없이 도는 순수 코드).
//   계약: _workspace/03_contracts/11-instructor.md §4-2(임시 저장 본문) · §4-4(승인 요청)
//   요구: FR-050(강사 수업 등록) · FR-051(수업 구분 9종) · FR-052a(회차·기간 신청 단위) · FR-057(반복 일정)
//         · FR-092(성별 정원) · FR-092c(단일 정원) · FR-028(적정 연령) · FR-011b(활동 장르 하나)
//
// 수업 만들기는 두 단계다.
//   ① 임시 저장(draft) — 학원·수업 구분·수업명만 있으면 저장된다. 나머지 칸은 비어도 되지만, **적힌 칸은 모양이 맞아야** 한다
//   ② 승인 요청(submit) — 이때 「다 찼나」를 본다(checkSubmittable). 빠진 칸은 fields 로 한꺼번에 알려 준다
// 그래서 스키마(classDraftSchema)는 「적힌 칸 검사」만, 완성 검사는 따로 둔다.
//
// 이 Task 가 하지 않는 것(뒤 Task 의 몫): 겹침 거부(S2-2.4).
// 환불 공지 종류 고르기(refundNoticeKindFor)는 S2-2.5(공지 자동 입력)가 더했다.
// refundDeadlineOn 은 임시 저장 때 모양만 본다. 정규 계열이면 버린다(계약 11 §4-2 「정규 계열은 보내도 무시」).
// 필수·개최일 판정은 S2-2.6(환불 마감일 필수)의 refund-deadline.ts 가 승인 요청 때 한다.
import { z } from "zod";

import {
  CLASS_AGE_GROUPS,
  CLASS_DISCIPLINES,
  CLASS_KINDS,
  CLASS_SUB_GENRES,
  CLASS_TARGET_LEVELS,
  GENRES,
  type ClassDiscipline,
  type ClassKind,
  type ClassSubGenre,
  type EnrollmentUnit,
  type Genre,
  type SeatKind,
} from "./constants";
import { buildRecurringSessions, MAX_RECURRING_SESSIONS, WEEKDAYS } from "./recurring-schedule";
import { KST_TIME_ZONE, parseKstDate, parseTimeOfDay } from "./time";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

/** 이벤트형 수업 구분 — 회차 하나(kind: single)만 받고, 신청 단위는 회차(session)다(계약 11 §4-2 · 열린 점 ⑦) */
export const EVENT_CLASS_KINDS = ["one_day", "event", "party", "performance", "competition"] as const satisfies readonly ClassKind[];

/** 수업명 글자 수 상한(**추천값** — 계약이 정하지 않았다. 카드 한 줄에 들어갈 만큼) */
export const CLASS_TITLE_MAX = 60;
/** 소개 문구 상한(**추천값** — 생성 흐름은 SX-6 몫이라 칸만 둔다) */
export const CLASS_INTRO_MAX = 2000;
/** 수강료 상한(원, **추천값** — 잘못 친 0 하나를 막으려는 값) */
export const CLASS_PRICE_MAX = 10_000_000;
/** 성별 한 칸·단일 정원 상한(**추천값**) */
export const CLASS_CAPACITY_MAX = 999;

/** 세부 장르 ↔ 장르 짝(data-model §8-7). 이 목록에 없는 장르(아르헨티나 탱고·스윙)는 세부 장르가 없다 */
export const SUB_GENRES_OF: Readonly<Partial<Record<Genre, readonly ClassSubGenre[]>>> = {
  dance_sport: ["latin", "standard"],
  salsa_bachata: ["salsa", "bachata"],
};

/** 종목 ↔ 세부 장르 짝(FR-021 · D11). 라틴 5종 · 스탠다드 5종 */
const DISCIPLINES_OF: Readonly<Partial<Record<ClassSubGenre, readonly ClassDiscipline[]>>> = {
  latin: ["rumba", "cha_cha_cha", "samba", "paso_doble", "jive"],
  standard: ["waltz", "tango", "viennese_waltz", "slow_foxtrot", "quickstep"],
};

export const isEventClassKind = (kind: ClassKind): boolean => (EVENT_CLASS_KINDS as readonly string[]).includes(kind);

/**
 * S2-2.5(공지 자동 입력) — 이 수업에 붙일 학원 환불 공지의 종류. 붙일 공지가 없으면 null.
 *   정규 계열(정규·베이직·레이디 스타일 등) → regular
 *   이벤트형 → event. 단 0원이면 null — 환불할 돈이 없으니 이벤트형 공지를 붙이지 않는다(FR-099d 「무료(0원) 행사」)
 * 금액을 아직 안 넣은 임시 저장(null)은 유료로 본다 — 0원이 확정되기 전까지는 공지를 보여 주는 쪽이 안전하다.
 * 개인 레슨은 이 경로(수업 등록)로 오지 않는다(계약 11 §10).
 */
export function refundNoticeKindFor(classKind: ClassKind, priceAmount: number | null): "regular" | "event" | null {
  if (!isEventClassKind(classKind)) return "regular";
  return priceAmount === 0 ? null : "event";
}

// ---- 칸 모양 ---------------------------------------------------------------------------------

const timeText = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "시각은 HH:MM 으로 넣어 주세요");
const dateText = z.iso.date();

const recurringScheduleSchema = z.object({
  kind: z.literal("recurring"),
  weekdays: z.array(z.enum(WEEKDAYS)).min(1, "요일을 하나 이상 골라 주세요"),
  startTime: timeText,
  endTime: timeText,
  periodFrom: dateText,
  periodTo: dateText,
});

const singleScheduleSchema = z.object({
  kind: z.literal("single"),
  date: dateText,
  startTime: timeText,
  endTime: timeText,
});

export const classScheduleSchema = z.discriminatedUnion("kind", [recurringScheduleSchema, singleScheduleSchema]);
export type ClassSchedule = z.infer<typeof classScheduleSchema>;

const seatCount = z.int().min(0, "0 이상으로 넣어 주세요").max(CLASS_CAPACITY_MAX);

/** 정원 — 성별 두 칸(FR-092) 또는 한 칸(FR-092c). 서버는 정수만 본다(버튼·직접 입력 둘 다 결국 숫자) */
export const classCapacitySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("gender_split"), male: seatCount, female: seatCount, any: z.null().optional() }),
  z.object({ mode: z.literal("single"), any: seatCount, male: z.null().optional(), female: z.null().optional() }),
]);
export type ClassCapacity = z.infer<typeof classCapacitySchema>;

/**
 * 임시 저장 본문(POST·PUT 공통, 계약 11 §4-2). z.object 라 모르는 칸은 **버린다** —
 * `refundNotice`·`status`·`paidCount` 같은 읽기 전용 칸을 보내도 무시된다(수용 ① 「강사가 공지 값을 보내도 무시된다」).
 */
export const classDraftSchema = z
  .object({
    academyId: z.uuid(),
    classKind: z.enum(CLASS_KINDS),
    title: z.string().trim().min(1, "수업명을 넣어 주세요").max(CLASS_TITLE_MAX),
    genre: z.enum(GENRES).nullish(),
    subGenre: z.enum(CLASS_SUB_GENRES).nullish(),
    discipline: z.enum(CLASS_DISCIPLINES).nullish(),
    targetLevel: z.enum(CLASS_TARGET_LEVELS).nullish(),
    targetAges: z.array(z.enum(CLASS_AGE_GROUPS)).nullish(),
    roomId: z.uuid().nullish(),
    priceAmount: z.int().min(0, "0원 이상으로 넣어 주세요").max(CLASS_PRICE_MAX).nullish(),
    schedule: classScheduleSchema.nullish(),
    capacity: classCapacitySchema.nullish(),
    refundDeadlineOn: dateText.nullish(),
    introText: z.string().max(CLASS_INTRO_MAX).nullish(),
    instructorAccountId: z.uuid().nullish(),
  })
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });

    // 개인 레슨은 승인 대상이 아니라 이 경로로 만들지 않는다(계약 11 §10 의 경로를 쓴다)
    if (value.classKind === "private_lesson") issue("classKind", "개인 레슨은 개인 레슨 개설에서 만들어 주세요");

    // 세부 장르·종목은 「적혀 있으면」 장르와 짝이 맞아야 한다. 비어 있는지는 승인 요청 때 본다
    if (value.genre != null && value.subGenre != null && !(SUB_GENRES_OF[value.genre] ?? []).includes(value.subGenre)) {
      issue("subGenre", "이 장르에 없는 세부 장르예요");
    }
    if (value.discipline != null) {
      // 장르를 안 보냈으면(서버가 활동 장르로 채운다) 세부 장르와의 짝만 본다. 장르를 채운 뒤 서비스가 한 번 더 검사한다
      const genreOk = value.genre == null || value.genre === "dance_sport";
      const ok = genreOk && value.subGenre != null && (DISCIPLINES_OF[value.subGenre] ?? []).includes(value.discipline);
      if (!ok) issue("discipline", "세부 장르에 맞는 종목을 골라 주세요");
    }

    // 적정 연령: 「전 연령」은 다른 값과 같이 고를 수 없고, 같은 값을 두 번 넣지 않는다(FR-028)
    if (value.targetAges != null) {
      if (value.targetAges.includes("all") && value.targetAges.length > 1) issue("targetAges", "전 연령은 다른 연령과 함께 고를 수 없어요");
      if (new Set(value.targetAges).size !== value.targetAges.length) issue("targetAges", "같은 연령을 두 번 골랐어요");
    }

    // 일정: 이벤트형은 회차 하나(single), 그 밖은 요일 반복(recurring)
    if (value.schedule != null) {
      const wantsSingle = isEventClassKind(value.classKind);
      if (wantsSingle !== (value.schedule.kind === "single")) {
        issue("schedule.kind", wantsSingle ? "이 수업 구분은 하루 일정으로 넣어 주세요" : "요일 반복 일정으로 넣어 주세요");
      }
      for (const message of timeIssues(value.schedule.startTime, value.schedule.endTime)) issue("schedule.endTime", message);
    }

    // 레이디 스타일은 성별 구분 없는 한 칸 정원으로 받는다(열린 점 ⑦ 임시 확정)
    if (value.classKind === "lady_style" && value.capacity != null && value.capacity.mode !== "single") {
      issue("capacity.mode", "레이디 스타일은 정원 한 칸으로 넣어 주세요");
    }
  });
export type ClassDraftInput = z.infer<typeof classDraftSchema>;

/**
 * 시각 두 개 검사 — 10분 단위, 끝이 시작보다 늦다(자정 넘김은 받지 않는다). 모양이 틀린 글자는 칸 검사가 이미 잡는다.
 * S2-2.8c(일정 겹침 미리보기)의 본문 검사도 같은 규칙을 쓰려고 내보낸다.
 */
export function timeIssues(startTime: string, endTime: string): string[] {
  if (!timeText.safeParse(startTime).success || !timeText.safeParse(endTime).success) return [];
  const start = parseTimeOfDay(startTime);
  const end = parseTimeOfDay(endTime);
  const issues: string[] = [];
  if (start.minute % 10 !== 0 || end.minute % 10 !== 0) issues.push("시각은 10분 단위로 넣어 주세요");
  if (Temporal.PlainTime.compare(end, start) <= 0) issues.push("끝나는 시각이 시작보다 늦어야 해요");
  return issues;
}

// ---- 저장 값(registration_payload) ------------------------------------------------------------

/**
 * DB 의 registration_payload 에 넣는 값. 요청에서 학원·담당 강사·읽기 전용 칸을 뺀 「수업 값」만 둔다.
 * 빈 칸은 null 로 맞춘다 — 읽을 때 「안 보냄」과 「비움」을 나누지 않는다(PUT 은 전체 교체다).
 */
export type ClassPayload = {
  classKind: ClassKind;
  title: string;
  genre: Genre | null;
  subGenre: ClassSubGenre | null;
  discipline: ClassDiscipline | null;
  targetLevel: (typeof CLASS_TARGET_LEVELS)[number] | null;
  targetAges: (typeof CLASS_AGE_GROUPS)[number][];
  roomId: string | null;
  priceAmount: number | null;
  schedule: ClassSchedule | null;
  capacity: ClassCapacity | null;
  refundDeadlineOn: string | null;
  introText: string | null;
};

export function toClassPayload(input: ClassDraftInput, genre: Genre | null): ClassPayload {
  return {
    classKind: input.classKind,
    title: input.title,
    genre,
    subGenre: input.subGenre ?? null,
    discipline: input.discipline ?? null,
    targetLevel: input.targetLevel ?? null,
    targetAges: input.targetAges ?? [],
    roomId: input.roomId ?? null,
    priceAmount: input.priceAmount ?? null,
    schedule: input.schedule ?? null,
    capacity: input.capacity ?? null,
    // 정규 계열은 환불 마감일이 없다 — 보낸 값이 있어도 저장하지 않는다(S2-2.6). 이벤트형은 0원이어도 일단 둔다(금액을 다시 바꿀 수 있어서)
    refundDeadlineOn: isEventClassKind(input.classKind) ? (input.refundDeadlineOn ?? null) : null,
    introText: input.introText ?? null,
  };
}

/** DB 에서 읽은 payload(JSON 글자)를 다시 모양으로 — 저장할 때 이미 검사한 값이라 실패하면 데이터가 깨진 것이다 */
const storedPayloadSchema = z.object({
  classKind: z.enum(CLASS_KINDS),
  title: z.string(),
  genre: z.enum(GENRES).nullable(),
  subGenre: z.enum(CLASS_SUB_GENRES).nullable(),
  discipline: z.enum(CLASS_DISCIPLINES).nullable(),
  targetLevel: z.enum(CLASS_TARGET_LEVELS).nullable(),
  targetAges: z.array(z.enum(CLASS_AGE_GROUPS)),
  roomId: z.uuid().nullable(),
  priceAmount: z.int().nullable(),
  schedule: classScheduleSchema.nullable(),
  capacity: classCapacitySchema.nullable(),
  refundDeadlineOn: dateText.nullable(),
  introText: z.string().nullable(),
});
export function readClassPayload(json: string): ClassPayload {
  return storedPayloadSchema.parse(JSON.parse(json));
}

// ---- 회차 만들기 -----------------------------------------------------------------------------

export type PlannedSession = { seq: number; startsAt: Temporal.Instant; endsAt: Temporal.Instant };

/** KST 날짜 + KST 시각 → 저장용 순간 */
function kstInstant(date: string, time: string): Temporal.Instant {
  return parseKstDate(date).toZonedDateTime({ timeZone: KST_TIME_ZONE, plainTime: parseTimeOfDay(time) }).toInstant();
}

/**
 * 일정 → 회차 목록(FR-057). 요일 반복은 S2-2.2 의 buildRecurringSessions 를 그대로 쓰고(끝나는 날 포함),
 * 하루 일정은 회차 하나다. 규칙이 틀리면(회차 0개·200개 초과 등) RangeError 를 던진다.
 */
export function planSessions(schedule: ClassSchedule): PlannedSession[] {
  if (schedule.kind === "single") {
    return [{ seq: 1, startsAt: kstInstant(schedule.date, schedule.startTime), endsAt: kstInstant(schedule.date, schedule.endTime) }];
  }
  return buildRecurringSessions({
    weekdays: schedule.weekdays,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    periodFrom: schedule.periodFrom,
    periodTo: schedule.periodTo,
  }).map((s) => ({ seq: s.seq, startsAt: s.startsAt, endsAt: s.endsAt }));
}

/** 응답의 sessionCount — 일정이 비었거나 규칙이 틀려 회차를 못 만들면 null(임시 저장 화면에서는 아직 모를 수 있다) */
export function countSessions(schedule: ClassSchedule | null): number | null {
  if (schedule === null) return null;
  try {
    return planSessions(schedule).length;
  } catch {
    return null;
  }
}

// ---- 승인 요청 판정 --------------------------------------------------------------------------

export type FieldProblem = { path: string; message: string };

/** 판정을 통과한 값 — 판매 단위·회차·자리 묶음을 만들 재료 */
export type SubmittablePlan = {
  enrollmentUnit: EnrollmentUnit;
  priceAmount: number;
  sessions: PlannedSession[];
  seatPools: { seatKind: SeatKind; capacity: number }[];
};

/**
 * 승인 요청할 만큼 다 찼나(계약 11 §4-4 ①). 빠진 칸을 **한꺼번에** 모아 돌려준다 — 하나씩 고치게 하지 않으려고.
 *   필수: 장르 · 세부 장르(댄스스포츠·살사바차타) · 종목(댄스스포츠) · 대상 레벨(이벤트형이 아니면) · 적정 연령 1개 이상
 *         · 홀 · 수강료(0 이면 무료 수업 — 같은 흐름을 탄다, 수용 ⑤) · 일정 · 정원(합이 0 이면 안 된다, FR-092)
 *   일정: 회차 1~200개 · 첫 회차는 지금보다 뒤
 */
export function checkSubmittable(
  payload: ClassPayload,
  now: Temporal.Instant,
): { ok: true; plan: SubmittablePlan } | { ok: false; problems: FieldProblem[] } {
  const problems: FieldProblem[] = [];
  const need = (path: string, message: string) => problems.push({ path, message });
  const event = isEventClassKind(payload.classKind);

  if (payload.genre === null) need("genre", "장르를 골라 주세요");
  if (payload.genre !== null && SUB_GENRES_OF[payload.genre] !== undefined && payload.subGenre === null) {
    need("subGenre", "세부 장르를 골라 주세요");
  }
  if (payload.genre === "dance_sport" && payload.discipline === null) need("discipline", "종목을 골라 주세요");
  if (!event && payload.targetLevel === null) need("targetLevel", "대상 레벨을 골라 주세요");
  if (payload.targetAges.length === 0) need("targetAges", "적정 연령을 하나 이상 골라 주세요");
  if (payload.roomId === null) need("roomId", "홀을 골라 주세요");
  if (payload.priceAmount === null) need("priceAmount", "수강료를 넣어 주세요");

  // 정원 — 자리 묶음은 0 보다 큰 칸만 만든다(DB 의 ck_seat_pools_capacity_positive). 합이 0 이면 받을 사람이 없다
  const seatPools: SubmittablePlan["seatPools"] = [];
  if (payload.capacity === null) {
    need("capacity", "정원을 넣어 주세요");
  } else if (payload.capacity.mode === "gender_split") {
    if (payload.capacity.male > 0) seatPools.push({ seatKind: "male", capacity: payload.capacity.male });
    if (payload.capacity.female > 0) seatPools.push({ seatKind: "female", capacity: payload.capacity.female });
  } else if (payload.capacity.any > 0) {
    seatPools.push({ seatKind: "any", capacity: payload.capacity.any });
  }
  if (payload.capacity !== null && seatPools.length === 0) need("capacity", "정원은 1명 이상이어야 해요");

  // 일정 → 회차
  let sessions: PlannedSession[] = [];
  if (payload.schedule === null) {
    need("schedule", "일정을 넣어 주세요");
  } else {
    try {
      sessions = planSessions(payload.schedule);
    } catch {
      need("schedule", `회차가 1~${MAX_RECURRING_SESSIONS}개가 되게 요일과 기간을 정해 주세요`);
    }
    const first = sessions[0];
    if (first !== undefined && Temporal.Instant.compare(first.startsAt, now) <= 0) need("schedule", "첫 회차는 지금보다 뒤여야 해요");
  }

  if (problems.length > 0 || payload.priceAmount === null) return { ok: false, problems };
  return {
    ok: true,
    plan: { enrollmentUnit: event ? "session" : "term", priceAmount: payload.priceAmount, sessions, seatPools },
  };
}

/** 판매 단위 이름 — 「12/01~12/24 · 8회」, 하루 행사는 「12/06」(KST 달력) */
export function offeringLabel(sessions: readonly PlannedSession[]): string {
  const md = (at: Temporal.Instant) => {
    const d = at.toZonedDateTimeISO(KST_TIME_ZONE);
    return `${String(d.month).padStart(2, "0")}/${String(d.day).padStart(2, "0")}`;
  };
  const first = sessions[0];
  const last = sessions[sessions.length - 1];
  if (first === undefined || last === undefined) return "";
  return sessions.length === 1 ? md(first.startsAt) : `${md(first.startsAt)}~${md(last.startsAt)} · ${sessions.length}회`;
}
