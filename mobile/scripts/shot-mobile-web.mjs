// 모바일 앱을 Expo 웹으로 띄워 첫 화면 스크린샷을 찍는다(로드맵 S1-0.2(모바일 Expo 웹 스크린샷 경로 확인)).
//
//   실행(mobile 폴더에서): node scripts/shot-mobile-web.mjs [--out <png 경로>] [--path /login] [--port 8081]
//
// 왜 따로 스크립트를 두나:
//   모바일 화면 Task 도 관리자 웹처럼 "브라우저로 열어 찍은 사진" 을 증거로 남겨야 한다.
//   mobile 에는 Playwright 를 새로 넣지 않고, S1-0.1(관리자 웹 E2E 테스트 도구 준비)이
//   admin-web 에 넣은 Playwright 를 빌려 쓴다 — 같은 도구를 두 번 깔면 버전이 어긋나기 쉽다.
//
// 흐름: ① 웹 서버가 이미 떠 있으면 그대로 쓰고, 없으면 `expo start --web` 을 직접 띄운다
//       ② 첫 화면이 그려질 때까지 기다린다 ③ 390×844(모바일 기준 크기)로 찍는다 ④ 직접 띄운 서버는 끈다
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_WEB_DIR = resolve(MOBILE_DIR, "../admin-web");

// 모바일 스크린샷 기준 크기(leave-verifiable-evidence 규칙: 모바일 390×844)
const VIEWPORT = { width: 390, height: 844 };
// Metro 가 처음 번들을 만드는 데 시간이 걸려서 서버 기동·첫 화면 대기를 넉넉히 준다.
const SERVER_TIMEOUT_MS = 180_000;
const RENDER_TIMEOUT_MS = 90_000;

// S1-0.1 과 같은 Chromium(chromium-1247)을 쓴다. 다른 PC 는 E2E_CHROMIUM_PATH 로 바꾼다.
const CHROMIUM_PATH =
  process.env["E2E_CHROMIUM_PATH"] ??
  join(homedir(), ".cache/ms-playwright/chromium-1247/chrome-linux64/chrome");

/** `--이름 값` 꼴의 인자를 읽는다. 없으면 기본값. */
function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(readArg("port", "8081"));
const routePath = readArg("path", "/");
const outPath = resolve(readArg("out", join(MOBILE_DIR, "shots/mobile-first.png")));
const baseUrl = `http://localhost:${port}`;

/** 서버가 응답하면 true. 연결이 안 되면 false(아직 안 뜬 것). */
async function isUp(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

/** 서버가 뜰 때까지 1초마다 확인한다. 시간이 넘으면 실패로 멈춘다. */
async function waitUntilUp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(url)) return;
    await new Promise((done) => setTimeout(done, 1_000));
  }
  throw new Error(`Expo 웹 서버가 ${timeoutMs / 1000}초 안에 뜨지 않았다: ${url}`);
}

/** `expo start --web` 을 띄운다. CI=1 은 대화형 질문(포트 바꿀까요 등) 없이 돌게 한다. */
function startExpoWeb() {
  const expoBin = join(MOBILE_DIR, "node_modules/.bin/expo");
  const child = spawn(expoBin, ["start", "--web", "--port", String(port)], {
    cwd: MOBILE_DIR,
    env: { ...process.env, CI: "1", BROWSER: "none" },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true, // 끌 때 Metro 자식 프로세스까지 한 번에 끄려고 프로세스 묶음을 따로 만든다
  });
  return child;
}

/** 직접 띄운 서버를 프로세스 묶음째 끈다. */
function stopExpoWeb(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // 이미 끝났으면 할 일이 없다
  }
}

async function main() {
  // admin-web 의 Playwright 를 빌려 온다(mobile 에는 설치하지 않는다).
  const requireFromAdminWeb = createRequire(join(ADMIN_WEB_DIR, "package.json"));
  const { chromium } = requireFromAdminWeb("@playwright/test");

  let server = null;
  if (await isUp(baseUrl)) {
    console.log(`[shot] 이미 떠 있는 서버를 쓴다: ${baseUrl}`);
  } else {
    console.log(`[shot] expo start --web 을 띄운다(포트 ${port})`);
    server = startExpoWeb();
    await waitUntilUp(baseUrl, SERVER_TIMEOUT_MS);
  }

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(`${baseUrl}${routePath}`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    // expo-router 는 #root 안에 화면을 그린다. 글자가 생길 때까지 기다려야 빈 흰 화면을 찍지 않는다.
    await page.waitForFunction(
      () => (document.getElementById("root")?.innerText ?? "").trim().length > 0,
      undefined,
      { timeout: RENDER_TIMEOUT_MS },
    );
    // 진입 화면(`/`)은 로그인 여부를 확인한 뒤 다른 화면으로 넘어간다 — 넘어간 결과까지 기다린다.
    await page.waitForLoadState("networkidle", { timeout: RENDER_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(1_000);

    mkdirSync(dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath });
    console.log(`[shot] 주소: ${page.url()}`);
    console.log(`[shot] 저장: ${outPath}`);
    if (pageErrors.length > 0) {
      console.log(`[shot] 화면 오류 ${pageErrors.length}건:\n  ${pageErrors.join("\n  ")}`);
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
