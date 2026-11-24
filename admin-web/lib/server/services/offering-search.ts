// SX-5.3(조건 검색 결과를 수업 카드로) — MCP 읽기 도구 `search_offerings` 의 본체(계약 16 §5-1 조건 · §5-2 offering_cards · §6).
//   요구: FR-037a(강사 수업 말로 찾기 — 「답에 들어가는 수업은 그 조건으로 DB 를 검색한 결과 그대로」) · FR-039(없는 항목 추천 금지)
//         FR-032(강사의 여러 학원 수업 조회) · FR-033(시간대 필터) · FR-052c(개인 레슨은 「레슨 모집」 시간만) · FR-214(AI 쓰기 금지)
//   데이터: 03_data-model.md §8-2 classes·class_offerings·class_sessions · §4-4 seat_pools · §8-6 private_lesson_products·_slots
//
// 처음 보는 사람용 요약
//   - AI(에이전트 서버)는 회원 질문에서 조건만 뽑는다(SX-5.2). 그 조건을 이 함수가 받아 **DB 에서 직접** 찾고,
//     찾은 행을 카드 모양으로 옮겨 적기만 한다. 카드의 글자·숫자는 모두 DB 값이다 — AI 가 수업을 만들거나 고쳐 쓸 자리가 없다.
//   - 「보여도 되는 수업」은 홈 목록(S3-2.1 home-offerings.ts)·수업 상세(S3-2.3 offering-detail.ts)와 같은 공개 조건이다:
//       수업 published · 판매 단위 open · 학원 active · 끝나지 않은 노출 중지 없음 · 예정 회차가 있고 첫 회차가 지금 이후.
//     그래서 승인 전 수업 · 입점 심사 전(학원 행 자체가 없다) · 게시 제한된 학원의 수업은 나오지 않는다(플랜 SX-5 수용 ③).
//   - 남은 자리 계산은 홈 목록·상세와 **같은 함수**(buildCapacity)를 쓴다. 카드의 남은 자리와 상세 화면 숫자가 어긋나지 않게.
//   - 개인 레슨은 판매 단위가 없다(상품 + 「레슨 모집」 시간). 카드에는 지금 비어 있는(open) 시간만 싣는다 — 결제 중(held)·
//     예약된(booked) 시간은 강사 사생활이라 회원에게 보이지 않는다(FR-052c).
//   - 이 파일은 읽기만 한다. 홈 목록이 읽기 전에 하는 「기한 지난 결제 대기 정리」(쓰기)도 부르지 않는다 —
//     AI 경로는 어떤 행도 바꾸지 않는다(FR-214). 그 정리는 회원이 카드를 눌러 상세를 열 때 상세 경로가 한다.
import { z } from "zod";

import { CLASS_TARGET_LEVELS, GENRES, SEAT_KINDS, type Genre } from "../../domain/constants";
import { offeringCardActionSchema, openOfferingAction } from "../../domain/offering-card-action";
import { isNearlyFull } from "../../domain/owner-dashboard";
import { WEEKDAYS } from "../../domain/recurring-schedule";
import type { Clock } from "../../domain/time";
import type { Db } from "../../../prisma/db";
import { buildCapacity } from "./home-offerings";

export type OfferingSearchDeps = { readonly db: Db; readonly clock: Clock };

/** 카드 최대 수(계약 16 §6 「limit 1..20」) */
const MAX_CARDS = 20;

/** 시간대 이름 → KST 하루 안의 [시작 분, 끝 분](계약 16 §5-1 열린 점 ⑨ 추천 경계). 저녁 끝 24:00 = 1440분 */
const TIME_BANDS = {
  morning: [6 * 60, 12 * 60],
  afternoon: [12 * 60, 18 * 60],
  evening: [18 * 60, 24 * 60],
} as const;

