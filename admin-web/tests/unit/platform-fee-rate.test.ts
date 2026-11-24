// S3-3.2a(수수료 분류와 주문에 고정하는 요율) · S3-3.17(개인 레슨 수수료 강사 가입 1년 면제)
//   — 주문에 고정할 플랫폼 수수료율 판정(순수 함수) 단위 테스트
//   요구: data-model §7-8b · 결정 12(일반 5%·개인 레슨 1%) · 결정 13(입점 면제는 일반 수업·행사에만) · FR-124 · FR-135a · 전제 5b · FR-284
//   verify: 면제 기간 일반 0bp · 면제 뒤 일반 500bp · 개인 레슨은 강사 가입 1년 안 0bp · 1년 되는 날 0bp · 다음 날 100bp
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import { CLASS_KINDS } from "../../lib/domain/constants";
import {
  appliedPlatformFee,
  effectiveFeeRate,
  feeCategoryOfClassKind,
  instructorExemptUntil,
  withinOnboardingExemption,
  type PlatformFeeRateRow,
} from "../../lib/domain/platform-fee-rate";

const SEED_FROM = Temporal.Instant.from("2026-01-01T00:00:00Z");
// 마이그레이션 시드와 같은 두 행(일반 500bp 면제 적용 · 개인 레슨 100bp 면제 미적용)
const SEED: PlatformFeeRateRow[] = [
  { feeCategory: "general", rateBp: 500, onboardingExemptionApplies: true, effectiveFrom: SEED_FROM },
  { feeCategory: "private_lesson", rateBp: 100, onboardingExemptionApplies: false, effectiveFrom: SEED_FROM },
];
const EXEMPT_UNTIL = Temporal.PlainDate.from("2027-11-20"); // 2026-11-20 승인 + 1년
const IN_EXEMPTION = Temporal.Instant.from("2026-12-01T03:00:00Z");
const AFTER_EXEMPTION = Temporal.Instant.from("2027-11-21T03:00:00Z");
// 강사 가입 시각 — 2026-11-01 10:00 KST. 개인 레슨 면제는 2027-11-01(KST)까지
const INSTRUCTOR_SIGNED_UP = Temporal.Instant.from("2026-11-01T01:00:00Z");
// 아주 옛날에 가입한 강사(면제가 이미 끝남) — 학원 입점 면제와 섞이지 않는지 볼 때 쓴다
const OLD_INSTRUCTOR = Temporal.Instant.from("2020-01-01T01:00:00Z");

describe("feeCategoryOfClassKind — 수업 종류 → 수수료 분류", () => {
  test("개인 레슨만 private_lesson, 나머지 8종은 general(일반 수업·행사)", () => {
    for (const kind of CLASS_KINDS) {
      expect(feeCategoryOfClassKind(kind)).toBe(kind === "private_lesson" ? "private_lesson" : "general");
    }
  });
});

describe("appliedPlatformFee — 주문에 고정할 실제 적용 요율", () => {
  test("면제 기간 일반 수업은 0bp", () => {
    expect(appliedPlatformFee({ classKind: "regular", paidAt: IN_EXEMPTION, exemptUntil: EXEMPT_UNTIL, instructorSignedUpAt: null, rates: SEED })).toEqual({
      feeCategory: "general",
      rateBp: 0,
      exempted: true,
    });
  });
  test("면제 기간 행사(이벤트형)도 0bp", () => {
    for (const kind of ["one_day", "event", "party", "performance", "competition"] as const) {
      expect(appliedPlatformFee({ classKind: kind, paidAt: IN_EXEMPTION, exemptUntil: EXEMPT_UNTIL, instructorSignedUpAt: null, rates: SEED }).rateBp).toBe(0);
    }
  });
  test("학원 입점 면제 기간이어도 강사 가입 면제가 끝난 개인 레슨은 100bp(입점 면제는 개인 레슨에 쓰지 않는다)", () => {
    expect(
      appliedPlatformFee({ classKind: "private_lesson", paidAt: IN_EXEMPTION, exemptUntil: EXEMPT_UNTIL, instructorSignedUpAt: OLD_INSTRUCTOR, rates: SEED }),
    ).toEqual({ feeCategory: "private_lesson", rateBp: 100, exempted: false });
  });
  test("면제 뒤 일반 수업은 500bp", () => {
    expect(appliedPlatformFee({ classKind: "regular", paidAt: AFTER_EXEMPTION, exemptUntil: EXEMPT_UNTIL, instructorSignedUpAt: null, rates: SEED })).toEqual({
      feeCategory: "general",
      rateBp: 500,
      exempted: false,
    });
  });
  test("담당 강사의 가입일을 모르면(null) 개인 레슨은 100bp", () => {
    expect(appliedPlatformFee({ classKind: "private_lesson", paidAt: AFTER_EXEMPTION, exemptUntil: EXEMPT_UNTIL, instructorSignedUpAt: null, rates: SEED }).rateBp).toBe(100);
  });
  test("면제 종료일이 없는 학원(null)은 일반도 500bp", () => {
    expect(appliedPlatformFee({ classKind: "basic", paidAt: IN_EXEMPTION, exemptUntil: null, instructorSignedUpAt: null, rates: SEED }).rateBp).toBe(500);
  });
  test("결제 시점의 판본을 고른다 — 미래 요율은 시작 전이면 쓰지 않고, 시작 뒤 결제부터 쓴다", () => {
    const next = Temporal.Instant.from("2027-03-01T00:00:00Z");
    const rates: PlatformFeeRateRow[] = [
      ...SEED,
      { feeCategory: "general", rateBp: 600, onboardingExemptionApplies: true, effectiveFrom: next },
    ];
    const before = Temporal.Instant.from("2027-02-28T14:59:59Z");
    expect(appliedPlatformFee({ classKind: "regular", paidAt: before, exemptUntil: null, instructorSignedUpAt: null, rates }).rateBp).toBe(500);
    expect(appliedPlatformFee({ classKind: "regular", paidAt: next, exemptUntil: null, instructorSignedUpAt: null, rates }).rateBp).toBe(600);
  });
});

