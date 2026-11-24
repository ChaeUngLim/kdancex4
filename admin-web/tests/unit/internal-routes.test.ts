// S0-4.3(내부 작업 경로 패턴) — 플랜 S0-4 수용 ② 「내부 작업 경로는 토큰 없이 401 이다」
//   계약: _workspace/03_contracts/README.md §1 「내부 경로」
//
// 확인하는 것
//   ① 토큰 헤더가 없거나 틀리면 401 UNAUTHENTICATED 이고, 처리기는 불리지도 않는다
//   ② 서버에 토큰(INTERNAL_API_TOKEN)이 설정돼 있지 않으면 무엇을 보내도 401 이다(닫는 쪽으로 실패)
//   ③ 맞는 토큰이면 처리기의 응답을 그대로 돌려준다
//   ④ 비교는 상수 시간 함수(timingSafeEqual)로 한다 — 길이가 달라도 예외 없이 401
//   ⑤ `app/api/internal/**/route.ts` 는 전부 withInternalRoute 를 거친다(경로가 생긴 뒤에도 막아 두는 구조 검사)
//      route 가 직접 감싸지 않고 바로 import 한 공장 함수가 감싸도 된다(M3-FIX.1 — SX-2.3(검토 API) 경로)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  INTERNAL_TOKEN_ENV,
  INTERNAL_TOKEN_HEADER,
  internalTokenMatches,
  withInternalRoute,
} from "../../lib/server/internal-routes";

const TOKEN = "test-internal-token-0123456789abcdef";
const env = { [INTERNAL_TOKEN_ENV]: TOKEN };

/** 내부 작업 경로로 오는 요청. token 을 주면 X-Internal-Token 헤더에 싣는다 */
function request(token?: string): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set(INTERNAL_TOKEN_HEADER, token);
  return new Request("http://localhost/api/internal/orders/expire", { method: "POST", headers, body: "{}" });
}

const UNAUTHORIZED_BODY = { detail: "인증이 필요해요", code: "UNAUTHENTICATED" };

