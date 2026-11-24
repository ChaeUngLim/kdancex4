import type { PromoImageAgentPayload } from "../../domain/promo-image-conditions";

// SX-2.3(검토 API) — 에이전트 서버 `POST /v1/jobs`(계약 16 §1-4 · §7-1)를 부르는 연결. 포스터 읽기 작업을 맡길 때 쓴다.
// 서버 대 서버 증명은 헤더 `X-Agent-Token`(환경 변수 AGENT_API_TOKEN). 에이전트는 202 로 받고, 결과는 나중에
// Next.js 내부 경로 `POST /api/internal/ai/jobs/{jobId}/result` 로 따로 보낸다(그래서 여기서는 「받았나」만 본다).

/** 에이전트에게 넘기는 작업 한 건(계약 16 §7-1 공통 요청). kind 마다 payload 모양이 다르다 */
export type AgentJobRequest =
  | {
      jobId: string;
      kind: "poster_extract";
      deadlineMs: number;
      payload: { extractionId: string; fileUrl: string; targetKind: string; fieldKeys: readonly string[] };
    }
  | {
      // 홍보 이미지(SX-6.5) — 문장·조건·글자 없음 표시와 사용자가 고른 엔진 id
      jobId: string;
      kind: "promo_image";
      deadlineMs: number;
      payload: PromoImageAgentPayload & { engineId: string };
    };

/**
 * 작업을 맡긴다. 에이전트가 받았으면(202·200) true, 꺼져 있거나 거절하면 false.
 * 던지지 않는다 — 맡기지 못한 작업은 queued 로 남고 sweep 이 기한 뒤 AGENT_UNAVAILABLE 로 닫는다(계약 16 §4-6).
 */
export type AgentJobDispatcher = (job: AgentJobRequest) => Promise<boolean>;

/** 에이전트 응답을 오래 기다리지 않는다 — 접수는 금방 끝나는 일이다(추천값 5초) */
const DISPATCH_TIMEOUT_MS = 5_000;

export function createHttpAgentJobDispatcher(config: { baseUrl: string; apiToken: string }): AgentJobDispatcher {
  return async (job) => {
    try {
      const response = await fetch(new URL("/v1/jobs", config.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-Token": config.apiToken },
        body: JSON.stringify(job),
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      });
      return response.status === 202 || response.status === 200;
    } catch {
      // 연결 거부·시간 초과 — 에이전트가 꺼진 것으로 본다
      return false;
    }
  };
}

/** 에이전트 주소·토큰이 없으면 맡길 곳이 없다 — 늘 false(작업은 queued 로 남는다) */
export const unavailableAgentJobDispatcher: AgentJobDispatcher = async () => false;

/** 앱(route.ts)이 쓰는 고르기 — 빈 값·공백은 「설정 안 됨」으로 본다 */
export function agentJobDispatcherFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): AgentJobDispatcher {
  const baseUrl = env["AGENT_SERVER_URL"]?.trim() ?? "";
  const apiToken = env["AGENT_API_TOKEN"]?.trim() ?? "";
  if (baseUrl === "" || apiToken === "") return unavailableAgentJobDispatcher;
  return createHttpAgentJobDispatcher({ baseUrl, apiToken });
}
