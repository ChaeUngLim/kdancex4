// S2-2.6(환불 마감일 필수) — 환불 마감일 판정(순수 함수) 단위 테스트
//   계약: _workspace/03_contracts/11-instructor.md §4-2(refundDeadlineOn) · §4-4 ①(REFUND_DEADLINE_REQUIRED · REFUND_DEADLINE_AFTER_START)
//   요구: FR-099d(환불 마감일 필수 입력) · 계약 11 Phase 6 단위 「환불 마감일 판정(개최일 당일 가능·다음 날 불가)」
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import { checkRefundDeadline, refundDeadlineRequired } from "../../lib/domain/refund-deadline";

// 개최: 2026-12-06 14:00 KST(= 05:00Z)
const START = Temporal.Instant.from("2026-12-06T05:00:00Z");
// 개최: 2026-12-06 00:30 KST(= 12-05 15:30Z) — UTC 날짜와 KST 날짜가 다른 경계
const START_EARLY_KST = Temporal.Instant.from("2026-12-05T15:30:00Z");

describe("refundDeadlineRequired — 마감일이 필요한 수업인가", () => {
  test("이벤트형 5종 + 금액 0 초과 → 필요", () => {
    for (const kind of ["one_day", "event", "party", "performance", "competition"] as const) {
      expect(refundDeadlineRequired(kind, 30000)).toBe(true);
    }
  });
  test("이벤트형이라도 0원이면 필요 없다(무료 행사)", () => {
    expect(refundDeadlineRequired("one_day", 0)).toBe(false);
  });
  test("정규 계열은 필요 없다", () => {
    for (const kind of ["regular", "basic", "lady_style"] as const) expect(refundDeadlineRequired(kind, 300000)).toBe(false);
  });
});

describe("checkRefundDeadline — 승인 요청 때 판정", () => {
  const paidEvent = { classKind: "one_day" as const, priceAmount: 30000, firstSessionStartsAt: START };

  test("유료 이벤트형인데 마감일이 없다 → REFUND_DEADLINE_REQUIRED", () => {
    const verdict = checkRefundDeadline({ ...paidEvent, refundDeadlineOn: null });
    expect(verdict).toMatchObject({ ok: false, code: "REFUND_DEADLINE_REQUIRED" });
  });

  test("개최일 당일은 된다", () => {
    expect(checkRefundDeadline({ ...paidEvent, refundDeadlineOn: "2026-12-06" })).toEqual({ ok: true, deadlineOn: "2026-12-06" });
  });

  test("개최일 전날도 된다", () => {
    expect(checkRefundDeadline({ ...paidEvent, refundDeadlineOn: "2026-12-05" })).toEqual({ ok: true, deadlineOn: "2026-12-05" });
  });

  test("개최일 다음 날은 안 된다 → REFUND_DEADLINE_AFTER_START", () => {
    const verdict = checkRefundDeadline({ ...paidEvent, refundDeadlineOn: "2026-12-07" });
    expect(verdict).toMatchObject({ ok: false, code: "REFUND_DEADLINE_AFTER_START" });
  });

  test("개최일은 KST 달력으로 본다 — 00:30 KST 개최면 UTC 로는 전날이어도 당일(12-06)까지 된다", () => {
    const early = { ...paidEvent, firstSessionStartsAt: START_EARLY_KST };
    expect(checkRefundDeadline({ ...early, refundDeadlineOn: "2026-12-06" }).ok).toBe(true);
    expect(checkRefundDeadline({ ...early, refundDeadlineOn: "2026-12-07" })).toMatchObject({ ok: false, code: "REFUND_DEADLINE_AFTER_START" });
  });

  test("0원 이벤트형은 마감일이 없어도 되고, 보내도 저장하지 않는다(null)", () => {
    expect(checkRefundDeadline({ ...paidEvent, priceAmount: 0, refundDeadlineOn: null })).toEqual({ ok: true, deadlineOn: null });
    expect(checkRefundDeadline({ ...paidEvent, priceAmount: 0, refundDeadlineOn: "2026-12-09" })).toEqual({ ok: true, deadlineOn: null });
  });

  test("정규 계열은 보내도 무시한다(늦은 날짜여도 통과, 저장 값 null)", () => {
    const regular = { classKind: "regular" as const, priceAmount: 300000, firstSessionStartsAt: START };
    expect(checkRefundDeadline({ ...regular, refundDeadlineOn: "2027-01-01" })).toEqual({ ok: true, deadlineOn: null });
    expect(checkRefundDeadline({ ...regular, refundDeadlineOn: null })).toEqual({ ok: true, deadlineOn: null });
  });
});
