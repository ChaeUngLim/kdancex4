// S3-2.1(홈 목록 API) — `GET /api/home/offerings`(계약 02 §1). 회원 홈에 「지금 신청할 수 있는 수업」을 거른 목록으로 준다.
//   요구: FR-030(수업 검색) · FR-033(시간대 필터) · FR-090(정원·신청 인원 표시) · FR-022a(첫 화면 장르 선택·유지)
//   데이터: 03_data-model.md §4-4 seat_pools(남은 자리 = 정원 − 잡힌 자리 − 확정) · §7-3 academies(status) · §8-2 classes·class_offerings·class_sessions
//
// 거르는 조건은 쿼리 문자열이 아니라 **내 프로필**에서 온다(Q1(홈 목록: 거르기 vs 정렬) = 거르기, 2026-11-06 사용자 결정):
//   - 장르: members.base_genre 하나. 비어 있으면 409 BASE_GENRE_REQUIRED — 「고르기 전에는 홈 데이터를 주지 않는다」(AC-9)를
//           화면이 아니라 API 에서 막는다(화면만 막으면 주소를 직접 불러 우회된다)
//   - 지역: member_regions 가 있으면 학원의 (시·도, 구)가 그중 하나와 같아야 한다. 없으면 조건을 뺀다
//   - 가능 시간대: available_from~to 가 있으면 판매 단위의 **모든 예정 회차**가 KST 하루 시각으로 [from, to] 안이어야 한다.
//                  KST 자정을 넘기는 회차는 하루 안의 구간이 아니라 밖으로 본다(domain/time.ts isWithinKstTimeWindow 와 같은 규칙)
//   - 날짜: ?from=&to=(선택, KST 달력) — 첫 회차 날짜가 그 안. 비우면 「지금 이후」 전부
//
// 「보여도 되는 수업」(플랜 S3-2 수용 ③ — 승인 전·입점 심사 전 학원의 수업은 나오지 않는다):
//   - 수업 status = 'published'(대표가 승인했거나 대표가 직접 올린 것 — S2-2 가 만든 상태). 임시 저장·승인 대기는 안 나온다
//   - 판매 단위 status = 'open' 이고 첫 회차가 지금 이후
//   - 학원 status = 'active'. 입점 심사 전 학원은 academies 행 자체가 없어(승인 트랜잭션이 처음 만든다) 수업이 붙을 수 없고,
//     승인 뒤 게시 제한(restricted)·해지(termination_requested·terminated)가 되면 그때부터 목록에서 빠진다
//   - 사업자 점검이 연 노출 중지(academy_restrictions.kind = 'listing_suspended', 끝나지 않은 것, FR-254)도 뺀다
//
// 정렬(S3-2.2(시간대 필터·정렬)): `?sort=recommended|deadline|seats` — 기준은 lib/domain/home-offering-sort.ts 의 순수 함수다.
//   거르기(위 조건)는 정렬과 상관없이 그대로이고, 거른 후보를 그 함수로 줄 세운 뒤 커서 뒤의 한 쪽을 자른다.
//   거리 정렬은 만들지 않는다(로드맵 S3-2 「먼저 정할 것」 — 지도 API 무료 구간 확인이 먼저).
//
// 읽기 전 정리(계약 02 §1 「목록을 읽기 전에」, D15): 목록을 읽기 직전에 기한 지난 결제 대기를 모두 정리한다(S3-3.7 order-expiry.ts).
//   스케줄러가 없어도 잔여석이 「기한 지난 결제 대기가 잡고 있는 자리」를 빼고 보이게 하려는 것이다.
import { z } from "zod";

import { CLASS_KINDS, ENROLLMENT_UNITS, GENRES, SEAT_KINDS } from "../../domain/constants";
import {
  compareSortKeys,
  DEFAULT_HOME_OFFERING_SORT,
  HOME_OFFERING_SORTS,
  recommendedScore,
  sortHomeOfferings,
  sortKeyOf,
  type HomeOfferingSort,
  type HomeSortKey,
  type SortableOffering,
} from "../../domain/home-offering-sort";
import { kstDateRangeToInstants, parseKstDate, type Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, parseWith, withRoute } from "../http";
import type { PaymentGatewayPort } from "../ports/payment-gateway";
import { expireDuePayments } from "./order-expiry";

export type HomeOfferingsDeps = GuardDeps & {
  readonly clock: Clock;
  /** 읽기 전 정리가 만료한 결제의 계좌를 PG 에서 폐기할 때 쓴다(S3-3.7) */
  readonly paymentGateway: PaymentGatewayPort;
};

