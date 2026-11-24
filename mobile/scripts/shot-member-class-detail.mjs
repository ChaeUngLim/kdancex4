// 회원 앱 「신청한 수업 상세(보드 M8C)」의 「수업 일정」 달력을 Expo 웹으로 띄워 장면을 찍는다
// — 로드맵 S3-4.8(앱 신청한 수업 상세 화면, 한 달 달력 ‹ ›).
//
//   실행(mobile 폴더에서): node scripts/shot-member-class-detail.mjs --out-dir <폴더> [--port 8097]
//   결과(<폴더> 안):
//     M8C-첫달.png     처음 연 화면 — 다음 수업이 있는 달, ‹ 막힘
//     M8C-다음달.png   › 를 한 번 누른 뒤 — 다음 달 수업일(아이보리 동그라미)
//     M8C-마지막달.png  › 를 끝까지 누른 뒤 — 마지막 수업 달, › 막힘
//     M8C-전체.png     첫 달 화면을 세로로 늘려 한 장에 담은 것(요약 카드·내 수업 일정·달력·하단 탭)
//
// 무엇을 보여 주나 — 개발 DB 의 진짜 데이터(2026-11-23 사용자 지시 「가상데이터도 추가해서」):
//   admin-web/scripts/dev-demo-member-my-class.ts 가 진짜 등록·주문·결제 경로로 만든 「윤서아」의 결제완료 수업
//   「바차타(초급)」(월·수 20:30, 8주 16회)을 떠 있는 개발 서버(:3000)에서 그대로 읽는다. 응답을 꾸며 넣지 않는다.
//   먼저: admin-web `KDANCE_DEV_ROUTES=true npm run dev -- --port 3000` · `./node_modules/.bin/jiti scripts/dev-demo-member-my-class.ts`
//
// 로그인은 어떻게 하나:
//   앱 웹(localhost:8081)에서 이메일 로그인을 누르면 서버가 출처 검사(INVALID_ORIGIN, 403)로 막는다 — S3-4.7b(앱 캘린더·알림함·내역
//   시연 데이터)에 사람 결정으로 남은 열린 점이다. 그래서 이 스크립트가 Node 에서 같은 로그인 경로(POST /api/auth/sign-in/email,
//   출처 헤더 없음)를 불러 세션 토큰을 받고, 브라우저의 `/api/**` 요청에 `Authorization: Bearer` 헤더만 붙여 진짜 서버로 보낸다(아래 attachToken).
//   응답 본문은 건드리지 않는다(앱이 휴대폰에서 SecureStore 토큰을 붙이는 것과 같은 모양).
//   화면 글자·버튼 상태가 기대와 다르면 [check] FAIL 을 찍고 exit 1 로 끝낸다.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
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

const port = Number(readArg("port", "8097"));
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/member-class-detail")));
const baseUrl = `http://localhost:${port}`;
const API_BASE = readArg("api", "http://localhost:3000");
const DEMO = { email: "demo-myclass@example.com", password: "demo-myclass-1234", title: "바차타(초급)" };

