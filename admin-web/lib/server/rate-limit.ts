// 요청 제한 공통 제한기(S0-3.10) — 로그인·인증 앱 6자리·본인확인처럼 마구 시도하면 안 되는 동작에 건다.
//   계약: _workspace/03_contracts/README.md §6-4(429 RATE_LIMITED) · 플랜 S0-3 수용 ⑤ `[운영 보강 ②]`
//
// 규칙(기본값, 환경 변수로 바꾼다 — 실사용 기록이 없는 어림값이라 설정으로 둔다):
//   - 로그인·인증 코드 실패: 같은 계정 또는 같은 IP 가 15분에 5회 실패하면 15분 동안 429
//   - 본인확인 요청: 계정당 하루 5회
//   - 결제 시작(S3-3.13): 회원 한 명당 1분에 10회 — IP 가 아니라 회원으로 센다(R28: 학원 한 곳이 공유기 하나로 여럿 접속)
//   - 결제 웹훅 서명 실패(S3-3.13): 10분에 20회 — 서명이 맞는 웹훅은 세지도 막지도 않는다(정상 PG 재전송이 막히면 확정이 빠진다)
//
// 횟수는 Redis(`kdance-redis`)에 센다. Redis 가 꺼졌거나 답하지 않으면 **막는 쪽**으로 실패한다 —
// 세지 못하는 동안 열어 두면 그 틈에 비밀번호를 무한히 넣어 볼 수 있기 때문이다.
//
// 쓰는 법(라우트·Better Auth before 훅에서):
//   await limiter.assertAllowed(rules.authFailure, [`account:${id}`, `ip:${ip}`]);  // 시도 전 — 막혔으면 429
//   ...비밀번호·코드 확인이 틀리면...
//   await limiter.recordFailure(rules.authFailure, [`account:${id}`, `ip:${ip}`]);  // 실패 1회 더하기
//   await limiter.consume(rules.identityVerification, [`account:${id}`]);           // 요청마다 1회, 넘으면 429
import { createHash } from "node:crypto";

import { z } from "zod";

import { HttpError } from "./http";
import { redisCommands, type RedisValue } from "./redis";

/** 규칙 하나. `name` 은 Redis 키에 들어가므로 규칙마다 달라야 한다. */
export type RateLimitRule = Readonly<{ name: string; limit: number; windowSeconds: number }>;

