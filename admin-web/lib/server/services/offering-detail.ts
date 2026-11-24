// S3-2.3(수업 상세 API) — `GET /api/offerings/{offeringId}`(계약 02 §2). 회원이 홈 카드를 눌렀을 때 보는 수업 상세.
//   요구: FR-090(정원·신청 인원 표시) · FR-092(성별 정원) · FR-092c(성별 구분 없는 단일 정원) · AC-7(성별 자리 기본값)
//   데이터: 03_data-model.md §4-4 seat_pools — 화면의 「신청 인원」 = confirmed_count, 「잔여」 = capacity − held_count − confirmed_count
//
// 이 파일이 하는 일은 세 가지다.
//   ① 「보여도 되는 판매 단위」만 찾는다 — 홈 목록(S3-2.1)과 같은 기준(게시된 수업 · 열린 판매 단위 · 활동 중인 학원 · 노출 중지 없음).
//      기준에 안 맞으면 있는지조차 알리지 않고 404 NOT_FOUND 로 답한다(승인 전 수업 id 를 알아도 내용을 못 본다)
//   ② 자리 묶음별 정원·신청 인원·잔여를 낸다. 신청 인원은 **확정만** 센다 — 결제 대기(held)는 돈이 아직 안 들어온 자리라
//      「신청했다」고 보이지 않는다(플랜 S3-2 수용 ②). 계산은 홈 목록과 한 함수(buildCapacity)를 써서 둘이 어긋나지 않게 한다
//   ③ 기본 자리(seatSelection)를 회원 성별로 고른다. 성별 정원이면 같은 성별 자리, 단일 정원이면 any 하나.
//      **마감이어도 기본 선택은 바꾸지 않는다**(계약 02 §2 시나리오 6 — 앱이 「마감」 표시 + 결제 버튼을 끈다)
//
// S3-2.4(판매자 정보·결제 전 정책)에서 더한 것 — 결제 버튼을 누르기 전에 회원이 봐야 하는 세 가지(FR-241 · FR-282):
//   - seller: 학원(판매자)의 상호·대표자·사업자등록번호 등 6항목. 대표 학원 설정과 같은 목록(lib/domain/seller-info.ts)
//   - refundNotice: 이 수업에 붙은 환불·취소 공지 판본(classes.refund_notice_version_id). 「학원의 최신 공지」가 아니라
//     **승인 때 수업에 고정된 판본**을 읽는다 — 대표가 공지를 새로 써도 이미 게시된 수업의 약속은 바뀌지 않는다.
//     판본이 안 붙어 있으면(0원 이벤트형 등) null 로 주고, 주문 생성이 409 NOTICE_MISSING 으로 막는다(계약 02 §2)
//   - intermediaryNotice: 회사가 통신판매중개자라는 고정 고지(lib/domain/intermediary-notice.ts)
//
// S3-3.15b(결제 화면용 서버 조각)에서 더한 것 — 앱 결제 화면(S3-3.16)이 서버 값만으로 그려지게:
//   - classKind: 수업 구분(정규·원데이·이벤트 …). 앱이 결제수단 목록(이벤트형은 계좌이체만, FR-280)을 고를 때 쓴다
//   - priceBreakdownPreview: 결제 전 가격 내역(정가 → 혜택 할인 → 쿠폰 → 예매 수수료 → 최종, README §3).
//     **주문 생성이 금액을 정하는 함수(computeOrderAmounts)를 그대로 부른다** — 화면에 보인 금액과 실제 주문 금액이
//     다를 수 없게 하려는 것이다. 이벤트형 유료 수업이면 예매 수수료 2,000원 줄이 들어 있다(FR-282a)
//
// 아직 내지 않는 계약 §2 칸: myReservation(주문이 생긴 뒤의 내 예약) — 결제 뒤 화면 Task 의 몫
import { z } from "zod";

