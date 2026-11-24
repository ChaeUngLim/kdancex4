// S4-1.4(대표 환불 입력) — DB 없이 정해지는 결정 규칙(lib/domain/refund-decision.ts)을 본다.
//   근거 항목 목록 · 환불 상한 · 결정 판정 순서 · 기한 칩
import { describe, expect, test } from "vitest";

// Temporal 전역은 lib/domain/time 이 불러올 때 채워진다(다른 단위 테스트와 같은 방식)
import "../../lib/domain/time";

import {
  NO_REFUND_CASE_CODE,
  buildRefundNoticeItems,
  checkRefundDecision,
  refundDueState,
  refundableAmountFor,
  type RefundDecisionContext,
} from "../../lib/domain/refund-decision";

const regularItems = buildRefundNoticeItems({
  kind: "regular",
  tiers: [
    { point: "after_half", percent: 0 },
    { point: "before_start", percent: 100 },
    { point: "before_half", percent: 50 },
    { point: "before_one_third", percent: 67 },
  ],
  nonRefundableCases: "이미 들은 회차",
});

const base: RefundDecisionContext = {
  kind: "regular",
  noticeItems: regularItems,
  refundableAmount: 180000,
  eventComputedAmount: null,
  refundAccountReady: true,
};

describe("근거 항목 목록", () => {
  test("정규 — 공지 순서(시점 넷) + 안 되는 경우, 라벨에 항 번호와 %", () => {
    expect(regularItems.map((i) => i.code)).toEqual([
      "tier:before_start",
      "tier:before_one_third",
      "tier:before_half",
      "tier:after_half",
      NO_REFUND_CASE_CODE,
    ]);
    expect(regularItems[1]).toEqual({ code: "tier:before_one_third", label: "2항 · 총 기간의 1/3 이 지나기 전 · 67%", percent: 67 });
    expect(regularItems[4]).toEqual({ code: "no_refund_case", label: "환불이 안 되는 경우 · 이미 들은 회차", percent: null });
  });

  test("이벤트형 — 수수료 구간 넷 + 안 되는 경우", () => {
    const items = buildRefundNoticeItems({
      kind: "event",
      feeTiers: [
        { window: "d10_plus", percent: 0 },
        { window: "d9_d7", percent: 10 },
        { window: "d6_d3", percent: 20 },
        { window: "d2_to_deadline", percent: 30 },
      ],
      nonRefundableCases: "행사 당일",
    });
    expect(items.map((i) => i.code)).toEqual(["window:d10_plus", "window:d9_d7", "window:d6_d3", "window:d2_to_deadline", "no_refund_case"]);
    expect(items[1]!.label).toBe("2항 · 9일 전 ~ 7일 전 · 수수료 10%");
  });
});

describe("환불 상한", () => {
  test("결제액 − 예매 수수료 − 이미 잡힌 환불", () => {
    expect(refundableAmountFor({ totalAmount: 180000, bookingFeeAmount: 0, alreadyRefundedAmount: 0 })).toBe(180000);
    expect(refundableAmountFor({ totalAmount: 32000, bookingFeeAmount: 2000, alreadyRefundedAmount: 0 })).toBe(30000);
    expect(refundableAmountFor({ totalAmount: 180000, bookingFeeAmount: 0, alreadyRefundedAmount: 100000 })).toBe(80000);
  });
  test("어긋난 데이터면 0 아래로 내려가지 않는다 · 음수·소수 입력은 RangeError", () => {
    expect(refundableAmountFor({ totalAmount: 1000, bookingFeeAmount: 0, alreadyRefundedAmount: 5000 })).toBe(0);
    expect(() => refundableAmountFor({ totalAmount: -1, bookingFeeAmount: 0, alreadyRefundedAmount: 0 })).toThrow(RangeError);
    expect(() => refundableAmountFor({ totalAmount: 1.5, bookingFeeAmount: 0, alreadyRefundedAmount: 0 })).toThrow(RangeError);
  });
});

