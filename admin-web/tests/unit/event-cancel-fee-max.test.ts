// S1-3.5(이벤트형 취소 수수료 저장 API) 단위 테스트 — FR-099c(이벤트·원데이·파티·공연·대회 취소 규정) · FR-099a(공지 양식)
// 계약 09 「Phase 6(테스트) 목록」: 이벤트형 상한 경계(20 통과, 21 거부) · 화면용 본문 만들기(항목 순서)
import { describe, expect, test } from "vitest";

import { buildEventNoticeBody } from "../../lib/domain/refund-notice-body";
import {
  EVENT_CANCEL_FEE_MAX_PERCENTS,
  EVENT_PROCESSING_DAYS_MAX,
  findFeeTiersAboveMax,
  type EventFeeTier,
} from "../../lib/domain/refund-templates";

/** 구간 4개를 순서대로 % 로 채운 feeTiers 를 만든다 */
const feeOf = (a: number, b: number, c: number, d: number): EventFeeTier[] => [
  { window: "d10_plus", percent: a },
  { window: "d9_d7", percent: b },
  { window: "d6_d3", percent: c },
  { window: "d2_to_deadline", percent: d },
];

describe("findFeeTiersAboveMax — 이벤트형 취소 수수료는 낮추기만 된다", () => {
  test("6일 전~3일 전 상한 경계: 20 은 통과, 21 은 거부", () => {
    expect(findFeeTiersAboveMax(feeOf(10, 10, 20, 30))).toEqual([]);
    expect(findFeeTiersAboveMax(feeOf(10, 10, 21, 30))).toEqual([{ window: "d6_d3", percent: 21, maximum: 20 }]);
  });

  test("수용 시나리오 3: 25% 는 거부, 15% 는 통과(낮추기)", () => {
    expect(findFeeTiersAboveMax(feeOf(10, 10, 25, 30))).toEqual([{ window: "d6_d3", percent: 25, maximum: 20 }]);
    expect(findFeeTiersAboveMax(feeOf(10, 10, 15, 30))).toEqual([]);
  });

  test("상한은 상수 한 곳(10·10·20·30)에서 온다 — 각 구간 상한 그대로는 통과, +1 은 그 구간만 걸린다", () => {
    expect(EVENT_CANCEL_FEE_MAX_PERCENTS).toEqual({ d10_plus: 10, d9_d7: 10, d6_d3: 20, d2_to_deadline: 30 });
    expect(findFeeTiersAboveMax(feeOf(11, 11, 21, 31)).map((f) => [f.window, f.maximum])).toEqual([
      ["d10_plus", 10],
      ["d9_d7", 10],
      ["d6_d3", 20],
      ["d2_to_deadline", 30],
    ]);
  });

  test("0% 는 통과(수수료 없이 전액 환불), 입력 순서가 섞여도 구간으로 맞춰 본다", () => {
    expect(findFeeTiersAboveMax(feeOf(0, 0, 0, 0))).toEqual([]);
    expect(findFeeTiersAboveMax([...feeOf(10, 10, 21, 30)].reverse())).toEqual([{ window: "d6_d3", percent: 21, maximum: 20 }]);
  });

  test("처리 기간 상한은 3영업일", () => {
    expect(EVENT_PROCESSING_DAYS_MAX).toBe(3);
  });
});

describe("buildEventNoticeBody — FR-099a 항목 순서", () => {
  test("여섯 항목 순서 + 구간은 늘 10일 전 → 환불 마감일 순", () => {
    const body = buildEventNoticeBody({
      feeTiers: [...feeOf(5, 10, 15, 30)].reverse(),
      nonRefundableCases: "환불 마감일이 지난 뒤의 취소",
      processingBusinessDays: 3,
      ownerContact: "01012345678",
    });
    const lines = body.split("\n");
    expect(lines.map((l) => l.trim().split(" ")[0])).toEqual(["1.", "2.", "-", "-", "-", "-", "3.", "4.", "5.", "6."]);
    expect(lines[2]).toContain("10일 전까지: 낸 참가비의 5%");
    expect(lines[4]).toContain("6일 전 ~ 3일 전: 낸 참가비의 15%");
    expect(lines[5]).toContain("2일 전 ~ 환불 마감일까지: 낸 참가비의 30%");
    expect(lines[0]).toContain("환불 마감일");
    expect(lines[7]).toBe("4. 환불 처리 기간: 요청 뒤 3영업일 안");
  });
});