const DETAIL = {
  baseGenreRequired: "먼저 보고 싶은 장르를 골라 주세요",
  badCursor: "목록 위치(cursor)가 올바르지 않아요. 처음부터 다시 불러 주세요",
  badRange: "끝 날짜가 시작 날짜보다 앞이에요",
  badDate: "날짜는 YYYY-MM-DD 형식이에요",
  cursorSortMismatch: "목록 위치(cursor)가 다른 정렬의 것이에요. 처음부터 다시 불러 주세요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** 한 쪽 기본 개수와 최대 개수(계약 02 §1 「기본 20, 최대 50」) */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// DB 가 내주는 시각 모양(마이크로초까지). 커서 안 시각이 이 모양이 아니면 받지 않는다
const CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ISO_US_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

// ---- 커서 = 이 쪽에서 마지막으로 본 (정렬, 주 값, 첫 회차 시작 시각, 판매 단위 id) ------------------
// 정렬마다 줄 세우는 기준이 달라 커서도 정렬 값마다 따로다(계약 02 §1). 커서 안의 정렬과 요청의 sort 가 다르면 받지 않는다.
// 마지막에 id 까지 넣어 한 줄로 세우므로, 쪽을 넘길 때 겹치거나 빠지는 행이 없다.

type Cursor = { sort: HomeOfferingSort; key: HomeSortKey };

export function encodeHomeCursor(cursor: Cursor): string {
  const { sort, key } = cursor;
  return Buffer.from(`${sort}|${key.primary}|${key.firstAt}|${key.offeringId}`, "utf8").toString("base64url");
}

export function decodeHomeCursor(raw: string): Cursor | null {
  const [sort, primary, at, id, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (rest.length > 0 || sort === undefined || primary === undefined || at === undefined || id === undefined) return null;
  const knownSort = HOME_OFFERING_SORTS.find((s) => s === sort);
  if (knownSort === undefined || !/^-?\d{1,9}$/.test(primary)) return null;
  if (!CURSOR_TIME_PATTERN.test(at) || !UUID_PATTERN.test(id)) return null;
  return { sort: knownSort, key: { primary: Number(primary), firstAt: at, offeringId: id } };
}

// ---- 요청(쿼리 문자열) — 모르는 키는 받지 않는다(지역·장르를 쿼리로 바꿔 끼우는 길을 열지 않는다) ----

const kstDateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, DETAIL.badDate)
  .transform((value, ctx) => {
    try {
      return parseKstDate(value);
    } catch {
      ctx.addIssue({ code: "custom", message: DETAIL.badDate });
      return z.NEVER;
    }
  });

export const homeOfferingsQuerySchema = z
  .strictObject({
    from: kstDateParam.optional(),
    to: kstDateParam.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    // 모르는 정렬 값(예: 거리 distance, 아직 없는 popular)은 422 VALIDATION_FAILED
    sort: z.enum(HOME_OFFERING_SORTS).default(DEFAULT_HOME_OFFERING_SORT),
    cursor: z
      .string()
      .max(200)
      .optional()
      .transform((value, ctx) => {
        if (value === undefined || value === "") return undefined;
        const decoded = decodeHomeCursor(value);
        if (decoded === null) {
          ctx.addIssue({ code: "custom", message: DETAIL.badCursor });
          return z.NEVER;
        }
        return decoded;
      }),
  })
  .superRefine((q, ctx) => {
    if (q.from !== undefined && q.to !== undefined && Temporal.PlainDate.compare(q.from, q.to) > 0) {
      ctx.addIssue({ code: "custom", path: ["to"], message: DETAIL.badRange });
    }
    // 다른 정렬로 받은 커서를 이어 쓰면 줄 세운 기준이 달라 행이 겹치거나 빠진다 — 받지 않는다
    if (q.cursor !== undefined && q.cursor.sort !== q.sort) {
      ctx.addIssue({ code: "custom", path: ["cursor"], message: DETAIL.cursorSortMismatch });
    }
  });

// ---- 응답(계약 02 §1) — 테스트가 본문을 이 스키마로 parse 한다(strict: 모르는 키가 섞이면 실패) ----

const isoInstant = z.iso.datetime({ offset: true });

export const homeSeatPoolSchema = z.strictObject({
  seatKind: z.enum(SEAT_KINDS),
  capacity: z.int().min(1),
  enrolled: z.int().min(0),
  remaining: z.int().min(0),
});

export const homeOfferingItemSchema = z.strictObject({
  offeringId: z.uuid(),
  classId: z.uuid(),
  title: z.string(),
  genre: z.enum(GENRES),
  classKind: z.enum(CLASS_KINDS),
  academy: z.strictObject({ id: z.uuid(), name: z.string(), regionSido: z.string(), regionGu: z.string() }),
  label: z.string(),
  enrollmentUnit: z.enum(ENROLLMENT_UNITS),
  sessionCount: z.int().min(1),
  firstSessionStartsAt: isoInstant,
  lastSessionEndsAt: isoInstant,
  priceAmount: z.int().min(0),
  capacity: z.strictObject({ total: z.int().min(0), enrolled: z.int().min(0), pools: z.array(homeSeatPoolSchema) }),
});
export type HomeOfferingItem = z.infer<typeof homeOfferingItemSchema>;

export const homeOfferingsResponseSchema = z.strictObject({
  items: z.array(homeOfferingItemSchema),
  nextCursor: z.string().nullable(),
});

// ---- 읽기 -----------------------------------------------------------------------------------------

const OFFERING_ROW = {
  offering_id: "pg/uuid@1",
  class_id: "pg/uuid@1",
  title: "pg/text@1",
  genre: "pg/text@1",
  class_kind: "pg/text@1",
  academy_id: "pg/uuid@1",
  academy_name: "pg/text@1",
  region_sido: "pg/text@1",
  region_gu: "pg/text@1",
  label: "pg/text@1",
  enrollment_unit: "pg/text@1",
  session_count: "pg/int4@1",
  first_at: "pg/text@1",
  last_at: "pg/text@1",
  price_amount: "pg/int4@1",
  // 자리 묶음은 「종류:정원:잡힘:확정」을 쉼표로 이은 글자로 받는다(raw 레인에서 배열·JSON 칸을 피하려는 것)
  pools: "pg/text@1",
} as const;

type PoolCounts = { seatKind: (typeof SEAT_KINDS)[number]; capacity: number; held: number; confirmed: number };

/** "male:6:2:1,female:6:0:0" → 자리 묶음 목록. 순서는 남 → 여 → 구분 없음으로 고정한다(앱 카드가 늘 같은 순서로 그리게) */
function parsePools(text: string): PoolCounts[] {
  if (text === "") return [];
  const pools = text.split(",").map((part) => {
    const [kind, capacity, held, confirmed] = part.split(":");
    return {
      seatKind: z.enum(SEAT_KINDS).parse(kind),
      capacity: Number(capacity),
      held: Number(held),
      confirmed: Number(confirmed),
    };
  });
  return [...pools].sort((a, b) => SEAT_KINDS.indexOf(a.seatKind) - SEAT_KINDS.indexOf(b.seatKind));
}

/**
 * 자리 묶음 글자("종류:정원:잡힘:확정,…") → 응답의 capacity 묶음. 홈 목록과 수업 상세(S3-2.3)가 같이 쓴다.
 * 신청 인원(enrolled)은 **확정(confirmed)만** 센다 — 결제 대기(held)는 아직 돈이 들어오지 않은 자리라 「신청했다」고 보이지 않는다
 * (플랜 S3-2 수용 ②). 다만 남은 자리(remaining)에서는 잡힌 자리도 빼야 실제로 살 수 있는 수가 된다(data-model §4-4).
 */
export function buildCapacity(poolsText: string): HomeOfferingItem["capacity"] {
  const pools = parsePools(poolsText).map((p) => ({
    seatKind: p.seatKind,
    capacity: p.capacity,
    enrolled: p.confirmed,
    remaining: Math.max(0, p.capacity - p.held - p.confirmed),
  }));
  return {
    total: pools.reduce((sum, p) => sum + p.capacity, 0),
    enrolled: pools.reduce((sum, p) => sum + p.enrolled, 0),
    pools,
  };
}

/**
 * DB 한 줄 → 응답 항목. 자리 숫자는 buildCapacity 가 만든다(확정만 신청 인원).
 */
function toItem(row: { [K in keyof typeof OFFERING_ROW]: K extends "session_count" | "price_amount" ? number : string }): HomeOfferingItem {
  return homeOfferingItemSchema.parse({
    offeringId: row.offering_id,
    classId: row.class_id,
    title: row.title,
    genre: row.genre,
    classKind: row.class_kind,
    academy: { id: row.academy_id, name: row.academy_name, regionSido: row.region_sido, regionGu: row.region_gu },
    label: row.label,
    enrollmentUnit: row.enrollment_unit,
    sessionCount: row.session_count,
    firstSessionStartsAt: row.first_at,
    lastSessionEndsAt: row.last_at,
    priceAmount: row.price_amount,
    capacity: buildCapacity(row.pools),
  });
}

/** `GET /api/home/offerings` 처리기. 회원만(세션 없음 401 · 가입 전 403 SIGNUP_INCOMPLETE) */
export function createHomeOfferingsRoute(deps: HomeOfferingsDeps) {
  const guards = createGuards(deps);
  const { db } = deps;

  return withRoute<unknown>(async (request) => {
    const { memberId } = await guards.requireMember(request);
    const query = parseWith(homeOfferingsQuerySchema, Object.fromEntries(new URL(request.url).searchParams));

    // ① 기준 장르가 없으면 목록을 주지 않는다(409). 앱은 이 코드를 보고 장르 선택 화면으로 보낸다(플랜 S3-2 수용 ①)
    //    추천 점수용으로 「관심 지역·가능 시간대를 골랐나」도 같이 읽는다(비워 둔 조건은 점수에서 빠진다)
    const [me] = await db.query(
      db.raw.sql`SELECT COALESCE(base_genre, '') AS base_genre,
                        (SELECT count(*)::int4 FROM member_regions mr WHERE mr.member_id = members.id) AS region_count,
                        (available_from IS NOT NULL)::text AS has_window
                 FROM members WHERE id = ${memberId}::uuid`
        .returnsRow({ base_genre: "pg/text@1", region_count: "pg/int4@1", has_window: "pg/text@1" })
        .build(),
    );
    const baseGenre = GENRES.find((g) => g === me?.base_genre);
    if (baseGenre === undefined) throw HttpError.conflict("BASE_GENRE_REQUIRED", DETAIL.baseGenreRequired);

    // ①-1 읽기 전 정리(D15) — 기한 지난 결제 대기를 전부 닫아 자리를 푼 뒤에 잔여석을 읽는다(계약 03 §5, 범위는 전부)
    await expireDuePayments(deps);

    // ② 날짜 범위 → 순간 구간. 이미 시작한 수업은 날짜와 상관없이 안 나온다(첫 회차 > 지금)
    const now = deps.clock();
    // from 은 그날 0시(KST)부터(그 시각 포함). 없으면 아주 이른 때 — 「지금 이후」 조건만 남는다
    const fromStart = query.from === undefined ? "-infinity" : kstDateRangeToInstants(query.from, query.from).start.toString();
    // to 는 그날 끝(다음 날 0시 KST, 그 시각은 빼고)까지. 없으면 끝이 없다
    const endBefore = query.to === undefined ? "infinity" : kstDateRangeToInstants(query.to, query.to).endExclusive.toString();

    const pageSize = query.limit ?? DEFAULT_PAGE_SIZE;

    // ③ 거른 후보를 모두 읽는다. 잔여석·추천 점수는 DB 열이 아니라 계산값이라, 줄 세우기와 쪽 자르기를
    //    SQL 이 아니라 순수 함수(home-offering-sort.ts)로 한다. 후보는 이미 기준 장르 하나 + 관심 지역·시간대로 좁혀져 있고
    //    베타 규모(회원 1~10명, 학원 몇 곳)에서는 몇십 줄이다. 검색 1초(SC-015) 측정 방법은 S3-2 「먼저 정할 것」에 열려 있다.
    //    지역·시간대 조건은 회원 행을 이 쿼리 안에서 다시 읽어 건다 — 앱이 보낸 값이 아니라 저장된 프로필만 쓰게.
    const rows = await db.query(
      db.raw.sql`SELECT o.id AS offering_id, c.id AS class_id, c.title, c.genre::text AS genre, c.class_kind::text AS class_kind,
                        a.id AS academy_id, a.name AS academy_name, a.region_sido, a.region_gu,
                        o.label, o.enrollment_unit::text AS enrollment_unit,
                        (SELECT count(*)::int4 FROM class_sessions s WHERE s.offering_id = o.id AND s.status = 'scheduled') AS session_count,
                        to_char(o.first_session_starts_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS first_at,
                        to_char(o.last_session_ends_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS last_at,
                        o.price_amount::int4 AS price_amount,
                        -- 잡힌 자리 칸에는 앞으로 올 회차의 현장 등록 인원 최댓값(S3-5.4, 계약 18 §6 규칙 7)을 더해 넘긴다 — 남은 자리 계산에만 쓰인다
                        COALESCE((SELECT string_agg(p.seat_kind::text || ':' || p.capacity || ':'
                                                    || (p.held_count + COALESCE((SELECT max(sc.onsite_count) FROM session_seat_counters sc
                                                                                 JOIN class_sessions ss ON ss.id = sc.session_id
                                                                                 WHERE ss.offering_id = p.offering_id AND sc.seat_kind = p.seat_kind
                                                                                   AND ss.status = 'scheduled' AND ss.ends_at > now()), 0))
                                                    || ':' || p.confirmed_count, ',')
                                  FROM seat_pools p WHERE p.offering_id = o.id), '') AS pools
                 FROM class_offerings o
                 JOIN classes c ON c.id = o.class_id
                 JOIN academies a ON a.id = c.academy_id
                 JOIN members m ON m.id = ${memberId}::uuid
                 WHERE c.status = 'published'
                   AND o.status = 'open'
                   AND a.status = 'active'
                   AND NOT EXISTS (SELECT 1 FROM academy_restrictions r
                                   WHERE r.academy_id = a.id AND r.kind = 'listing_suspended' AND r.ended_at IS NULL)
                   AND c.genre = ${baseGenre}
                   -- 세부 장르(FR-022a): 회원이 「전체」(NULL)면 조건 없음, 「라틴」처럼 골랐으면 같은 세부 장르 수업만
                   AND (m.base_sub_genre IS NULL OR c.sub_genre = m.base_sub_genre)
                   -- 관심 지역: 하나도 없으면 조건 없음, 있으면 학원의 시·구가 그중 하나
                   AND (NOT EXISTS (SELECT 1 FROM member_regions mr WHERE mr.member_id = m.id)
                        OR EXISTS (SELECT 1 FROM member_regions mr
                                   WHERE mr.member_id = m.id AND mr.region_sido = a.region_sido AND mr.region_gu = a.region_gu))
                   -- 가능 시간대: 비어 있으면 조건 없음, 있으면 예정 회차 중 하나라도 밖이면 뺀다(자정을 넘기는 회차는 밖)
                   AND (m.available_from IS NULL OR NOT EXISTS (
                         SELECT 1 FROM class_sessions s
                         WHERE s.offering_id = o.id AND s.status = 'scheduled'
                           AND NOT ((s.starts_at AT TIME ZONE 'Asia/Seoul')::date = (s.ends_at AT TIME ZONE 'Asia/Seoul')::date
                                    AND (s.starts_at AT TIME ZONE 'Asia/Seoul')::time >= m.available_from
                                    AND (s.ends_at AT TIME ZONE 'Asia/Seoul')::time <= m.available_to)))
                   -- 예정 회차가 하나도 없는 판매 단위(전부 휴강·폐강)는 신청할 것이 없다
                   AND EXISTS (SELECT 1 FROM class_sessions s WHERE s.offering_id = o.id AND s.status = 'scheduled')
                   AND o.first_session_starts_at > ${now.toString()}::timestamptz
                   AND o.first_session_starts_at >= ${fromStart}::timestamptz
                   AND o.first_session_starts_at < ${endBefore}::timestamptz
                 ORDER BY o.first_session_starts_at ASC, o.id ASC`
        .returnsRow(OFFERING_ROW)
        .build(),
    );

    // ④ 정렬 재료를 붙인다. 위 쿼리가 장르·지역·시간대로 이미 걸렀으므로 남은 후보는 고른 조건에 모두 맞는다 —
    //    그래서 지금 추천 점수는 「무엇을 비워 두었나」에만 달라지고 후보끼리는 같다(같으면 첫 회차 → id 순).
    //    인기는 0(2026-11-23 사용자 결정, 조회 수 표는 S6-2)
    const score = recommendedScore({
      genreMatch: true,
      regionMatch: (me?.region_count ?? 0) > 0 ? true : null,
      timeMatch: me?.has_window === "true" ? true : null,
      popularity: 0,
    });
    const candidates = rows.map((row): SortableOffering & { item: HomeOfferingItem } => {
      const item = toItem(row);
      return {
        item,
        offeringId: item.offeringId,
        firstAt: row.first_at,
        remainingSeats: item.capacity.pools.reduce((sum, p) => sum + p.remaining, 0),
        recommendedScore: score,
      };
    });
    const ordered = sortHomeOfferings(query.sort, candidates);

    // ⑤ 커서가 있으면 그 열쇠보다 뒤인 것만 남기고 한 쪽(+1 로 다음 쪽 여부)을 자른다
    const after = query.cursor?.key;
    const rest = after === undefined ? ordered : ordered.filter((o) => compareSortKeys(sortKeyOf(query.sort, o), after) > 0);
    const page = rest.slice(0, pageSize);
    const last = page.at(-1);
    const nextCursor =
      rest.length > pageSize && last !== undefined ? encodeHomeCursor({ sort: query.sort, key: sortKeyOf(query.sort, last) }) : null;
    const body = homeOfferingsResponseSchema.parse({ items: page.map((o) => o.item), nextCursor });
    return Response.json(body, { status: 200, headers: NO_STORE });
  });
}