describe("결정 판정(계약 §2-3)", () => {
  test("승인 — 0원·상한과 같은 금액은 통과, 1원 넘으면 REFUND_EXCEEDS_PAID(상한 함께)", () => {
    expect(checkRefundDecision({ decision: "approve", amount: 0, noticeItemCode: "no_refund_case" }, base)).toEqual({ ok: true });
    expect(checkRefundDecision({ decision: "approve", amount: 180000, noticeItemCode: "tier:before_start" }, base)).toEqual({ ok: true });
    expect(checkRefundDecision({ decision: "approve", amount: 180001, noticeItemCode: "tier:before_start" }, base)).toEqual({
      ok: false,
      code: "REFUND_EXCEEDS_PAID",
      refundableAmount: 180000,
    });
  });

  test("근거 항목이 없거나 목록 밖이면 NOTICE_ITEM_REQUIRED — 승인·거절 둘 다, 금액 검사보다 먼저", () => {
    expect(checkRefundDecision({ decision: "approve", amount: 999999, noticeItemCode: null }, base)).toEqual({ ok: false, code: "NOTICE_ITEM_REQUIRED" });
    expect(checkRefundDecision({ decision: "reject", noticeItemCode: null }, base)).toEqual({ ok: false, code: "NOTICE_ITEM_REQUIRED" });
    expect(checkRefundDecision({ decision: "reject", noticeItemCode: "window:d9_d7" }, base)).toEqual({ ok: false, code: "NOTICE_ITEM_REQUIRED" });
    expect(checkRefundDecision({ decision: "reject", noticeItemCode: "tier:after_half" }, base)).toEqual({ ok: true });
  });

  test("이벤트형 — 거절 불가(가장 먼저), 계산값보다 낮은 승인 불가", () => {
    const event: RefundDecisionContext = {
      ...base,
      kind: "event",
      noticeItems: [{ code: "window:d6_d3", label: "3항", percent: 20 }, { code: "no_refund_case", label: "안 됨", percent: null }],
      eventComputedAmount: 24000,
    };
    expect(checkRefundDecision({ decision: "reject", noticeItemCode: null }, event)).toEqual({ ok: false, code: "EVENT_REFUND_NOT_REJECTABLE" });
    expect(checkRefundDecision({ decision: "approve", amount: 23999, noticeItemCode: "window:d6_d3" }, event)).toEqual({
      ok: false,
      code: "REFUND_BELOW_COMPUTED",
      computedAmount: 24000,
    });
    expect(checkRefundDecision({ decision: "approve", amount: 26000, noticeItemCode: "window:d6_d3" }, event)).toEqual({ ok: true });
  });

  test("계좌 결제분인데 환불 계좌가 없으면 승인만 막힌다", () => {
    const noAccount = { ...base, refundAccountReady: false };
    expect(checkRefundDecision({ decision: "approve", amount: 1000, noticeItemCode: "tier:before_half" }, noAccount)).toEqual({
      ok: false,
      code: "REFUND_ACCOUNT_REQUIRED",
    });
    expect(checkRefundDecision({ decision: "reject", noticeItemCode: "tier:before_half" }, noAccount)).toEqual({ ok: true });
  });
});

describe("기한 칩", () => {
  test("하루 넘게 남음 ok · 하루 이내 due_soon · 딱 그 순간 due_soon · 지나면 overdue · 끝난 요청은 ok", () => {
    const due = Temporal.Instant.from("2026-11-10T05:20:00Z");
    expect(refundDueState({ open: true, answerDueAt: due }, Temporal.Instant.from("2026-11-09T05:19:00Z"))).toBe("ok");
    expect(refundDueState({ open: true, answerDueAt: due }, Temporal.Instant.from("2026-11-09T05:20:00Z"))).toBe("due_soon");
    expect(refundDueState({ open: true, answerDueAt: due }, due)).toBe("due_soon");
    expect(refundDueState({ open: true, answerDueAt: due }, Temporal.Instant.from("2026-11-10T05:20:01Z"))).toBe("overdue");
    expect(refundDueState({ open: false, answerDueAt: due }, Temporal.Instant.from("2026-12-01T00:00:00Z"))).toBe("ok");
  });
});
