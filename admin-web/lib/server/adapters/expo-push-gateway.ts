// S7-1.1(SP-4 푸시 경로 조사) — PushGatewayPort 의 Expo 푸시 서비스 구현(무료, 03_research.md §3-5).
//
// 보내는 곳: POST https://exp.host/--/api/v2/push/send (docs.expo.dev push-notifications/sending-notifications, context7 2026-11-24)
//   - 본문은 메시지 배열, 한 요청에 100건까지 → 100건씩 잘라 보낸다
//   - 응답 `data` 는 보낸 순서대로의 「접수표(ticket)」 배열. 한 건씩 ok / error 다
//   - 요청 전체가 실패하면 `errors` 배열이 온다
// 재시도: 문서대로 네트워크 오류 · 429 · 5xx 는 기다렸다 다시(지수 백오프 1초 → 2초 …, Retry-After 가 있으면 그 값),
//         400 같은 「본문이 틀림」은 다시 보내도 같으니 바로 실패로 돌려준다.
// 토큰 무효: 접수표가 `details.error = "DeviceNotRegistered"` 면 그 기기는 앱을 지웠거나 토큰이 바뀐 것이다 → invalid_token.
//
// 실제 Expo 서버에 붙는 것은 S7-1.5 이후다. 이 Task 의 테스트는 가짜 서버(fakes/fake-expo-push-server.ts)에만 붙는다.
import { z } from "zod";

import type { PushGatewayPort, PushMessage, PushOutcome } from "../ports/push-gateway";

export const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
/** Expo 가 한 요청에 받는 최대 메시지 수 */
export const EXPO_PUSH_CHUNK = 100;

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
/** Retry-After 가 아무리 길어도 한 번에 이 이상은 기다리지 않는다 — 발송 작업이 오래 멈추지 않게. 더 길면 S7-1.6 이 나중에 다시 한다 */
const MAX_DELAY_MS = 30_000;

/** Expo 접수표의 「다시 보내면 될 수도 있는」 오류. 나머지(MessageTooBig·InvalidCredentials 등)는 다시 보내도 같다 */
const RETRYABLE_TICKET_ERRORS = new Set(["MessageRateExceeded"]);

const ticketSchema = z.union([
  z.object({ status: z.literal("ok"), id: z.string() }),
  z.object({
    status: z.literal("error"),
    message: z.string().optional(),
    details: z.object({ error: z.string().optional() }).passthrough().optional(),
  }),
]);
const responseSchema = z.object({
  data: z.array(ticketSchema).optional(),
  errors: z.array(z.object({ code: z.string(), message: z.string().optional() })).optional(),
});

export type ExpoPushGatewayOptions = {
  /** 기본은 Expo 실제 주소. 테스트는 가짜 서버 주소를 준다 */
  readonly endpoint?: string;
  /** Expo 「보안 푸시」를 켰을 때만 쓰는 접근 토큰. 지금은 켜지 않아 비워 둔다(로그에 남기지 않는다) */
  readonly accessToken?: string;
  readonly fetch?: typeof fetch;
  /** 기다리기. 테스트는 0초짜리를 넣어 빨리 돈다 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 한 묶음을 몇 번까지 보내 보나(처음 포함) */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Expo 가 받는 메시지 모양으로 바꾼다. Android 는 알림 채널 `default`(expo-notifications 기본 채널)·높은 우선순위로 보낸다 */
export function toExpoMessage(message: PushMessage): Record<string, unknown> {
  return {
    to: message.to,
    title: message.title,
    body: message.body,
    data: message.data ?? {},
    sound: "default",
    priority: "high",
    channelId: "default",
  };
}

/** 다시 보낼 만한 HTTP 상태인가 — 문서: 429 · 5xx */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** n 번째(1부터) 재시도 전에 기다릴 시간. Retry-After(초)가 있으면 그 값, 없으면 1초·2초·4초 … */
export function retryDelayMs(attempt: number, retryAfterHeader: string | null, baseDelayMs: number): number {
  const seconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : baseDelayMs * 2 ** (attempt - 1);
  return Math.min(delay, MAX_DELAY_MS);
}

/** 한 묶음 전체가 같은 오류로 끝났을 때 — 묶음의 모든 메시지에 같은 결과를 붙인다 */
function allFailed(chunk: readonly PushMessage[], code: string, retryable: boolean): PushOutcome[] {
  return chunk.map((m) => ({ to: m.to, status: "error" as const, code, retryable }));
}

/** 접수표 하나 → 결과 하나 */
function ticketOutcome(to: string, ticket: z.infer<typeof ticketSchema>): PushOutcome {
  if (ticket.status === "ok") return { to, status: "ok", ticketId: ticket.id };
  const code = ticket.details?.error ?? "UNKNOWN_TICKET_ERROR";
  if (code === "DeviceNotRegistered") return { to, status: "invalid_token" };
  return { to, status: "error", code, retryable: RETRYABLE_TICKET_ERRORS.has(code) };
}

export function createExpoPushGateway(options: ExpoPushGatewayOptions = {}): PushGatewayPort {
  const endpoint = options.endpoint ?? EXPO_PUSH_ENDPOINT;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? realSleep;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  const headers: Record<string, string> = {
    accept: "application/json",
    "accept-encoding": "gzip, deflate",
    "content-type": "application/json",
    ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
  };

  /** 묶음 하나(100건 이하)를 보낸다. 재시도는 이 안에서만 한다 */
  async function sendChunk(chunk: readonly PushMessage[]): Promise<PushOutcome[]> {
    const body = JSON.stringify(chunk.map(toExpoMessage));
    let lastCode = "PUSH_SERVICE_UNAVAILABLE";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await doFetch(endpoint, { method: "POST", headers, body });
      } catch {
        // 네트워크 오류 — 서버에 닿지 못했다. 다시 해 볼 만하다
        lastCode = "NETWORK_ERROR";
        if (attempt < maxAttempts) await sleep(retryDelayMs(attempt, null, baseDelayMs));
        continue;
      }

      if (isRetryableStatus(response.status)) {
        lastCode = `HTTP_${response.status}`;
        if (attempt < maxAttempts) await sleep(retryDelayMs(attempt, response.headers.get("retry-after"), baseDelayMs));
        continue;
      }

      const parsed = responseSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success) {
        // 400 등 — 본문이 틀렸거나 자격증명이 없다. 다시 보내도 같으니 바로 실패
        const code = parsed.success ? (parsed.data.errors?.[0]?.code ?? `HTTP_${response.status}`) : `HTTP_${response.status}`;
        return allFailed(chunk, code, false);
      }
      const tickets = parsed.data.data ?? [];
      // 접수표 수가 보낸 수와 다르면 어느 표가 어느 메시지인지 알 수 없다 — 전부 실패로 두고 나중에 다시
      if (tickets.length !== chunk.length) return allFailed(chunk, "TICKET_COUNT_MISMATCH", true);
      return chunk.map((m, i) => ticketOutcome(m.to, tickets[i]!));
    }
    // 끝까지 429·5xx·네트워크 오류 — 다시 보낼 수 있는 실패로 돌려준다(S7-1.6 이 다음 시각에 다시)
    return allFailed(chunk, lastCode, true);
  }

  return {
    async send(messages) {
      const outcomes: PushOutcome[] = [];
      for (let i = 0; i < messages.length; i += EXPO_PUSH_CHUNK) {
        outcomes.push(...(await sendChunk(messages.slice(i, i + EXPO_PUSH_CHUNK))));
      }
      return outcomes;
    },
  };
}
