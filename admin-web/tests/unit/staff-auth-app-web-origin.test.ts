// 앱 웹(:8081) 이메일 로그인 출처 허용 — S3-4.7b(앱 캘린더·알림함·내역 시연 데이터), 2026-11-23 사용자 결정 「개발 전용으로 8081 신뢰」.
//   KDANCE_DEV_ROUTES 가 정확히 "true" 일 때만 Better Auth 가 앱 웹 출처를 믿는다. 운영·베타(값 없음)는 그대로 막힌다.
//   여기서는 판정 함수와 「만들어진 auth 설정」 두 겹만 본다. 같은 로그인 요청을 진짜 처리기에 보내 403/200 을 보는 것은
//   scripts/dev-check-app-web-origin.ts 가 맡는다 — vitest(NODE_ENV=test)에서는 Better Auth 가 출처 검사를 스스로 끄기 때문이다(create-context: isTest() 면 skipOriginCheck).
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { APP_WEB_DEV_ORIGIN } from "../../proxy";
import { createStaffAuth, staffTrustedOrigins } from "../../lib/server/staff-auth";

const TEST_SECRET = "unit-only-secret-unit-only-secret-0123456789";

// trustedOrigins 는 auth 를 만들 때 한 번 정해진다 → 만들기 전에 env 를 바꾼다. 풀은 접속하지 않는다(설정만 읽음).
async function trustedOriginsWhen(devRoutes: string | undefined): Promise<unknown> {
  if (devRoutes === undefined) delete process.env["KDANCE_DEV_ROUTES"];
  else process.env["KDANCE_DEV_ROUTES"] = devRoutes;
  const pool = new Pool({ connectionString: "postgres://nobody:nobody@127.0.0.1:1/nobody" });
  try {
    return createStaffAuth({ pool, secret: TEST_SECRET, baseURL: "http://localhost:3000" }).options.trustedOrigins;
  } finally {
    await pool.end();
  }
}

describe("staffTrustedOrigins — 개발 PC 에서만 앱 웹 출처를 더 믿는다", () => {
  const saved = process.env["KDANCE_DEV_ROUTES"];
  afterEach(() => {
    if (saved === undefined) delete process.env["KDANCE_DEV_ROUTES"];
    else process.env["KDANCE_DEV_ROUTES"] = saved;
  });

  it("스위치가 정확히 \"true\" 면 [http://localhost:8081], 그 밖에는 빈 목록", () => {
    expect(APP_WEB_DEV_ORIGIN).toBe("http://localhost:8081");
    expect(staffTrustedOrigins({ KDANCE_DEV_ROUTES: "true" })).toEqual(["http://localhost:8081"]);
    expect(staffTrustedOrigins({})).toEqual([]);
    expect(staffTrustedOrigins({ KDANCE_DEV_ROUTES: "false" })).toEqual([]);
    expect(staffTrustedOrigins({ KDANCE_DEV_ROUTES: "1" })).toEqual([]);
    expect(staffTrustedOrigins({ KDANCE_DEV_ROUTES: "TRUE" })).toEqual([]);
  });

  it("운영 설정(스위치 없음·false): 만들어진 직원 auth 가 앱 웹 출처를 믿지 않는다", async () => {
    expect(await trustedOriginsWhen(undefined)).toEqual([]);
    expect(await trustedOriginsWhen("false")).toEqual([]);
  });

  it("개발 설정(KDANCE_DEV_ROUTES=true): 만들어진 직원 auth 가 앱 웹 출처 하나만 더 믿는다", async () => {
    expect(await trustedOriginsWhen("true")).toEqual([APP_WEB_DEV_ORIGIN]);
  });
});
