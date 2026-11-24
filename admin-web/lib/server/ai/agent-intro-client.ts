// SX-6.6(소개 문구 초안) — 에이전트 서버 `POST /v1/intro-drafts`(계약 16 §1-4 · §4-7)를 부르는 연결.
// 포스터·홍보 이미지처럼 작업을 맡기고 나중에 결과를 받는 방식이 아니라, 바로 답을 받는 동기 호출이다(문장 두세 개).
// 서버 대 서버 증명은 헤더 `X-Agent-Token`(환경 변수 AGENT_API_TOKEN).
import { z } from "zod";

import type { IntroAgentPayload } from "../../domain/class-intro-draft";

/** 틀 하나를 받아 온다. 꺼짐·거절·시간 초과·모양 틀림은 모두 "unavailable" — 던지지 않는다 */
export type AgentIntroClient = (
  payload: IntroAgentPayload,
  signal: AbortSignal,
) => Promise<{ template: string; model: string } | "unavailable">;

const answerSchema = z.object({ bodyTemplate: z.string().min(1).max(500), model: z.string().min(1).max(100) });

export function createHttpAgentIntroClient(config: { baseUrl: string; apiToken: string }): AgentIntroClient {
  return async (payload, signal) => {
    try {
      const response = await fetch(new URL("/v1/intro-drafts", config.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-Token": config.apiToken },
        body: JSON.stringify(payload),
        signal,
      });
      if (response.status !== 200) return "unavailable";
      const parsed = answerSchema.safeParse(await response.json());
      return parsed.success ? { template: parsed.data.bodyTemplate, model: parsed.data.model } : "unavailable";
    } catch {
      // 연결 거부·시간 초과(AbortSignal) — 에이전트가 답하지 않은 것으로 본다
      return "unavailable";
    }
  };
}

/** 에이전트 주소·토큰이 없으면 부를 곳이 없다 — 늘 "unavailable"(→ 503, 앱은 손으로 쓰게 한다) */
export const unavailableAgentIntroClient: AgentIntroClient = async () => "unavailable";

/** 앱(route.ts)이 쓰는 고르기 — 빈 값·공백은 「설정 안 됨」으로 본다 */
export function agentIntroClientFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): AgentIntroClient {
  const baseUrl = env["AGENT_SERVER_URL"]?.trim() ?? "";
  const apiToken = env["AGENT_API_TOKEN"]?.trim() ?? "";
  if (baseUrl === "" || apiToken === "") return unavailableAgentIntroClient;
  return createHttpAgentIntroClient({ baseUrl, apiToken });
}
