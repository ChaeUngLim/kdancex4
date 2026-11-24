// S0-6.1(환경 변수 스키마) — 수용 ①: 필수 비밀값이 하나라도 없으면 그 **이름**을 알려 주고 시작을 멈춘다.
// 오류 문장에는 빠진 이름이 있어야 하고, 들어 있던 값은 하나도 없어야 한다(값은 로그에 찍지 않는다).
import { describe, expect, test } from "vitest";

import {
  REQUIRED_SECRET_NAMES,
  ServerEnvError,
  loadServerEnv,
  serverEnvNames,
} from "../../lib/server/env";

// 테스트용 값 — 오류 문장에 새어 나오면 바로 알아보게 눈에 띄는 문자열을 쓴다
const VALID_ENV: Record<string, string> = {
  DATABASE_URL: "postgresql://kdance:LEAK-db-password@localhost:5433/kdance_next",
  BETTER_AUTH_SECRET: "LEAK-better-auth-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
  INTERNAL_API_TOKEN: "LEAK-internal-token-0123456789abcdef",
  PG_WEBHOOK_SECRET: "LEAK-pg-webhook-secret",
  FAKE_IDENTITY_SECRET: "LEAK-fake-identity-secret",
  IDENTITY_CI_PEPPER: "LEAK-identity-ci-pepper",
  FIELD_ENCRYPTION_KEY: "LEAK-field-encryption-key",
};

/** 오류를 던지면 그 오류를, 안 던지면 테스트 실패 */
function captureError(env: Record<string, string | undefined>): ServerEnvError {
  try {
    loadServerEnv(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ServerEnvError);
    return error as ServerEnvError;
  }
  throw new Error("loadServerEnv 가 오류를 던지지 않았다");
}

/** 오류 문장에 VALID_ENV 의 값이 하나라도 들어 있는지 */
function expectNoValueLeak(message: string): void {
  for (const value of Object.values(VALID_ENV)) {
    expect(message).not.toContain(value);
  }
  expect(message).not.toContain("LEAK-");
}

describe("S0-6.1 환경 변수 스키마 — 수용 ①", () => {
  test("필수 비밀값이 다 있으면 통과하고 결제 기한은 기본값(15분·24시간·60분)이 된다", () => {
    const env = loadServerEnv(VALID_ENV);
    expect(env.PG_WEBHOOK_SECRET).toBe(VALID_ENV["PG_WEBHOOK_SECRET"]);
    expect(env.PAYMENT_CARD_DEADLINE_MINUTES).toBe(15);
    expect(env.PAYMENT_VA_DEADLINE_HOURS).toBe(24);
    expect(env.PAYMENT_VA_CUTOFF_MINUTES).toBe(60);
  });

  test("Task 가 정한 이름(결제 기한 3종·FAKE_IDENTITY_SECRET·IDENTITY_CI_PEPPER·PG_WEBHOOK_SECRET)이 스키마에 있다", () => {
    const names = serverEnvNames();
    for (const name of [
      "PAYMENT_CARD_DEADLINE_MINUTES",
      "PAYMENT_VA_DEADLINE_HOURS",
      "PAYMENT_VA_CUTOFF_MINUTES",
      "FAKE_IDENTITY_SECRET",
      "IDENTITY_CI_PEPPER",
      "PG_WEBHOOK_SECRET",
    ]) {
      expect(names).toContain(name);
    }
    expect(REQUIRED_SECRET_NAMES).toEqual(
      expect.arrayContaining(["FAKE_IDENTITY_SECRET", "IDENTITY_CI_PEPPER", "PG_WEBHOOK_SECRET"]),
    );
  });

  test.each(REQUIRED_SECRET_NAMES.map((name) => [name]))(
    "%s 하나만 빠지면 그 이름이 오류 문장에 있고 값은 없다",
    (missing) => {
      const env: Record<string, string | undefined> = { ...VALID_ENV };
      delete env[missing];
      const error = captureError(env);
      expect(error.message).toContain(missing);
      expect(error.missing).toEqual([missing]);
      expectNoValueLeak(error.message);
    },
  );

  test("빈 문자열·공백만 있는 값도 빠진 것으로 본다", () => {
    const error = captureError({ ...VALID_ENV, PG_WEBHOOK_SECRET: "", FAKE_IDENTITY_SECRET: "   " });
    expect(error.missing).toEqual(["PG_WEBHOOK_SECRET", "FAKE_IDENTITY_SECRET"]);
    expectNoValueLeak(error.message);
  });

  test("여러 개가 빠지면 빠진 이름을 전부 한 번에 알려 준다", () => {
    const error = captureError({});
    expect(error.missing).toEqual([...REQUIRED_SECRET_NAMES]);
    for (const name of REQUIRED_SECRET_NAMES) {
      expect(error.message).toContain(name);
    }
  });

  test("결제 기한 형식이 틀리면 이름은 알려 주고 들어 온 값은 싣지 않는다", () => {
    const error = captureError({ ...VALID_ENV, PAYMENT_CARD_DEADLINE_MINUTES: "LEAK-15m" });
    expect(error.invalid).toEqual(["PAYMENT_CARD_DEADLINE_MINUTES"]);
    expect(error.message).toContain("PAYMENT_CARD_DEADLINE_MINUTES");
    expectNoValueLeak(error.message);
  });

  test("결제 기한에 0 이나 음수는 받지 않는다", () => {
    const error = captureError({ ...VALID_ENV, PAYMENT_VA_DEADLINE_HOURS: "0", PAYMENT_VA_CUTOFF_MINUTES: "-5" });
    expect(error.invalid).toEqual(["PAYMENT_VA_DEADLINE_HOURS", "PAYMENT_VA_CUTOFF_MINUTES"]);
  });

  test("결제 기한 값을 주면 그 값을 숫자로 읽는다", () => {
    const env = loadServerEnv({ ...VALID_ENV, PAYMENT_CARD_DEADLINE_MINUTES: "20" });
    expect(env.PAYMENT_CARD_DEADLINE_MINUTES).toBe(20);
  });

  test("FAKE_IDENTITY_SECRET 과 IDENTITY_CI_PEPPER 가 같으면 거부한다(두 키가 한 비밀에 묶이지 않게)", () => {
    const error = captureError({ ...VALID_ENV, IDENTITY_CI_PEPPER: VALID_ENV["FAKE_IDENTITY_SECRET"] });
    expect(error.invalid).toEqual(["IDENTITY_CI_PEPPER"]);
    expectNoValueLeak(error.message);
  });

  test("돌려준 설정 객체는 고칠 수 없다", () => {
    const env = loadServerEnv(VALID_ENV);
    expect(Object.isFrozen(env)).toBe(true);
  });
});
