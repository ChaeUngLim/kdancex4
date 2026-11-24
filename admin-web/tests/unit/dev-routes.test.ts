// S0-4.2(dev 전용 경로 차단) — 플랜 S0-4 수용 ① 「운영 설정에서 dev 경로 호출은 404 다」
//   계약: _workspace/03_contracts/README.md §1 「시험 전용 경로」
//
// 확인하는 것
//   ① 운영 설정(`KDANCE_DEV_ROUTES=false`)과 값이 없을 때 dev 경로는 404 이고, 처리기는 불리지도 않는다
//   ② 정확히 `"true"` 일 때만 열린다 — 대소문자·`1`·공백 같은 비슷한 값은 닫힌다
//   ③ 판정은 이 변수 하나만 본다(NODE_ENV=development 여도 닫힌 값이면 404)
//   ④ `app/api/dev/**/route.ts` 는 전부 withDevRoute 를 거친다(경로가 생긴 뒤에도 막아 두려는 구조 검사)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { DEV_ROUTES_ENV, devRoutesEnabled, withDevRoute } from "../../lib/server/dev-routes";

const request = () =>
  new Request("http://localhost/api/dev/identity/fake-verify", { method: "POST", body: "{}" });

describe("운영 설정에서 dev 경로는 404 다(수용 ①)", () => {
  test("KDANCE_DEV_ROUTES=false 면 404 NOT_FOUND 이고 처리기를 부르지 않는다", async () => {
    const handler = vi.fn(() => Response.json({ ok: true }));
    const route = withDevRoute(handler, { [DEV_ROUTES_ENV]: "false" });

    const response = await route(request(), {});

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "찾을 수 없어요", code: "NOT_FOUND" });
    expect(handler).not.toHaveBeenCalled();
  });

  test("값이 아예 없어도 닫힌다(닫는 쪽으로 실패)", async () => {
    const handler = vi.fn(() => Response.json({ ok: true }));
    const response = await withDevRoute(handler, {})(request(), {});

    expect(response.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  test.each(["", "TRUE", "True", "1", "yes", " true", "true ", "flase"])(
    "비슷한 값 %j 도 닫힌다",
    async (value) => {
      const handler = vi.fn(() => Response.json({ ok: true }));
      const response = await withDevRoute(handler, { [DEV_ROUTES_ENV]: value })(request(), {});

      expect(response.status).toBe(404);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  test("NODE_ENV=development 여도 이 변수가 false 면 닫힌다 — 판정은 변수 하나로만", async () => {
    const handler = vi.fn(() => Response.json({ ok: true }));
    const env = { NODE_ENV: "development", [DEV_ROUTES_ENV]: "false" };

    expect(devRoutesEnabled(env)).toBe(false);
    expect((await withDevRoute(handler, env)(request(), {})).status).toBe(404);
  });

  test("env 를 주지 않으면 요청 때의 process.env 를 읽는다", async () => {
    const handler = vi.fn(() => Response.json({ ok: true }));
    const route = withDevRoute(handler);

    vi.stubEnv(DEV_ROUTES_ENV, "false");
    expect((await route(request(), {})).status).toBe(404);

    vi.stubEnv(DEV_ROUTES_ENV, "true");
    expect((await route(request(), {})).status).toBe(200);
    vi.unstubAllEnvs();
  });
});

describe("개발 설정(KDANCE_DEV_ROUTES=true)에서는 열린다", () => {
  test("처리기의 응답을 그대로 돌려준다", async () => {
    const handler = vi.fn(() => Response.json({ ok: true }, { status: 201 }));
    const response = await withDevRoute(handler, { [DEV_ROUTES_ENV]: "true" })(request(), {});

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  test("열린 경로도 공통 HTTP 계층을 탄다 — 예상 못 한 오류는 500 INTERNAL", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const route = withDevRoute(
      () => {
        throw new Error("secret stack");
      },
      { [DEV_ROUTES_ENV]: "true" },
    );

    const response = await route(request(), {});

    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe("INTERNAL");
    vi.restoreAllMocks();
  });
});

describe("dev 경로 파일은 전부 withDevRoute 를 거친다", () => {
  const devDir = join(__dirname, "../../app/api/dev");

  /** 폴더 아래 route.ts 를 모두 모은다. 폴더가 아직 없으면(경로를 만들기 전) 빈 목록 */
  function routeFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return routeFiles(path);
      return name === "route.ts" ? [path] : [];
    });
  }

  test("app/api/dev/**/route.ts 마다 withDevRoute 로 내보낸다", () => {
    const offenders = routeFiles(devDir).filter((file) => !/withDevRoute\(/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
