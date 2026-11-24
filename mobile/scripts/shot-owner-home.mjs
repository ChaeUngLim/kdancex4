// 대표 앱 「홈」(O6) 화면을 Expo 웹으로 띄워 장면을 찍는다 — 로드맵 S1-4.9(대표 앱 홈 화면 O6).
//
//   실행(mobile 폴더에서): node scripts/shot-owner-home.mjs --out-dir <폴더> [--port 8094]
//   결과(<폴더> 안):
//     첫-화면.png          M1 지금 모습 — 학원 이름·대표 표시, 해야 할 일 2건, 큰 타일 두 장(준비 중)
//     준비-중-타일.png     타일 7개 부분만 잘라 낸 모습 — 모두 「준비 중」, 숫자 0 이 없음
//     숫자-채운-타일.png   뒤 슬라이스가 타일을 채웠을 때 — 웹과 같은 숫자 글자(4,820,000원 · —)가 보임
//
// 왜 서버 응답을 브라우저에서 꾸며 넣나(shot-owner-instructors.mjs 와 같은 이유):
//   웹 실행에는 SecureStore 가 없어 로그인 토큰을 둘 수 없다(lib/session.ts). 그래서 page.route 로 `/api/**` 를
//   가로채 계약 10 §1 모양의 예시 응답을 돌려준다. 서버 쪽 집계는 S1-4.5 DB 테스트가 확인했다.
//   화면 글자를 보고 기대와 다르면 [check] FAIL 을 찍고 exit 1 로 끝낸다.
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

const port = Number(readArg("port", "8094"));
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/owner-home")));
const baseUrl = `http://localhost:${port}`;

// ---- 예시 응답(계약 10 §1 · README §6-1 모양 그대로) ----
const ACADEMY_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ME = {
  accountId: "33333333-3333-4333-8333-333333333333",
  displayName: "예시 대표",
  roles: ["owner"],
  secondFactorVerified: true,
  consoleAccess: true,
  academies: [{ academyId: ACADEMY_ID, name: "라틴하우스 강남", as: "owner", permissions: ["owner"], menus: ["instructors"] }],
  platformMenus: [],
};
/** M1 지금 모습 — S1-4.5 처리기가 내리는 타일 7개 그대로(전부 준비 전, 숫자 칸 null) */
const M1_DASHBOARD = {
  academyId: ACADEMY_ID,
  date: "2026-11-21",
  todayOrders: { available: false, availableFrom: "S3-3", applications: null, paidCount: null, paidAmount: null, awaitingDeposit: null },
  refundRequests: { available: false, availableFrom: "S4-1", regular: null, event: null, overdue: null },
  pendingClassApprovals: { available: false, availableFrom: "S2-2", count: null, top: null },
  nearlyFull: { available: false, availableFrom: "S3-3", items: [] },
  month: { available: false, availableFrom: "S5-1", revenue: null, paymentsCount: null, settlement: { completed: null, scheduled: null, hold: null } },
  nextPayout: { available: false, availableFrom: "S5-3", date: null, expectedNet: null, instructorPayoutPending: null },
  sessions: { available: false, availableFrom: "S2-2", today: [], tomorrow: [] },
  todos: [
    { kind: "terms_change_notice", title: "입점 약관 1.1 · 12월 10일 적용", dueAt: "2026-12-09T15:30:00Z", link: "/settings#terms" },
    { kind: "affiliation_requested", title: "아이유 강사 소속 신청", dueAt: null, link: "/staff/instructors?status=pending" },
  ],
};
/** 뒤 슬라이스가 채운 모습 — admin-web 비교 테스트(owner-dashboard-app-parity)의 filled 와 같은 값 */
const FILLED_DASHBOARD = {
  ...M1_DASHBOARD,
  todayOrders: { available: true, availableFrom: null, applications: 12, paidCount: 0, paidAmount: 1234567, awaitingDeposit: null },
  refundRequests: { available: true, availableFrom: null, regular: 2, event: null, overdue: 0 },
  pendingClassApprovals: { available: true, availableFrom: null, count: 1, top: null },
  nearlyFull: { available: true, availableFrom: null, items: [{}, {}] },
  month: { available: true, availableFrom: null, revenue: 4820000, paymentsCount: 37, settlement: { completed: null, scheduled: null, hold: null } },
  nextPayout: { available: true, availableFrom: null, date: "2026-12-05", expectedNet: null, instructorPayoutPending: null },
  sessions: { available: true, availableFrom: null, today: [{}, {}], tomorrow: [] },
};

/** `/api/**` 를 계약 모양 예시로 답한다. 강사 관리 화면(할 일 줄을 누르면 가는 곳)의 목록도 빈 값으로 답한다 */
async function installApiMock(page, log, dashboard) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    log.push(`${method} ${path}${url.search}`);
    const json = (status, body) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "access-control-allow-origin": "*" } });
    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT" } });
    }
    const base = `/api/academies/${ACADEMY_ID}`;
    if (method === "GET" && path === "/api/staff/me") return json(200, STAFF_ME);
    if (method === "GET" && path === `${base}/dashboard`) return json(200, dashboard);
    if (method === "GET" && path === `${base}/affiliations`) return json(200, { items: [] });
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

