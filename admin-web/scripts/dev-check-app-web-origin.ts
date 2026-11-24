// 개발 DB 전용 확인 도구 — 앱 웹(:8081) 출처 이메일 로그인이 스위치에 따라 열리고 닫히는지 진짜 직원 auth 로 본다
// (S3-4.7b(앱 캘린더·알림함·내역 시연 데이터), 2026-11-23 사용자 결정 「개발 전용으로 8081 신뢰」).
//
// 왜 테스트(vitest)가 아니라 스크립트인가:
//   Better Auth 는 NODE_ENV=test 이면 출처 검사를 스스로 끈다(create-context: isTest() 면 skipOriginCheck).
//   그래서 vitest 안에서는 「막히는 경우」를 재현할 수 없다. 이 스크립트는 보통 Node 로 돌아 검사가 켜진 채로 돈다.
//
// 하는 일: 같은 요청(Origin: http://localhost:8081 · 쿠키 있음 · POST /api/auth/sign-in/email · 시연 회원 이도윤)을
//   ① KDANCE_DEV_ROUTES=true 로 만든 auth 에 보내 200 을, ② 스위치 없이 만든 auth 에 보내 403 INVALID_ORIGIN 을 기대한다.
//   쿠키 헤더를 싣는 이유: 브라우저(앱 웹)는 localhost 쿠키를 함께 보내고, Better Auth 는 쿠키가 있을 때 출처를 검사한다.
//   두 결과가 기대와 다르면 exit 1.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-check-app-web-origin.ts
//   먼저 scripts/dev-demo-member-activity.ts 가 시연 회원을 만들어 두어야 한다. 로그인 세션이 한 줄 생길 뿐 다른 데이터는 바꾸지 않는다.
import "dotenv/config";

import { createDb } from "../prisma/db";
import { APP_WEB_DEV_ORIGIN } from "../proxy";
import { createStaffAuth } from "../lib/server/staff-auth";

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 붙지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에서만 돈다");
const secret = process.env["BETTER_AUTH_SECRET"];
const baseURL = process.env["BETTER_AUTH_URL"];
if (!secret || !baseURL) throw new Error("BETTER_AUTH_SECRET·BETTER_AUTH_URL 이 없다 — admin-web/.env 를 확인한다");

const { db, pool } = createDb(url, { poolMax: 2 });

/** 스위치를 정한 뒤 auth 를 새로 만들어(trustedOrigins 는 만들 때 정해진다) 같은 로그인 요청을 보낸다 */
async function signInFromAppWeb(devRoutes: "true" | undefined): Promise<{ status: number; code: string }> {
  if (devRoutes === undefined) delete process.env["KDANCE_DEV_ROUTES"];
  else process.env["KDANCE_DEV_ROUTES"] = devRoutes;
  const auth = createStaffAuth({ pool, secret: secret!, baseURL: baseURL! });
  const res = await auth.handler(
    new Request(`${baseURL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_WEB_DEV_ORIGIN, cookie: "kdance-check=1" },
      body: JSON.stringify({ email: "demo-activity@example.com", password: "demo-activity-1234" }),
    }),
  );
  const body = (await res.json().catch(() => ({}))) as { code?: string };
  return { status: res.status, code: body.code ?? "" };
}

const opened = await signInFromAppWeb("true");
console.log(`KDANCE_DEV_ROUTES=true  → ${opened.status} ${opened.code}`);
const closed = await signInFromAppWeb(undefined);
console.log(`KDANCE_DEV_ROUTES 없음 → ${closed.status} ${closed.code}`);

await db.close();
await pool.end();

// 개발에서는 열리고(200), 운영 설정에서는 그대로 막혀야(403 INVALID_ORIGIN) 통과다
const ok = opened.status === 200 && closed.status === 403 && closed.code === "INVALID_ORIGIN";
console.log(ok ? "판정: OK" : "판정: FAIL");
process.exit(ok ? 0 : 1);