/** 기본 규칙. 값을 바꾸려면 코드가 아니라 환경 변수(loadRateLimitRules)를 쓴다. */
export const RATE_LIMIT_RULES = {
  /** 로그인 비밀번호 실패와 인증 앱 6자리 실패를 같은 칸에 센다 — 따로 세면 5+5 번을 넣어 볼 수 있다. */
  authFailure: { name: "auth-failure", limit: 5, windowSeconds: 15 * 60 },
  identityVerification: { name: "identity-verification", limit: 5, windowSeconds: 24 * 60 * 60 },
  /** 결제 시작(`POST /api/orders`) — 회원 한 명이 1분에 10회까지(플랜 S3-3 수용 ⑦ 추천값) */
  checkoutStart: { name: "checkout-start", limit: 10, windowSeconds: 60 },
  /** 소개 문구 초안(`POST /api/ai/class-intro-drafts`) — 직원 계정 한 명이 1분에 10회까지(계약 16 §4-7 추천값, SX-6.6) */
  classIntroDraft: { name: "class-intro-draft", limit: 10, windowSeconds: 60 },
  /** 웹훅 서명 실패 — 10분에 20회를 넘으면 그 뒤의 틀린 서명은 기록 없이 429(추천값, S3-3.13 임시 확정) */
  webhookSignatureFailure: { name: "webhook-signature-failure", limit: 20, windowSeconds: 10 * 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitRules = { [K in keyof typeof RATE_LIMIT_RULES]: RateLimitRule };

/** Redis 가 꺼졌을 때 알려 줄 남은 시간. 다시 켜지면 곧 풀리도록 짧게 둔다. */
const UNAVAILABLE_RETRY_SECONDS = 60;
const DEFAULT_KEY_PREFIX = "kdance:rl";

const positiveInt = z.coerce.number().int().positive();

/**
 * 규칙마다 읽는 환경 변수 이름 — [횟수, 창(초)].
 * 접두어가 규칙 이름과 1대1 이라 새 규칙을 넣을 때 이 표 한 줄만 더하면 된다.
 */
const RULE_ENV_NAMES: { [K in keyof typeof RATE_LIMIT_RULES]: readonly [string, string] } = {
  authFailure: ["RATE_LIMIT_AUTH_FAILURE_MAX", "RATE_LIMIT_AUTH_FAILURE_WINDOW_SECONDS"],
  identityVerification: ["RATE_LIMIT_IDENTITY_MAX", "RATE_LIMIT_IDENTITY_WINDOW_SECONDS"],
  checkoutStart: ["RATE_LIMIT_CHECKOUT_MAX", "RATE_LIMIT_CHECKOUT_WINDOW_SECONDS"],
  classIntroDraft: ["RATE_LIMIT_INTRO_DRAFT_MAX", "RATE_LIMIT_INTRO_DRAFT_WINDOW_SECONDS"],
  webhookSignatureFailure: ["RATE_LIMIT_WEBHOOK_SIGNATURE_FAILURE_MAX", "RATE_LIMIT_WEBHOOK_SIGNATURE_FAILURE_WINDOW_SECONDS"],
};

/**
 * 환경 변수에서 규칙 값을 읽는다. 없으면 기본값, 있는데 양의 정수가 아니면 바로 예외(잘못된 설정으로 뜨지 않게).
 * 읽는 이름은 위 RULE_ENV_NAMES 표다.
 */
export function loadRateLimitRules(env: Record<string, string | undefined> = process.env): RateLimitRules {
  const read = (key: string, fallback: number): number => {
    const raw = env[key];
    return raw === undefined || raw === "" ? fallback : positiveInt.parse(raw);
  };
  const ruleFor = (key: keyof typeof RATE_LIMIT_RULES): RateLimitRule => {
    const base = RATE_LIMIT_RULES[key];
    const [maxName, windowName] = RULE_ENV_NAMES[key];
    return { name: base.name, limit: read(maxName, base.limit), windowSeconds: read(windowName, base.windowSeconds) };
  };
  return {
    authFailure: ruleFor("authFailure"),
    identityVerification: ruleFor("identityVerification"),
    checkoutStart: ruleFor("checkoutStart"),
    classIntroDraft: ruleFor("classIntroDraft"),
    webhookSignatureFailure: ruleFor("webhookSignatureFailure"),
  };
}

// Redis 안에서 한 번에 도는 작은 스크립트(Lua). 「1 더하기 + 만료 걸기 + 남은 시간 읽기」를 한 덩어리로
// 해야 두 요청이 동시에 와도 횟수가 어긋나지 않는다.
//   - 첫 1회에 창(windowSeconds)만큼 만료를 건다 → 창이 지나면 저절로 0 으로 돌아간다
//   - 한도에 닿는 순간 만료를 창만큼 다시 건다 → 「넘으면 15분 동안 429」(계약 §6-4)
const HIT_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 or c == tonumber(ARGV[2]) then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('TTL', KEYS[1])}`;

const PEEK_SCRIPT = `
local c = tonumber(redis.call('GET', KEYS[1]) or '0')
return {c, redis.call('TTL', KEYS[1])}`;

type Count = { count: number; ttl: number };

function toCount(reply: RedisValue): Count {
  if (!Array.isArray(reply) || typeof reply[0] !== "number" || typeof reply[1] !== "number") {
    throw new Error("요청 제한 스크립트 응답 모양이 다르다");
  }
  return { count: reply[0], ttl: reply[1] };
}

export type RateLimiterOptions = {
  /** 예: redis://localhost:6380 (없으면 REDIS_URL 환경 변수) */
  redisUrl?: string;
  /** 키 앞에 붙는 말. 테스트는 실행마다 다른 값을 써서 서로 섞이지 않게 한다. */
  keyPrefix?: string;
  /** Redis 가 이 시간 안에 답하지 않으면 꺼진 것으로 보고 막는다. */
  timeoutMs?: number;
};

export type RateLimiter = {
  /** 시도 전에 부른다. 대상 가운데 하나라도 한도에 닿아 있으면 429. 횟수는 더하지 않는다. */
  assertAllowed(rule: RateLimitRule, subjects: readonly string[]): Promise<void>;
  /** 실패했을 때 부른다. 대상마다 1회씩 더한다. */
  recordFailure(rule: RateLimitRule, subjects: readonly string[]): Promise<void>;
  /** 요청할 때마다 1회 더하고, 더한 뒤 한도를 넘었으면 429(본인확인처럼 성공·실패 없이 세는 것). */
  consume(rule: RateLimitRule, subjects: readonly string[]): Promise<void>;
};

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const redisUrl = options.redisUrl ?? process.env["REDIS_URL"] ?? "redis://localhost:6380";
  const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const timeoutMs = options.timeoutMs;

  // 대상(IP·계정 id)은 원문 대신 해시로 키를 만든다 — Redis 를 들여다봐도 누가 시도했는지 남지 않게.
  const keyOf = (rule: RateLimitRule, subject: string) =>
    `${prefix}:${rule.name}:${createHash("sha256").update(subject).digest("hex").slice(0, 32)}`;

  /** 대상마다 스크립트를 한 연결로 보낸다. Redis 에 닿지 못하면 막는 쪽(429)으로 바꿔 던진다. */
  async function run(script: string, rule: RateLimitRule, subjects: readonly string[]): Promise<Count[]> {
    if (subjects.length === 0) throw new Error("요청 제한 대상이 비었다");
    const commands = subjects.map((s) => ["EVAL", script, "1", keyOf(rule, s), String(rule.windowSeconds), String(rule.limit)]);
    try {
      return (await redisCommands(redisUrl, commands, timeoutMs)).map(toCount);
    } catch (error) {
      // 서버 쪽에는 원인을 남기고, 응답에는 일반 429 만 준다(내부 정보를 내보내지 않는다).
      console.error(`[rate-limit] Redis 에 닿지 못해 요청을 막는다: ${error instanceof Error ? error.message : String(error)}`);
      throw HttpError.rateLimited(UNAVAILABLE_RETRY_SECONDS);
    }
  }

  /** 막힌 대상들 가운데 가장 늦게 풀리는 시간으로 429 를 만든다. TTL 이 이상하면(없음) 창 전체로 본다. */
  function blockedError(rule: RateLimitRule, blocked: Count[]): HttpError {
    const seconds = Math.max(...blocked.map((c) => (c.ttl > 0 ? c.ttl : rule.windowSeconds)));
    return HttpError.rateLimited(seconds);
  }

  return {
    async assertAllowed(rule, subjects) {
      const counts = await run(PEEK_SCRIPT, rule, subjects);
      const blocked = counts.filter((c) => c.count >= rule.limit);
      if (blocked.length > 0) throw blockedError(rule, blocked);
    },
    async recordFailure(rule, subjects) {
      await run(HIT_SCRIPT, rule, subjects);
    },
    async consume(rule, subjects) {
      const counts = await run(HIT_SCRIPT, rule, subjects);
      const blocked = counts.filter((c) => c.count > rule.limit);
      if (blocked.length > 0) throw blockedError(rule, blocked);
    },
  };
}
