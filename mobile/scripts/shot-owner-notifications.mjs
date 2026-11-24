// 대표 앱 「알림」(O21·O21B) 화면을 Expo 웹으로 띄워 장면을 찍는다 — 로드맵 S1-4.10(대표 앱 알림함 화면 O21·O21B).
//
//   실행(mobile 폴더에서): node scripts/shot-owner-notifications.mjs --out-dir <폴더> [--port 8095]
//   결과(<폴더> 안):
//     전체.png           칩 「전체」 — 오늘·어제 묶음, 소속 신청 알림의 「확인하고 승인 ›」, 안 읽음 점
//     운영-칩.png        칩 「운영」 — category=operations 로 다시 부른 목록(계좌·약관·제한 알림만)
//     O37-이동.png       「확인하고 승인 ›」을 누른 뒤 — 강사 관리(O37) 화면
//     모두-읽음.png      운영 칩에서 「모두 읽음」 뒤 — 점이 사라지고 안내 한 줄
//
// 왜 서버 응답을 브라우저에서 꾸며 넣나(shot-owner-home.mjs 와 같은 이유):
//   웹 실행에는 SecureStore 가 없어 로그인 토큰을 둘 수 없다(lib/session.ts). 그래서 page.route 로 `/api/**` 를
//   가로채 계약 10 §2 모양의 예시 응답을 돌려준다. 서버 쪽 알림함 동작은 S1-4.6 DB 테스트가 확인했다.
//   화면이 보낸 요청(category·읽음·모두 읽음 본문)이 기대와 다르면 [check] FAIL 을 찍고 exit 1 로 끝낸다.
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

const port = Number(readArg("port", "8095"));
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/owner-notifications")));
const baseUrl = `http://localhost:${port}`;

// ---- 예시 응답(계약 10 §2 · README §6-1 모양 그대로) ----
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
const AFFILIATION_NOTIFICATION_ID = "aaaaaaaa-0000-4000-8000-000000000001";
// 「오늘」·「어제」 묶음이 늘 같게 나오도록 지금 시각에서 거꾸로 센다
const MINUTE = 60_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
/** M1 이 만드는 대표 알림 종류(계약 10 §2 표) — S1-4.6 쓰는 쪽 payload 모양 */
const ALL_ITEMS = [
  {
    id: AFFILIATION_NOTIFICATION_ID,
    kind: "affiliation_requested",
    category: "approval",
    academyId: ACADEMY_ID,
    createdAt: ago(3 * MINUTE),
    readAt: null,
    payload: { title: "아이유 강사가 소속을 신청했어요", body: "살사·바차타 · 「주말 저녁 수업을 맡고 싶어요」", actionLabel: "확인하고 승인", link: "/staff/instructors?status=pending" },
  },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000002",
    kind: "payout_account_changed",
    category: "operations",
    academyId: ACADEMY_ID,
    createdAt: ago(5 * MINUTE),
    readAt: null,
    payload: { title: "정산 계좌가 바뀌었어요", body: "국민 ****1234 · 다음 정산부터 이 계좌로 보내요", actionLabel: "계좌 보기", link: "/settings#payout" },
  },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000003",
    kind: "terms_change_notice",
    category: "operations",
    academyId: ACADEMY_ID,
    createdAt: ago(24 * 60 * MINUTE),
    readAt: null,
    payload: { title: "입점 약관 1.1 · 12월 10일 적용", body: "12월 10일까지 확인해 주세요", actionLabel: "약관 보기", link: "/settings#terms" },
  },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000004",
    kind: "affiliation_requested",
    category: "approval",
    academyId: ACADEMY_ID,
    createdAt: ago(25 * 60 * MINUTE),
    readAt: ago(24 * 60 * MINUTE),
    payload: { title: "정우진 강사가 소속을 신청했어요", body: "바차타 · 초대 링크로 신청", actionLabel: "확인하고 승인", link: "/staff/instructors?status=pending" },
  },
];

/** `/api/**` 를 계약 모양 예시로 답한다. 화면이 보낸 요청을 log 에 남겨 나중에 대조한다 */
async function installApiMock(page, log, readState) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postData();
    log.push({ method, path, search: url.search, body });
    const json = (status, payload) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload), headers: { "access-control-allow-origin": "*" } });
    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT" } });
    }
    const withRead = (item) => (readState.has(item.id) && item.readAt === null ? { ...item, readAt: new Date().toISOString() } : item);
    if (method === "GET" && path === "/api/staff/me") return json(200, STAFF_ME);
    if (method === "GET" && path === "/api/staff/notifications") {
      const category = url.searchParams.get("category");
      const items = ALL_ITEMS.filter((item) => category === null || item.category === category).map(withRead);
      return json(200, { items, nextCursor: null });
    }
    const readMatch = path.match(/^\/api\/staff\/notifications\/([^/]+)\/read$/);
    if (method === "POST" && readMatch) {
      readState.add(readMatch[1]);
      const item = ALL_ITEMS.find((i) => i.id === readMatch[1]);
      return item ? json(200, withRead(item)) : json(404, { detail: "알림을 찾을 수 없어요", code: "NOT_FOUND" });
    }
    if (method === "POST" && path === "/api/staff/notifications/read-all") {
      const category = JSON.parse(body ?? "{}").category ?? null;
      const targets = ALL_ITEMS.filter((i) => (category === null || i.category === category) && i.readAt === null && !readState.has(i.id));
      targets.forEach((i) => readState.add(i.id));
      return json(200, { updated: targets.length });
    }
    // 강사 관리(O37) — 「확인하고 승인 ›」이 이어지는 화면. 승인 대기 한 명만 답한다
    if (method === "GET" && path === `/api/academies/${ACADEMY_ID}/affiliations`) {
      const pending = url.searchParams.get("status") === "pending";
      return json(200, {
        items: pending
          ? [{ affiliationId: "bbbbbbbb-0000-4000-8000-000000000001", status: "pending", source: "application", requestedAt: ago(3 * MINUTE), instructor: { accountId: "cccccccc-0000-4000-8000-000000000001", displayName: "아이유", phoneMasked: "010-****-5678", activityGenre: null }, message: "주말 저녁 수업을 맡고 싶어요.", isAcademyEmployee: false, permissions: [] }]
          : [],
      });
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

async function shot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, name) });
  console.log(`[shot] 저장: ${join(outDir, name)}`);
}