async function shot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, name) });
  console.log(`[shot] 저장: ${join(outDir, name)}`);
}

function check(ok, label) {
  console.log(`[check] ${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
}

/** 화면에 보이는 글 전체(Expo 웹은 DOM 글자로 그린다) */
const bodyText = (page) => page.evaluate(() => document.body.innerText);

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
  const pageErrors = [];
  try {
    mkdirSync(outDir, { recursive: true });

    // ---- M1 지금 모습 ----
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installApiMock(page, apiLog, M1_DASHBOARD);

    // 장면 1 — 첫 화면
    await page.goto(`${baseUrl}/owner`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("해야 할 일 2건").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const text = await bodyText(page);
    check(text.includes("라틴하우스 강남") && text.includes("대표"), "제목 줄에 학원 이름과 「대표」");
    check(text.includes("2026-11-21 (토)"), "날짜 줄 「2026-11-21 (토)」(웹과 같은 글자)");
    check(text.includes("12월 10일까지 확인해 주세요") && text.includes("확인하고 승인하거나 거절해 주세요"), "할 일 안내 두 줄(웹과 같은 글자)");
    const pendingCount = text.split("준비 중").length - 1;
    check(pendingCount === 7, `「준비 중」 배지 7개(지금 ${pendingCount}개)`);
    await shot(page, "첫-화면.png");

    // 장면 2 — 아래 작은 타일까지 내린다. 타일 글자 어디에도 숫자가 없어야 한다(0 으로 보이면 안 된다)
    await page.getByText("정산 예정", { exact: true }).scrollIntoViewIfNeeded();
    const tileTexts = await page.locator('[aria-label*="준비 중"]').allInnerTexts();
    check(tileTexts.length === 7, `준비 중 타일 7개(지금 ${tileTexts.length}개)`);
    check(tileTexts.every((t) => !/\d/.test(t)), `준비 중 타일 글자에 숫자 0개: ${JSON.stringify(tileTexts)}`);
    // 첫 화면에 타일이 다 들어와 스크롤이 없으므로, 타일 부분(승인 대기 수업 ~ 정산 예정)만 잘라 크게 남긴다
    const firstTile = await page.locator('[aria-label^="승인 대기 수업"]').boundingBox();
    const lastTile = await page.locator('[aria-label^="정산 예정"]').boundingBox();
    const top = Math.max(0, Math.floor(firstTile.y) - 8);
    const bottom = Math.ceil(lastTile.y + lastTile.height) + 8;
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, "준비-중-타일.png"), clip: { x: 0, y: top, width: VIEWPORT.width, height: bottom - top } });
    console.log(`[shot] 저장: ${join(outDir, "준비-중-타일.png")} (타일 부분 y ${top}~${bottom})`);

    // 할 일 줄 누르기 → 강사 관리(O37)로 간다
    await page.getByRole("button", { name: "아이유 강사 소속 신청" }).click();
    await page.getByText("강사 관리").first().waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(new URL(page.url()).pathname === "/owner/instructors", `소속 신청 줄 → ${new URL(page.url()).pathname}`);
    await page.close();

    // ---- 뒤 슬라이스가 채운 모습 ----
    const filled = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    filled.on("pageerror", (error) => pageErrors.push(error.message));
    await installApiMock(filled, apiLog, FILLED_DASHBOARD);
    await filled.goto(`${baseUrl}/owner`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await filled.getByText("4,820,000원").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const filledText = await bodyText(filled);
    // admin-web 비교 테스트가 웹 함수로 확인한 글자와 같은 글자가 앱 화면에 그려졌는가
    for (const expected of ["4,820,000원", "결제 37건", "12건 · 0건", "결제 1,234,567원 · 입금 대기 —", "정규 2 · 이벤트형 — · 기한 지남 0", "오늘 2개 · 내일 0개", "정산일 2026-12-05", "1개", "2개"]) {
      check(filledText.includes(expected), `채운 타일 글자 「${expected}」`);
    }
    check(!filledText.includes("준비 중"), "채운 뒤에는 「준비 중」이 없다");
    await filled.getByText("정산 예정", { exact: true }).scrollIntoViewIfNeeded();
    await shot(filled, "숫자-채운-타일.png");
    await filled.close();

    console.log(`[shot] 가로챈 API 호출:\n  ${apiLog.join("\n  ")}`);
    if (pageErrors.length > 0) {
      console.log(`[shot] 화면 오류 ${pageErrors.length}건:\n  ${pageErrors.join("\n  ")}`);
      process.exitCode = 1;
    } else {
      console.log("[shot] 화면 오류 0건");
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