// ---- 입력(계약 16 §5-1 + limit — 에이전트 쪽 pydantic SearchOfferingsInput 과 같은 모양) -------------------
// strict: 모르는 칸(memberId 등)은 거부한다. 비워 둔 칸은 null(또는 빠짐).

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/);
const toMinutes = (text: string): number => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));

/** 이름과 id. id 는 SX-5.1 이름 후보 도구가 정해 준 값이다 */
const nameRef = z.strictObject({ name: z.string().trim().max(100).nullish(), id: z.uuid().nullish() });

export const searchOfferingsInputSchema = z
  .strictObject({
    instructor: nameRef.nullish(),
    academy: nameRef.nullish(),
    genre: z.enum(GENRES).nullish(),
    weekdays: z.array(z.enum(WEEKDAYS)).max(7).nullish(),
    timeBand: z.union([z.enum(["morning", "afternoon", "evening"]), z.strictObject({ from: hhmm, to: hhmm })]).nullish(),
    level: z.enum(CLASS_TARGET_LEVELS).nullish(),
    regionSido: z.string().trim().min(1).max(50).nullish(),
    regionGu: z.string().trim().min(1).max(50).nullish(),
    maxPriceAmount: z.int().min(0).nullish(),
    dateFrom: z.iso.date().nullish(),
    dateTo: z.iso.date().nullish(),
    limit: z.int().min(1).max(MAX_CARDS),
  })
  .superRefine((value, ctx) => {
    const issue = (path: string) => ctx.addIssue({ code: "custom", path: [path], message: "invalid" });
    // 이름만 있고 id 가 없으면 받지 않는다 — 이름으로 짐작해 하나를 고르지 않게(동명이인은 후보 카드가 먼저, SX-5 수용 ②)
    if (value.instructor != null && value.instructor.id == null) issue("instructor");
    if (value.academy != null && value.academy.id == null) issue("academy");
    if (typeof value.timeBand === "object" && value.timeBand !== null && toMinutes(value.timeBand.from) >= toMinutes(value.timeBand.to)) {
      issue("timeBand");
    }
    if (value.dateFrom != null && value.dateTo != null && value.dateFrom > value.dateTo) issue("dateTo");
    // 조건이 하나도 없으면 검색하지 않는다(계약 16 §5-1 — 에이전트는 「조건을 더 알려 주세요」만 낸다)
    const hasAny =
      value.instructor != null ||
      value.academy != null ||
      value.genre != null ||
      (value.weekdays ?? []).length > 0 ||
      value.timeBand != null ||
      value.level != null ||
      value.regionSido != null ||
      value.regionGu != null ||
      value.maxPriceAmount != null ||
      value.dateFrom != null ||
      value.dateTo != null;
    if (!hasAny) issue("conditions");
  });
export type SearchOfferingsInput = z.input<typeof searchOfferingsInputSchema>;
type ParsedInput = z.infer<typeof searchOfferingsInputSchema>;

// ---- 출력(계약 16 §5-2 offering_cards) ----------------------------------------------------------------

const patternItemSchema = z.strictObject({ weekday: z.enum(WEEKDAYS), startTime: hhmm, endTime: hhmm });

export const offeringCardSchema = z.strictObject({
  // 개인 레슨은 판매 단위가 없어 null 이고, classId(상품 수업 id)로 찾아간다
  offeringId: z.uuid().nullable(),
  classId: z.uuid(),
  title: z.string(),
  genre: z.enum(GENRES),
  isPrivateLesson: z.boolean(),
  academy: z.strictObject({ id: z.uuid(), name: z.string() }),
  hall: z.string().nullable(),
  pattern: z.array(patternItemSchema),
  firstSessionDate: z.iso.date(),
  lastSessionDate: z.iso.date(),
  sessionCount: z.int().min(1),
  level: z.enum(CLASS_TARGET_LEVELS).nullable(),
  pools: z.array(z.strictObject({ seatKind: z.enum(SEAT_KINDS), remaining: z.int().min(0) })),
  priceAmount: z.int().min(0),
  recruitStatus: z.enum(["open", "closing_soon", "full"]),
  // 대기 신청(FR-093, S4-4)이 생기기 전이라 늘 false
  waitlistAvailable: z.boolean(),
  // 이동은 수업 상세로만(SX-5.6) — 예약·결제를 일으키는 값은 없다
  action: offeringCardActionSchema,
});
export type OfferingCard = z.infer<typeof offeringCardSchema>;