describe("토큰 없이·틀린 토큰으로는 401 이다(수용 ②)", () => {
  test("헤더가 없으면 401 UNAUTHENTICATED 이고 처리기를 부르지 않는다", async () => {
    const handler = vi.fn(() => Response.json({ expired: 3 }));
    const response = await withInternalRoute(handler, env)(request(), {});

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(UNAUTHORIZED_BODY);
    expect(handler).not.toHaveBeenCalled();
  });

  test.each([
    ["빈 문자열", ""],
    ["한 글자 틀림", `${TOKEN.slice(0, -1)}X`],
    ["앞부분만", TOKEN.slice(0, 10)],
    ["뒤에 한 글자 더", `${TOKEN}x`],
    ["대소문자 다름", TOKEN.toUpperCase()],
    // 앞뒤 공백은 Fetch 의 Headers 가 값을 받을 때 잘라 내므로(표준 동작) 여기서는 가운데 공백을 본다
    ["가운데 공백", `${TOKEN.slice(0, 5)} ${TOKEN.slice(5)}`],
  ])("틀린 토큰(%s)이면 401 이고 처리기를 부르지 않는다", async (_label, token) => {
    const handler = vi.fn(() => Response.json({ expired: 3 }));
    const response = await withInternalRoute(handler, env)(request(token), {});

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(UNAUTHORIZED_BODY);
    expect(handler).not.toHaveBeenCalled();
  });

  test.each([
    ["변수가 없음", {}],
    ["빈 값", { [INTERNAL_TOKEN_ENV]: "" }],
  ])("서버 토큰이 설정되지 않았으면(%s) 무엇을 보내도 401 이다", async (_label, serverEnv) => {
    const handler = vi.fn(() => Response.json({ expired: 3 }));
    const route = withInternalRoute(handler, serverEnv);

    expect((await route(request(""), {})).status).toBe(401);
    expect((await route(request(), {})).status).toBe(401);
    expect((await route(request("anything"), {})).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("맞는 토큰이면 통과한다", () => {
  test("처리기의 응답을 그대로 돌려준다", async () => {
    const handler = vi.fn(() => Response.json({ expired: 3 }));
    const response = await withInternalRoute(handler, env)(request(TOKEN), {});

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ expired: 3 });
    expect(handler).toHaveBeenCalledOnce();
  });

  test("열린 경로도 공통 HTTP 계층을 탄다 — 예상 못 한 오류는 500 INTERNAL", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const route = withInternalRoute(() => {
      throw new Error("secret stack");
    }, env);

    const response = await route(request(TOKEN), {});

    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe("INTERNAL");
    vi.restoreAllMocks();
  });

  test("env 를 주지 않으면 요청 때의 process.env 를 읽는다", async () => {
    const handler = vi.fn(() => Response.json({ ok: true }));
    const route = withInternalRoute(handler);

    vi.stubEnv(INTERNAL_TOKEN_ENV, TOKEN);
    expect((await route(request(TOKEN), {})).status).toBe(200);

    vi.stubEnv(INTERNAL_TOKEN_ENV, "rotated-token-value");
    expect((await route(request(TOKEN), {})).status).toBe(401);
    vi.unstubAllEnvs();
  });
});

describe("토큰은 상수 시간으로 비교한다", () => {
  test("internalTokenMatches 는 같을 때만 참, 길이가 달라도 예외 없이 거짓", () => {
    expect(internalTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(internalTokenMatches("a", TOKEN)).toBe(false);
    expect(internalTokenMatches(`${TOKEN}${TOKEN}`, TOKEN)).toBe(false);
    expect(internalTokenMatches(null, TOKEN)).toBe(false);
    expect(internalTokenMatches(TOKEN, undefined)).toBe(false);
    expect(internalTokenMatches("", "")).toBe(false);
  });

  test("구현이 === 가 아니라 timingSafeEqual 로 비교한다", () => {
    const source = readFileSync(join(__dirname, "../../lib/server/internal-routes.ts"), "utf8");
    expect(source).toMatch(/timingSafeEqual\(/);
    expect(source).not.toMatch(/===\s*expected|expected\s*===/);
  });
});

describe("내부 작업 경로 파일은 전부 withInternalRoute 를 거친다", () => {
  const internalDir = join(__dirname, "../../app/api/internal");

  /** 폴더 아래 route.ts 를 모두 모은다. 폴더가 아직 없으면(경로를 만들기 전) 빈 목록 */
  function routeFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return routeFiles(path);
      return name === "route.ts" ? [path] : [];
    });
  }

  const adminWebRoot = join(__dirname, "../..");
  const WRAPS = /withInternalRoute(<[^>]*>)?\(/;

  /**
   * route 파일이 withInternalRoute 를 거치는지 본다.
   * 직접 감싸거나, 바로 import 한 `@/…` 모듈(공장 함수, 예: createPosterJobRoutes)이 감싸면 통과다.
   * 왜 한 단계만 따라가나: SX-2.3(검토 API)의 route 는 서비스 파일의 공장 함수를 부를 뿐이라
   * 글자 검사가 route 파일만 보면 「안 감쌌다」로 잘못 본다. 더 깊이는 따라가지 않아 검사가 느슨해지지 않게 한다.
   */
  function wrapsInternalRoute(source: string): boolean {
    if (WRAPS.test(source)) return true;
    const imports = [...source.matchAll(/from\s+"@\/([^"]+)"/g)].map((m) => m[1]);
    return imports.some((spec) => {
      const target = [".ts", ".tsx", "/index.ts"].map((ext) => join(adminWebRoot, spec + ext)).find(existsSync);
      return target !== undefined && WRAPS.test(readFileSync(target, "utf8"));
    });
  }

  test("app/api/internal/**/route.ts 마다 withInternalRoute 로 내보낸다(직접 또는 바로 부르는 공장 함수 안에서)", () => {
    const offenders = routeFiles(internalDir).filter((file) => !wrapsInternalRoute(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("감싸지 않은 route 는 잡아낸다(검사기가 늘 통과만 하지 않는지)", () => {
    // deps 모듈은 withInternalRoute 를 쓰지 않는다 — 이것만 import 해 처리기를 그냥 내보내면 걸려야 한다
    const bare = 'import { getDeps } from "@/lib/server/deps";\nexport const POST = () => Response.json(getDeps());';
    expect(wrapsInternalRoute(bare)).toBe(false);
    // 공장 함수 모듈을 import 하면 통과한다
    const viaFactory = 'import { createPosterJobRoutes } from "@/lib/server/services/poster-extraction-jobs";';
    expect(wrapsInternalRoute(viaFactory)).toBe(true);
  });
});
