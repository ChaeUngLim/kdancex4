// 개발 PC 실사용 시연 — 화면이 보이는 Chrome(WSLg 창)을 띄워 입력을 천천히 넣으며 대표 brad 로 앱·관리자 웹을 돈다.
//   2026-11-23 사용자 요청: 「원격으로 화면에 입력 넣어 주면서 테스트 구현 보여줘」「콘솔에 가상의 데이터를 만들어서 시연」.
//   가짜 응답 없이 진짜 서버(admin-web :3000, KDANCE_DEV_ROUTES=true)와 앱 웹(Expo :8081)에 붙는다. 개발 DB(kdance_next)만 쓴다.
//   시연 데이터는 scripts/dev-demo-owner.ts(brad·학원) → scripts/dev-demo-console-data.ts(강사 6·공지 3) 를 먼저 넣는다.
//
// 순서:
//   A. 앱(390×844) — 강사·대표 로그인 「대표」 탭 → brad/brad → 대표 홈
//   B. 관리자 웹(1440×900) — brad/brad → 첫 로그인이라 인증 앱 등록(QR) → 그 순간의 진짜 6자리를 계산해 넣음 → 대시보드
//      → 강사 관리 → 직원 공지 → 학원 설정
//      6자리는 고정값이 아니다. 등록 때 서버가 만든 비밀값(auth.twoFactor, BETTER_AUTH_SECRET 로 암호화)을 풀어 만든다.
//      개발 PC 에서는 코드가 5분마다 바뀐다(staff-auth.ts 의 staffTotpPeriodSeconds).
//   주의: B 에서 인증 앱을 켜면 그 뒤로 brad 는 앱 로그인이 막힌다(서버 규칙 — 앱은 TWO_FACTOR_REQUIRED 안내). 그래서 A 를 먼저 한다.
//
// 실행: cd admin-web && KDANCE_DEV_ROUTES=true ./node_modules/.bin/jiti scripts/dev-demo-live.ts <스크린샷 폴더>
//   녹화: DEMO_RECORD=1 을 붙이면 앱·웹 창을 각각 영상(webm)으로 <스크린샷 폴더>/video/ 에 남긴다.
//         영상은 창을 닫을 때 완성되므로, 녹화 때는 흐름이 끝나면 창을 바로 닫는다(열어 두기 없음).
import "dotenv/config";

import { homedir } from "node:os";
import { join } from "node:path";

import { createOTP } from "@better-auth/utils/otp";
import { chromium, type Locator, type Page } from "@playwright/test";
import { symmetricDecrypt } from "better-auth/crypto";
import pg from "pg";

import { staffTotpPeriodSeconds } from "../lib/server/staff-auth";

const OUT = process.argv[2] ?? ".";
const CHROME = join(homedir(), ".cache/ms-playwright/chromium-1255/chrome-linux64/chrome");
const USERNAME = "brad";
const PASSWORD = "brad";
// 사람이 따라 볼 수 있게 동작마다 쉬는 시간(ms)
const SLOW = 400;
// 화면마다 멈춰 보여 주는 시간(ms)
const PAUSE = 2500;
// 끝난 뒤 창을 열어 두는 시간 — 사용자가 직접 더 눌러 볼 수 있게
const KEEP_OPEN_MS = 20 * 60 * 1000;
// 녹화 여부와 영상 폴더
const RECORD = process.env["DEMO_RECORD"] === "1";
const VIDEO_DIR = join(OUT, "video");

