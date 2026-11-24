// S3-1.3(연령 판정과 결제 시작 차단) — 만 나이 순수 함수. DB 없이 돈다.
//   verify: 생일 전날·당일 경계(전날은 만 18세라 결제 불가, 당일부터 만 19세라 결제 가능)
// 이름: verify 의 tests/unit/s3-1-3.test.ts 는 Task 번호 이름이라 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import { canStartPaymentByAge, fullAgeYears, MEMBER_PAYMENT_MIN_AGE_YEARS } from "@/lib/domain/member-age";
import { isAtLeastAge, STAFF_MIN_AGE_YEARS } from "@/lib/domain/staff-signup";

const d = (iso: string) => Temporal.PlainDate.from(iso);

describe("회원 만 나이와 결제 시작 가능 여부(FR-009)", () => {
  test("기준 나이는 만 19세 — 강사·대표 가입 기준과 같다", () => {
    expect(MEMBER_PAYMENT_MIN_AGE_YEARS).toBe(19);
    expect(MEMBER_PAYMENT_MIN_AGE_YEARS).toBe(STAFF_MIN_AGE_YEARS);
  });

  test("19번째 생일 전날은 만 18세 → 결제 시작 불가", () => {
    expect(fullAgeYears(d("2007-11-24"), d("2026-11-23"))).toBe(18);
    expect(canStartPaymentByAge(d("2007-11-24"), d("2026-11-23"))).toBe(false);
  });

  test("19번째 생일 당일은 만 19세 → 결제 시작 가능", () => {
    expect(fullAgeYears(d("2007-11-23"), d("2026-11-23"))).toBe(19);
    expect(canStartPaymentByAge(d("2007-11-23"), d("2026-11-23"))).toBe(true);
  });

  test("생일 다음 날도 만 19세, 해가 바뀌는 경계(12/31생 · 1/1생)", () => {
    expect(fullAgeYears(d("2007-11-22"), d("2026-11-23"))).toBe(19);
    expect(canStartPaymentByAge(d("2007-12-31"), d("2026-12-30"))).toBe(false);
    expect(canStartPaymentByAge(d("2007-12-31"), d("2026-12-31"))).toBe(true);
    expect(canStartPaymentByAge(d("2008-01-01"), d("2026-12-31"))).toBe(false);
    expect(canStartPaymentByAge(d("2008-01-01"), d("2027-01-01"))).toBe(true);
  });

  test("2월 29일생은 평년엔 2월 28일에 한 살 는다 — 직원 가입 isAtLeastAge 와 같은 판정", () => {
    // 2008-02-29 생 → 2027-02-28(평년)에 만 19세
    expect(fullAgeYears(d("2008-02-29"), d("2027-02-27"))).toBe(18);
    expect(fullAgeYears(d("2008-02-29"), d("2027-02-28"))).toBe(19);
    for (const today of ["2027-02-27", "2027-02-28", "2027-03-01"]) {
      expect(canStartPaymentByAge(d("2008-02-29"), d(today))).toBe(isAtLeastAge(d("2008-02-29"), d(today), 19));
    }
  });

  test("만 14세·어린이·성인도 숫자가 맞고, 생일이 오늘보다 뒤면 0", () => {
    expect(fullAgeYears(d("2012-05-12"), d("2026-11-23"))).toBe(14);
    expect(fullAgeYears(d("1995-03-02"), d("2026-11-23"))).toBe(31);
    expect(fullAgeYears(d("2026-11-23"), d("2026-11-23"))).toBe(0);
    expect(fullAgeYears(d("2026-11-24"), d("2026-11-23"))).toBe(0);
  });
});