// ---- 회차 한 칸(정규 회차 또는 레슨 모집 시간)을 조건에 비추기 --------------------------------------------

/** DB 가 KST 로 바꿔 준 회차 한 칸. endMinute 는 시작한 날 0시부터 센 분(자정을 넘기면 1440 을 넘는다) */
type Slot = { dow: number; startText: string; endText: string; startMinute: number; endMinute: number; dateText: string };

/** 조건의 요일·시간대·날짜에 이 한 칸이 들어가나. 자정을 넘기는 칸은 어떤 시간대에도 들지 않는다(홈 목록과 같은 규칙) */
function slotFits(input: ParsedInput, slot: Slot): boolean {
  const weekdays = input.weekdays ?? [];
  if (weekdays.length > 0 && !weekdays.includes(WEEKDAYS[slot.dow - 1] as (typeof WEEKDAYS)[number])) return false;
  if (input.timeBand != null) {
    const [from, to] = typeof input.timeBand === "string" ? TIME_BANDS[input.timeBand] : [toMinutes(input.timeBand.from), toMinutes(input.timeBand.to)];
    if (slot.startMinute < from || slot.endMinute > to) return false;
  }
  return true;
}

/** 칸들 → 요일·시간 묶음(월→일, 이른 시각 순, 같은 것은 하나로). 카드의 「요일·시간」 줄이 된다 */
function toPattern(slots: readonly Slot[]): OfferingCard["pattern"] {
  const seen = new Map<string, { weekday: (typeof WEEKDAYS)[number]; startTime: string; endTime: string; dow: number }>();
  for (const s of slots) {
    const key = `${s.dow}|${s.startText}|${s.endText}`;
    if (!seen.has(key)) seen.set(key, { weekday: WEEKDAYS[s.dow - 1] as (typeof WEEKDAYS)[number], startTime: s.startText, endTime: s.endText, dow: s.dow });
  }
  return [...seen.values()]
    .sort((a, b) => a.dow - b.dow || a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime))
    .map(({ weekday, startTime, endTime }) => ({ weekday, startTime, endTime }));
}

/**
 * 자리 묶음 → 모집 상태. 계약 16 §5-2 「W29 와 같은 함수」(isNearlyFull — 남은 자리 ≤ 2 또는 정원의 10% 이하).
 *   - 모든 묶음이 0 이면 마감(full)
 *   - 한 묶음이라도 0 이거나 임박이면 마감 임박(closing_soon) — 남자 자리만 다 찼어도 남자 회원에게는 곧 마감이다
 *   - 그 밖은 모집 중(open)
 */
function recruitStatusOf(pools: readonly { capacity: number; remaining: number }[]): OfferingCard["recruitStatus"] {
  if (pools.length > 0 && pools.every((p) => p.remaining === 0)) return "full";
  if (pools.some((p) => p.remaining === 0 || isNearlyFull(p.capacity, p.remaining))) return "closing_soon";
  return "open";
}

// ---- 읽기 -------------------------------------------------------------------------------------------

