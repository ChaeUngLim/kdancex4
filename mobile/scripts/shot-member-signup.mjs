// 회원 가입 흐름(보드 M1 로그인 → C14A 약관 동의 → M2 본인확인 → M3 가입 정보)을 Expo 웹으로 띄워
// 장면마다 찍고, 가입 요청 본문을 파일로 남긴다 — 로드맵 S3-1.8(앱 가입·동의·취향 화면 보정).
//
//   실행(mobile 폴더에서): node scripts/shot-member-signup.mjs --out-dir <폴더> [--port 8093]
//   결과(<폴더>): M1.png · C14A.png · C14A-checked.png · M2.png · M3-nickname-empty.png · M3.png
//                 · after-signup.png · signup-request.json(가로챈 POST /api/members 본문)
//
// 왜 서버 응답을 브라우저에서 꾸며 넣나:
//   웹 실행에서 실제 서버로 가입하면 가짜 본인확인 키·시드 계정·DB 가 다 맞아야 하고, 한 번 가입하면
//   같은 사람으로 다시 찍을 수 없다. 이 스크립트는 화면이 계약 01 모양의 응답을 받았을 때 어떻게 그려지고
//   무엇을 보내는지를 보려는 것이라 Playwright 의 page.route 로 `/api/**` 를 가로채 계약 모양 예시로 답한다.
//   서버 쪽 동작(닉네임·동의 검사)은 S3-1.2 의 DB 테스트가 맡는다.
//
// 흐름은 shot-mobile-web.mjs(S1-0.2)와 같다: 서버 기동 → 390×844 로 열기 → 찍기 → 직접 띄운 서버 끄기.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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

const port = Number(readArg("port", "8093"));
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/member-signup")));
const baseUrl = `http://localhost:${port}`;

// ---- 예시 응답(계약 01 모양 그대로). 실제 개인정보·비밀값은 없다 ----
const FAKE_TOKEN = "example-verification-token";
const MEMBER = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "김서연",
  nickname: "서연",
  gender: "female",
  birthDate: "1998-05-14",
  phoneMasked: "010-****-3390",
  profile: { interestGenres: [], regions: [], availableFrom: null, availableTo: null, experienceLevel: null },
  baseGenre: null,
  onboarding: { profileDone: false, baseGenreDone: false },
};

/** `/api/**` 를 계약 모양 예시로 답한다. 가입 요청 본문은 captured 에 담는다 */
async function installApiMock(page, log, captured) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    log.push(`${request.method()} ${path}`);
    const json = (status, body) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "access-control-allow-origin": "*" } });
    if (request.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT" } });
    }
    if (request.method() === "POST" && path === "/api/auth/sign-in/email") return json(200, { token: "example-session-token" });
    // 가입 전에는 403 — 로그인 화면이 약관 동의로 보내는지 본다. 가입 뒤에는 회원 정보(취향 화면이 읽는다)
    if (request.method() === "GET" && path === "/api/me") {
      return captured.length === 0 ? json(403, { detail: "가입을 먼저 마쳐 주세요.", code: "SIGNUP_INCOMPLETE" }) : json(200, MEMBER);
    }
    if (request.method() === "POST" && path === "/api/dev/identity/fake-verify") {
      return json(200, { verificationToken: FAKE_TOKEN, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    }
    if (request.method() === "POST" && path === "/api/members") {
      captured.push(request.postDataJSON());
      return json(201, MEMBER);
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
  const path = join(outDir, name);
  await page.screenshot({ path });
  console.log(`[shot] 저장: ${path} (주소 ${new URL(page.url()).pathname})`);
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
  const captured = [];
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installApiMock(page, apiLog, captured);
    mkdirSync(outDir, { recursive: true });

    // 장면 M1 — 로그인
    await page.goto(`${baseUrl}/login`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByLabel("이메일").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await shot(page, "M1.png");

    // 로그인 → /api/me 403 → 약관 동의(C14A)
    await page.getByLabel("이메일").fill("member@example.com");
    await page.getByLabel("비밀번호").fill("example-password");
    await page.getByRole("button", { name: "로그인" }).click();
    await page.getByText("시작하기 전에 동의해 주세요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await shot(page, "C14A.png");

    // 필수 넷 + 광고성 알림만 체크(위치 정보는 끈 채로 — 선택 동의가 따로 실리는지 본다)
    for (const label of ["[필수] 이용약관", "[필수] 개인정보 수집·이용", "[필수] 학원에 개인정보 제공", "[필수] 만 19세 이상이에요", "[선택] 광고성 알림 받기"]) {
      await page.getByRole("checkbox", { name: label }).click();
    }
    await shot(page, "C14A-checked.png");

    // 장면 M2 — 본인확인(가짜)
    await page.getByRole("button", { name: "동의하고 본인확인으로" }).click();
    await page.getByLabel("이름").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByLabel("이름").fill("김서연");
    await page.getByLabel("생년월일").fill("1998-05-14");
    await page.getByLabel("휴대폰 번호").fill("01048213390");
    await page.getByLabel("시험용 사람 키").fill("seed-member-shot");
    await shot(page, "M2.png");

    // 장면 M3 — 가입 정보. 닉네임을 비운 채 누르면 막히는지 먼저 본다
    await page.getByRole("button", { name: "다음 · 가입 정보" }).click();
    await page.getByText("가입 정보를 확인해요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByRole("button", { name: "다음 · 관심 장르" }).click();
    await page.getByText("닉네임을 적어 주세요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await shot(page, "M3-nickname-empty.png");
    if (captured.length !== 0) throw new Error("닉네임이 비었는데 가입 요청이 나갔다");

    await page.getByLabel("닉네임").fill("서연");
    await shot(page, "M3.png");

    // 가입 → 요청 본문을 남기고 다음 화면(취향)으로 넘어가는지 본다
    await page.getByRole("button", { name: "다음 · 관심 장르" }).click();
    await page.waitForURL(/\/preferences/, { timeout: RENDER_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: RENDER_TIMEOUT_MS }).catch(() => {});
    if (!new URL(page.url()).pathname.startsWith("/preferences")) throw new Error(`가입 뒤 취향 화면에 머물지 않았다: ${page.url()}`);
    await shot(page, "after-signup.png");

    if (captured.length !== 1) throw new Error(`가입 요청이 ${captured.length}건 — 1건이어야 한다`);
    writeFileSync(join(outDir, "signup-request.json"), `${JSON.stringify(captured[0], null, 2)}\n`);
    console.log(`[shot] 가입 요청 본문:\n${JSON.stringify(captured[0], null, 2)}`);
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