let shotNo = 0;
async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(PAUSE);
  const file = join(OUT, `${String(++shotNo).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`[화면] ${file}  (${new URL(page.url()).pathname})`);
}

/** 사람이 치듯 한 글자씩 넣는다 */
async function typeSlowly(box: Locator, text: string): Promise<void> {
  await box.click();
  await box.pressSequentially(text, { delay: 160 });
}

/** brad 의 인증 앱 비밀값을 DB 에서 풀어 지금 구간의 6자리를 만든다(서버와 같은 간격) */
async function currentTotp(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ secret: string }>(
    `SELECT t.secret FROM auth."twoFactor" t JOIN auth."user" u ON u.id = t."userId" WHERE u.username = $1`,
    [USERNAME],
  );
  if (rows[0] === undefined) throw new Error("인증 앱 등록 기록이 없다(QR 화면까지 갔는지 확인)");
  const totpSecret = await symmetricDecrypt({ key: process.env["BETTER_AUTH_SECRET"]!, data: rows[0].secret });
  return createOTP(totpSecret, { period: staffTotpPeriodSeconds() }).totp();
}

function logApi(page: Page, who: string, host: string): void {
  page.on("response", (r) => {
    if (r.url().includes(`${host}/api/`)) console.log(`  [${who} API] ${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}`);
  });
}

const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"], max: 1 });
const { rows: academyRows } = await pool.query<{ academy_id: string }>(
  `SELECT o.academy_id FROM auth."user" u JOIN staff_accounts s ON s.auth_user_id = u.id
     JOIN academy_owners o ON o.staff_account_id = s.id WHERE u.username = $1`,
  [USERNAME],
);
const academyId = academyRows[0]?.academy_id;
if (academyId === undefined) throw new Error("brad 학원이 없다 — scripts/dev-demo-owner.ts 먼저");

const browser = await chromium.launch({ executablePath: CHROME, headless: false, slowMo: SLOW, args: ["--window-position=40,40"] });

// ---- A. 앱(휴대폰 크기) -------------------------------------------------------------
console.log("── A. 앱(대표) ──");
const appCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  ...(RECORD ? { recordVideo: { dir: VIDEO_DIR, size: { width: 390, height: 844 } } } : {}),
});
const app = await appCtx.newPage();
logApi(app, "앱", ":3000");
await app.goto("http://localhost:8081/staff-login", { waitUntil: "networkidle" });
await app.getByRole("tab", { name: /Owner/ }).click();
await typeSlowly(app.getByRole("textbox", { name: "아이디" }), USERNAME);
await typeSlowly(app.getByRole("textbox", { name: "비밀번호" }), PASSWORD);
await shot(app, "app-owner-login-filled");
await app.getByRole("button", { name: "로그인" }).click();
// 인증 앱을 이미 켠 대표는 앱에서 막히고 안내가 뜬다(서버 규칙). 켜기 전이면 대표 홈으로 넘어간다
const blocked = app.getByRole("alert");
await Promise.race([
  app.waitForURL((url) => !url.pathname.startsWith("/staff-login"), { timeout: 20_000 }),
  blocked.waitFor({ timeout: 20_000 }),
]);
await shot(app, (await blocked.isVisible()) ? "app-owner-blocked-2fa" : "app-owner-home");

// ---- B. 관리자 웹(PC 크기) ----------------------------------------------------------
console.log("── B. 관리자 웹(대표) ──");
const webCtx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  ...(RECORD ? { recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } } } : {}),
});
const web = await webCtx.newPage();
logApi(web, "웹", ":3000");
await web.goto("http://localhost:3000/login", { waitUntil: "networkidle" });
await typeSlowly(web.locator('input[placeholder="아이디"]'), USERNAME);
await typeSlowly(web.locator('input[placeholder="비밀번호"]'), PASSWORD);
await shot(web, "web-login-filled");
await web.getByRole("button", { name: "로그인" }).click();
await web.getByText("인증 코드 6자리").first().waitFor({ timeout: 20_000 });
await shot(web, "web-enroll-qr");

const code = await currentTotp(pool);
console.log(`[6자리] 지금 구간 코드: ${code} (간격 ${staffTotpPeriodSeconds()}초)`);
for (let i = 0; i < 6; i += 1) {
  await web.getByRole("textbox", { name: `${i + 1}번째 숫자` }).pressSequentially(code[i]!, { delay: 200 });
}
await shot(web, "web-code-filled");
await web.getByRole("button", { name: "확인" }).click();
await web.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
await shot(web, "web-dashboard");

for (const [path, name] of [
  [`/academies/${academyId}/instructors`, "web-instructors"],
  [`/academies/${academyId}/staff-notices`, "web-staff-notices"],
  [`/academies/${academyId}/settings`, "web-settings"],
] as const) {
  await web.goto(`http://localhost:3000${path}`, { waitUntil: "networkidle" });
  await shot(web, name);
}

await pool.end();
if (RECORD) {
  // 창을 닫아야 영상 파일이 완성된다
  const appVideo = app.video();
  const webVideo = web.video();
  await appCtx.close();
  await webCtx.close();
  console.log(`[영상] 앱 ${await appVideo?.path()}`);
  console.log(`[영상] 웹 ${await webVideo?.path()}`);
  await browser.close();
  process.exit(0);
}
console.log(`끝. 창을 ${KEEP_OPEN_MS / 60000}분 열어 둡니다 — 직접 더 눌러 보셔도 됩니다.`);
await new Promise((resolve) => setTimeout(resolve, KEEP_OPEN_MS));
await browser.close();