describe("appliedPlatformFee — 개인 레슨은 강사 가입일부터 1년 면제(S3-3.17)", () => {
  const privateLesson = (paidAt: Temporal.Instant, exemptUntil: Temporal.PlainDate | null = null) =>
    appliedPlatformFee({ classKind: "private_lesson", paidAt, exemptUntil, instructorSignedUpAt: INSTRUCTOR_SIGNED_UP, rates: SEED });

  test("가입 1년 안 개인 레슨은 0bp(학원 입점 면제가 없어도)", () => {
    expect(privateLesson(Temporal.Instant.from("2027-03-15T03:00:00Z"))).toEqual({
      feeCategory: "private_lesson",
      rateBp: 0,
      exempted: true,
    });
  });
  test("가입한 바로 그 순간에 결제해도 0bp", () => {
    expect(privateLesson(INSTRUCTOR_SIGNED_UP).rateBp).toBe(0);
  });
  test("1년 되는 날(2027-11-01 KST 23:59) 결제는 0bp", () => {
    expect(privateLesson(Temporal.Instant.from("2027-11-01T14:59:00Z")).rateBp).toBe(0);
  });
  test("다음 날(2027-11-02 KST 00:00) 결제부터 100bp", () => {
    expect(privateLesson(Temporal.Instant.from("2027-11-01T15:00:00Z"))).toEqual({
      feeCategory: "private_lesson",
      rateBp: 100,
      exempted: false,
    });
  });
  test("학원 입점 면제 종료일과 따로 센다 — 학원 면제가 남아 있어도 강사 1년이 지나면 100bp", () => {
    expect(privateLesson(Temporal.Instant.from("2027-11-10T03:00:00Z"), Temporal.PlainDate.from("2028-05-01")).rateBp).toBe(100);
  });
  test("일반 수업은 강사가 막 가입했어도 강사 면제를 받지 않는다 — 학원 입점 면제 그대로", () => {
    const paidAt = Temporal.Instant.from("2027-03-15T03:00:00Z");
    const regular = (exemptUntil: Temporal.PlainDate | null) =>
      appliedPlatformFee({ classKind: "regular", paidAt, exemptUntil, instructorSignedUpAt: INSTRUCTOR_SIGNED_UP, rates: SEED });
    expect(regular(EXEMPT_UNTIL)).toEqual({ feeCategory: "general", rateBp: 0, exempted: true });
    expect(regular(null)).toEqual({ feeCategory: "general", rateBp: 500, exempted: false });
  });
});

describe("instructorExemptUntil — 강사 가입 KST 날짜 + 1년", () => {
  test("KST 날짜로 센다 — UTC 로는 전날이어도 KST 로 다음 날이면 그날이 가입일", () => {
    // 2026-11-01T16:00Z = 2026-11-02 01:00 KST
    expect(instructorExemptUntil(Temporal.Instant.from("2026-11-01T16:00:00Z"))?.toString()).toBe("2027-11-02");
  });
  test("2월 29일 가입은 다음 해 2월 28일까지", () => {
    expect(instructorExemptUntil(Temporal.Instant.from("2028-02-29T03:00:00Z"))?.toString()).toBe("2029-02-28");
  });
  test("가입일을 모르면 null", () => {
    expect(instructorExemptUntil(null)).toBeNull();
  });
});

describe("withinOnboardingExemption — 면제 기간 판정(KST 날짜, 종료일 포함)", () => {
  test("종료일 KST 23:59 는 면제, 다음 날 KST 00:00 은 면제 아님", () => {
    expect(withinOnboardingExemption(Temporal.Instant.from("2027-11-20T14:59:00Z"), EXEMPT_UNTIL)).toBe(true);
    expect(withinOnboardingExemption(Temporal.Instant.from("2027-11-20T15:00:00Z"), EXEMPT_UNTIL)).toBe(false);
  });
  test("종료일이 없으면 면제 아님", () => {
    expect(withinOnboardingExemption(IN_EXEMPTION, null)).toBe(false);
  });
});

describe("effectiveFeeRate — 유효한 요율 행이 없으면 멈춘다", () => {
  test("결제 시각 전에 시작한 행이 없으면 오류", () => {
    expect(() => effectiveFeeRate(SEED, "general", Temporal.Instant.from("2025-12-31T00:00:00Z"))).toThrow(/유효한 수수료율이 없다/);
  });
  test("그 분류 행이 아예 없으면 오류", () => {
    expect(() => effectiveFeeRate(SEED.filter((r) => r.feeCategory === "general"), "private_lesson", IN_EXEMPTION)).toThrow();
  });
});
