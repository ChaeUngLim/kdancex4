// S0-6.3(DB 환경 표식 대조) — 수용 ③: 베타 설정으로 운영 DB 에 붙으면 시작이 거부된다.
//   플랜: _workspace/06_master-plan.md 「S0-6(환경 분리·비밀값 목록)」 수용 ③
//
// 베타와 운영은 한 기계에 DB 만 나눠 둔다(10-3 ⑪). 그래서 비밀값 파일의 DATABASE_URL 하나만 잘못 적어도
// 베타 서버가 운영 DB 에 붙을 수 있다. 막는 방법: DB 안에 「나는 어느 환경 DB 다」를 한 줄 적어 두고,
// 서버가 시작할 때 자기 설정(KDANCE_ENV)과 맞춰 본다.
//
// 확인하는 것
//   ① 마이그레이션이 표식 표(deployment_marker)를 만들었고, 한 줄만·세 환경 이름만 받는다
//   ② 표식과 설정이 다르면 거부(베타→운영 DB, 개발→운영 DB, 운영→베타 DB)
//   ③ 같으면 통과
//   ④ 표식이 없으면 베타·운영은 거부, 개발만 통과(개발 DB 는 표식 없이도 쓴다)
//   ⑤ 표식 쓰기: 처음 한 번만 쓰고, 다른 환경으로 덮어쓰지 못한다
//   ⑥ DB 에 붙지 못하면 베타·운영은 거부(확인 못 한 채로 뜨지 않는다), 개발은 「확인 안 됨」으로 통과
//   ⑦ 서버 시작(instrumentation.ts register)도 표식이 다르면 멈춘다
//   ⑧ 오류 문장에 접속 주소·비밀번호가 없다
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 테스트마다 표식 줄을 직접 지우고 시작한다.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  DbEnvironmentMarkerMissingError,
  DbEnvironmentMismatchError,
  DbEnvironmentUnreachableError,
  checkDbEnvironment,
  readDbEnvironmentMarker,
  writeDbEnvironmentMarker,
} from "@/lib/server/db-environment";

import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

// 시작 검사에 넘길 필수 비밀값 — 시험용 가짜 값이다
const SECRETS = {
  BETTER_AUTH_SECRET: "LEAK-better-auth-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
  INTERNAL_API_TOKEN: "LEAK-internal-token-0123456789abcdef",
  PG_WEBHOOK_SECRET: "LEAK-pg-webhook-secret-0123456789abcdef",
  FAKE_IDENTITY_SECRET: "LEAK-fake-identity-secret-0123456789abcdef",
  IDENTITY_CI_PEPPER: "LEAK-identity-ci-pepper-fedcba9876543210",
  FIELD_ENCRYPTION_KEY: "LEAK-field-encryption-key-0123456789abcdef",
} as const;

// 아무도 듣지 않는 포트 — 「DB 에 못 붙는」 경우를 만든다
const UNREACHABLE_URL = "postgresql://kdance:LEAK-password@127.0.0.1:1/nowhere";

