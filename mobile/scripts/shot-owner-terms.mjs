// 대표 앱 「약관·동의 기록」(O35) 화면을 Expo 웹으로 띄워 장면 두 개를 찍는다
// — 로드맵 S1-1.34(대표 앱 약관·수수료 변경 안내).
//
//   실행(mobile 폴더에서): node scripts/shot-owner-terms.mjs --out-dir <폴더> [--port 8092]
//   결과: <폴더>/안내-상자.png(읽기 전) · <폴더>/읽음-후.png(「읽었어요」를 누른 뒤)
//
// 왜 서버 응답을 브라우저에서 꾸며 넣나:
//   웹 실행에는 SecureStore 가 없어 로그인 토큰을 둘 수 없다(lib/session.ts). 그래서 실제 서버로는
//   대표 화면을 열 수 없다. 화면이 계약 07 §5 모양의 응답을 받았을 때 어떻게 그려지는지를 보려는 것이므로
//   Playwright 의 page.route 로 `/api/**` 요청을 가로채 계약 모양 그대로의 예시 응답을 돌려준다.
//   서버 쪽 동작(읽음 두 번 같은 응답 등)은 S1-1.24 의 DB 테스트가 이미 확인했다.
//
// 흐름은 shot-mobile-web.mjs(S1-0.2)와 같다: 서버 기동 → 390×844 로 열기 → 찍기 → 직접 띄운 서버 끄기.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_WEB_DIR = resolve(MOBILE_DIR, "../admin-web");
const VIEWPORT = { width: 390, height: 844 };
const SERVER_TIMEOUT_MS = 180_000;
const RENDER_TIMEOUT_MS = 90_000;
const CHROMIUM_PATH =
  process.env["E2E_CHROMIUM_PATH"] ??
  join(homedir(), ".cache/ms-playwright/chromium-1247/chrome-linux64/chrome");

function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(readArg("port", "8092"));
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/owner-terms")));
const baseUrl = `http://localhost:${port}`;

// ---- 예시 응답(계약 07 §5 · README §6-1 모양 그대로). 개인정보·비밀값은 없다 ----
const ACADEMY_ID = "11111111-1111-4111-8111-111111111111";
const NOTICE_ID = "22222222-2222-4222-8222-222222222222";
const STAFF_ME = {
  accountId: "33333333-3333-4333-8333-333333333333",
  displayName: "예시 대표",
  roles: ["owner"],
  secondFactorVerified: true,
  consoleAccess: true,
  academies: [{ academyId: ACADEMY_ID, name: "예시 댄스 학원", as: "owner", permissions: ["owner"], menus: ["roster", "classes", "settings"] }],
  platformMenus: [],
};
const AGREED_AT = "2026-10-01T05:22:00.000Z"; // KST 14:22
const NOTICE = {
  noticeId: NOTICE_ID,
  item: "merchant_terms",
  version: "1.1",
  effectiveAt: "2026-12-21T15:00:00.000Z", // KST 12-22 00:00
  notifiedAt: "2026-11-21T01:00:00.000Z",
  readAt: null,
};
const CONSENTS = {
  items: [
    { item: "merchant_terms", version: "1.0", termsVersionId: "44444444-4444-4444-8444-444444444441", agreedAt: AGREED_AT, current: true },
    { item: "platform_fee_notice", version: "1.0", termsVersionId: "44444444-4444-4444-8444-444444444442", agreedAt: AGREED_AT, current: true },
    { item: "card_fee_notice", version: "1.0", termsVersionId: "44444444-4444-4444-8444-444444444443", agreedAt: AGREED_AT, current: true },
    { item: "content_license", version: "1.0", termsVersionId: "44444444-4444-4444-8444-444444444444", agreedAt: AGREED_AT, current: true },
    { item: "one_plus_one_notice", version: "1.0", termsVersionId: "44444444-4444-4444-8444-444444444445", agreedAt: "2026-10-01T01:31:00.000Z", current: true },
  ],
  pendingChanges: [NOTICE],
};

/** `/api/**` 요청을 계약 모양 예시로 답한다. 읽음 POST 는 처음 읽은 시각을 기억해 두 번째에도 같은 본문 */
async function installApiMock(page, log) {
  let readAt = null;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    log.push(`${request.method()} ${path}`);
    const json = (status, body) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "access-control-allow-origin": "*" } });
    if (request.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST" } });
    }
    if (request.method() === "GET" && path === "/api/staff/me") return json(200, STAFF_ME);
    if (request.method() === "GET" && path === `/api/academies/${ACADEMY_ID}/consents`) {
      return json(200, { ...CONSENTS, pendingChanges: [{ ...NOTICE, readAt }] });
    }
    if (request.method() === "POST" && path === `/api/academies/${ACADEMY_ID}/terms-notices/${NOTICE_ID}/read`) {
      readAt = readAt ?? "2026-11-21T03:05:00.000Z"; // KST 12:05
      return json(200, { ...NOTICE, readAt });
    }
    return json(404, { detail: "없는 경로예요.", code: "NOT_FOUND" });
  });
}

async function isUp(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function waitUntilUp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(url)) return;
    await new Promise((done) => setTimeout(done, 1_000));
  }
  throw new Error(`Expo 웹 서버가 ${timeoutMs / 1000}초 안에 뜨지 않았다: ${url}`);
}

function startExpoWeb() {
  return spawn(join(MOBILE_DIR, "node_modules/.bin/expo"), ["start", "--web", "--port", String(port)], {
    cwd: MOBILE_DIR,
    env: { ...process.env, CI: "1", BROWSER: "none" },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
}

function stopExpoWeb(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // 이미 끝났다
  }
}

async function main() {
  const { chromium } = createRequire(join(ADMIN_WEB_DIR, "package.json"))("@playwright/test");
  let server = null;
  if (!(await isUp(baseUrl))) {
    console.log(`[shot] expo start --web 을 띄운다(포트 ${port})`);
    server = startExpoWeb();
    await waitUntilUp(baseUrl, SERVER_TIMEOUT_MS);
  }
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  const apiLog = [];
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installApiMock(page, apiLog);
    mkdirSync(outDir, { recursive: true });

    // 장면 1 — 안내 상자(읽기 전)
    await page.goto(`${baseUrl}/owner/terms`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    const readButton = page.getByRole("button", { name: /변경 안내 읽음/ });
    await readButton.waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(outDir, "안내-상자.png") });
    console.log(`[shot] 저장: ${join(outDir, "안내-상자.png")}`);

    // 장면 2 — 「읽었어요」를 누른 뒤
    await readButton.click();
    await page.getByText(/^읽음 · /).waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, "읽음-후.png") });
    console.log(`[shot] 저장: ${join(outDir, "읽음-후.png")}`);

    console.log(`[shot] 주소: ${page.url()}`);
    console.log(`[shot] 가로챈 API 호출:\n  ${apiLog.join("\n  ")}`);
    if (pageErrors.length > 0) {
      console.log(`[shot] 화면 오류 ${pageErrors.length}건:\n  ${pageErrors.join("\n  ")}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    stopExpoWeb(server);
  }
}

main().catch((error) => {
  console.error(`[shot] 실패: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
