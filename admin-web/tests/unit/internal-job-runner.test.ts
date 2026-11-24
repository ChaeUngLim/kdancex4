// S0-4.4(SP-6 시간 작업 실행기 정하기) — 고른 방식(cron → 내부 경로)으로 내부 경로가 「1회」 불리는지
//   결정과 근거: _workspace/03_research.md §3-4
//
// 확인하는 것
//   ① 실행기(runInternalJob)가 진짜 HTTP 서버의 내부 경로를 POST 로 한 번 부르고, 처리기가 정확히 1회 돈다
//   ② cron 이 실제로 부르는 명령(scripts/run-internal-job.ts)을 cron 처럼 「거의 빈 환경」에서 node 로 돌려도
//      처리기가 1회 돌고 exit 0 이다. 토큰 값은 출력에 찍히지 않는다
//   ③ 토큰이 틀리면 401 이고 처리기는 0회, 명령은 exit 1
//   ④ 내부 경로가 아니거나 토큰이 비었으면 요청을 보내기 전에 멈춘다(처리기 0회)
//   ⑤ 실행기의 헤더 이름이 내부 경로 가드(S0-4.3)의 것과 같다
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  INTERNAL_PATH_PREFIX,
  RUNNER_TOKEN_HEADER,
  RunnerConfigError,
  runInternalJob,
} from "../../lib/server/internal-job-runner";
import { INTERNAL_TOKEN_ENV, INTERNAL_TOKEN_HEADER, withInternalRoute } from "../../lib/server/internal-routes";

const TOKEN = "test-runner-token-0123456789abcdef";
const JOB_PATH = "/api/internal/test-job";
const adminWebDir = fileURLToPath(new URL("../../", import.meta.url));

/** 처리기가 불린 기록 — 「1회 불렸다」를 세는 곳 */
const calls: { method: string; path: string }[] = [];

// 내부 경로 하나를 진짜 처리기처럼 만든다. 가드는 S0-4.3 의 withInternalRoute 를 그대로 쓴다.
const route = withInternalRoute(
  async (request: Request) => {
    calls.push({ method: request.method, path: new URL(request.url).pathname });
    return Response.json({ done: true });
  },
  { [INTERNAL_TOKEN_ENV]: TOKEN },
);

/** node:http 요청을 Fetch Request 로 바꿔 route 에 넘긴다(Next.js 가 하는 일을 작게 흉내 낸다) */
async function toFetchRequest(incoming: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(key, value);
  }
  const method = incoming.method ?? "GET";
  return new Request(new URL(incoming.url ?? "/", origin), {
    method,
    headers,
    body: method === "GET" ? undefined : Buffer.concat(chunks),
  });
}

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((incoming, outgoing) => {
    void (async () => {
      const request = await toFetchRequest(incoming, baseUrl);
      const response =
        new URL(request.url).pathname === JOB_PATH
          ? await route(request, {})
          : Response.json({ detail: "찾을 수 없어요" }, { status: 404 });
      outgoing.writeHead(response.status, { "content-type": "application/json" });
      outgoing.end(await response.text());
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  calls.length = 0;
});

/** cron 이 부르는 명령을 그대로 돌린다. env 는 cron 처럼 최소한만 넘긴다 */
function runCli(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // execFile 은 비동기라 같은 프로세스 안의 시험 서버가 그동안 요청을 받을 수 있다(spawnSync 는 막혀 버린다).
    execFile(
      process.execPath,
      ["scripts/run-internal-job.ts", JOB_PATH],
      {
        cwd: adminWebDir,
        // NODE_ENV 는 Next.js 의 ProcessEnv 타입이 요구해서 넣는다. 나머지는 cron 이 주는 정도(PATH·HOME)뿐이다.
        env: {
          NODE_ENV: "test",
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          HOME: process.env["HOME"] ?? "/tmp",
          ...env,
        },
      },
      (error, stdout, stderr) => {
        // 0 이 아닌 exit 는 error.code 에 숫자로 온다. error 가 없으면 exit 0 이다.
        const code = error ? Number((error as NodeJS.ErrnoException & { code?: unknown }).code ?? 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

describe("① 실행기가 내부 경로를 1회 부른다", () => {
  test("맞는 토큰이면 200 이고 처리기가 정확히 1회 POST 로 돈다", async () => {
    const result = await runInternalJob({ baseUrl, jobPath: JOB_PATH, token: TOKEN });

    expect(result).toEqual({ ok: true, status: 200, body: JSON.stringify({ done: true }) });
    expect(calls).toEqual([{ method: "POST", path: JOB_PATH }]);
  });
});

describe("② cron 이 부르는 명령(scripts/run-internal-job.ts)", () => {
  test("cron 처럼 빈 환경에서 돌려도 처리기가 1회 돌고 exit 0, 토큰은 출력에 없다", async () => {
    const out = await runCli({ INTERNAL_API_TOKEN: TOKEN, KDANCE_INTERNAL_BASE_URL: baseUrl });

    expect(out.code).toBe(0);
    expect(out.stdout).toContain(`job=${JOB_PATH} status=200`);
    expect(out.stdout + out.stderr).not.toContain(TOKEN);
    expect(calls).toEqual([{ method: "POST", path: JOB_PATH }]);
  }, 20_000);

  test("토큰이 틀리면 exit 1 이고 처리기는 불리지 않는다", async () => {
    const out = await runCli({ INTERNAL_API_TOKEN: "wrong-token", KDANCE_INTERNAL_BASE_URL: baseUrl });

    expect(out.code).toBe(1);
    expect(out.stdout).toContain("status=401");
    expect(calls).toHaveLength(0);
  }, 20_000);
});

describe("③ HTTP 실패는 던지지 않고 ok:false 로 돌려준다", () => {
  test("틀린 토큰 → 401, 처리기 0회", async () => {
    const result = await runInternalJob({ baseUrl, jobPath: JOB_PATH, token: "wrong-token" });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("④ 설정 오류는 요청 전에 멈춘다", () => {
  test.each([
    ["내부 경로가 아님", { jobPath: "/api/orders/expire", token: TOKEN }],
    ["접두어만 있음", { jobPath: INTERNAL_PATH_PREFIX, token: TOKEN }],
    ["토큰이 비었음", { jobPath: JOB_PATH, token: "" }],
  ])("%s → RunnerConfigError, 처리기 0회", async (_label, input) => {
    await expect(runInternalJob({ baseUrl, ...input })).rejects.toBeInstanceOf(RunnerConfigError);
    expect(calls).toHaveLength(0);
  });

  test("서버 주소가 URL 이 아니면 RunnerConfigError", async () => {
    await expect(runInternalJob({ baseUrl: "not a url", jobPath: JOB_PATH, token: TOKEN })).rejects.toBeInstanceOf(
      RunnerConfigError,
    );
  });
});

describe("⑤ 헤더 이름이 가드와 같다", () => {
  test("RUNNER_TOKEN_HEADER === INTERNAL_TOKEN_HEADER", () => {
    expect(RUNNER_TOKEN_HEADER).toBe(INTERNAL_TOKEN_HEADER);
  });
});