describe.skipIf(!dbAvailable())("DB 환경 표식 대조(deployment_marker)", () => {
  let handle: TestDb;
  let url: string;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  /** 표식을 직접 한 줄 적는다(쓰기 함수와 따로, 대조만 시험할 때) */
  const mark = (environment: string) =>
    q("INSERT INTO public.deployment_marker (id, environment) VALUES (1, $1)", [environment]);

  /** 오류를 돌려받는다. 안 던지면 테스트 실패 */
  async function rejection(run: Promise<unknown>): Promise<Error> {
    const error = await run.then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error, "거부돼야 하는데 통과했다").not.toBeNull();
    return error as Error;
  }

  beforeAll(() => {
    handle = openTestDb();
    url = String(process.env["DATABASE_URL"]);
  });

  beforeEach(async () => {
    await q("DELETE FROM public.deployment_marker");
  });

  afterAll(async () => {
    await q("DELETE FROM public.deployment_marker");
    await closeTestDb(handle);
  });

  describe("① 마이그레이션이 만든 표", () => {
    test("deployment_marker 표가 있다", async () => {
      const { rows } = await q("SELECT to_regclass('public.deployment_marker') IS NOT NULL AS ok");
      expect(rows[0].ok).toBe(true);
    });

    test("한 줄만 둔다 — id 1 밖은 거부", async () => {
      const error = await rejection(mark("beta").then(() => q("INSERT INTO public.deployment_marker (id, environment) VALUES (2, 'beta')")));
      expect((error as { constraint?: string }).constraint).toContain("ck_deployment_marker_single");
    });

    test("세 환경 이름 밖(staging)은 거부", async () => {
      const error = await rejection(mark("staging"));
      expect((error as { constraint?: string }).constraint).toContain("deployment_marker_environment_check");
    });
  });

  describe("② 표식과 설정이 다르면 시작 거부", () => {
    test.each([
      ["beta", "production"],
      ["development", "production"],
      ["production", "beta"],
      ["beta", "development"],
    ])("설정 %s → %s DB: 거부", async (configured, marked) => {
      await mark(marked);
      const error = await rejection(checkDbEnvironment({ DATABASE_URL: url, KDANCE_ENV: configured }));
      expect(error).toBeInstanceOf(DbEnvironmentMismatchError);
      expect(error.message).toContain(configured);
      expect(error.message).toContain(marked);
    });

    test("KDANCE_ENV 를 비운 설정(=개발)도 운영 DB 에는 못 붙는다", async () => {
      await mark("production");
      const error = await rejection(checkDbEnvironment({ DATABASE_URL: url }));
      expect(error).toBeInstanceOf(DbEnvironmentMismatchError);
    });
  });

  describe("③ 같으면 통과", () => {
    test.each(["development", "beta", "production"])("%s 설정 → 같은 표식 DB: 통과", async (env) => {
      await mark(env);
      await expect(checkDbEnvironment({ DATABASE_URL: url, KDANCE_ENV: env })).resolves.toEqual({
        environment: env,
        marker: env,
        verified: true,
      });
    });
  });

  describe("④ 표식이 없을 때", () => {
    test.each(["beta", "production"])("%s 설정은 거부", async (env) => {
      const error = await rejection(checkDbEnvironment({ DATABASE_URL: url, KDANCE_ENV: env }));
      expect(error).toBeInstanceOf(DbEnvironmentMarkerMissingError);
      expect(error.message).toContain("db:mark-env");
    });

    test("개발 설정은 통과(표식 없는 개발 DB)", async () => {
      await expect(checkDbEnvironment({ DATABASE_URL: url, KDANCE_ENV: "development" })).resolves.toEqual({
        environment: "development",
        marker: null,
        verified: true,
      });
    });
  });

  describe("⑤ 표식 쓰기", () => {
    test("처음 쓰면 적히고, 같은 값으로 다시 쓰면 그대로다", async () => {
      await expect(writeDbEnvironmentMarker(url, "beta")).resolves.toBe("written");
      await expect(writeDbEnvironmentMarker(url, "beta")).resolves.toBe("unchanged");
      await expect(readDbEnvironmentMarker(url)).resolves.toBe("beta");
    });

    test("다른 환경으로 덮어쓰지 못한다(운영 DB 를 베타로 바꿔 적는 사고 방지)", async () => {
      await writeDbEnvironmentMarker(url, "production");
      const error = await rejection(writeDbEnvironmentMarker(url, "beta"));
      expect(error).toBeInstanceOf(DbEnvironmentMismatchError);
      await expect(readDbEnvironmentMarker(url)).resolves.toBe("production");
    });
  });

  describe("⑥ DB 에 붙지 못할 때", () => {
    test.each(["beta", "production"])("%s 설정은 거부", async (env) => {
      const error = await rejection(checkDbEnvironment({ DATABASE_URL: UNREACHABLE_URL, KDANCE_ENV: env }));
      expect(error).toBeInstanceOf(DbEnvironmentUnreachableError);
    });

    test("개발 설정은 「확인 안 됨」으로 통과", async () => {
      await expect(checkDbEnvironment({ DATABASE_URL: UNREACHABLE_URL, KDANCE_ENV: "development" })).resolves.toEqual({
        environment: "development",
        marker: null,
        verified: false,
      });
    });
  });

  describe("⑦ 서버 시작 — instrumentation.ts register()", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    function stubStart(env: string): void {
      vi.stubEnv("NEXT_RUNTIME", "nodejs");
      for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
      vi.stubEnv("DATABASE_URL", url);
      vi.stubEnv("KDANCE_ENV", env);
    }

    test("베타 설정 + 운영 표식 DB → 시작 거부", async () => {
      await mark("production");
      stubStart("beta");
      const { register } = await import("../../instrumentation");
      await expect(register()).rejects.toBeInstanceOf(DbEnvironmentMismatchError);
    });

    test("베타 설정 + 베타 표식 DB → 시작", async () => {
      await mark("beta");
      stubStart("beta");
      const { register } = await import("../../instrumentation");
      await expect(register()).resolves.toBeUndefined();
    });
  });

  describe("⑧ 오류 문장에 접속 정보가 없다", () => {
    test("다름·없음·접속 실패 세 오류 모두 주소·비밀번호를 싣지 않는다", async () => {
      await mark("production");
      const errors = [
        await rejection(checkDbEnvironment({ DATABASE_URL: url, KDANCE_ENV: "beta" })),
        await rejection(checkDbEnvironment({ DATABASE_URL: UNREACHABLE_URL, KDANCE_ENV: "beta" })),
      ];
      await q("DELETE FROM public.deployment_marker");
      errors.push(await rejection(checkDbEnvironment({ DATABASE_URL: url, KDANCE_ENV: "beta" })));
      for (const error of errors) {
        expect(error.message).not.toContain("LEAK");
        expect(error.message).not.toContain("postgresql://");
        expect(error.message).not.toContain("kdance_next_test");
      }
    });
  });
});
