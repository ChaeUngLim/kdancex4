// S4-1.4(대표 환불 입력) — 대표가 환불 요청에 승인(금액)·거절을 넣을 때의 규칙 중 DB 없이 정해지는 것만 모은 순수 함수.
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §2-2(상세의 noticeItems·refundableAmount) · §2-3(decision 검사 표) · §1-2(오류 코드)
//   spec: FR-293(대표 환불 입력) · FR-100(환불 정수 연산) · SC-010(환불 초과 0건)
//
// 무엇을 하나:
//   ① 주문이 동의한 공지 판본에서 「근거로 고를 수 있는 항목」 목록을 만든다(정규 = 시점별 % 넷 + 환불이 안 되는 경우,
//      이벤트형 = 수수료 구간 넷 + 환불이 안 되는 경우). 대표는 승인이든 거절이든 이 목록에서 하나를 꼭 고른다.
//   ② 환불할 수 있는 남은 금액(환불 상한) = 결제액 − 예매 수수료 − 이미 잡힌 환불 합. 0 아래로는 내려가지 않는다.
//   ③ 대표가 보낸 결정이 규칙에 맞는지 판정한다 — 맞지 않으면 어떤 오류 코드인지를 돌려준다(던지지 않는다).
//
// 왜 서버가 다시 비교하나(계약 §2-3 「클라이언트가 보낸 maxAmount 를 믿지 않는다」):
//   화면은 상세 응답의 refundableAmount 로 입력칸 상한을 걸지만, 그 사이 다른 환불이 잡혔을 수도 있고
//   요청을 손으로 만들어 보낼 수도 있다. 그래서 결정 때 DB 에서 결제액·환불 합을 다시 읽어 이 함수로 한 번 더 본다.
//
// 모든 함수는 DB·현재 시각을 읽지 않는다(같은 입력 → 같은 답).
import type { RefundRequestKind } from "./constants";
import { EVENT_WINDOW_LABELS, REGULAR_POINT_LABELS } from "./refund-notice-body";
import { EVENT_FEE_WINDOWS, REGULAR_REFUND_POINTS, type EventFeeTier, type RegularRefundTier } from "./refund-templates";

/** 「환불이 안 되는 경우」 항목 코드 — 정규·이벤트형 공통(계약 §2-2 예시 `no_refund_case`) */
export const NO_REFUND_CASE_CODE = "no_refund_case";

/** 대표 화면의 근거 항목 한 줄. percent 는 정규 시점이면 환불 %, 이벤트형 구간이면 취소 수수료 %, 「안 되는 경우」는 null */
export interface RefundNoticeItem {
  readonly code: string;
  readonly label: string;
  readonly percent: number | null;
}

/** 근거 항목을 만드는 데 필요한 공지 판본 내용 — 종류에 따라 둘 중 하나 */
export type DecisionNoticeContent =
  | { readonly kind: "regular"; readonly tiers: readonly RegularRefundTier[]; readonly nonRefundableCases: string }
  | { readonly kind: "event"; readonly feeTiers: readonly EventFeeTier[]; readonly nonRefundableCases: string };

/**
 * 공지 판본 → 근거 항목 목록. 순서는 공지 본문과 같은 고정 순서(REGULAR_REFUND_POINTS · EVENT_FEE_WINDOWS)이고
 * 맨 끝에 「환불이 안 되는 경우」를 붙인다. 라벨의 「N항」은 공지 2번(시점별 기준) 아래 몇째 줄인지다.
 * 예: `2항 · 총 기간의 1/3 이 지나기 전 · 67%` (계약 §2-2 예시와 같은 모양)
 */
export function buildRefundNoticeItems(content: DecisionNoticeContent): readonly RefundNoticeItem[] {
  const items: RefundNoticeItem[] = [];
  if (content.kind === "regular") {
    const byPoint = new Map(content.tiers.map((t) => [t.point, t.percent]));
    REGULAR_REFUND_POINTS.forEach((point, index) => {
      const percent = byPoint.get(point);
      // 저장 때 시점 넷을 다 검사받으므로 빠진 시점은 없지만, 깨진 판본이면 그 줄만 빼고 고를 수 없게 둔다
      if (percent === undefined) return;
      items.push({ code: `tier:${point}`, label: `${index + 1}항 · ${REGULAR_POINT_LABELS[point]} · ${percent}%`, percent });
    });
  } else {
    const byWindow = new Map(content.feeTiers.map((t) => [t.window, t.percent]));
    EVENT_FEE_WINDOWS.forEach((window, index) => {
      const percent = byWindow.get(window);
      if (percent === undefined) return;
      items.push({ code: `window:${window}`, label: `${index + 1}항 · ${EVENT_WINDOW_LABELS[window]} · 수수료 ${percent}%`, percent });
    });
  }
  items.push({ code: NO_REFUND_CASE_CODE, label: `환불이 안 되는 경우 · ${content.nonRefundableCases}`, percent: null });
  return Object.freeze(items);
}

/** 환불 상한 계산에 넣는 주문 금액 사실 */
export interface RefundableInput {
  /** 결제액(`orders.total_amount`) */
  readonly totalAmount: number;
  /** 예매 수수료(`orders.booking_fee_amount`) — 법정 청약철회가 아니면 돌려주지 않는다(D15·D21). 정규는 0 */
  readonly bookingFeeAmount: number;
  /** 이 주문에 이미 잡힌 환불 합(실패하지 않은 환불 + 승인됐지만 아직 실행 전인 다른 요청의 금액) */
  readonly alreadyRefundedAmount: number;
}

