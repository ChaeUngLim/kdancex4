// 개발 PC 전용 — 회원 앱 알림함(보드 M21)에 수업 전 알림(S7-1.7(수업 전 알림 작업))이 보이는지 진짜 서버·개발 DB 데이터로 찍는다.
//
// 가짜 응답을 만들지 않는다. 앱(Expo 웹 :8081)이 부르는 `/api/**` 를 진짜 서버(admin-web :3000)로 넘기면서
// 이도윤(demo-activity@example.com)의 Better Auth 세션 토큰을 `Authorization: Bearer` 로 붙일 뿐이다.
//   왜 붙여 주나: 웹 실행에서는 회원 소셜 로그인을 거칠 수 없고, 토큰은 메모리에만 있어 밖에서 넣을 수 없다(mobile/lib/session.ts).
//   토큰은 화면·로그에 찍지 않는다.
//
// 먼저 넣을 데이터: dev-demo-member-activity.ts(이도윤) → dev-demo-notification-settings.ts(2시간 전) → dev-demo-pre-class-reminder.ts
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/shot-member-notifications-pre-class.ts <스크린샷 폴더>
//   결과: 01-M21-notifications-pre-class.png(알림함 맨 위 「곧 수업이 시작해요」)
//   화면에 기대한 글자가 없으면 [check] FAIL 을 찍고 exit 1.
import "dotenv/config";

import { homedir } from "node:os";
import { join } from "node:path";

import { chromium, type Page } from "@playwright/test";

import { createStaffAuth } from "../lib/server/staff-auth";

const OUT = process.argv[2] ?? ".";
const CHROME = join(homedir(), ".cache/ms-playwright/chromium-1255/chrome-linux64/chrome");
const APP = "http://localhost:8081";
const API = "http://localhost:3000";
const EMAIL = "demo-activity@example.com";

const url = process.env["DATABASE_URL"] ?? "";
// 개발 DB 에서만 세션을 만든다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에서만 돈다");

const pg = await import("pg");
const pool = new pg.default.Pool({ connectionString: url, max: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const { rows } = await pool.query<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [EMAIL]);
if (rows[0] === undefined) throw new Error(`${EMAIL} 가 없다 — dev-demo-member-activity.ts 를 먼저 돌린다`);
const token = (await ctx.internalAdapter.createSession(rows[0].id)).token;

let failed = false;
async function expectText(page: Page, text: string): Promise<void> {
  const ok = await page.getByText(text, { exact: false }).first().isVisible().catch(() => false);
  console.log(`[check] ${ok ? "PASS" : "FAIL"} ${text}`);
  if (!ok) failed = true;
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
// 앱이 어느 주소(.env 의 터널 주소 등)로 부르든 /api/** 는 로컬 진짜 서버로 넘기고 토큰을 붙인다
await page.route(/\/api\//, async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname + new URL(req.url()).search;
  const headers = { ...req.headers(), authorization: `Bearer ${token}` };
  const res = await route.fetch({ url: `${API}${path}`, headers });
  console.log(`[api] ${req.method()} ${path} → ${res.status()}`);
  await route.fulfill({ response: res });
});

await page.goto(`${APP}/notifications`);
await page.getByText("곧 수업이 시작해요").first().waitFor({ timeout: 90_000 });
await page.waitForTimeout(800);
// 작업이 쓴 제목과 KST 시각 글이 알림함 줄에 그대로 보여야 한다(앱은 payload 의 title·body 를 읽는다)
for (const t of ["곧 수업이 시작해요", "바차타 센슈얼 입문 · 12월 1일 20:00 시작", "오늘"]) await expectText(page, t);
await page.screenshot({ path: join(OUT, "01-M21-notifications-pre-class.png"), fullPage: false });

await browser.close();
await pool.end();
process.exit(failed ? 1 : 0);