/** 정규·이벤트 수업: 한 줄 = (판매 단위, 그 판매 단위의 예정 회차 하나). JS 에서 판매 단위별로 묶는다 */
const OFFERING_SESSION_ROW = {
  offering_id: "pg/uuid@1",
  class_id: "pg/uuid@1",
  title: "pg/text@1",
  genre: "pg/text@1",
  academy_id: "pg/uuid@1",
  academy_name: "pg/text@1",
  hall: "pg/text@1",
  level: "pg/text@1",
  price_amount: "pg/int4@1",
  first_at: "pg/text@1",
  first_date: "pg/text@1",
  last_date: "pg/text@1",
  pools: "pg/text@1",
  dow: "pg/int4@1",
  start_text: "pg/text@1",
  end_text: "pg/text@1",
  start_minute: "pg/int4@1",
  end_minute: "pg/int4@1",
  date_text: "pg/text@1",
} as const;

/** 개인 레슨: 한 줄 = (상품, 지금 비어 있는 「레슨 모집」 시간 하나) */
const LESSON_SLOT_ROW = {
  class_id: "pg/uuid@1",
  title: "pg/text@1",
  genre: "pg/text@1",
  academy_id: "pg/uuid@1",
  academy_name: "pg/text@1",
  hall: "pg/text@1",
  price_amount: "pg/int4@1",
  session_count: "pg/int4@1",
  starts_at: "pg/text@1",
  dow: "pg/int4@1",
  start_text: "pg/text@1",
  end_text: "pg/text@1",
  start_minute: "pg/int4@1",
  end_minute: "pg/int4@1",
  date_text: "pg/text@1",
} as const;

const ISO_US_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/** 정렬용 열쇠를 붙인 카드 */
type Ranked = { card: OfferingCard; firstAt: string };

/** null·undefined → SQL 에서 「조건 없음」으로 읽는 빈 글자 */
const textOrEmpty = (value: string | number | null | undefined): string => (value == null ? "" : String(value));