const HOUR = 3_600_000;
/** KST 달력 날짜(연·월·일·요일) */
function kst(ms) {
  const d = new Date(ms + 9 * HOUR);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

// 실서버에서 읽어 채운다(main 첫머리) — 기대값 계산에만 쓰고 화면에 넣지 않는다
let OFFERING_ID = "";
let DETAIL = { title: DEMO.title, sessions: [] };
let SESSIONS = [];
let monthsOf = [];

/**
 * 시연 회원으로 로그인해 세션 토큰을 받는다(Better Auth bearer 플러그인이 set-auth-token 헤더로 준다).
 * Node 의 fetch 는 `sec-fetch-mode: cors` 를 붙여 서버가 「브라우저인데 출처가 없다」(MISSING_OR_NULL_ORIGIN)로 막는다.
 * 앱(휴대폰)·curl 처럼 브라우저 머리글 없이 보내려고 node:http 로 부른다.
 */
function signIn() {
  const body = JSON.stringify({ email: DEMO.email, password: DEMO.password });
  return new Promise((done, fail) => {
    const request = httpRequest(
      `${API_BASE}/api/auth/sign-in/email`,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (response) => {
        response.resume();
        const token = response.headers["set-auth-token"];
        if (response.statusCode === 200 && typeof token === "string" && token.length > 0) return done(token);
        fail(new Error(`시연 회원 로그인 실패(${response.statusCode}) — admin-web 에서 scripts/dev-demo-member-my-class.ts 를 먼저 돌린다`));
      },
    );
    request.on("error", fail);
    request.end(body);
  });
}

async function apiGet(token, path) {
  const response = await fetch(`${API_BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`GET ${path} → ${response.status} ${await response.text()}`);
  return response.json();
}

/**
 * 브라우저의 `/api/**` 요청을 진짜 서버로 보내되 Bearer 헤더만 붙인다. 응답 본문·상태 코드는 서버가 준 그대로다.
 * 요청은 Playwright 가 Node 쪽에서 대신 보내고(route.fetch), 돌려줄 때 이 앱 웹 출처를 허용하는 CORS 머리글 하나만 더한다 —
 * 개발 서버의 CORS 허용(proxy.ts)은 localhost:8081 하나뿐이라, 이 스크립트가 따로 띄운 Expo 웹(기본 8097)에서도 찍히게 하려는 것이다.
 */
async function attachToken(page, token, log) {
  await page.route(`${API_BASE}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const cors = { "access-control-allow-origin": baseUrl, "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const entry = { method: request.method(), path: url.pathname, search: url.search, status: 0 };
    log.push(entry);
    const response = await route.fetch({ headers: { ...request.headers(), authorization: `Bearer ${token}` } });
    entry.status = response.status();
    return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
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
    // 앱이 부를 서버 = 개발 서버. mobile/.env 파일은 건드리지 않고 이 실행에만 준다
    env: { ...process.env, CI: "1", BROWSER: "none", EXPO_PUBLIC_API_URL: API_BASE },
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

async function shot(page, name, fullPage = false) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, name), fullPage });
  console.log(`[shot] 저장: ${join(outDir, name)}`);
}

function check(ok, label) {
  console.log(`[check] ${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
}

const bodyText = (page) => page.evaluate(() => document.body.innerText);
/** 달력이 그린 「수업 있는 날」 칸 수 */
const classDayCount = (page) => page.locator('[aria-label$=", 수업 있는 날"]').count();
/** 한 번에 보이는 달 제목 수 — 「2026년 12월」 꼴이 정확히 하나여야 한다 */
const monthTitles = async (page) => ((await bodyText(page)).match(/\d{4}년 \d{1,2}월/g) ?? []);

function expectedDaysIn(ym) {
  return SESSIONS.filter((s) => { const k = kst(Date.parse(s.startsAt)); return `${k.year}-${k.month}` === ym; }).length;
}
const label = (ym) => { const [y, m] = ym.split("-"); return `${y}년 ${m}월`; };

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
    // ---- 실서버 데이터 읽기: 내 캘린더에서 시연 수업 → 수업 상세의 회차 전체 ----
    const token = await signIn();
    const mine = await apiGet(token, "/api/me/calendar");
    const entry = (mine.items ?? []).find((item) => item.title === DEMO.title);
    if (entry === undefined) throw new Error(`내 캘린더에 「${DEMO.title}」이 없다 — dev-demo-member-my-class.ts 를 먼저 돌린다`);
    OFFERING_ID = entry.offeringId;
    DETAIL = await apiGet(token, `/api/offerings/${encodeURIComponent(OFFERING_ID)}`);
    SESSIONS = DETAIL.sessions;
    monthsOf = [...new Set(SESSIONS.map((s) => { const k = kst(Date.parse(s.startsAt)); return `${k.year}-${k.month}`; }))];
    const nextSeq = SESSIONS.find((s) => Date.parse(s.startsAt) > Date.now())?.seq;
    console.log(`[shot] 실서버 ${API_BASE} · 수업 ${DETAIL.title} · ${DETAIL.academy?.name} · 강사 ${DETAIL.instructorName} · ${DETAIL.priceAmount}원`);
    console.log(`[shot] 회차 ${SESSIONS.length}개 · 달 ${monthsOf.join(", ")} · 첫 회차 ${SESSIONS[0].startsAt}`);
    check(monthsOf.length >= 3, `수업 기간이 석 달 이상에 걸친다(${monthsOf.length}달) — 첫·다음·마지막 달이 서로 다르다`);
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await attachToken(page, token, apiLog);

    // ---- 들어가는 길: 캘린더 탭 → 첫 회차 날 → 수업명 ----
    await page.goto(`${baseUrl}/calendar`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByRole("button", { name: "다음 달" }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    const first = kst(Date.parse(SESSIONS[0].startsAt));
    if (first.month !== kst(Date.now()).month) await page.getByRole("button", { name: "다음 달" }).click();
    await page.getByRole("button", { name: `${first.month}월 ${first.day}일, 수업 1개` }).click();
    await page.getByRole("link", { name: `${DETAIL.title} 수업 상세 보기` }).click();
    await page.waitForURL(/\/my-class\//, { timeout: RENDER_TIMEOUT_MS });
    check(new URL(page.url()).pathname === `/my-class/${OFFERING_ID}`, `캘린더 수업명 → ${new URL(page.url()).pathname}`);

    // ---- 장면 M8C-첫달 ----
    await page.getByText("수업 일정", { exact: true }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    let text = await bodyText(page);
    let titles = await monthTitles(page);
    check(titles.length === 1 && titles[0] === label(monthsOf[0]), `첫 달 = 다음 수업이 있는 달, 달력은 한 달만: ${JSON.stringify(titles)}`);
    check(await page.getByRole("button", { name: "이전 달" }).isDisabled(), "첫 달에서 ‹ 막힘");
    check(!(await page.getByRole("button", { name: "다음 달" }).isDisabled()), "첫 달에서 › 열림");
    check((await classDayCount(page)) === expectedDaysIn(monthsOf[0]), `첫 달 수업일 동그라미 ${await classDayCount(page)}개 = 회차 ${expectedDaysIn(monthsOf[0])}`);
    check(text.includes("신청함") && text.includes(`다음 수업 · ${nextSeq}회차`) && text.includes(`총 ${SESSIONS.length}회`), `요약 「신청함」 · 내 수업 일정 「다음 수업 · ${nextSeq}회차」 · 「총 ${SESSIONS.length}회」`);
    check(text.includes(`수업일은 총 ${SESSIONS.length}회예요`) && text.includes(`› 로 ${monthsOf[1].split("-")[1]}월을 봐요.`), `달력 아래 안내 「총 ${SESSIONS.length}회 (기간). › 로 다음 달」`);
    // 주 2회 수업은 요일을 모두 보인다(첫 회차 요일만 보이던 문제를 실데이터로 찾아 고침)
    check(text.includes("월·수 20:30–21:30"), "요약 카드 요일·시간 「월·수 20:30–21:30」");
    await shot(page, "M8C-첫달.png");
    await page.setViewportSize({ width: 390, height: 1400 });
    await shot(page, "M8C-전체.png");
    await page.setViewportSize(VIEWPORT);

    // ---- 장면 M8C-다음달: › 한 번 ----
    await page.getByRole("button", { name: "다음 달" }).click();
    await page.getByText(label(monthsOf[1]), { exact: true }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    titles = await monthTitles(page);
    check(titles.length === 1 && titles[0] === label(monthsOf[1]), `› 뒤 다음 달 하나만: ${JSON.stringify(titles)}`);
    check(!(await page.getByRole("button", { name: "이전 달" }).isDisabled()), "다음 달에서 ‹ 열림");
    check((await classDayCount(page)) === expectedDaysIn(monthsOf[1]), `다음 달 수업일 ${await classDayCount(page)}개 = 회차 ${expectedDaysIn(monthsOf[1])}`);
    await page.getByText(/^ⓘ 수업일은/).scrollIntoViewIfNeeded();
    await shot(page, "M8C-다음달.png");

    // ---- 장면 M8C-마지막달: › 를 끝까지 ----
    for (let i = 2; i < monthsOf.length; i += 1) await page.getByRole("button", { name: "다음 달" }).click();
    const lastYm = monthsOf[monthsOf.length - 1];
    await page.getByText(label(lastYm), { exact: true }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(await page.getByRole("button", { name: "다음 달" }).isDisabled(), "마지막 달에서 › 막힘");
    // 막힌 › 를 한 번 더 눌러도(강제 클릭) 수업 기간 밖으로 넘어가지 않는다
    await page.getByRole("button", { name: "다음 달" }).click({ force: true });
    titles = await monthTitles(page);
    check(titles.length === 1 && titles[0] === label(lastYm), `막힌 › 를 눌러도 마지막 달에 머문다: ${JSON.stringify(titles)}`);
    check((await classDayCount(page)) === expectedDaysIn(lastYm), `마지막 달 수업일 ${await classDayCount(page)}개 = 회차 ${expectedDaysIn(lastYm)}`);
    text = await bodyText(page);
    check(text.includes(`‹ 로 ${monthsOf[monthsOf.length - 2].split("-")[1]}월을 봐요.`), "마지막 달 안내는 ‹ 쪽");
    await page.getByText(/^ⓘ 수업일은/).scrollIntoViewIfNeeded();
    await shot(page, "M8C-마지막달.png");

    const reads = apiLog.filter((r) => r.method === "GET").map((r) => r.path);
    check(reads.includes(`/api/offerings/${OFFERING_ID}`) && reads.includes("/api/me/calendar"), "화면이 읽은 경로: 수업 상세 · 내 캘린더");
    console.log(`[shot] 화면이 부른 실서버 API(Bearer 만 붙임):\n  ${apiLog.map((r) => `${r.method} ${r.path}${r.search} → ${r.status}`).join("\n  ")}`);
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
