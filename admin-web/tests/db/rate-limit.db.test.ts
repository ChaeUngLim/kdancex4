// S0-3.10(요청 제한 공통 제한기) — 실제 Redis(kdance-redis)로 센다.
//   1 로그인·인증 앱 6자리 실패가 15분에 5회를 넘으면 6번째 시도가 429 + 남은 시간(Retry-After)
//   2 같은 IP 를 쓰는 다른 계정도 그 IP 가 막혔으면 막힌다 / 상관없는 계정은 그대로 된다
//   3 본인확인 요청은 계정당 하루 5회 — 6번째가 429, 남은 시간은 하루 이내
//   4 횟수·창은 설정값(환경 변수)으로 바꿀 수 있다
//   5 Redis 가 꺼져 있거나 답하지 않으면 막는 쪽(429)으로 실패한다
//   6 Redis 키에는 IP·계정 원문이 남지 않는다
// 테스트 Redis 는 TEST_REDIS_URL(없으면 redis://localhost:6380/15 — 개발용 0번 DB 와 나눈다).
// Redis 에 못 붙으면 실제 Redis 가 필요한 1~4·6 은 건너뛴다(DB 테스트와 같은 규칙). 5 는 언제나 돈다.
import { randomUUID } from "node:crypto";
import net from "node:net";

import { afterAll, describe, expect, test } from "vitest";

import { errorResponse, HttpError } from "@/lib/server/http";
import { createRateLimiter, loadRateLimitRules, RATE_LIMIT_RULES } from "@/lib/server/rate-limit";
import { redisCommands } from "@/lib/server/redis";

const REDIS_URL = process.env["TEST_REDIS_URL"] ?? "redis://localhost:6380/15";
const PREFIX = `rl-test-${randomUUID()}`;

async function redisReachable(): Promise<boolean> {
  try {
    const [pong] = await redisCommands(REDIS_URL, [["PING"]]);
    return pong === "PONG";
  } catch {
    return false;
  }
}
const reachable = await redisReachable();

/** 429 HttpError 인지 보고, 남은 초를 돌려준다. */
async function expectRateLimited(promise: Promise<unknown>): Promise<number> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpError);
  const http = error as HttpError;
  expect(http.status).toBe(429);
  expect(http.code).toBe("RATE_LIMITED");
  const seconds = http.extra.retryAfterSeconds ?? -1;
  expect(http.headers["Retry-After"]).toBe(String(seconds));
  return seconds;
}

