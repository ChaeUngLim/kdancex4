// S1-3.4(정규 과정 공지 저장 API) — 정규 공지 화면용 본문이 FR-099a(환불·취소 공지 양식) 항목 순서를 지키는지 본다.
import { describe, expect, test } from "vitest";

import { buildRegularNoticeBody, REFUND_REQUEST_METHOD_TEXT } from "@/lib/domain/refund-notice-body";

const content = {
  cancellableUntil: "수강 시작 전까지 언제든",
  // 일부러 순서를 섞어 보낸다 — 본문은 늘 시점 순서대로 나와야 한다
  tiers: [
    { point: "after_half", percent: 0 },
    { point: "before_half", percent: 50 },
    { point: "before_start", percent: 100 },
    { point: "before_one_third", percent: 67 },
  ],
  nonRefundableCases: "이미 들은 회차",
  processingBusinessDays: 5,
  ownerContact: "0200000000",
} as const;

describe("buildRegularNoticeBody", () => {
  test("여섯 항목을 FR-099a 순서로, 시점별 기준은 시점 순서로 적는다", () => {
    expect(buildRegularNoticeBody(content)).toBe(
      [
        "1. 취소 가능 시점: 수강 시작 전까지 언제든",
        "2. 시점별 환불 기준",
        "   - 수강 시작 전: 낸 금액의 100% 환불",
        "   - 총 기간의 1/3 이 지나기 전: 낸 금액의 67% 환불",
        "   - 총 기간의 1/2 이 지나기 전: 낸 금액의 50% 환불",
        "   - 총 기간의 1/2 이 지난 뒤: 낸 금액의 0% 환불",
        "3. 환불이 안 되는 경우: 이미 들은 회차",
        "4. 환불 처리 기간: 요청 뒤 5영업일 안",
        `5. 환불 요청 방법: ${REFUND_REQUEST_METHOD_TEXT}`,
        "6. 대표 연락처: 0200000000",
      ].join("\n"),
    );
  });
});
