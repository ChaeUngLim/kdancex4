// S1-1.29(소명 기한 지남 → 운영자 게시 중단) — 소명 기한 계산(순수 함수). 계약 13 §10-3 의 dueInDays·「기한 지남」.
import { describe, expect, test } from "vitest";

import { OVERDUE_LABEL, businessCaseReasonText, explanationDue, maskBusinessNo } from "@/lib/domain/business-check-case";

// 기한 2026-11-27T18:10Z = 11-28 03:10 KST (감지 11-21 03:10 KST + 7일)
const DUE = Temporal.Instant.from("2026-11-27T18:10:00Z");

describe("explanationDue — 소명 기한까지 남은 날과 기한 지남", () => {
  test("기한이 없으면 모두 비어 있다", () => {
    expect(explanationDue(null, DUE)).toEqual({ dueInDays: null, overdue: false, dueLabel: null });
  });

  test("한국 날짜로 센다 — 감지 다음 날(11-22 KST)이면 D-6", () => {
    expect(explanationDue(DUE, Temporal.Instant.from("2026-11-21T18:10:00Z"))).toEqual({ dueInDays: 6, overdue: false, dueLabel: "D-6" });
  });

  test("기한 당일 기한 시각 전이면 D-day, 지나면 기한 지남", () => {
    expect(explanationDue(DUE, Temporal.Instant.from("2026-11-27T16:00:00Z"))).toEqual({ dueInDays: 0, overdue: false, dueLabel: "D-day" });
    expect(explanationDue(DUE, Temporal.Instant.from("2026-11-27T18:10:00.001Z"))).toEqual({ dueInDays: 0, overdue: true, dueLabel: OVERDUE_LABEL });
  });

  test("8일째(기한 다음 날)는 음수와 「기한 지남」", () => {
    expect(explanationDue(DUE, Temporal.Instant.from("2026-11-28T18:10:00Z"))).toEqual({ dueInDays: -1, overdue: true, dueLabel: "기한 지남" });
  });

  test("기한 시각과 정확히 같으면 아직 지나지 않았다", () => {
    expect(explanationDue(DUE, DUE).overdue).toBe(false);
  });
});

describe("businessCaseReasonText — 대표에게 보일 사유 글", () => {
  test("폐업·휴업을 구별해 알린다", () => {
    expect(businessCaseReasonText("closed")).toContain("폐업");
    expect(businessCaseReasonText("suspended")).toContain("휴업");
  });
});

// S7-4.8c(사업자 점검 소명 처리 API(P11)) — 콘솔 응답은 가린 등록번호만 낸다(15-ops §4-1)
describe("maskBusinessNo — 사업자등록번호 가리기", () => {
  test("10자리면 앞 3·2자리만 보이고 뒤 5자리는 별표", () => {
    expect(maskBusinessNo("1234598765")).toBe("123-45-*****");
    expect(maskBusinessNo("123-45-98765")).toBe("123-45-*****");
  });
  test("자릿수가 이상하면 통째로 가린다", () => {
    expect(maskBusinessNo("12345")).toBe("***-**-*****");
    expect(maskBusinessNo("")).toBe("***-**-*****");
  });
});