describe.skipIf(!reachable)("요청 제한 — 실제 Redis", () => {
  const limiter = createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: PREFIX });
  const rule = RATE_LIMIT_RULES.authFailure;

  afterAll(async () => {
    // 이 실행이 만든 키만 지운다(접두어에 무작위 값이 들어 있다).
    const [keys] = await redisCommands(REDIS_URL, [["KEYS", `${PREFIX}:*`]]);
    if (Array.isArray(keys) && keys.length > 0) await redisCommands(REDIS_URL, [["DEL", ...(keys as string[])]]);
  });

  test("로그인·인증 코드 실패 5회 뒤 6번째 시도는 429 와 남은 시간", async () => {
    const subjects = ["account:staff-1", "ip:203.0.113.7"];
    for (let i = 1; i <= 5; i++) {
      await limiter.assertAllowed(rule, subjects); // 5번째까지는 시도할 수 있다
      await limiter.recordFailure(rule, subjects);
    }
    const seconds = await expectRateLimited(limiter.assertAllowed(rule, subjects));
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(15 * 60);

    // 응답 모양은 계약 README §6-4 그대로다.
    const res = errorResponse(
      await limiter.assertAllowed(rule, subjects).then(
        () => {
          throw new Error("막혀야 한다");
        },
        (e: HttpError) => e,
      ),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: "RATE_LIMITED", detail: "잠시 뒤 다시 시도해 주세요" });
    expect(typeof body["retryAfterSeconds"]).toBe("number");
  });

  test("같은 IP 의 다른 계정은 막히고, 상관없는 계정·IP 는 그대로 된다", async () => {
    const ip = "ip:198.51.100.9";
    for (let i = 0; i < 5; i++) await limiter.recordFailure(rule, ["account:staff-2", ip]);
    await expectRateLimited(limiter.assertAllowed(rule, ["account:staff-3", ip]));
    await expect(limiter.assertAllowed(rule, ["account:staff-3", "ip:198.51.100.10"])).resolves.toBeUndefined();
  });

  test("본인확인 요청은 계정당 하루 5회 — 6번째가 429", async () => {
    const identity = RATE_LIMIT_RULES.identityVerification;
    const subjects = ["account:member-1"];
    for (let i = 1; i <= 5; i++) await expect(limiter.consume(identity, subjects)).resolves.toBeUndefined();
    const seconds = await expectRateLimited(limiter.consume(identity, subjects));
    expect(seconds).toBeGreaterThan(15 * 60);
    expect(seconds).toBeLessThanOrEqual(24 * 60 * 60);
    // 다른 계정은 영향이 없다.
    await expect(limiter.consume(identity, ["account:member-2"])).resolves.toBeUndefined();
  });

  test("횟수·창은 환경 변수로 바꾼다(설정값)", async () => {
    const rules = loadRateLimitRules({
      RATE_LIMIT_AUTH_FAILURE_MAX: "2",
      RATE_LIMIT_AUTH_FAILURE_WINDOW_SECONDS: "60",
    });
    expect(rules.authFailure).toMatchObject({ limit: 2, windowSeconds: 60 });
    expect(rules.identityVerification).toMatchObject({ limit: 5, windowSeconds: 86_400 }); // 안 준 값은 기본값
    const subjects = ["account:staff-config"];
    await limiter.recordFailure(rules.authFailure, subjects);
    await limiter.assertAllowed(rules.authFailure, subjects);
    await limiter.recordFailure(rules.authFailure, subjects);
    const seconds = await expectRateLimited(limiter.assertAllowed(rules.authFailure, subjects));
    expect(seconds).toBeLessThanOrEqual(60);
    expect(() => loadRateLimitRules({ RATE_LIMIT_AUTH_FAILURE_MAX: "0" })).toThrow();
  });

  test("Redis 키에는 IP·계정 원문이 남지 않는다", async () => {
    await limiter.recordFailure(rule, ["ip:192.0.2.55", "account:secret-user"]);
    const [keys] = await redisCommands(REDIS_URL, [["KEYS", `${PREFIX}:*`]]);
    const joined = (keys as string[]).join("\n");
    expect(joined).not.toContain("192.0.2.55");
    expect(joined).not.toContain("secret-user");
  });
});

describe("요청 제한 — Redis 가 꺼지면 막는다", () => {
  const rule = RATE_LIMIT_RULES.authFailure;

  test("접속이 거절되면(꺼진 포트) 세 동작 모두 429", async () => {
    // 1번 포트는 아무도 듣지 않는다 — Redis 가 꺼진 상태와 같다.
    const down = createRateLimiter({ redisUrl: "redis://127.0.0.1:1", keyPrefix: PREFIX });
    await expectRateLimited(down.assertAllowed(rule, ["account:staff-1"]));
    await expectRateLimited(down.recordFailure(rule, ["account:staff-1"]));
    await expectRateLimited(down.consume(RATE_LIMIT_RULES.identityVerification, ["account:member-1"]));
  });

  test("붙기만 하고 답하지 않으면(멈춘 Redis) 시간 초과 뒤 429", async () => {
    const silent = net.createServer(() => {}); // 연결은 받되 아무 답도 하지 않는다
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as net.AddressInfo;
    try {
      const hung = createRateLimiter({ redisUrl: `redis://127.0.0.1:${port}`, keyPrefix: PREFIX, timeoutMs: 300 });
      await expectRateLimited(hung.assertAllowed(rule, ["account:staff-1"]));
    } finally {
      silent.close();
    }
  });
});
