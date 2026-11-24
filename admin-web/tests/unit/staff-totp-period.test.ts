// 직원 인증 앱 코드가 바뀌는 간격 — 2026-11-23 사용자 결정: 개발 환경에서만 5분, 베타·운영은 표준 30초(RFC 6238).
//   개발 PC 표시는 dev 경로 스위치(KDANCE_DEV_ROUTES=true)와 KDANCE_ENV=development 가 둘 다 맞을 때뿐이다.
//   테스트·베타·운영처럼 스위치가 없으면 30초 — Google Authenticator 등 표준 앱은 30초만 만들기 때문이다.
import { describe, expect, it } from "vitest";

import { STANDARD_TOTP_PERIOD_SECONDS, DEV_TOTP_PERIOD_SECONDS, staffTotpPeriodSeconds } from "../../lib/server/staff-auth";

describe("staffTotpPeriodSeconds", () => {
  it("표준은 30초, 개발 PC 는 300초(5분)", () => {
    expect(STANDARD_TOTP_PERIOD_SECONDS).toBe(30);
    expect(DEV_TOTP_PERIOD_SECONDS).toBe(300);
  });

  it("dev 경로 켜짐 + 개발 환경(빈 값 포함)이면 5분", () => {
    expect(staffTotpPeriodSeconds({ KDANCE_DEV_ROUTES: "true" })).toBe(300);
    expect(staffTotpPeriodSeconds({ KDANCE_DEV_ROUTES: "true", KDANCE_ENV: "development" })).toBe(300);
  });

  it("dev 경로가 꺼져 있으면(테스트 기본) 30초", () => {
    expect(staffTotpPeriodSeconds({})).toBe(30);
    expect(staffTotpPeriodSeconds({ KDANCE_DEV_ROUTES: "1" })).toBe(30);
  });

  it("베타·운영이면 dev 경로가 켜져 있어도 30초", () => {
    expect(staffTotpPeriodSeconds({ KDANCE_DEV_ROUTES: "true", KDANCE_ENV: "beta" })).toBe(30);
    expect(staffTotpPeriodSeconds({ KDANCE_DEV_ROUTES: "true", KDANCE_ENV: "production" })).toBe(30);
  });
});
