// S1-3.9(관리자 웹 공지 화면 W4a) — 공지 화면의 순수 함수 확인: 처음 값 · 저장 요청 · 서버 오류 → 칸 · 안내 문구.
import { describe, expect, test } from "vitest";

import {
  buildRegularNoticeRequest,
  fieldErrorsByKey,
  formatPhone,
  initialRegularNoticeForm,
  isBelowMinimum,
  processingDaysWarning,
  raisedTierNotes,
} from "@/lib/refund-notice-form";
import type { RefundNoticesCurrent } from "@/lib/server/services/refund-notice-read";

const template: NonNullable<RefundNoticesCurrent["regular"]["template"]> = {
  code: "hakwon_act",
  templateVersion: "2026-11-13",
  minimums: [
    { point: "before_start", percent: 100 },
    { point: "before_one_third", percent: 67 },
    { point: "before_half", percent: 50 },
    { point: "after_half", percent: 0 },
  ],
};
const empty: RefundNoticesCurrent["regular"] = { version: null, createdAt: null, content: null, template };

describe("initialRegularNoticeForm", () => {
  test("판본이 없으면 템플릿 최소값·기본 문구·학원 전화(숫자만)로 채운다", () => {
    const form = initialRegularNoticeForm(empty, "02-000-0000");
    expect(form.percents).toEqual({ before_start: "100", before_one_third: "67", before_half: "50", after_half: "0" });
    expect(form.cancellableUntil).toBe("수강 시작 전까지 언제든");
    expect(form.processingBusinessDays).toBe("5");
    expect(form.ownerContact).toBe("020000000");
  });

  test("저장된 판본이 있으면 그 값을 그대로 쓴다", () => {
    const form = initialRegularNoticeForm(
      {
        ...empty,
        version: 2,
        createdAt: "2026-11-20T00:00:00Z",
        content: {
          cancellableUntil: "첫 수업 전날까지",
          tiers: [
            { point: "before_start", percent: 100 },
            { point: "before_one_third", percent: 80 },
            { point: "before_half", percent: 67 },
            { point: "after_half", percent: 10 },
          ],
          nonRefundableCases: "기간 끝난 수강권",
          processingBusinessDays: 7,
          ownerContact: "01012345678",
        },
      },
      "020000000",
    );
    expect(form.percents.before_half).toBe("67");
    expect(form.cancellableUntil).toBe("첫 수업 전날까지");
    expect(form.processingBusinessDays).toBe("7");
    expect(form.ownerContact).toBe("01012345678");
  });

  test("템플릿이 없는 등록 형태(신고 체육시설)는 % 칸을 비워 둔다 — 값을 지어내지 않는다", () => {
    const form = initialRegularNoticeForm({ ...empty, template: null }, "");
    expect(Object.values(form.percents)).toEqual(["", "", "", ""]);
  });
});

describe("buildRegularNoticeRequest", () => {
  test("시점은 늘 정해진 순서, % 는 정수, 연락처는 숫자만", () => {
    const form = { ...initialRegularNoticeForm(empty, "02-000-0000"), ownerContact: "02-000-0000" };
    const body = buildRegularNoticeRequest({ ...form, percents: { ...form.percents, before_half: " 67 " } }, 3);
    expect(body.baseVersion).toBe(3);
    expect(body.content.tiers).toEqual([
      { point: "before_start", percent: 100 },
      { point: "before_one_third", percent: 67 },
      { point: "before_half", percent: 67 },
      { point: "after_half", percent: 0 },
    ]);
    expect(body.content.processingBusinessDays).toBe(5);
    expect(body.content.ownerContact).toBe("020000000");
  });

  test("정수가 아니면 글자 그대로 보낸다(서버가 VALIDATION_FAILED 로 짚는다)", () => {
    const form = initialRegularNoticeForm(empty, "");
    const body = buildRegularNoticeRequest({ ...form, percents: { ...form.percents, after_half: "1.5" } }, null);
    expect(body.content.tiers[3]).toEqual({ point: "after_half", percent: "1.5" });
  });
});

describe("fieldErrorsByKey", () => {
  test("tiers 경로의 번호 → 시점, content 칸 → 칸 이름, 모르는 경로는 버린다", () => {
    expect(
      fieldErrorsByKey([
        { path: "content.tiers.2.percent", message: "50% 이상이어야 해요" },
        { path: "content.ownerContact", message: "연락처 형식" },
        { path: "baseVersion", message: "무시" },
      ]),
    ).toEqual({ before_half: "50% 이상이어야 해요", ownerContact: "연락처 형식" });
  });
});

describe("안내 문구", () => {
  test("템플릿보다 올린 시점만 안내한다", () => {
    const form = initialRegularNoticeForm(empty, "");
    expect(raisedTierNotes(form, template)).toEqual([]);
    expect(raisedTierNotes({ ...form, percents: { ...form.percents, before_half: "67" } }, template)).toEqual([
      "총 기간 1/2 지나기 전 50% → 67% 로 올렸어요",
    ]);
    expect(raisedTierNotes(form, null)).toEqual([]);
  });

  test("하한보다 낮은 칸 판정 — 같은 값은 통과", () => {
    expect(isBelowMinimum("40", 50)).toBe(true);
    expect(isBelowMinimum("50", 50)).toBe(false);
    expect(isBelowMinimum("40", undefined)).toBe(false);
  });

  test("처리 기간은 30영업일까지 경고 없음, 31 부터 경고", () => {
    expect(processingDaysWarning("30")).toBeNull();
    expect(processingDaysWarning("31")).toContain("30영업일보다 길어요");
  });

  test("전화번호 하이픈", () => {
    expect(formatPhone("020000000")).toBe("02-000-0000");
    expect(formatPhone("0212345678")).toBe("02-1234-5678");
    expect(formatPhone("01012345678")).toBe("010-1234-5678");
    expect(formatPhone("0311234567")).toBe("031-123-4567");
    expect(formatPhone("12")).toBe("12");
  });
});
