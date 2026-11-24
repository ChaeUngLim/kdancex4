// S1-3.10(관리자 웹 이벤트형 수수료 표 W4b) — 이벤트형 공지 화면의 순수 함수 확인: 처음 값 · 저장 요청 · 서버 오류 → 칸 · 낮춤 안내.
import { describe, expect, test } from "vitest";

import { EVENT_CANCEL_FEE_MAX_PERCENTS } from "@/lib/domain/refund-templates";
import {
  buildEventNoticeRequest,
  DEFAULT_EVENT_NON_REFUNDABLE_CASES,
  eventFieldErrorsByKey,
  initialEventNoticeForm,
  isAboveMax,
  isLowered,
  isProcessingDaysOver,
  loweredTierNotes,
  maxLabel,
  type EventNoticeCurrent,
} from "@/lib/event-notice-form";

const maxFeePercents = { ...EVENT_CANCEL_FEE_MAX_PERCENTS };
const empty: EventNoticeCurrent = { version: null, createdAt: null, content: null, maxFeePercents };

describe("initialEventNoticeForm — 처음 값", () => {
  test("판본이 없으면 구간마다 플랫폼 최대값 · 처리 기간 3 · 연락처는 숫자만", () => {
    const form = initialEventNoticeForm(empty, "02-555-0142");
    expect(form.percents).toEqual({ d10_plus: "10", d9_d7: "10", d6_d3: "20", d2_to_deadline: "30" });
    expect(form.processingBusinessDays).toBe("3");
    expect(form.ownerContact).toBe("025550142");
    expect(form.nonRefundableCases).toBe(DEFAULT_EVENT_NON_REFUNDABLE_CASES);
  });

  test("저장된 판본이 있으면 그 값으로", () => {
    const form = initialEventNoticeForm(
      {
        ...empty,
        version: 2,
        createdAt: "2026-11-21T00:00:00.000Z",
        content: {
          feeTiers: [
            { window: "d10_plus", percent: 0 },
            { window: "d9_d7", percent: 10 },
            { window: "d6_d3", percent: 15 },
            { window: "d2_to_deadline", percent: 30 },
          ],
          nonRefundableCases: "마감 뒤 결제",
          processingBusinessDays: 2,
          ownerContact: "0212345678",
        },
      },
      "0200000000",
    );
    expect(form.percents.d6_d3).toBe("15");
    expect(form.percents.d10_plus).toBe("0");
    expect(form.processingBusinessDays).toBe("2");
    expect(form.ownerContact).toBe("0212345678");
    expect(form.nonRefundableCases).toBe("마감 뒤 결제");
  });
});

describe("buildEventNoticeRequest — 저장 요청", () => {
  test("구간은 늘 정해진 순서, 숫자 칸은 정수로, 연락처 하이픈 제거", () => {
    const form = { ...initialEventNoticeForm(empty, "02-555-0142"), ownerContact: "02-555-0142" };
    const body = buildEventNoticeRequest({ ...form, percents: { ...form.percents, d6_d3: "15" } }, 1);
    expect(body.baseVersion).toBe(1);
    expect(body.content.feeTiers.map((t) => t.window)).toEqual(["d10_plus", "d9_d7", "d6_d3", "d2_to_deadline"]);
    expect(body.content.feeTiers[2]).toEqual({ window: "d6_d3", percent: 15 });
    expect(body.content.processingBusinessDays).toBe(3);
    expect(body.content.ownerContact).toBe("025550142");
  });

  test("숫자가 아닌 칸은 글자 그대로 보내 서버가 짚게 한다", () => {
    const form = initialEventNoticeForm(empty, "0200000000");
    const body = buildEventNoticeRequest({ ...form, percents: { ...form.percents, d9_d7: "열" } }, null);
    expect(body.content.feeTiers[1]?.percent).toBe("열");
  });
});

describe("eventFieldErrorsByKey — 서버 오류 → 칸", () => {
  test("content.feeTiers.2.percent 는 6일~3일 전, 처리 기간 경로는 그 칸", () => {
    expect(
      eventFieldErrorsByKey([
        { path: "content.feeTiers.2.percent", message: "20% 이하여야 해요" },
        { path: "content.processingBusinessDays", message: "3영업일 이하여야 해요" },
        { path: "baseVersion", message: "무시" },
      ]),
    ).toEqual({ d6_d3: "20% 이하여야 해요", processingBusinessDays: "3영업일 이하여야 해요" });
  });
});

describe("칸 색·안내", () => {
  test("최대와 같으면 통과, 넘으면 빨강, 낮추면 플럼", () => {
    expect(isAboveMax("20", 20)).toBe(false);
    expect(isAboveMax("21", 20)).toBe(true);
    expect(isLowered("15", 20)).toBe(true);
    expect(isLowered("20", 20)).toBe(false);
    expect(isAboveMax("", 20)).toBe(false);
  });

  test("낮춘 구간만 안내한다", () => {
    const form = initialEventNoticeForm(empty, "0200000000");
    expect(loweredTierNotes(form, maxFeePercents)).toEqual([]);
    expect(loweredTierNotes({ ...form, percents: { ...form.percents, d6_d3: "15" } }, maxFeePercents)).toEqual([
      "6일 전 ~ 3일 전 구간을 15%로 낮췄어요",
    ]);
  });

  test("처리 기간 3 은 통과, 4 는 넘음 · 10일 전까지 최대는 「이내」", () => {
    expect(isProcessingDaysOver("3")).toBe(false);
    expect(isProcessingDaysOver("4")).toBe(true);
    expect(maxLabel("d10_plus", 10)).toBe("10% 이내");
    expect(maxLabel("d6_d3", 20)).toBe("20%");
  });
});
