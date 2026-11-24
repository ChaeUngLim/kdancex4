// 개발 PC 전용 — 운영자 콘솔 P11 「사업자 상태 점검」(S7-4.9g(사업자 점검 화면(P11)))을 진짜 서버·개발 DB 시연 데이터로 찍는다.
//
// 가짜 응답을 만들지 않는다. 시연 운영자 「데모 운영자」(demo-admin@example.com)의 Better Auth 세션을 새로 만들어
// 서명 쿠키로 브라우저에 넣을 뿐이다(shot-admin-holidays.ts 와 같은 방법). 토큰은 화면·로그에 찍지 않는다.
//
// 먼저 넣을 데이터: scripts/dev-demo-business-checks.ts(모던스텝 합정 폐업·소명 1건 · 스윙라인 성수 휴업·기한 지남 · 비트스튜디오 건대 조회 실패)
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/shot-admin-business-checks.ts <스크린샷 폴더>
//   결과: 01-P11-목록.png(요약 카드·감지 목록·모던스텝 합정 상세) · 02-P11-소명-처리.png(「소명 받아들이고 풀기」를 눌러 확인 카드를 연 상태 — 보내지는 않는다)
//   화면에 기대한 글자가 없거나 콘솔 오류가 있으면 [check] FAIL 을 찍고 exit 1.
import "dotenv/config";

import { createHmac } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { chromium, type Locator } from "@playwright/test";

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
if (rows[0] === undefined) throw new Error(`${EMAIL} 가 없다 — dev-demo-business-checks.ts 를 먼저 돌린다`);
const token = (await ctx.internalAdapter.createSession(rows[0].id)).token;
// better-call 의 서명 쿠키와 같은 모양 — 「토큰.HMAC-SHA256(base64)」 를 URL 인코딩
const cookieValue = encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`);

let failed = false;
function check(ok: boolean, label: string): void {
  console.log(`[check] ${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failed = true;
}
async function expectText(scope: Locator, text: string): Promise<void> {
  check(await scope.getByText(text, { exact: false }).first().isVisible().catch(() => false), text);
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

// ① 목록 — 모던스텝 합정을 골라 오른쪽 상세를 연다(보드 P11 과 같은 모양)
await page.goto(`${BASE}/admin/business-checks`);
await page.getByTestId("summary-cards").waitFor({ timeout: 90_000 });
await page.getByTestId("check-row").filter({ hasText: "모던스텝 합정" }).getByRole("button").click();
await page.waitForURL(/case=/);
const detail = page.getByTestId("case-detail");
await detail.getByText("폐업자 · 폐업일 2026-11-10").waitFor();
const body = page.locator("main");
for (const t of ["사업자 상태 점검", "정산 직전에 한 번 더 조회해요", "전체", "계속 사업", "휴업", "폐업", "조회 실패", "감지 목록"]) await expectText(body, t);
for (const t of ["모던스텝 합정", "대표 정수아 · 123-45-*****", "새 결제 막음", "지급 보류", "소명 D-5", "스윙라인 성수", "소명 기한 지남", "비트스튜디오 건대", "다음 점검에서 다시 확인 · 조치 없음"]) {
  await expectText(body, t);
}
for (const t of ["국세청 조회 결과", "폐업자 · 폐업일 2026-11-10", "대표 소명", "신규 사업자 등록증을 첨부해요", "소명 받아들이고 풀기", "게시 중단", "소명 기한은 D-5예요"]) {
  await expectText(detail, t);
}
await expectText(body, "이미 결제한 수업은 그대로 진행돼요");
await page.screenshot({ path: join(OUT, "01-P11-목록.png"), fullPage: true });

// ② 소명 처리 — 「소명 받아들이고 풀기」를 누르면 한 번 더 묻는 카드가 열린다. 메모만 채우고 보내지 않는다(시연 데이터가 그대로 남게)
await detail.getByRole("button", { name: "소명 받아들이고 풀기" }).click();
const confirm = page.getByTestId("confirm-card");
await confirm.waitFor();
await confirm.getByLabel(/메모/).fill("신규 사업자등록증 확인");
for (const t of ["소명을 받아들이고 제한을 모두 풀까요?", "대표에게 알림이 가요", "메모(감사 기록에 남아요", "취소", "풀기"]) await expectText(confirm, t);
await page.screenshot({ path: join(OUT, "02-P11-소명-처리.png"), fullPage: true });

check(consoleErrors.length === 0, `콘솔 오류 0건(${consoleErrors.join(" | ")})`);
await browser.close();
await pool.end();
process.exit(failed ? 1 : 0);
