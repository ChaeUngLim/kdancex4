// 개발 PC 전용 — 회원 앱 「마이(보드 M12) · 알림 설정(보드 C1A)」을 진짜 서버·개발 DB 데이터로 찍는다(S7-1.8(앱 알림 설정·권한 화면)).
//
// 가짜 응답을 만들지 않는다. 앱(Expo 웹 :8081)이 부르는 `/api/**` 를 진짜 서버(admin-web :3000)로 넘기면서
// 이도윤(demo-activity@example.com)의 Better Auth 세션 토큰을 `Authorization: Bearer` 로 붙일 뿐이다.
//   왜 붙여 주나: 웹 실행에서는 회원 소셜 로그인을 거칠 수 없고, 토큰은 메모리에만 있어 밖에서 넣을 수 없다(mobile/lib/session.ts).
//   토큰은 화면·로그에 찍지 않는다.
//
// 먼저 넣을 데이터: scripts/dev-demo-member-activity.ts(이도윤) → scripts/dev-demo-notification-settings.ts(이도윤 알림 설정)
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/shot-member-my-notification-settings.ts <스크린샷 폴더>
//   결과: 01-M12-my.png(마이 첫 화면) · 02-C1A-notification-settings.png(알림 설정)
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

await page.goto(`${APP}/my`);
await page.getByText("알림 설정").first().waitFor({ timeout: 90_000 });
await page.waitForTimeout(800);
for (const t of ["마이", "멤버십", "내 예약 · 결제 내역", "관심 장르 · 지역 · 시간대", "알림 설정", "로그아웃"]) await expectText(page, t);
await page.screenshot({ path: join(OUT, "01-M12-my.png"), fullPage: false });

// 줄을 눌러 들어간다 — 마이 → 알림 설정 이동도 함께 확인
await page.getByRole("button", { name: "알림 설정" }).click();
await page.getByText("수업 전 알림").waitFor({ timeout: 60_000 });
await page.waitForTimeout(800);
for (const t of ["2시간 전", "광고성 알림 받기", "동의", "대기 자리 알림", "항상 받아요", "학원별로"]) await expectText(page, t);
// 이도윤은 권한 토큰이 없다(unknown) — 꺼짐 띠가 보이면 안 된다
const banner = await page.getByText("휴대폰 알림이 꺼져 있어요").isVisible().catch(() => false);
console.log(`[check] ${banner ? "FAIL" : "PASS"} 권한 unknown 이면 꺼짐 띠 없음`);
if (banner) failed = true;
await page.screenshot({ path: join(OUT, "02-C1A-notification-settings.png"), fullPage: false });

await browser.close();
await pool.end();
process.exit(failed ? 1 : 0);
