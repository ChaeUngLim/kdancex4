// S1-3.4(정규 과정 공지 저장 API) — 정규 과정 환불·취소 공지의 화면용 본문 만들기(FR-099a(환불·취소 공지 양식)).
//
// 무엇을 하나:
//   대표가 고른 값(content)으로 회원·강사 화면에 그대로 보일 본문 글을 만든다. 대표가 본문을 직접 쓰지 않는 이유는
//   모든 학원의 공지가 **같은 항목, 같은 순서**로 보여야 해서다(FR-099a). 순서는 아래 여섯 줄로 고정이다.
//     1 취소 가능 시점 → 2 시점별 환불 기준(%) → 3 환불이 안 되는 경우 → 4 환불 처리 기간 → 5 환불 요청 방법 → 6 대표 연락처
//   5번 「환불 요청 방법」은 대표가 고르지 않는 고정 문구다(FR-098b(환불 요청 경로) — 앱 문의로만 받는다).
//
// 만든 본문은 판본 행의 body 에 저장되고, 주문이 그 판본을 가리키는 한 그대로 남는다(FR-284(주문 시점 값 고정)).
// 순수 함수다 — DB·시각·환경 변수를 읽지 않는다.
import {
  EVENT_FEE_WINDOWS,
  REGULAR_REFUND_POINTS,
  type EventFeeTier,
  type EventFeeWindow,
  type RegularRefundPoint,
  type RegularRefundTier,
} from "./refund-templates";

/** 정규 공지 content — 저장 요청 스키마(zod)가 모양을 확인한 값 */
export interface RegularNoticeContent {
  readonly cancellableUntil: string;
  readonly tiers: readonly RegularRefundTier[];
  readonly nonRefundableCases: string;
  readonly processingBusinessDays: number;
  readonly ownerContact: string;
}

/** 시점 이름 → 화면 문구. 「총 기간」은 정규 과정 한 기간(예: 8주)을 뜻한다 */
export const REGULAR_POINT_LABELS: Readonly<Record<RegularRefundPoint, string>> = Object.freeze({
  before_start: "수강 시작 전",
  before_one_third: "총 기간의 1/3 이 지나기 전",
  before_half: "총 기간의 1/2 이 지나기 전",
  after_half: "총 기간의 1/2 이 지난 뒤",
});

/** 환불 요청 방법 — 고정 문구(FR-098b). 대표가 바꾸지 못한다 */
export const REFUND_REQUEST_METHOD_TEXT = "앱의 학원 문의로 환불을 요청해 주세요";

/**
 * 정규 공지 본문을 만든다. 시점별 기준은 대표가 보낸 순서와 상관없이 늘 REGULAR_REFUND_POINTS 순서로 적는다.
 * (요청 스키마가 네 시점이 하나씩 다 있는지 먼저 확인하므로 빠진 시점은 없다.)
 */
export function buildRegularNoticeBody(content: RegularNoticeContent): string {
  const percentByPoint = new Map(content.tiers.map((t) => [t.point, t.percent]));
  const tierLines = REGULAR_REFUND_POINTS.map(
    (point) => `   - ${REGULAR_POINT_LABELS[point]}: 낸 금액의 ${percentByPoint.get(point) ?? 0}% 환불`,
  );
  return [
    `1. 취소 가능 시점: ${content.cancellableUntil}`,
    "2. 시점별 환불 기준",
    ...tierLines,
    `3. 환불이 안 되는 경우: ${content.nonRefundableCases}`,
    `4. 환불 처리 기간: 요청 뒤 ${content.processingBusinessDays}영업일 안`,
    `5. 환불 요청 방법: ${REFUND_REQUEST_METHOD_TEXT}`,
    `6. 대표 연락처: ${content.ownerContact}`,
  ].join("\n");
}

// ---- S1-3.5(이벤트형 취소 수수료 저장 API) 에서 더한 것 ------------------------------------------

/** 이벤트형 공지 content — 저장 요청 스키마(zod)가 모양을 확인한 값(data-model §7-6) */
export interface EventNoticeContent {
  readonly feeTiers: readonly EventFeeTier[];
  readonly nonRefundableCases: string;
  readonly processingBusinessDays: number;
  readonly ownerContact: string;
}

/** 구간 이름 → 화면 문구(행사·수업일 기준, FR-099c 표) */
export const EVENT_WINDOW_LABELS: Readonly<Record<EventFeeWindow, string>> = Object.freeze({
  d10_plus: "10일 전까지",
  d9_d7: "9일 전 ~ 7일 전",
  d6_d3: "6일 전 ~ 3일 전",
  d2_to_deadline: "2일 전 ~ 환불 마감일까지",
});

/**
 * 이벤트형 「취소 가능 시점」 — 고정 문구. 환불 마감일은 공지가 아니라 **상품마다** 정하므로(FR-099a 화면 W4b)
 * 공지에는 날짜를 적지 않고 「그 상품의 환불 마감일까지」라고만 쓴다.
 */
export const EVENT_CANCELLABLE_UNTIL_TEXT = "상품마다 정한 환불 마감일까지(마감일 다음 날부터 취소·환불 불가)";

/**
 * 이벤트형 공지 본문을 만든다. 항목 순서는 정규와 같은 FR-099a 여섯 줄이고, 2번만 「구간별 취소 수수료」다.
 * 구간은 대표가 보낸 순서와 상관없이 늘 EVENT_FEE_WINDOWS 순서로 적는다.
 */
export function buildEventNoticeBody(content: EventNoticeContent): string {
  const percentByWindow = new Map(content.feeTiers.map((t) => [t.window, t.percent]));
  const tierLines = EVENT_FEE_WINDOWS.map(
    (window) => `   - ${EVENT_WINDOW_LABELS[window]}: 낸 참가비의 ${percentByWindow.get(window) ?? 0}% 취소 수수료`,
  );
  return [
    `1. 취소 가능 시점: ${EVENT_CANCELLABLE_UNTIL_TEXT}`,
    "2. 구간별 취소 수수료(행사·수업일 기준)",
    ...tierLines,
    `3. 환불이 안 되는 경우: ${content.nonRefundableCases}`,
    `4. 환불 처리 기간: 요청 뒤 ${content.processingBusinessDays}영업일 안`,
    `5. 환불 요청 방법: ${REFUND_REQUEST_METHOD_TEXT}`,
    `6. 대표 연락처: ${content.ownerContact}`,
  ].join("\n");
}
