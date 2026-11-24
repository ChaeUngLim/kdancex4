// S7-2.10b(관리자 웹 신고 처리 화면) — 신고함 화면의 순수 규칙: 거르기, 누를 수 있는 버튼, 조치 목록, 처리 입력 확인·본문.
import { describe, expect, test } from "vitest";

import {
  EMPTY_RESOLVE_FORM,
  availableReportActions,
  buildResolveBody,
  measuresForTarget,
  parseReportStatusFilter,
  resolveFormProblems,
} from "@/lib/admin-report-form";

describe("신고함 화면 규칙(S7-2.10b)", () => {
  test("거르기 — 아는 상태만 받고 나머지는 전체(null)", () => {
    expect(parseReportStatusFilter("in_review")).toBe("in_review");
    expect(parseReportStatusFilter("done")).toBeNull();
    expect(parseReportStatusFilter(["received"])).toBeNull();
    expect(parseReportStatusFilter(undefined)).toBeNull();
  });

  test("버튼 — 접수는 확인 시작·처리, 확인 중은 처리만, 처리 끝은 없음", () => {
    expect(availableReportActions("received")).toEqual(["startReview", "resolve"]);
    expect(availableReportActions("in_review")).toEqual(["resolve"]);
    expect(availableReportActions("resolved")).toEqual([]);
  });

  test("조치 — 수업·학원 신고는 여섯 가지, 회원·강사 신고는 학원 전용 조치를 뺀다", () => {
    expect(measuresForTarget("class")).toHaveLength(6);
    expect(measuresForTarget("academy")).toContain("payout_hold");
    expect(measuresForTarget("member")).toEqual(["warning", "feature_limit", "suspension", "termination"]);
    expect(measuresForTarget("instructor")).not.toContain("listing_limit");
  });

  test("입력 확인 — 결과 미선택, 제한을 켜고 조치·사유가 비면 안내", () => {
    expect(resolveFormProblems(EMPTY_RESOLVE_FORM)).toEqual(["처리 결과(인정·기각)를 골라 주세요"]);
    expect(resolveFormProblems({ ...EMPTY_RESOLVE_FORM, outcome: "upheld", openRestriction: true })).toEqual([
      "예정 조치를 골라 주세요",
      "대상에게 알릴 사유를 적어 주세요",
    ]);
    // 기각이면 제한 칸은 보지 않는다
    expect(resolveFormProblems({ ...EMPTY_RESOLVE_FORM, outcome: "dismissed", openRestriction: true })).toEqual([]);
    expect(resolveFormProblems({ ...EMPTY_RESOLVE_FORM, outcome: "dismissed", note: "가".repeat(1001) })).toHaveLength(1);
  });

  test("본문 — 빈 메모는 null, 인정+조치면 openRestriction, 기각이면 늘 null", () => {
    expect(buildResolveBody({ ...EMPTY_RESOLVE_FORM, outcome: "dismissed", note: "  " })).toEqual({
      outcome: "dismissed",
      note: null,
      openRestriction: null,
    });
    expect(
      buildResolveBody({ outcome: "upheld", note: " 대화 캡처 확인 ", openRestriction: true, measure: "warning", reasonText: " 앱 밖 결제 유도 " }),
    ).toEqual({ outcome: "upheld", note: "대화 캡처 확인", openRestriction: { measure: "warning", reasonText: "앱 밖 결제 유도" } });
    expect(buildResolveBody({ outcome: "dismissed", note: "", openRestriction: true, measure: "warning", reasonText: "x" }).openRestriction).toBeNull();
    expect(() => buildResolveBody(EMPTY_RESOLVE_FORM)).toThrow();
  });
});
