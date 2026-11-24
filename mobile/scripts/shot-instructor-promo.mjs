// 강사 앱 「홍보 이미지 · 소개 문구」(수업 등록 마지막 단계)를 Expo 웹으로 띄워 장면을 찍는다 — 로드맵 SX-6.9(앱 홍보 이미지·소개 문구 화면).
//
//   실행(mobile 폴더에서): node scripts/shot-instructor-promo.mjs --out-dir <폴더> --class-a <강다온 수업 id> --class-b <문하율 수업 id> [--port 8098]
//   결과(<폴더> 안) — 보드 이름 그대로 7장:
//     I32.png   2 검토·고치기 — 만든 이미지 + 앱이 얹은 글자 · 소개 문구 초안 · 다시 만들기 · 남은 횟수
//     I32B.png  1 만들기 — 장르 칩 · 필수 4항목 칩 · 문장 · 자동 조건 · 엔진 카드 · 만들기 버튼
//     I32C.png  예시 보기 — 장르별 완성 문장 카드
//     I41.png   만들기 직전 확인 창 「1번 사용할까요?」
//     I43.png   막는 입력 — 만들기 요청이 422 로 막힌 뒤(횟수 그대로)
//     I32D.png  소개 문구 — 강조할 점 · 초안 · 그대로 가져온 값
//     I42.png   오늘 다 씀 — 만들기 잠김 · 내일 0시 안내 · 사진 올리기 · 「수업 등록은 그대로」
//
// 무엇을 보여 주나 — 개발 DB 의 진짜 데이터(가짜 응답 없음):
//   admin-web/scripts/dev-demo-promo-screen.ts 가 진짜 경로로 만든 두 강사의 임시 저장 수업.
//     A = 강다온 「바차타(입문) · 2월」 — 오늘 이미지 1장(+ 다른 수업 1장) · AI 소개 문구 초안 저장(검토 전)
//     B = 문하율 「살사(초급) · 2월」 — 오늘 이미지 3장(횟수 다 씀)
//   먼저: admin-web `KDANCE_DEV_ROUTES=true npm run dev -- --port 3000` · `./node_modules/.bin/jiti scripts/dev-demo-promo-screen.ts`
//
// 로그인: Node 에서 강사 아이디 로그인(POST /api/auth/sign-in/username, 출처 머리글 없음 — 앱과 같은 모양)으로 세션 토큰을 받고,
//   브라우저의 `/api/**` 요청(사진 /api/files/… 포함)에 `Authorization: Bearer` 만 붙여 진짜 서버로 보낸다. 응답 본문은 건드리지 않는다.
//   I41 에서는 「고치기」만 누르고, I43 의 「만들기」는 막는 입력이라 서버가 차감 전에 거부한다 — 이 스크립트는 횟수를 쓰지 않는다
//   (돌리기 전후 options 의 남은 횟수가 같은지 [check] 로 본다).
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
  process.env["E2E_CHROMIUM_PATH"] ?? join(homedir(), ".cache/ms-playwright/chromium-1247/chrome-linux64/chrome");

function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(readArg("port", "8098"));
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/instructor-promo")));
const baseUrl = `http://localhost:${port}`;
const API_BASE = readArg("api", "http://localhost:3000");
const CLASS_A = readArg("class-a", "");
const CLASS_B = readArg("class-b", "");
// 시연 강사 비밀번호 — dev-demo-record-approvals.ts 가 만든 시연 계정 값(개발 DB 전용)
const DEMO_PASSWORD = "Demo-pass-2026!";
const INSTRUCTOR_A = "haneulpmd82"; // 강다온
const INSTRUCTOR_B = "haneulp0wb1"; // 문하율
const BLOCKED_SENTENCE = "유명 아이돌 얼굴로 바차타를 추는 커플";