function check(ok, label) {
  console.log(`[check] ${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
}

const bodyText = (page) => page.evaluate(() => document.body.innerText);
/** 안 읽음 줄 수 — 줄 이름표가 「안 읽음.」으로 시작한다 */
const unreadCount = (page) => page.locator('[aria-label^="안 읽음."]').count();

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
    const readState = new Set();

    // ---- 장면 1: 칩 「전체」 ----
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installApiMock(page, apiLog, readState);
    await page.goto(`${baseUrl}/owner/notifications`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("아이유 강사가 소속을 신청했어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const text = await bodyText(page);
    const chipLabels = await page.getByRole("tab").allInnerTexts();
    check(JSON.stringify(chipLabels) === JSON.stringify(["전체", "승인", "신청·마감", "문의", "정산", "운영"]), `칩 여섯(O21 다섯 + O21B 운영): ${JSON.stringify(chipLabels)}`);
    check(text.includes("오늘") && text.includes("어제"), "「오늘」·「어제」 묶음 제목");
    check(text.includes("확인하고 승인 ›"), "소속 신청 알림에 「확인하고 승인 ›」");
    check(text.includes("관리자 웹에서 확인해요"), "앱 화면이 없는 계좌 알림은 「관리자 웹에서 확인해요」");
    check((await unreadCount(page)) === 3, `안 읽음 3줄(지금 ${await unreadCount(page)}줄)`);
    const firstList = apiLog.filter((r) => r.path === "/api/staff/notifications");
    check(firstList.length === 1 && !firstList[0].search.includes("category=") && firstList[0].search.includes(`academyId=${ACADEMY_ID}`), `전체 칩은 category 없이 학원만 붙여 부른다: ${firstList.map((r) => r.search).join(" ")}`);
    await shot(page, "전체.png");

    // ---- 장면 2: 칩 「운영」 ----
    await page.getByRole("tab", { name: "운영 알림" }).click();
    await page.getByText("정산 계좌가 바뀌었어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.waitForFunction(() => !document.body.innerText.includes("아이유 강사가 소속을 신청했어요"), null, { timeout: RENDER_TIMEOUT_MS });
    const opsText = await bodyText(page);
    const opsCall = apiLog.filter((r) => r.path === "/api/staff/notifications").at(-1);
    check(opsCall.search.includes("category=operations"), `운영 칩 → category=operations 로 부른다: ${opsCall.search}`);
    check(opsText.includes("입점 약관 1.1") && !opsText.includes("소속을 신청했어요"), "운영 칩 목록에 계좌·약관만, 소속 신청 없음");
    check((await page.getByRole("tab", { name: "운영 알림" }).getAttribute("aria-selected")) === "true", "운영 칩이 선택됨(aria-selected)");
    await shot(page, "운영-칩.png");

    // ---- 장면 3: 「모두 읽음」(운영 칩만) ----
    await page.getByRole("button", { name: "모두 읽음" }).click();
    await page.getByText("알림 2건을 읽음으로 바꿨어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const readAllCall = apiLog.find((r) => r.path === "/api/staff/notifications/read-all");
    check(readAllCall !== undefined && JSON.parse(readAllCall.body).category === "operations", `모두 읽음 본문 ${readAllCall?.body}`);
    await page.waitForFunction(() => document.querySelectorAll('[aria-label^="안 읽음."]').length === 0, null, { timeout: RENDER_TIMEOUT_MS });
    check((await unreadCount(page)) === 0, "모두 읽음 뒤 운영 칩 안 읽음 0줄");
    await shot(page, "모두-읽음.png");

    // ---- 장면 4: 전체 칩 → 「확인하고 승인 ›」 → 강사 관리(O37) ----
    await page.getByRole("tab", { name: "전체 알림" }).click();
    await page.getByText("아이유 강사가 소속을 신청했어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check((await unreadCount(page)) === 1, `운영 2건을 읽은 뒤 전체 칩 안 읽음 1줄(소속 신청만)`);
    await page.getByRole("button", { name: /^안 읽음\. 아이유 강사가 소속을 신청했어요/ }).click();
    await page.getByText("강사 관리").first().waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByText("주말 저녁 수업을 맡고 싶어요.").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(new URL(page.url()).pathname === "/owner/instructors", `확인하고 승인 › → ${new URL(page.url()).pathname}(O37)`);
    const readCall = apiLog.find((r) => r.method === "POST" && r.path === `/api/staff/notifications/${AFFILIATION_NOTIFICATION_ID}/read`);
    check(readCall !== undefined, "누른 알림을 읽음 처리했다(POST …/read)");
    await shot(page, "O37-이동.png");
    await page.close();

    console.log(`[shot] 가로챈 API 호출:\n  ${apiLog.map((r) => `${r.method} ${r.path}${r.search}${r.body ? ` ${r.body}` : ""}`).join("\n  ")}`);
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