async function readOfferingCards(deps: OfferingSearchDeps, input: ParsedInput): Promise<Ranked[]> {
  const { db } = deps;
  const now = deps.clock().toString();
  const instructorId = textOrEmpty(input.instructor?.id);
  const academyId = textOrEmpty(input.academy?.id);
  const genre = textOrEmpty(input.genre);
  const level = textOrEmpty(input.level);
  const sido = textOrEmpty(input.regionSido);
  const gu = textOrEmpty(input.regionGu);
  const maxPrice = textOrEmpty(input.maxPriceAmount);
  const dateFrom = textOrEmpty(input.dateFrom);
  const dateTo = textOrEmpty(input.dateTo);

  // 공개 조건은 홈 목록(S3-2.1)·상세(S3-2.3)와 같다. 비워 둔 조건은 '' 라 「조건 없음」이 된다(NULLIF 로 형 변환 오류를 막는다).
  // 자리 묶음 글자는 홈 목록과 같은 식(현장 등록 인원 포함)으로 만들어 buildCapacity 에 넘긴다.
  const rows = await db.query(
    db.raw.sql`SELECT o.id AS offering_id, c.id AS class_id, c.title, c.genre::text AS genre,
                      a.id AS academy_id, a.name AS academy_name, COALESCE(rm.name, '') AS hall,
                      COALESCE(c.target_level::text, '') AS level, o.price_amount::int4 AS price_amount,
                      to_char(o.first_session_starts_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS first_at,
                      to_char(o.first_session_starts_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS first_date,
                      to_char(o.last_session_ends_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS last_date,
                      COALESCE((SELECT string_agg(p.seat_kind::text || ':' || p.capacity || ':'
                                                  || (p.held_count + COALESCE((SELECT max(sc.onsite_count) FROM session_seat_counters sc
                                                                               JOIN class_sessions ss ON ss.id = sc.session_id
                                                                               WHERE ss.offering_id = p.offering_id AND sc.seat_kind = p.seat_kind
                                                                                 AND ss.status = 'scheduled' AND ss.ends_at > now()), 0))
                                                  || ':' || p.confirmed_count, ',')
                                FROM seat_pools p WHERE p.offering_id = o.id), '') AS pools,
                      extract(isodow FROM s.starts_at AT TIME ZONE 'Asia/Seoul')::int4 AS dow,
                      to_char(s.starts_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS start_text,
                      to_char(s.ends_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS end_text,
                      (extract(hour FROM s.starts_at AT TIME ZONE 'Asia/Seoul') * 60
                        + extract(minute FROM s.starts_at AT TIME ZONE 'Asia/Seoul'))::int4 AS start_minute,
                      (extract(epoch FROM (s.ends_at AT TIME ZONE 'Asia/Seoul') - date_trunc('day', s.starts_at AT TIME ZONE 'Asia/Seoul')) / 60)::int4 AS end_minute,
                      to_char(s.starts_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS date_text
               FROM class_offerings o
               JOIN classes c ON c.id = o.class_id
               JOIN academies a ON a.id = c.academy_id
               LEFT JOIN rooms rm ON rm.id = c.room_id
               JOIN class_sessions s ON s.offering_id = o.id AND s.status = 'scheduled'
               WHERE c.status = 'published'
                 AND o.status = 'open'
                 AND a.status = 'active'
                 AND NOT EXISTS (SELECT 1 FROM academy_restrictions r
                                 WHERE r.academy_id = a.id AND r.kind = 'listing_suspended' AND r.ended_at IS NULL)
                 AND o.first_session_starts_at > ${now}::timestamptz
                 AND (${instructorId} = '' OR c.instructor_account_id = NULLIF(${instructorId}, '')::uuid)
                 AND (${academyId} = '' OR a.id = NULLIF(${academyId}, '')::uuid)
                 AND (${genre} = '' OR c.genre::text = ${genre})
                 AND (${level} = '' OR c.target_level::text = ${level})
                 AND (${sido} = '' OR a.region_sido = ${sido})
                 AND (${gu} = '' OR a.region_gu = ${gu})
                 AND (${maxPrice} = '' OR o.price_amount <= NULLIF(${maxPrice}, '')::int4)
                 -- 날짜는 첫 회차 날짜(KST)로 본다 — 홈 목록 ?from=&to= 와 같은 기준
                 AND (${dateFrom} = '' OR (o.first_session_starts_at AT TIME ZONE 'Asia/Seoul')::date >= NULLIF(${dateFrom}, '')::date)
                 AND (${dateTo} = '' OR (o.first_session_starts_at AT TIME ZONE 'Asia/Seoul')::date <= NULLIF(${dateTo}, '')::date)
               ORDER BY o.first_session_starts_at ASC, o.id ASC, s.starts_at ASC`
      .returnsRow(OFFERING_SESSION_ROW)
      .build(),
  );

  // 판매 단위별로 회차를 모은다. 요일·시간대는 **모든 예정 회차**가 들어가야 맞는 수업이다(홈 목록 가능 시간대와 같은 규칙) —
  // 「주말 오전」으로 물었는데 평일 저녁 회차가 섞인 수업이 나오면 조건을 어긴 답이 된다.
  const groups = new Map<string, { rows: (typeof rows)[number][]; slots: Slot[] }>();
  for (const row of rows) {
    const group = groups.get(row.offering_id) ?? { rows: [], slots: [] };
    group.rows.push(row);
    group.slots.push({
      dow: row.dow,
      startText: row.start_text,
      endText: row.end_text,
      startMinute: row.start_minute,
      endMinute: row.end_minute,
      dateText: row.date_text,
    });
    groups.set(row.offering_id, group);
  }

  const ranked: Ranked[] = [];
  for (const { rows: offeringRows, slots } of groups.values()) {
    const head = offeringRows[0];
    if (head === undefined || !slots.every((slot) => slotFits(input, slot))) continue;
    const capacity = buildCapacity(head.pools);
    ranked.push({
      firstAt: head.first_at,
      card: offeringCardSchema.parse({
        offeringId: head.offering_id,
        classId: head.class_id,
        title: head.title,
        genre: head.genre,
        isPrivateLesson: false,
        academy: { id: head.academy_id, name: head.academy_name },
        hall: head.hall === "" ? null : head.hall,
        pattern: toPattern(slots),
        firstSessionDate: head.first_date,
        lastSessionDate: head.last_date,
        sessionCount: slots.length,
        level: head.level === "" ? null : head.level,
        pools: capacity.pools.map((p) => ({ seatKind: p.seatKind, remaining: p.remaining })),
        priceAmount: head.price_amount,
        recruitStatus: recruitStatusOf(capacity.pools),
        waitlistAvailable: false,
        // 버튼은 수업 상세로 가기뿐 — 값은 한 함수로만 만든다(SX-5.6)
        action: openOfferingAction(head.offering_id, head.class_id),
      }),
    });
  }
  return ranked;
}

