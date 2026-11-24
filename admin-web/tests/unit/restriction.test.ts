// S7-2.6(이용 제한 절차) — 순수 규칙(lib/domain/restriction.ts) 확인. DB 없이 돈다.
import { describe, expect, test } from "vitest";

import {
  academyRestrictionKindFor,
  initialRestrictionState,
  RESTRICTION_REASON_CODES,
  restrictionNoticeText,
  restrictionSubjectForReportTarget,
} from "@/lib/domain/restriction";

describe("이용 제한 순수 규칙(S7-2.6)", () => {
  test("첫 단계 — 보통은 사유 통지, 긴급이면 조치 먼저", () => {
    expect(initialRestrictionState(false)).toBe("notice_sent");
    expect(initialRestrictionState(true)).toBe("measure_applied");
  });

  test("학원 제한 행 — 학원의 게시 제한·정산 보류만 행이 된다", () => {
    expect(academyRestrictionKindFor("academy", "listing_limit")).toBe("listing_suspended");
    expect(academyRestrictionKindFor("academy", "payout_hold")).toBe("payout_hold");
    expect(academyRestrictionKindFor("academy", "warning")).toBeNull();
    expect(academyRestrictionKindFor("member", "payout_hold")).toBeNull();
    expect(academyRestrictionKindFor("instructor", "listing_limit")).toBeNull();
  });

  test("신고 대상 → 제한 대상 — 수업 신고는 학원", () => {
    expect(restrictionSubjectForReportTarget("class")).toBe("academy");
    expect(restrictionSubjectForReportTarget("academy")).toBe("academy");
    expect(restrictionSubjectForReportTarget("member")).toBe("member");
    expect(restrictionSubjectForReportTarget("instructor")).toBe("instructor");
  });

  test("사유 코드 — 신고 사유 다섯 개를 모두 받는다", () => {
    for (const code of ["off_platform_payment", "info_mismatch", "harassment", "illegal_dangerous", "other"]) {
      expect(RESTRICTION_REASON_CODES).toContain(code);
    }
  });

  test("알림 글 — 사유 글을 싣고, 긴급이면 「적용됐어요」", () => {
    const notice = restrictionNoticeText({ urgent: false, measure: "listing_limit", reasonText: "앱 밖 결제 유도" });
    expect(notice.title).toBe("이용 제한(수업 게시 제한) 예정 안내");
    expect(notice.body).toContain("앱 밖 결제 유도");
    expect(restrictionNoticeText({ urgent: true, measure: "payout_hold", reasonText: "x" }).title).toBe("이용 제한(정산 보류)이 적용됐어요");
  });
});
