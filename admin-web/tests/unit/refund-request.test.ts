// S4-1.2(환불 요청 생성·철회) — lib/domain/refund-request.ts 의 순수 규칙(종류 · 기한 · 철회 가능 · 표시 상태)
import { describe, expect, test } from "vitest";

import { createHolidayCalendar } from "../../lib/domain/business-days";
import {
  isRefundRequestWithdrawable,
  needsRefundAccount,
  refundAnswerDueAt,
  refundRequestDisplayStatus,
  refundRequestKindFor,
} from "../../lib/domain/refund-request";

const noHolidays = createHolidayCalendar([]);

describe("환불 요청 규칙", () => {
  test("수업 구분 → 정규·이벤트형", () => {
    for (const kind of ["regular", "private_lesson", "basic", "lady_style"] as const) expect(refundRequestKindFor(kind)).toBe("regular");
    for (const kind of ["one_day", "event", "party", "performance", "competition"] as const) expect(refundRequestKindFor(kind)).toBe("event");
  });

  test("계좌로 돌려받는 수단은 간편 계좌이체·가상계좌뿐", () => {
    expect(needsRefundAccount("virtual_account")).toBe(true);
    expect(needsRefundAccount("easy_transfer")).toBe(true);
    expect(needsRefundAccount("card")).toBe(false);
    expect(needsRefundAccount("easy_pay")).toBe(false);
  });

  test("답할 기한 = 접수 + 3영업일, 시각은 그대로 · 주말·공휴일 건너뜀", () => {
    // 목요일 14:20 KST → 화요일 14:20 KST (계약 §2-1 예시와 같다)
    expect(refundAnswerDueAt(Temporal.Instant.from("2026-11-05T05:20:00Z"), noHolidays).toString()).toBe("2026-11-10T05:20:00Z");
    // 금요일 밤 23:30 KST(UTC 로는 같은 날 14:30) → 월·화·수 → 수요일 23:30 KST
    expect(refundAnswerDueAt(Temporal.Instant.from("2026-11-06T14:30:00Z"), noHolidays).toString()).toBe("2026-11-11T14:30:00Z");
    const withHoliday = createHolidayCalendar([{ date: Temporal.PlainDate.from("2026-11-09") }]);
    expect(refundAnswerDueAt(Temporal.Instant.from("2026-11-05T05:20:00Z"), withHoliday).toString()).toBe("2026-11-11T05:20:00Z");
  });

  test("철회 가능 = 정규 · 결정 전 · 접수/처리 중", () => {
    expect(isRefundRequestWithdrawable({ kind: "regular", status: "received", decisionKind: null })).toBe(true);
    expect(isRefundRequestWithdrawable({ kind: "regular", status: "in_progress", decisionKind: null })).toBe(true);
    expect(isRefundRequestWithdrawable({ kind: "regular", status: "in_progress", decisionKind: "approved" })).toBe(false);
    expect(isRefundRequestWithdrawable({ kind: "event", status: "received", decisionKind: null })).toBe(false);
    for (const status of ["completed", "rejected", "withdrawn"] as const) {
      expect(isRefundRequestWithdrawable({ kind: "regular", status, decisionKind: null })).toBe(false);
    }
  });

  test("표시 상태 — 기한이 지난 처리 전 요청만 pending_overdue", () => {
    const due = Temporal.Instant.from("2026-11-10T05:20:00Z");
    const after = Temporal.Instant.from("2026-11-10T05:20:01Z");
    expect(refundRequestDisplayStatus({ status: "received", answerDueAt: due }, due)).toBe("received");
    expect(refundRequestDisplayStatus({ status: "received", answerDueAt: due }, after)).toBe("pending_overdue");
    expect(refundRequestDisplayStatus({ status: "in_progress", answerDueAt: due }, after)).toBe("pending_overdue");
    expect(refundRequestDisplayStatus({ status: "withdrawn", answerDueAt: due }, after)).toBe("withdrawn");
  });
});
