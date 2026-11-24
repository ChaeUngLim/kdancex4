// SX-1.5(Next.js 스트림 번역) — 질문 한 건용 신원 토큰 `agentSessionToken` 을 만든다(계약 16 §3-1 4번 · 열린 점 ②).
//
// 처음 보는 사람용 요약
// - 에이전트 서버는 회원 id 를 모른다. Next.js 가 「이 질문은 회원 X 의 run Y」라는 짧은 증명서를 만들어 주면,
//   에이전트는 열어 보지 않고 도구를 부를 때 그대로 싣는다(SX-1.3(권한 밖 데이터 차단)).
// - 증명서 = `본문(base64url JSON).서명(base64url HMAC-SHA256)`. 비밀 키를 모르면 본문을 바꾼 뒤 서명을 맞출 수 없다.
// - 유효 시간은 120초다 — 새어 나가도 오래 못 쓴다. 확인(서명·시간 대조)은 도구 서버(`/api/internal/mcp`)의 몫이다.
import { createHmac, timingSafeEqual } from "node:crypto";

/** 토큰 유효 시간(계약 16 §3-1 4번 「유효 120초」) */
export const AGENT_SESSION_TOKEN_TTL_SECONDS = 120;

export type AgentSessionClaims = Readonly<{ kind: "member"; sub: string; runId: string; exp: number }>;

const base64url = (value: Buffer | string): string => Buffer.from(value).toString("base64url");

/** 회원 질문 한 건의 토큰을 만든다. `nowEpochSeconds` 를 받아 시계를 바깥에서 정한다(테스트에서 고정) */
export function signAgentSessionToken(input: {
  secret: string;
  memberId: string;
  runId: string;
  nowEpochSeconds: number;
}): string {
  const claims: AgentSessionClaims = {
    kind: "member",
    sub: input.memberId,
    runId: input.runId,
    exp: input.nowEpochSeconds + AGENT_SESSION_TOKEN_TTL_SECONDS,
  };
  const body = base64url(JSON.stringify(claims));
  const signature = base64url(createHmac("sha256", input.secret).update(body).digest());
  return `${body}.${signature}`;
}

/**
 * 토큰을 확인한다(SX-5.8 — 도구 서버 `POST /api/internal/mcp` 가 쓴다). 맞으면 클레임, 아니면 null.
 * 서명은 상수 시간으로 비교하고, 시간이 지났거나 본문 모양이 다르면 null — 이유는 구별해 알려 주지 않는다.
 */
export function verifyAgentSessionToken(token: string, input: { secret: string; nowEpochSeconds: number }): AgentSessionClaims | null {
  if (input.secret === "") return null;
  const [body, signature, extra] = token.split(".");
  if (body === undefined || signature === undefined || extra !== undefined || body === "" || signature === "") return null;
  const expected = createHmac("sha256", input.secret).update(body).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const { kind, sub, runId, exp } = claims as Record<string, unknown>;
  if (kind !== "member" || typeof sub !== "string" || typeof runId !== "string" || typeof exp !== "number") return null;
  if (exp <= input.nowEpochSeconds) return null;
  return { kind, sub, runId, exp };
}
