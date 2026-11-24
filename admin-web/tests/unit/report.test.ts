// S7-2.5(신고 접수·처리) — 신고 순수 규칙(lib/domain/report.ts): 신고 가능한 조합(계약 15 열린 점 ⑩)과 결과 글자.
import { describe, expect, test } from "vitest";

import { REPORT_REASON_CODES, REPORT_TARGET_KINDS } from "@/lib/domain/constants";
import { isReportTargetAllowed, REPORT_REASON_LABELS, REPORT_TARGET_KIND_LABELS, reportOutcomeLabel } from "@/lib/domain/report";

describe("신고 가능한 조합(열린 점 ⑩)", () => {
  test("회원은 학원·강사·수업·회원 모두 신고할 수 있다", () => {
    for (const target of REPORT_TARGET_KINDS) expect(isReportTargetAllowed("member", target)).toBe(true);
  });
  test("강사·대표는 회원만 신고할 수 있다", () => {
    for (const reporter of ["instructor", "owner"] as const) {
      expect(isReportTargetAllowed(reporter, "member")).toBe(true);
      for (const target of ["academy", "instructor", "class"] as const) expect(isReportTargetAllowed(reporter, target)).toBe(false);
    }
  });
});

describe("신고 글자", () => {
  test("사유·대상 글자가 값마다 하나씩 있다", () => {
    expect(Object.keys(REPORT_REASON_LABELS).sort()).toEqual([...REPORT_REASON_CODES].sort());
    expect(Object.keys(REPORT_TARGET_KIND_LABELS).sort()).toEqual([...REPORT_TARGET_KINDS].sort());
    expect(REPORT_REASON_LABELS.off_platform_payment).toBe("앱 밖 결제·거래 유도");
  });
  test("처리 결과 글자는 처리 끝일 때만 나온다", () => {
    expect(reportOutcomeLabel("received", null)).toBeNull();
    expect(reportOutcomeLabel("in_review", null)).toBeNull();
    expect(reportOutcomeLabel("resolved", "upheld")).toBe("처리했어요");
    expect(reportOutcomeLabel("resolved", "dismissed")).toBe("신고 내용을 확인했지만 조치할 일이 없어요");
  });
});