/**
 * 개인 레슨 상품 카드. 「레슨 모집」(status = 'open') 이면서 지금 이후인 시간만 읽는다(FR-052c).
 * 상품이 열려 있고(open) 강사가 그 학원에 지금 active 로 소속돼 있어야 한다(소속이 끝나면 그 학원에서 팔 수 없다).
 * 개인 레슨에는 레벨이 없어, 레벨 조건이 있으면 개인 레슨은 고르지 않는다. 요일·시간대·날짜는 **시간 칸마다** 걸러,
 * 맞는 칸이 하나라도 남은 상품만 카드가 된다 — 레슨은 회원이 그중 한 칸을 고르는 것이라 전부 맞을 필요가 없다.
 */
async function readPrivateLessonCards(deps: OfferingSearchDeps, input: ParsedInput): Promise<Ranked[]> {
  if (input.level != null) return [];
  const { db } = deps;
  const now = deps.clock().toString();
  const instructorId = textOrEmpty(input.instructor?.id);
  const academyId = textOrEmpty(input.academy?.id);
  const genre = textOrEmpty(input.genre);
  const sido = textOrEmpty(input.regionSido);
  const gu = textOrEmpty(input.regionGu);
  const maxPrice = textOrEmpty(input.maxPriceAmount);

  const rows = await db.query(
    db.raw.sql`SELECT c.id AS class_id, c.title, c.genre::text AS genre, a.id AS academy_id, a.name AS academy_name,
                      COALESCE(rm.name, '') AS hall, p.price_amount::int4 AS price_amount, p.session_count::int4 AS session_count,
                      to_char(s.starts_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS starts_at,
                      extract(isodow FROM s.starts_at AT TIME ZONE 'Asia/Seoul')::int4 AS dow,
                      to_char(s.starts_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS start_text,
                      to_char(s.ends_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS end_text,
                      (extract(hour FROM s.starts_at AT TIME ZONE 'Asia/Seoul') * 60
                        + extract(minute FROM s.starts_at AT TIME ZONE 'Asia/Seoul'))::int4 AS start_minute,
                      (extract(epoch FROM (s.ends_at AT TIME ZONE 'Asia/Seoul') - date_trunc('day', s.starts_at AT TIME ZONE 'Asia/Seoul')) / 60)::int4 AS end_minute,
                      to_char(s.starts_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS date_text
               FROM classes c
               JOIN private_lesson_products p ON p.class_id = c.id
               JOIN academies a ON a.id = c.academy_id
               JOIN private_lesson_slots s ON s.product_class_id = c.id AND s.status = 'open' AND s.starts_at > ${now}::timestamptz
               LEFT JOIN rooms rm ON rm.id = s.room_id
               WHERE c.class_kind = 'private_lesson'
                 AND c.status = 'published'
                 AND p.status = 'open'
                 AND a.status = 'active'
                 AND NOT EXISTS (SELECT 1 FROM academy_restrictions r
                                 WHERE r.academy_id = a.id AND r.kind = 'listing_suspended' AND r.ended_at IS NULL)
                 AND EXISTS (SELECT 1 FROM instructor_affiliations f
                             WHERE f.academy_id = a.id AND f.instructor_account_id = c.instructor_account_id AND f.status = 'active')
                 AND (${instructorId} = '' OR c.instructor_account_id = NULLIF(${instructorId}, '')::uuid)
                 AND (${academyId} = '' OR a.id = NULLIF(${academyId}, '')::uuid)
                 AND (${genre} = '' OR c.genre::text = ${genre})
                 AND (${sido} = '' OR a.region_sido = ${sido})
                 AND (${gu} = '' OR a.region_gu = ${gu})
                 AND (${maxPrice} = '' OR p.price_amount <= NULLIF(${maxPrice}, '')::int4)
               ORDER BY s.starts_at ASC, c.id ASC`
      .returnsRow(LESSON_SLOT_ROW)
      .build(),
  );

  const groups = new Map<string, { rows: (typeof rows)[number][]; slots: Slot[] }>();
  for (const row of rows) {
    const slot: Slot = {
      dow: row.dow,
      startText: row.start_text,
      endText: row.end_text,
      startMinute: row.start_minute,
      endMinute: row.end_minute,
      dateText: row.date_text,
    };
    // 날짜 조건은 개인 레슨에서는 시간 칸의 날짜로 본다
    if (!slotFits(input, slot)) continue;
    if (input.dateFrom != null && slot.dateText < input.dateFrom) continue;
    if (input.dateTo != null && slot.dateText > input.dateTo) continue;
    const group = groups.get(row.class_id) ?? { rows: [], slots: [] };
    group.rows.push(row);
    group.slots.push(slot);
    groups.set(row.class_id, group);
  }

  const ranked: Ranked[] = [];
  for (const { rows: lessonRows, slots } of groups.values()) {
    const head = lessonRows[0];
    const last = slots.at(-1);
    if (head === undefined || last === undefined) continue;
    ranked.push({
      firstAt: head.starts_at,
      card: offeringCardSchema.parse({
        offeringId: null,
        classId: head.class_id,
        title: head.title,
        genre: head.genre as Genre,
        isPrivateLesson: true,
        academy: { id: head.academy_id, name: head.academy_name },
        // 첫 「레슨 모집」 시간의 홀(홀을 고르지 않고 연 시간이면 null)
        hall: head.hall === "" ? null : head.hall,
        pattern: toPattern(slots),
        firstSessionDate: slots[0]?.dateText ?? last.dateText,
        lastSessionDate: last.dateText,
        // 수강권 한 장의 횟수(상품 값 그대로)
        sessionCount: head.session_count,
        level: null,
        // 1:1 레슨이라 남·여 자리 묶음이 없다 — 남은 「레슨 모집」 시간이 있으면 모집 중이다
        pools: [],
        priceAmount: head.price_amount,
        recruitStatus: "open",
        waitlistAvailable: false,
        action: openOfferingAction(null, head.class_id),
      }),
    });
  }
  return ranked;
}

/**
 * 조건 → 수업 카드(첫 회차가 가까운 순, 같으면 id 순). 조건은 searchOfferingsInputSchema 로 한 번 더 검사한다.
 * 결과에 없는 수업은 만들지 않는다 — 카드 하나하나가 위 두 SELECT 의 행에서 나온다(지어낸 수업 0건, SX-5 수용 ①).
 */
export async function searchOfferingCards(deps: OfferingSearchDeps, rawInput: SearchOfferingsInput): Promise<OfferingCard[]> {
  const input = searchOfferingsInputSchema.parse(rawInput);
  const [offerings, lessons] = await Promise.all([readOfferingCards(deps, input), readPrivateLessonCards(deps, input)]);
  return [...offerings, ...lessons]
    .sort((a, b) => a.firstAt.localeCompare(b.firstAt) || (a.card.offeringId ?? a.card.classId).localeCompare(b.card.offeringId ?? b.card.classId))
    .slice(0, input.limit)
    .map((r) => r.card);
}