import { computeOrderAmounts } from "../../domain/checkout";
import { CLASS_KINDS, GENDERS, SEAT_KINDS, SEAT_MODES } from "../../domain/constants";
import { PRICE_LINE_KINDS } from "../../domain/money";
import { INTERMEDIARY_NOTICE } from "../../domain/intermediary-notice";
import { sellerInfoSchema } from "../../domain/seller-info";
import type { Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";
import type { PaymentGatewayPort } from "../ports/payment-gateway";
import { buildCapacity, homeSeatPoolSchema } from "./home-offerings";
import { expireDuePayments } from "./order-expiry";

/** 시계·PG 는 읽기 전 정리(S3-3.7 — 기한 지난 결제 대기를 닫고 계좌를 폐기)에 쓴다 */
export type OfferingDetailDeps = GuardDeps & { readonly clock: Clock; readonly paymentGateway: PaymentGatewayPort };

const DETAIL = { notFound: "수업을 찾을 수 없어요" } as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

const ISO_US_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

const offeringIdSchema = z.uuid();

// ---- 응답(계약 02 §2) — 테스트가 본문을 이 스키마로 parse 한다(strict: 모르는 키가 섞이면 실패) ----

const isoInstant = z.iso.datetime({ offset: true });

/** 자리 하나의 선택 가능 여부. 못 고르는 자리에는 이유(SOLD_OUT)를 붙인다 */
export const seatOptionSchema = z.union([
  z.strictObject({ seatKind: z.enum(SEAT_KINDS), available: z.literal(true) }),
  z.strictObject({ seatKind: z.enum(SEAT_KINDS), available: z.literal(false), reason: z.literal("SOLD_OUT") }),
]);
export type SeatOption = z.infer<typeof seatOptionSchema>;

export const offeringDetailSchema = z.strictObject({
  offeringId: z.uuid(),
  title: z.string(),
  academy: z.strictObject({ id: z.uuid(), name: z.string(), regionSido: z.string(), regionGu: z.string() }),
  instructorName: z.string(),
  // 담당 강사 계정 id — 앱이 강사 프로필(M15)로 넘어갈 때 쓴다. 담당 강사가 정해지지 않은 옛 수업은 null(SX-5.7)
  instructorId: z.uuid().nullable(),
  label: z.string(),
  sessions: z.array(z.strictObject({ seq: z.int().min(1), startsAt: isoInstant, endsAt: isoInstant })),
  priceAmount: z.int().min(0),
  seatMode: z.enum(SEAT_MODES),
  capacity: z.strictObject({ total: z.int().min(0), enrolled: z.int().min(0), pools: z.array(homeSeatPoolSchema) }),
  seatSelection: z.strictObject({ defaultSeatKind: z.enum(SEAT_KINDS), options: z.array(seatOptionSchema) }),
  // ↓ S3-2.4(판매자 정보·결제 전 정책)
  seller: sellerInfoSchema,
  refundNotice: z.strictObject({ versionId: z.uuid(), body: z.string() }).nullable(),
  intermediaryNotice: z.strictObject({ version: z.string(), body: z.string() }),
  // ↓ S3-3.15b(결제 화면용 서버 조각)
  classKind: z.enum(CLASS_KINDS),
  priceBreakdownPreview: z
    .array(z.strictObject({ kind: z.enum(PRICE_LINE_KINDS), label: z.string(), amount: z.int().min(0) }))
    .min(1),
});
export type OfferingDetail = z.infer<typeof offeringDetailSchema>;

// ---- 기본 자리 고르기(계약 02 §2 「기본 자리 규칙」) -------------------------------------------------

type Gender = (typeof GENDERS)[number];
type SeatMode = (typeof SEAT_MODES)[number];

/**
 * 회원 성별 + 자리 방식 → 기본 자리와 고를 수 있는 자리 목록.
 *   - gender_split: 기본은 회원과 같은 성별 자리. 그 자리가 마감이어도 기본을 반대 자리로 바꾸지 않는다
 *     (바꾸면 남성 회원이 모르고 여성 자리를 사게 된다 — 반대 자리로 바꾸는 것은 앱에서 회원이 직접 한다)
 *   - single: 기본은 any, 목록도 any 하나
 * 잔여(remaining)가 0 이면 그 자리는 available=false, reason=SOLD_OUT 이다(그 자리로는 주문을 만들 수 없다, FR-091a).
 */
export function chooseSeatSelection(
  seatMode: SeatMode,
  gender: Gender,
  pools: readonly { seatKind: (typeof SEAT_KINDS)[number]; remaining: number }[],
): OfferingDetail["seatSelection"] {
  const wanted: readonly (typeof SEAT_KINDS)[number][] = seatMode === "single" ? ["any"] : ["male", "female"];
  const options: SeatOption[] = pools
    .filter((p) => wanted.includes(p.seatKind))
    .map((p) =>
      p.remaining > 0
        ? { seatKind: p.seatKind, available: true as const }
        : { seatKind: p.seatKind, available: false as const, reason: "SOLD_OUT" as const },
    );
  return { defaultSeatKind: seatMode === "single" ? "any" : gender, options };
}

// ---- 읽기 -----------------------------------------------------------------------------------------

const DETAIL_ROW = {
  offering_id: "pg/uuid@1",
  title: "pg/text@1",
  class_kind: "pg/text@1",
  academy_id: "pg/uuid@1",
  academy_name: "pg/text@1",
  region_sido: "pg/text@1",
  region_gu: "pg/text@1",
  instructor_name: "pg/text@1",
  instructor_id: "pg/text@1",
  label: "pg/text@1",
  price_amount: "pg/int4@1",
  seat_mode: "pg/text@1",
  // 자리 묶음은 홈 목록과 같은 「종류:정원:잡힘:확정」 글자로 받아 buildCapacity 에 넘긴다
  pools: "pg/text@1",
  // 판매자 정보(S3-2.4) — 통신판매업 신고번호는 비어 있을 수 있어 SQL 에서 '' 로 바꿔 받는다
  business_name: "pg/text@1",
  representative_name: "pg/text@1",
  business_registration_number: "pg/text@1",
  mail_order_report_number: "pg/text@1",
  business_address: "pg/text@1",
  seller_phone: "pg/text@1",
  // 수업에 붙은 공지 판본(S3-2.4) — 안 붙었으면 두 칸 다 ''
  refund_notice_version_id: "pg/text@1",
  refund_notice_body: "pg/text@1",
} as const;

/** `GET /api/offerings/{offeringId}` 처리기. 회원만(세션 없음 401 · 가입 전 403 SIGNUP_INCOMPLETE) — 기본 자리에 성별이 필요하다 */
export function createOfferingDetailRoute(deps: OfferingDetailDeps) {
  const guards = createGuards(deps);
  const { db } = deps;

  return withRoute<{ params: Promise<{ offeringId: string }> }>(async (request, context) => {
    const { memberId } = await guards.requireMember(request);
    // id 모양이 틀리면 DB 에 넘기기 전에 「없음」으로 답한다(형 변환 오류 500 을 막는다)
    const parsedId = offeringIdSchema.safeParse((await context.params).offeringId);
    if (!parsedId.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const offeringId = parsedId.data;

    // ⓪ 읽기 전 정리(계약 03 §5, D15) — 이 판매 단위의 기한 지난 결제 대기를 먼저 닫아, 잔여석에 풀린 자리가 보이게 한다
    await expireDuePayments(deps, { offeringId });

    // ① 판매 단위 + 수업 + 학원 + 자리 묶음을 한 번에 읽는다. 홈 목록과 같은 「보여도 되는」 조건을 건다
    const [row] = await db.query(
      db.raw.sql`SELECT o.id AS offering_id, c.title, c.class_kind::text AS class_kind, a.id AS academy_id, a.name AS academy_name, a.region_sido, a.region_gu,
                        c.instructor_name, COALESCE(c.instructor_account_id::text, '') AS instructor_id,
                        o.label, o.price_amount::int4 AS price_amount, c.seat_mode::text AS seat_mode,
                        -- 잡힌 자리 칸에는 앞으로 올 회차의 현장 등록 인원 최댓값(S3-5.4, 계약 18 §6 규칙 7)을 더해 넘긴다 — 남은 자리 계산에만 쓰인다
                        COALESCE((SELECT string_agg(p.seat_kind::text || ':' || p.capacity || ':'
                                                    || (p.held_count + COALESCE((SELECT max(sc.onsite_count) FROM session_seat_counters sc
                                                                                 JOIN class_sessions ss ON ss.id = sc.session_id
                                                                                 WHERE ss.offering_id = p.offering_id AND sc.seat_kind = p.seat_kind
                                                                                   AND ss.status = 'scheduled' AND ss.ends_at > now()), 0))
                                                    || ':' || p.confirmed_count, ',')
                                  FROM seat_pools p WHERE p.offering_id = o.id), '') AS pools,
                        a.business_name, a.representative_name, a.business_registration_number,
                        COALESCE(a.mail_order_report_number, '') AS mail_order_report_number,
                        a.business_address, a.phone AS seller_phone,
                        COALESCE(n.id::text, '') AS refund_notice_version_id, COALESCE(n.body, '') AS refund_notice_body
                 FROM class_offerings o
                 JOIN classes c ON c.id = o.class_id
                 JOIN academies a ON a.id = c.academy_id
                 -- 공지 판본은 이 학원의 것만 붙인다(다른 학원 판본 id 가 잘못 들어가 있어도 남의 공지를 보여 주지 않는다)
                 LEFT JOIN refund_notice_versions n ON n.id = c.refund_notice_version_id AND n.academy_id = a.id
                 WHERE o.id = ${offeringId}::uuid
                   AND c.status = 'published'
                   AND o.status = 'open'
                   AND a.status = 'active'
                   AND NOT EXISTS (SELECT 1 FROM academy_restrictions r
                                   WHERE r.academy_id = a.id AND r.kind = 'listing_suspended' AND r.ended_at IS NULL)`
        .returnsRow(DETAIL_ROW)
        .build(),
    );
    if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);

    // ② 예정 회차만 순서대로 — 휴강·폐강한 회차는 신청할 대상이 아니라 목록에서 뺀다(홈 목록의 회차 수와 같은 기준)
    const sessions = await db.query(
      db.raw.sql`SELECT seq, to_char(starts_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS starts_at,
                        to_char(ends_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS ends_at
                 FROM class_sessions WHERE offering_id = ${offeringId}::uuid AND status = 'scheduled' ORDER BY seq`
        .returnsRow({ seq: "pg/int4@1", starts_at: "pg/text@1", ends_at: "pg/text@1" })
        .build(),
    );

    // ③ 기본 자리 계산에 쓸 회원 성별(본인확인에서 온 값)
    const [me] = await db.query(
      db.raw.sql`SELECT gender::text AS gender FROM members WHERE id = ${memberId}::uuid`.returnsRow({ gender: "pg/text@1" }).build(),
    );
    const gender = z.enum(GENDERS).parse(me?.gender);
    const seatMode = z.enum(SEAT_MODES).parse(row.seat_mode);

    const capacity = buildCapacity(row.pools);
    const classKind = z.enum(CLASS_KINDS).parse(row.class_kind);
    // 결제 전 가격 내역 — 주문 생성과 같은 계산 함수(같은 수업 종류·같은 판매 단위 가격)라 결제 시작 응답의 priceBreakdown 과 같다
    const priceBreakdownPreview = computeOrderAmounts(classKind, row.price_amount).breakdown;
    const body = offeringDetailSchema.parse({
      offeringId: row.offering_id,
      title: row.title,
      academy: { id: row.academy_id, name: row.academy_name, regionSido: row.region_sido, regionGu: row.region_gu },
      instructorName: row.instructor_name,
      instructorId: row.instructor_id === "" ? null : row.instructor_id,
      label: row.label,
      sessions: sessions.map((s) => ({ seq: s.seq, startsAt: s.starts_at, endsAt: s.ends_at })),
      priceAmount: row.price_amount,
      seatMode,
      capacity,
      seatSelection: chooseSeatSelection(seatMode, gender, capacity.pools),
      seller: {
        businessName: row.business_name,
        representativeName: row.representative_name,
        businessRegistrationNumber: row.business_registration_number,
        mailOrderReportNumber: row.mail_order_report_number === "" ? null : row.mail_order_report_number,
        businessAddress: row.business_address,
        phone: row.seller_phone,
      },
      refundNotice:
        row.refund_notice_version_id === "" ? null : { versionId: row.refund_notice_version_id, body: row.refund_notice_body },
      intermediaryNotice: { version: INTERMEDIARY_NOTICE.version, body: INTERMEDIARY_NOTICE.body },
      classKind,
      priceBreakdownPreview,
    });
    return Response.json(body, { status: 200, headers: NO_STORE });
  });
}
