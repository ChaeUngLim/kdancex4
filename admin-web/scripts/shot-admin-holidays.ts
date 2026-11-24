// 개발 PC 전용 — 운영자 콘솔 P9 「공휴일 관리」(S7-4.9e(공휴일 화면(P9)))를 진짜 서버·개발 DB 시연 데이터로 찍는다.
//
// 가짜 응답을 만들지 않는다. 시연 운영자 「데모 운영자」(demo-admin@example.com)의 Better Auth 세션을 새로 만들어
// 서명 쿠키로 브라우저에 넣을 뿐이다(tests/e2e/support/console-session.ts 와 같은 방법). 토큰은 화면·로그에 찍지 않는다.
//
// 먼저 넣을 데이터: scripts/dev-demo-holidays.ts(2027년 자동 수집 19줄 + 운영자 줄 「2027-05-06 임시 휴일(예시)」)
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/shot-admin-holidays.ts <스크린샷 폴더>
//   결과: 01-P9-표.png(연도별 표) · 02-P9-더하기-카드.png(더하기 카드를 열고 칸을 채운 상태 — 보내지는 않는다)
//   화면에 기대한 글자가 없거나 콘솔 오류가 있으면 [check] FAIL 을 찍고 exit 1.
import "dotenv/config";

import { createHmac } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { chromium, type Page } from "@playwright/test";

import { createStaffAuth } from "../lib/server/staff-auth";

const OUT = process.argv[2] ?? ".";
const CHROME = join(homedir(), ".cache/ms-playwright/chromium-1255/chrome-linux64/chrome");
const BASE = "http://localhost:3000";
const EMAIL = "demo-admin@example.com";

const url = process.env["DATABASE_URL"] ?? "";
// 개발 DB 에서만 세션을 만든다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에서만 돈다");

const secret = process.env["BETTER_AUTH_SECRET"]!;
const pg = await import("pg");
const pool = new pg.default.Pool({ connectionString: url, max: 2 });
const auth = createStaffAuth({ pool, secret, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const { rows } = await pool.query<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [EMAIL]);
if (rows[0] === undefined) throw new Error(`${EMAIL} 가 없다 — dev-demo-holidays.ts 를 먼저 돌린다`);
const token = (await ctx.internalAdapter.createSession(rows[0].id)).token;
// better-call 의 서명 쿠키와 같은 모양 — 「토큰.HMAC-SHA256(base64)」 를 URL 인코딩
const cookieValue = encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`);

let failed = false;
function check(ok: boolean, label: string): void {
  console.log(`[check] ${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failed = true;
}
async function expectText(page: Page, text: string): Promise<void> {
  check(await page.getByText(text, { exact: false }).first().isVisible().catch(() => false), text);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies([
  { name: "better-auth.session_token", value: cookieValue, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
]);
const page = await context.newPage();
const consoleErrors: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(e.message));

// ① 연도별 표
await page.goto(`${BASE}/admin/holidays?year=2027`);
await page.getByTestId("holiday-table").waitFor({ timeout: 90_000 });
for (const t of ["공휴일 관리", "마지막 자동 수집", "공공데이터포털 특일 정보", "02-09 (화)", "설날 대체", "대체공휴일", "특일 정보 자동", "05-06 (목)", "임시 휴일(예시)", "운영자 입력", "영업일은 토·일과 이 표의 날을 뺀 날이에요"]) {
  await expectText(page, t);
}
const rowCount = await page.getByTestId("holiday-row").count();
check(rowCount === 20, `표 20줄(지금 ${rowCount}줄)`);
// 지우기 버튼은 운영자 줄 하나에만
check((await page.getByRole("button", { name: "지우기" }).count()) === 1, "지우기 버튼은 운영자 줄 1개에만");
await page.screenshot({ path: join(OUT, "01-P9-표.png"), fullPage: true });

// ② 더하기 카드 — 보드 P9 처럼 칸을 채운 상태로 찍고 보내지는 않는다(시연 데이터가 그대로 남게)
await page.getByRole("button", { name: "공휴일 더하기" }).click();
const card = page.getByTestId("add-card");
await card.waitFor();
await card.getByLabel("날짜").fill("2027-06-07");
await card.getByLabel("이름").fill("임시 휴일(예시)");
await card.getByLabel("임시공휴일").check();
for (const t of ["날짜", "이름", "종류", "공휴일", "대체공휴일", "임시공휴일", "취소", "더하기"]) await expectText(card as unknown as Page, t);
await page.screenshot({ path: join(OUT, "02-P9-더하기-카드.png"), fullPage: true });

check(consoleErrors.length === 0, `콘솔 오류 0건(${consoleErrors.join(" | ")})`);
await browser.close();
await pool.end();
process.exit(failed ? 1 : 0);