/** 강사 아이디 로그인 → 세션 토큰. Node fetch 는 브라우저 머리글을 붙여 출처 검사에 걸리므로 node:http 로 부른다 */
function signIn(username) {
  const body = JSON.stringify({ username, password: DEMO_PASSWORD });
  return new Promise((done, fail) => {
    const request = httpRequest(
      `${API_BASE}/api/auth/sign-in/username`,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (response) => {
        response.resume();
        const token = response.headers["set-auth-token"];
        if (response.statusCode === 200 && typeof token === "string" && token.length > 0) return done(token);
        fail(new Error(`${username} 로그인 실패(${response.statusCode}) — 강사 시연 데이터를 먼저 넣는다`));
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

/** 브라우저의 `/api/**` 를 진짜 서버로 — Bearer 만 붙이고, 이 Expo 웹 출처용 CORS 머리글 하나만 더한다 */
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

/**
 * 장면 저장. 앱 껍데기는 스크롤 칸이 화면 높이에 고정돼 fullPage 로는 아래가 잘린다 — 긴 장면은 창을 세로로 늘려 한 장에 담고 되돌린다.
 * height 를 주지 않으면 휴대폰 화면(390×844) 그대로 찍는다(확인 창처럼 겹쳐 뜨는 장면).
 */
async function shot(page, name, height = undefined) {
  if (height !== undefined) await page.setViewportSize({ width: VIEWPORT.width, height });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, name) });
  if (height !== undefined) await page.setViewportSize(VIEWPORT);
  console.log(`[shot] 저장: ${join(outDir, name)}`);
}

function check(ok, label) {
  console.log(`[check] ${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
}

const bodyText = (page) => page.evaluate(() => document.body.innerText);
/** 서버가 준 사진이 실제로 그려졌나(이미지 한 장 이상이 로드 완료 · 너비 > 0) */
const imageLoaded = (page) =>
  page.evaluate(() => [...document.images].some((img) => img.src.includes("/api/files/") && img.complete && img.naturalWidth > 0));

async function main() {
  if (CLASS_A === "" || CLASS_B === "") throw new Error("--class-a · --class-b 가 필요하다(dev-demo-promo-screen.ts 출력의 수업 id)");
  const { chromium } = createRequire(join(ADMIN_WEB_DIR, "package.json"))("@playwright/test");
  let server = null;
  if (!(await isUp(baseUrl))) {
    console.log(`[shot] expo start --web 을 띄운다(포트 ${port})`);
    server = startExpoWeb();
    await waitUntilUp(baseUrl, SERVER_TIMEOUT_MS);
  }
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  const pageErrors = [];
  try {
    mkdirSync(outDir, { recursive: true });
    const tokenA = await signIn(INSTRUCTOR_A);
    const tokenB = await signIn(INSTRUCTOR_B);
    const clsA = await apiGet(tokenA, `/api/classes/${CLASS_A}`);
    const before = await apiGet(tokenA, `/api/ai/promo-image/options?classId=${CLASS_A}`);
    const limit = before.usage.dailyLimit;
    console.log(`[shot] 실서버 ${API_BASE} · A ${clsA.title} · 남은 ${before.usage.remaining}/${limit} · 마지막 생성 ${before.lastGeneration?.status}`);

    // ================= 강사 A =================
    const logA = [];
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await attachToken(page, tokenA, logA);
    await page.goto(`${baseUrl}/instructor/classes/promo?classId=${CLASS_A}`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });

    // ---- I32 검토·고치기 ----
    await page.getByRole("button", { name: "검토 끝 · 수업 등록" }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.waitForFunction(() => [...document.images].some((img) => img.src.includes("/api/files/") && img.complete && img.naturalWidth > 0), null, { timeout: RENDER_TIMEOUT_MS });
    let text = await bodyText(page);
    const remain = before.usage.remaining;
    check(await imageLoaded(page), "만든 이미지(/api/files/…)가 실제로 그려졌다");
    check(text.includes(clsA.title) && text.includes("월·수 20:30–21:30") && text.includes("16회 · 300,000원"), "이미지 위 글자 = 수업 데이터(수업명 · 월·수 20:30–21:30 · 16회 · 300,000원)");
    check(text.includes("AI 생성 · 글자는 앱이 얹어요"), "배지 「AI 생성 · 글자는 앱이 얹어요」");
    check(text.includes(`다시 만들기 · 남은 횟수 ${remain}/${limit}`), `버튼 「다시 만들기 · 남은 횟수 ${remain}/${limit}」`);
    check(text.includes("처음 오는 분도 파트너 없이") && text.includes("AI 초안 · 고친 뒤에 수업과 함께 올라가요"), "소개 문구 초안(진짜 모델 초안) + AI 초안 안내");
    check(text.includes("커플") && text.includes("열정적인") && text.includes("빨간 조명") && text.includes("스튜디오"), "고른 필수 칩 네 개 표시");
    await shot(page, "I32.png", 1380);

    // ---- I32B 만들기 ----
    await page.getByRole("tab", { name: "1 만들기" }).click();
    await page.getByText("자동으로 더해지는 조건").waitFor({ timeout: RENDER_TIMEOUT_MS });
    text = await bodyText(page);
    check(text.includes("바차타 · 수업에서 가져왔어요"), "잠긴 장르 칩 「바차타 · 수업에서 가져왔어요」");
    check((await page.getByRole("radio", { name: "커플", checked: true }).count()) === 1 && (await page.getByRole("radio", { name: "빨간 조명", checked: true }).count()) === 1, "지난 생성의 칩이 골라진 채로 열림");
    check(text.includes("마주 선 커플 소셜댄스 자세") && text.includes("이미지 안에 글자 없음(끌 수 없어요)"), "자동 조건(장르 자세 · 글자 없음은 끌 수 없음)");
    check(text.includes("필수 4 / 4"), "필수 4 / 4");
    check(text.includes("FLUX.1 [schnell]") && text.includes("빠름 · 약 5초") && text.includes("지난번에 고른 엔진") && !text.includes("Sana Sprint"), "엔진 카드: 켜진 FLUX.1 [schnell] 하나만(로컬 3개 숨김) · 지난번 엔진");
    check(text.includes(`AI 이미지 만들기 · 남은 횟수 ${remain}/${limit}`), "만들기 버튼에 남은 횟수");
    // 칩을 바꾸면 문장이 다시 채워진다(덧붙인 글은 남김)
    await page.getByRole("radio", { name: "우아한" }).click();
    check((await page.getByLabel("원하는 이미지 문장").inputValue()).startsWith("커플이 스튜디오에서 빨간 조명 아래 우아하게 바차타를 추는 모습"), "칩 바꾸면 문장 다시 채움(우아하게)");
    await page.getByRole("radio", { name: "열정적인" }).click();
    await shot(page, "I32B.png", 1560);

    // ---- I32C 예시 보기 ----
    await page.getByRole("link", { name: "예시 보기 ›" }).click();
    await page.getByText("이 예시로 시작").first().waitFor({ timeout: RENDER_TIMEOUT_MS });
    text = await bodyText(page);
    check(text.indexOf("살사") < text.indexOf("아르헨티나 탱고") && text.includes("댄스스포츠 라틴"), "예시 3장 — 이 수업 장르(살사/바차타)가 맨 앞");
    check((await page.getByRole("button", { name: /예시로 시작$/ }).count()) === 3, "「이 예시로 시작」 3개");
    await shot(page, "I32C.png", 1100);

    // ---- I41 확인 창 ----
    await page.getByRole("button", { name: "아르헨티나 탱고 예시로 시작" }).click();
    await page.getByText("자동으로 더해지는 조건").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check((await page.getByLabel("원하는 이미지 문장").inputValue()).startsWith("커플이 파티 홀에서 따뜻한 노을빛"), "예시로 시작 → 문장 칸에 예시 문장");
    await page.getByRole("button", { name: new RegExp(`^AI 이미지 만들기 · 남은 횟수 ${remain}/${limit}`) }).click();
    await page.getByText("1번 사용할까요?").waitFor({ timeout: RENDER_TIMEOUT_MS });
    text = await bodyText(page);
    check(text.includes(`남은 횟수 ${remain}/${limit} → ${remain - 1}/${limit}`), `확인 창 「남은 횟수 ${remain}/${limit} → ${remain - 1}/${limit}」`);
    check(text.includes("만들다가 실패하면 횟수를 돌려드려요") && text.includes("다시 만들어도 1번으로 세요"), "실패하면 돌려줌 · 다시 만들어도 1번");
    await shot(page, "I41.png");
    await page.getByRole("button", { name: "고치기" }).click();
    await page.getByText("1번 사용할까요?").waitFor({ state: "hidden", timeout: RENDER_TIMEOUT_MS });

    // ---- I43 막는 입력 ----
    await page.getByLabel("원하는 이미지 문장").fill(BLOCKED_SENTENCE);
    await page.getByRole("button", { name: /^AI 이미지 만들기 · 남은 횟수/ }).click();
    await page.getByText("1번 사용할까요?").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByRole("button", { name: "만들기", exact: true }).click();
    await page.getByText("이 내용은 만들 수 없어요. 다른 표현으로 적어 주세요.").waitFor({ timeout: RENDER_TIMEOUT_MS });
    text = await bodyText(page);
    const posted = logA.filter((r) => r.method === "POST" && r.path === "/api/ai/promo-images");
    check(posted.length === 1 && posted[0].status === 422, `만들기 요청 1번 → 422(${posted.map((p) => p.status).join(",")})`);
    check(text.includes("실제 인물(유명 댄서·연예인)의 얼굴을 흉내 낸 그림은 만들 수 없어요."), "막힌 까닭 한 줄(서버 reason 그대로)");
    check(text.includes(`횟수는 그대로예요 · 남은 횟수 ${remain}/${limit}`), "횟수는 그대로");
    check(text.includes("만들 수 없는 내용") && text.includes("예시 단어로 바꿔 보세요") && text.includes("사진 올리기"), "만들 수 없는 내용 · 예시 단어 · 사진 올리기");
    await shot(page, "I43.png", 1180);
    const afterBlocked = await apiGet(tokenA, `/api/ai/promo-image/options?classId=${CLASS_A}`);
    check(afterBlocked.usage.remaining === remain && afterBlocked.lastGeneration?.generationId === before.lastGeneration?.generationId, `서버 기준 남은 횟수 ${afterBlocked.usage.remaining} = 전 ${remain}, 새 생성 없음`);

    // ---- I32D 소개 문구 ----
    await page.getByRole("tab", { name: "2 검토·고치기" }).click();
    await page.getByRole("link", { name: "고치기 ›" }).click();
    await page.getByText("이 수업에서 강조할 점").waitFor({ timeout: RENDER_TIMEOUT_MS });
    text = await bodyText(page);
    check((await page.getByLabel("소개 문구").inputValue()).includes("월·수 20:30–21:30 · 16회 · 300,000원"), "초안 본문에 수업 데이터 값 그대로(월·수 20:30–21:30 · 16회 · 300,000원)");
    check(["월·수 20:30–21:30", "16회", "300,000원", "입문"].every((f) => text.includes(f)), "그대로 가져온 값 칩 4개");
    const emphasis = "처음 오는 분도 파트너 없이 신청할 수 있어요";
    await page.getByLabel("이 수업에서 강조할 점").fill(emphasis);
    check((await bodyText(page)).includes(`${emphasis.length} / 60`), `강조할 점 글자 수 ${emphasis.length} / 60`);
    await shot(page, "I32D.png", 1000);
    await page.close();

    // ================= 강사 B — 오늘 다 씀 =================
    const logB = [];
    const pageB = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    pageB.on("pageerror", (error) => pageErrors.push(error.message));
    await attachToken(pageB, tokenB, logB);
    const optB = await apiGet(tokenB, `/api/ai/promo-image/options?classId=${CLASS_B}`);
    check(optB.usage.remaining === 0, `B 의 서버 기준 남은 횟수 0(${optB.usage.used}/${optB.usage.dailyLimit} 씀)`);
    await pageB.goto(`${baseUrl}/instructor/classes/promo?classId=${CLASS_B}`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await pageB.getByRole("button", { name: "검토 끝 · 수업 등록" }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    await pageB.waitForFunction(() => [...document.images].some((img) => img.src.includes("/api/files/") && img.complete && img.naturalWidth > 0), null, { timeout: RENDER_TIMEOUT_MS });
    text = await bodyText(pageB);
    const locked = pageB.getByRole("button", { name: `AI 이미지 만들기 · 남은 횟수 0/${limit} ${"○".repeat(limit)}` });
    check((await locked.count()) === 1 && (await locked.isDisabled()), `잠긴 버튼 「AI 이미지 만들기 · 남은 횟수 0/${limit} ○○○」`);
    check(text.includes(`오늘은 모두 사용했어요 · 내일 0시에 다시 ${limit}번 쓸 수 있어요`), "내일 0시 안내");
    check(text.includes("오늘 마지막으로 만든 이미지") && text.includes("살사(초급) · 2월") && text.includes("화·목 20:00–21:00"), "오늘 마지막 이미지 + 수업 데이터 글자");
    check(text.includes("수업 등록은 그대로 할 수 있어요") && !(await pageB.getByRole("button", { name: "검토 끝 · 수업 등록" }).isDisabled()), "수업 등록은 막지 않음");
    await shot(pageB, "I42.png", 1250);
    // 사진 올리기 — 앱에 사진 고르기 패키지가 아직 없어 안내만(서버 호출 없음)
    await pageB.getByRole("button", { name: "사진 올리기" }).click();
    check((await bodyText(pageB)).includes("사진 고르기는 곧 열려요"), "사진 올리기 → 안내(설치 승인 전)");
    await pageB.close();

    const all = [...logA, ...logB];
    console.log(`[shot] 화면이 부른 실서버 API(Bearer 만 붙임):\n  ${all.map((r) => `${r.method} ${r.path}${r.search} → ${r.status}`).join("\n  ")}`);
    check(all.filter((r) => r.method === "PUT" || (r.method === "POST" && r.path !== "/api/ai/promo-images")).length === 0, "촬영 중 저장·등록 요청 없음(시연 데이터 그대로)");
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
