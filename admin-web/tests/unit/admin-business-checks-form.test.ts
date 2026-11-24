// S7-4.9g(사업자 점검 화면(P11)) — 화면 글자(감지·점검 시각, 국세청 결과)와 버튼을 켜는 규칙
import { describe, expect, it } from "vitest";

import { caseButtons, caseFootText, checkResultLines, detectedText, lastRunText } from "../../lib/admin-business-checks-form";

// 지금 = 2026-11-19 10:00 KST
const NOW = "2026-11-19T01:00:00Z";

describe("사업자 점검 화면 글자", () => {
  it("마지막 점검 — 오늘·어제·그 밖, 정산 직전 점검, 기록 없음", () => {
    expect(lastRunText("2026-11-18T18:10:00Z", "daily", NOW)).toBe("오늘 03:10 점검");
    expect(lastRunText("2026-11-17T18:10:00Z", "daily", NOW)).toBe("어제 03:10 점검");
    expect(lastRunText("2026-11-10T05:00:00Z", "pre_payout", NOW)).toBe("11/10 14:00 정산 직전 점검");
    expect(lastRunText(null, null, NOW)).toBe("아직 점검 기록이 없어요");
  });

  it("목록 감지 글자 — 보드 P11 과 같은 모양, 기한 지남, 기한 없음", () => {
    expect(detectedText({ detectedAt: "2026-11-18T18:10:00Z", dueLabel: "D-7" }, NOW)).toBe("오늘 03:10 감지 · 소명 D-7");
    expect(detectedText({ detectedAt: "2026-11-17T18:10:00Z", dueLabel: "D-5" }, NOW)).toBe("어제 감지 11/18 03:10 · 소명 D-5");
    expect(detectedText({ detectedAt: "2026-11-10T18:10:00Z", dueLabel: "기한 지남" }, NOW)).toBe("11/11 03:10 감지 · 소명 기한 지남");
    expect(detectedText({ detectedAt: "2026-11-10T18:10:00Z", dueLabel: null }, NOW)).toBe("11/11 03:10 감지");
  });

  it("어제 판단은 달이 바뀌어도 맞다(12-01 의 어제 = 11-30)", () => {
    expect(detectedText({ detectedAt: "2026-11-29T18:10:00Z", dueLabel: null }, "2026-12-01T01:00:00Z")).toBe("어제 감지 11/30 03:10");
  });

  it("국세청 조회 결과 두 줄 — 폐업일·이전 상태", () => {
    const lines = checkResultLines({ checkedAt: "2026-11-17T18:10:00Z", status: "closed", closedOn: "2026-11-10", previousStatus: "active" });
    expect(lines).toEqual({ headline: "폐업자 · 폐업일 2026-11-10", sub: "조회 11/18 03:10 · 지난 점검에서는 「계속 사업」" });
    expect(checkResultLines({ checkedAt: "2026-11-17T18:10:00Z", status: "suspended", closedOn: null, previousStatus: null }).headline).toBe("휴업자");
  });
});

describe("사업자 점검 버튼 규칙", () => {
  const one = [{ explanationId: "x", submittedAt: NOW, body: "b", attachments: [] }];

  it("소명이 있으면 풀기·게시 중단 둘 다, 소명이 없으면 게시 중단만", () => {
    expect(caseButtons({ state: "explained", explanations: one })).toEqual({ accept: true, suspend: true });
    expect(caseButtons({ state: "notice_sent", explanations: [] })).toEqual({ accept: false, suspend: true });
  });

  it("게시 중단 뒤에는 풀기만, 끝난 건은 둘 다 없음", () => {
    expect(caseButtons({ state: "measure_applied", explanations: one })).toEqual({ accept: true, suspend: false });
    expect(caseButtons({ state: "lifted", explanations: one })).toEqual({ accept: false, suspend: false });
    expect(caseButtons({ state: "dismissed", explanations: [] })).toEqual({ accept: false, suspend: false });
  });

  it("아래 안내 — 기한 안 · 기한 지남(소명 없음) · 풀림", () => {
    expect(caseFootText({ state: "explained", dueLabel: "D-5", overdue: false, explanations: one })).toBe(
      "소명 기한은 D-5예요 · 기한이 지나도 소명이 없으면 게시 중단을 안내해요",
    );
    expect(caseFootText({ state: "notice_sent", dueLabel: "기한 지남", overdue: true, explanations: [] })).toBe(
      "소명 기한이 지났어요 · 소명이 없으니 게시 중단을 눌러 주세요",
    );
    expect(caseFootText({ state: "lifted", dueLabel: null, overdue: false, explanations: one })).toContain("제한을 풀었어요");
  });
});
