// S0-6.2(운영 설정에서 가짜 어댑터 거부) — 수용 ②: 운영 설정에서 가짜 PG·가짜 본인확인을 고르면 시작이 거부된다.
//   플랜: _workspace/06_master-plan.md 「S0-6(환경 분리·비밀값 목록)」 수용 ②
//
// 확인하는 것
//   ① 판정 함수: 운영(production) + 가짜 조합이면 오류, 개발·베타는 가짜를 써도 된다
//   ② deps.ts 의 선택 지점(createDeps)이 운영 설정이면 포트를 꺼내기 전에 바로 거부한다
//   ③ 서버 시작(instrumentation.ts 의 register)도 같은 이유로 멈춘다
//   ④ 환경 이름(KDANCE_ENV)이 오타면 「개발」로 넘어가지 않고 거부한다
import "temporal-polyfill/full/global";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  FakeAdapterInProductionError,
  assertAdaptersAllowed,
  chooseAdapters,
  createDeps,
} from "../../lib/server/deps";
import { ServerEnvError, deployEnvOf, loadServerEnv } from "../../lib/server/env";

// register() 는 S0-6.3(DB 환경 표식 대조)부터 DB 를 한 번 읽는다. 이 파일은 DB 없이 도는 단위 테스트라
// 그 검사만 통과로 바꿔 둔다. 표식 대조 자체는 tests/db/db-environment-marker.db.test.ts 가 실제 DB 로 본다.
vi.mock("../../lib/server/db-environment", () => ({
  checkDbEnvironment: vi.fn(async () => ({ environment: "beta", marker: "beta", verified: true })),
}));

// 오류 문장에 새어 나오면 바로 알아보게 눈에 띄는 값을 쓴다
const SECRETS = {
  DATABASE_URL: "postgresql://kdance:LEAK-db@localhost:5433/kdance_next",
  BETTER_AUTH_SECRET: "LEAK-better-auth-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
  INTERNAL_API_TOKEN: "LEAK-internal-token-0123456789abcdef",
  PG_WEBHOOK_SECRET: "LEAK-pg-webhook-secret-0123456789abcdef",
  FAKE_IDENTITY_SECRET: "LEAK-fake-identity-secret-0123456789abcdef",
  IDENTITY_CI_PEPPER: "LEAK-identity-ci-pepper-fedcba9876543210",
  FIELD_ENCRYPTION_KEY: "LEAK-field-encryption-key-0123456789abcdef",
} as const;

/** 오류를 던지면 그 오류를, 안 던지면 테스트 실패 */
function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("오류를 던지지 않았다");
}

describe("assertAdaptersAllowed — 환경과 고른 구현의 조합 판정", () => {
  test("운영 + 가짜 PG·가짜 본인확인 → 둘 다 이름이 박힌 오류", () => {
    const error = captureError(() =>
      assertAdaptersAllowed("production", { paymentGateway: "fake", identityVerification: "fake" }),
    );
    expect(error).toBeInstanceOf(FakeAdapterInProductionError);
    expect((error as FakeAdapterInProductionError).ports).toEqual(["paymentGateway", "identityVerification"]);
    expect(error.message).toContain("paymentGateway");
    expect(error.message).toContain("identityVerification");
  });

  test("운영 + 가짜 PG 하나만 → PG 만 거부 이유로 나온다", () => {
    const error = captureError(() =>
      assertAdaptersAllowed("production", { paymentGateway: "fake", identityVerification: "real" }),
    );
    expect((error as FakeAdapterInProductionError).ports).toEqual(["paymentGateway"]);
  });

  test("운영 + 가짜 본인확인 하나만 → 본인확인만 거부 이유로 나온다", () => {
    const error = captureError(() =>
      assertAdaptersAllowed("production", { paymentGateway: "real", identityVerification: "fake" }),
    );
    expect((error as FakeAdapterInProductionError).ports).toEqual(["identityVerification"]);
  });

  test("운영 + 둘 다 실물 → 통과", () => {
    expect(() =>
      assertAdaptersAllowed("production", { paymentGateway: "real", identityVerification: "real" }),
    ).not.toThrow();
  });

  test.each(["development", "beta"] as const)("%s + 가짜 → 통과(베타 개발은 가짜로 진행)", (deployEnv) => {
    expect(() =>
      assertAdaptersAllowed(deployEnv, { paymentGateway: "fake", identityVerification: "fake" }),
    ).not.toThrow();
  });
});

describe("chooseAdapters — 1회차는 실물이 없어 언제나 가짜를 고른다", () => {
  test("PG·본인확인 모두 fake", () => {
    expect(chooseAdapters(SECRETS)).toEqual({ paymentGateway: "fake", identityVerification: "fake" });
  });
});

describe("createDeps — 선택 지점에서 바로 거부", () => {
  test("KDANCE_ENV=production 이면 포트를 꺼내기 전에 오류(값은 문장에 없음)", () => {
    const error = captureError(() => createDeps({ ...SECRETS, KDANCE_ENV: "production" }));
    expect(error).toBeInstanceOf(FakeAdapterInProductionError);
    expect(error.message).not.toContain("LEAK-");
  });

  test.each([["development"], ["beta"], [undefined], [""]])("KDANCE_ENV=%s 이면 가짜로 만들어진다", (value) => {
    const deps = createDeps({ ...SECRETS, KDANCE_ENV: value });
    expect(typeof deps.paymentGateway.createPayment).toBe("function");
    expect(typeof deps.identityVerification.verify).toBe("function");
  });

  test("환경 이름 오타(prod)는 개발로 넘어가지 않고 거부한다", () => {
    expect(() => createDeps({ ...SECRETS, KDANCE_ENV: "prod" })).toThrow(/KDANCE_ENV/);
  });
});

describe("환경 이름 — env.ts 스키마", () => {
  test("비우면 development, 세 값은 그대로", () => {
    expect(deployEnvOf({})).toBe("development");
    expect(deployEnvOf({ KDANCE_ENV: " " })).toBe("development");
    expect(deployEnvOf({ KDANCE_ENV: "beta" })).toBe("beta");
    expect(deployEnvOf({ KDANCE_ENV: "production" })).toBe("production");
  });

  test("loadServerEnv 는 모르는 값을 「형식이 틀린 환경 변수」로 거부하고 값은 싣지 않는다", () => {
    const error = captureError(() => loadServerEnv({ ...SECRETS, KDANCE_ENV: "LEAK-prod" }));
    expect(error).toBeInstanceOf(ServerEnvError);
    expect((error as ServerEnvError).invalid).toEqual(["KDANCE_ENV"]);
    expect(error.message).not.toContain("LEAK-");
  });

  test("loadServerEnv 는 production 을 받아 들인다(거부는 어댑터 판정이 한다)", () => {
    expect(loadServerEnv({ ...SECRETS, KDANCE_ENV: "production" }).KDANCE_ENV).toBe("production");
  });
});

describe("서버 시작 — instrumentation.ts register()", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stubSecrets(): void {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
  }

  test("운영 설정이면 시작을 거부한다", async () => {
    stubSecrets();
    vi.stubEnv("KDANCE_ENV", "production");
    const { register } = await import("../../instrumentation");
    await expect(register()).rejects.toBeInstanceOf(FakeAdapterInProductionError);
  });

  test("베타 설정이면 시작한다", async () => {
    stubSecrets();
    vi.stubEnv("KDANCE_ENV", "beta");
    const { register } = await import("../../instrumentation");
    await expect(register()).resolves.toBeUndefined();
  });
});
