// S7-1.1(SP-4 푸시 경로 조사) — Expo 푸시 서비스(`POST /--/api/v2/push/send`)를 흉내 내는 가짜 HTTP 서버.
//
// 진짜 Expo 서버에는 붙지 않는다. 내 PC 의 127.0.0.1 빈 포트에 떠서, 받은 요청(머리글·본문)을 그대로 적어 두고
// Expo 문서와 같은 모양의 접수표를 돌려준다. 테스트가 아래 둘을 미리 정할 수 있다:
//   - failNext(횟수, 상태) — 다음 몇 번의 요청에 429·503 같은 오류를 준다(재시도 시험)
//   - unregister(토큰)     — 그 토큰에는 DeviceNotRegistered 접수표를 준다(토큰 무효 시험)
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_EXPO_PUSH_PATH = "/--/api/v2/push/send";

export type RecordedPushRequest = {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  /** 이 요청에 준 HTTP 상태 */
  readonly status: number;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export class FakeExpoPushServer {
  #server: Server | null = null;
  #requests: RecordedPushRequest[] = [];
  #failures: { status: number; retryAfter?: string }[] = [];
  #unregistered = new Set<string>();

  /** 띄우고 보낼 주소(…/--/api/v2/push/send)를 돌려준다 */
  async start(): Promise<string> {
    const server = createServer((req, res) => {
      void this.#handle(req).then(({ status, headers, payload }) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.#server = server;
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}${FAKE_EXPO_PUSH_PATH}`;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** 받은 요청 기록(순서대로, 복사본) */
  get requests(): readonly RecordedPushRequest[] {
    return [...this.#requests];
  }

  /** 다음 count 번의 요청에 이 상태로 답한다(429 면 Retry-After 도 줄 수 있다) */
  failNext(count: number, status: number, retryAfter?: string): void {
    const added = Array.from({ length: count }, () => (retryAfter === undefined ? { status } : { status, retryAfter }));
    this.#failures = [...this.#failures, ...added];
  }

  /** 이 토큰은 「등록되지 않은 기기」로 답한다 */
  unregister(token: string): void {
    this.#unregistered = new Set([...this.#unregistered, token]);
  }

  async #handle(req: IncomingMessage): Promise<{ status: number; headers: Record<string, string>; payload: unknown }> {
    const raw = await readBody(req);
    const body: unknown = raw === "" ? null : JSON.parse(raw);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v ?? "")]));
    const record = (status: number) => {
      this.#requests = [...this.#requests, { method: req.method ?? "", path: req.url ?? "", headers, body, status }];
    };

    if (req.method !== "POST" || req.url !== FAKE_EXPO_PUSH_PATH) {
      record(404);
      return { status: 404, headers: {}, payload: { errors: [{ code: "NOT_FOUND", message: "없는 경로" }] } };
    }
    const [failure, ...rest] = this.#failures;
    if (failure !== undefined) {
      this.#failures = rest;
      record(failure.status);
      const extra: Record<string, string> = failure.retryAfter === undefined ? {} : { "retry-after": failure.retryAfter };
      return { status: failure.status, headers: extra, payload: { errors: [{ code: "SERVER_ERROR", message: "가짜 오류" }] } };
    }
    // Expo 와 같게 메시지 하나도 받고 배열도 받는다. 100건을 넘으면 400
    const messages = Array.isArray(body) ? body : [body];
    if (messages.length > 100) {
      record(400);
      return { status: 400, headers: {}, payload: { errors: [{ code: "PUSH_TOO_MANY_NOTIFICATIONS", message: "100건까지" }] } };
    }
    record(200);
    const data = messages.map((m) => {
      const to = typeof m === "object" && m !== null ? (m as { to?: unknown }).to : undefined;
      if (typeof to === "string" && this.#unregistered.has(to)) {
        return { status: "error", message: `"${to}" is not a registered push notification recipient`, details: { error: "DeviceNotRegistered" } };
      }
      return { status: "ok", id: randomUUID() };
    });
    return { status: 200, headers: {}, payload: { data } };
  }
}