/**
 * 환불할 수 있는 남은 금액 = 결제액 − 예매 수수료 − 이미 잡힌 환불 합(계약 §2-3 2번째 줄).
 * 이미 잡힌 환불이 더 크면(데이터가 어긋난 경우) 음수가 아니라 0 을 돌려준다 — 그러면 1원 이상 승인이 모두 막힌다.
 * 법정 청약철회 환불(예매 수수료까지 전액)은 이벤트형 취소(S4-2)에서 다룬다 — 이 함수는 늘 예매 수수료를 뺀다.
 */
export function refundableAmountFor(input: RefundableInput): number {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} 는 0 이상 정수여야 한다: ${value}`);
  }
  return Math.max(0, input.totalAmount - input.bookingFeeAmount - input.alreadyRefundedAmount);
}

/** 대표가 보낸 결정(zod 를 거친 값). 근거 항목은 비어 올 수 있어 여기서 「없음」을 따로 판정한다 */
export type RefundDecisionInput =
  | { readonly decision: "approve"; readonly amount: number; readonly noticeItemCode: string | null }
  | { readonly decision: "reject"; readonly noticeItemCode: string | null };

/** 판정에 쓰는 요청 쪽 사실 */
export interface RefundDecisionContext {
  readonly kind: RefundRequestKind;
  /** 이 요청에서 고를 수 있는 근거 항목 */
  readonly noticeItems: readonly RefundNoticeItem[];
  /** 결정 때 서버가 다시 계산한 환불 상한 */
  readonly refundableAmount: number;
  /** 이벤트형 계산값(올리기만 된다). 정규는 null — 정규 미리 채움값은 대표가 내려도 된다 */
  readonly eventComputedAmount: number | null;
  /** 계좌 결제분인데 쓰는(active) 환불 계좌가 있나. 카드분은 true 로 넘긴다 */
  readonly refundAccountReady: boolean;
}

/** 판정 결과 — 실패면 계약 §1-2 의 코드 */
export type RefundDecisionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "NOTICE_ITEM_REQUIRED" }
  | { readonly ok: false; readonly code: "REFUND_EXCEEDS_PAID"; readonly refundableAmount: number }
  | { readonly ok: false; readonly code: "EVENT_REFUND_NOT_REJECTABLE" }
  | { readonly ok: false; readonly code: "REFUND_BELOW_COMPUTED"; readonly computedAmount: number }
  | { readonly ok: false; readonly code: "REFUND_ACCOUNT_REQUIRED" };

/**
 * 결정 판정(계약 §2-3 검사 표). 순서가 곧 우선순위다:
 *   1 이벤트형 거절 → 409 EVENT_REFUND_NOT_REJECTABLE(이벤트형은 수수료 표대로 돌려줘야 해서 거절이 없다)
 *   2 근거 항목이 비었거나 이 요청의 목록에 없음 → 422 NOTICE_ITEM_REQUIRED(FR-293 「입력하지 않은 항목이 있으면 처리 완료로 넘어가지 않는다」)
 *   3 승인 금액 > 환불 상한 → 409 REFUND_EXCEEDS_PAID(SC-010(환불 초과 0건)) — 상한을 함께 알려 화면이 고칠 수 있게 한다
 *   4 이벤트형 승인 금액 < 계산값 → 422 REFUND_BELOW_COMPUTED(올리기만)
 *   5 계좌 결제분 승인인데 환불 계좌 없음 → 422 REFUND_ACCOUNT_REQUIRED
 * 금액이 정수·0 이상인지는 zod 가 먼저 막는다(422 VALIDATION_FAILED). 여기서는 다시 보지 않는다.
 */
export function checkRefundDecision(input: RefundDecisionInput, context: RefundDecisionContext): RefundDecisionCheck {
  if (input.decision === "reject" && context.kind === "event") return { ok: false, code: "EVENT_REFUND_NOT_REJECTABLE" };

  const code = input.noticeItemCode;
  if (code === null || !context.noticeItems.some((item) => item.code === code)) return { ok: false, code: "NOTICE_ITEM_REQUIRED" };

  if (input.decision === "reject") return { ok: true };

  if (input.amount > context.refundableAmount) {
    return { ok: false, code: "REFUND_EXCEEDS_PAID", refundableAmount: context.refundableAmount };
  }
  if (context.kind === "event" && context.eventComputedAmount !== null && input.amount < context.eventComputedAmount) {
    return { ok: false, code: "REFUND_BELOW_COMPUTED", computedAmount: context.eventComputedAmount };
  }
  if (!context.refundAccountReady) return { ok: false, code: "REFUND_ACCOUNT_REQUIRED" };
  return { ok: true };
}

/** 대표 목록·상세의 기한 칩(계약 §2-2 `dueState`) */
export type RefundDueState = "ok" | "due_soon" | "overdue";

/** 「곧 기한」으로 보는 남은 시간 — 하루 이내(계약 §2-2) */
const DUE_SOON_MS = 24 * 60 * 60 * 1000;

/**
 * 기한 칩. 처리 전(접수·처리 중)만 기한을 보고, 끝난 요청은 늘 ok 다(더 답할 것이 없다).
 * 기한 시각 「딱 그 순간」은 아직 지나지 않은 것으로 본다(refundRequestDisplayStatus 와 같은 기준).
 */
export function refundDueState(
  state: { readonly open: boolean; readonly answerDueAt: Temporal.Instant },
  now: Temporal.Instant,
): RefundDueState {
  if (!state.open) return "ok";
  const leftMs = state.answerDueAt.epochMilliseconds - now.epochMilliseconds;
  if (leftMs < 0) return "overdue";
  return leftMs <= DUE_SOON_MS ? "due_soon" : "ok";
}
