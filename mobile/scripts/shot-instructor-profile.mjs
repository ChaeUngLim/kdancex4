// 강사 프로필 고치기(I40) · 개인 일정 넣기(I36) 화면을 Expo 웹으로 띄워 장면을 찍는다
// — 로드맵 S2-1.11(앱 프로필 고치기·개인 일정 화면).
//
//   실행(mobile 폴더에서): node scripts/shot-instructor-profile.mjs --out-dir <폴더> [--port 8096]
//   결과(<폴더> 안):
//     I9-입구.png           마이의 「강사 소개 · 프로필」·「개인 일정 넣기」 줄이 눌리는 상태(준비 중 배지 없음)
//     I40.png               불러온 프로필(경력 10년 · 강남구·서초구 · 자격·대회 · 소개 글 · 종목 안내 · 저장 버튼). 소개 영상 줄 없음
//     I40-자격-추가.png      「+ 자격 추가」로 입력칸이 열리고 새 자격을 적는 중
//     I40-저장.png          새 자격·송파구를 넣고 대회 하나를 뺀 뒤 저장 → 「저장했어요」(PUT 본문 대조)
//     I40-경력-오류.png      경력에 81 → 빨간 안내 + 저장 꺼짐
//     I36.png               개인 일정 시트: 개인 연습 · 11/12 (목) · 14:00–16:00 · 매주 목 · 「나만 봐요」 · 넣기 켜짐
//     I36-시간-오류.png      14:05 → 「10분 단위」 안내 + 넣기 꺼짐
//     I36-넣은-뒤.png        넣은 일정 카드(시각 · 반복 · 서버가 알린 겹침) + 「지우기」(POST 본문 대조: KST → UTC Z)
//     I36-지운-뒤.png        「지우기」 → DELETE 경로 → 카드가 사라짐
//
// 왜 서버 응답을 꾸며 넣나(shot-instructor-affiliation.mjs 와 같은 이유): 웹 실행에는 SecureStore 가 없어 로그인 토큰을
//   저장할 수 없다. 그래서 `/api/**` 를 가로채 계약 11 §2-1·§2-3 모양의 예시를 돌려주고 화면은 주소로 바로 연다.
//   서버 동작은 S2-1.6 의 DB 테스트(instructor-profile.db.test.ts)가 확인했다. 화면이 보낸 본문이 기대와 다르면 exit 1.
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

const port = Number(readArg("port", "8096"));
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/instructor-profile")));
const baseUrl = `http://localhost:${port}`;

// ---- 예시 응답. 이름·학원·문구는 보드 I40·I36 예시 ----
const LATIN = "11111111-1111-4111-8111-111111111111";
const SEOCHO = "44444444-4444-4444-8444-444444444444";
const ACCOUNT = "66666666-6666-4666-8666-666666666666";
const PHOTO = "77777777-7777-4777-8777-777777777777";
const EVENT_ID = "88888888-8888-4888-8888-888888888888";
const PROFILE = {
  accountId: ACCOUNT,
  displayName: "이준호",
  activityGenre: "dance_sport",
  photo: { fileId: PHOTO, url: `/api/files/${PHOTO}` },
  careerYears: 10,
  regions: [{ sido: "서울", gu: "강남구" }, { sido: "서울", gu: "서초구" }],
  qualifications: ["댄스스포츠 지도자 2급"],
  competitions: ["2025 서울 오픈 라틴 프로 4위"],
  bio: "라틴 10년, 대회 심사 경력이 있어요. 기본 스텝을 몸에 붙이는 수업을 해요.",
  disciplines: ["rumba", "samba", "waltz"],
  businessRegistration: { number: null, hasEvidence: false },
  affiliations: [
    { academyId: LATIN, name: "라틴하우스 강남", status: "active" },
    { academyId: SEOCHO, name: "라틴스텝 서초", status: "active" },
  ],
};

/** `/api/**` 를 계약 모양 예시로 답한다. PUT 은 받은 칸을 그대로 반영한 프로필을 돌려준다(서버와 같은 전체 교체) */
async function installApiMock(page, log, sent, state) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    log.push(`${method} ${path}${url.search}`);
    const json = (status, body) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "access-control-allow-origin": "*" } });
    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE" } });
    }
    if (method === "GET" && path === "/api/instructor/me/profile") return json(200, state.profile);
    if (method === "PUT" && path === "/api/instructor/me/profile") {
      const body = request.postDataJSON();
      sent.push({ kind: "profile", body });
      state.profile = {
        ...state.profile,
        careerYears: body.careerYears,
        regions: body.regions,
        qualifications: body.qualifications,
        competitions: body.competitions,
        bio: body.bio,
        photo: body.photoFileId === null ? null : { fileId: body.photoFileId, url: `/api/files/${body.photoFileId}` },
      };
      return json(200, state.profile);
    }
    if (method === "POST" && path === "/api/instructor/personal-events") {
      const body = request.postDataJSON();
      sent.push({ kind: "event", body });
      // 11 §2-3 예시처럼 수업 하나와 60분 겹친다고 알린다(막지 않고 저장)
      return json(201, { eventId: EVENT_ID, ...body, overlaps: [{ kind: "class_session", label: "쌈바(입문)", overlapMinutes: 60 }] });
    }
    const deleteMatch = /^\/api\/instructor\/personal-events\/([^/]+)$/.exec(path);
    if (method === "DELETE" && deleteMatch) {
      sent.push({ kind: "delete", id: deleteMatch[1] });
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
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

/** 화면이 보낸 본문 중 kind 가 같은 마지막 것이 기대와 같은지 */
function expectSent(sent, kind, expected) {
  const last = [...sent].reverse().find((item) => item.kind === kind) ?? null;
  const actual = JSON.stringify(last?.body ?? null);
  check(actual === JSON.stringify(expected), `보낸 본문(${kind}): ${actual}`);
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
  const sent = [];
  const state = { profile: PROFILE };
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installApiMock(page, apiLog, sent, state);
    mkdirSync(outDir, { recursive: true });
    const text = () => page.evaluate(() => document.body.innerText);

    // ---- I9 입구 ----
    await page.goto(`${baseUrl}/instructor/my`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    const profileRow = page.getByRole("button", { name: "강사 소개 · 프로필", exact: true });
    await profileRow.waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(!(await profileRow.isDisabled()), "마이 「강사 소개 · 프로필」 줄이 눌림");
    check(!(await page.getByRole("button", { name: "개인 일정 넣기", exact: true }).isDisabled()), "마이 「개인 일정 넣기」 줄이 눌림");
    await page.getByRole("button", { name: "개인 일정 넣기", exact: true }).scrollIntoViewIfNeeded();
    await shot(page, "I9-입구.png");

    // ---- I40 프로필 고치기 ----
    await profileRow.click();
    await page.waitForURL(/\/instructor\/profile$/, { timeout: RENDER_TIMEOUT_MS });
    await page.getByText("프로필 고치기").first().waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByLabel("소개 글").waitFor({ timeout: RENDER_TIMEOUT_MS });
    let body = await text();
    check(body.includes("이준호 강사") && body.includes("댄스스포츠 · 가입 때 고른 장르"), "이름 · 활동 장르(보기만)");
    check((await page.getByLabel("경력(년)").inputValue()) === "10", "경력 칸 10");
    check(body.includes("강남구") && body.includes("서초구"), "활동 지역 칩 강남구·서초구");
    check(body.includes("댄스스포츠 지도자 2급") && body.includes("2025 서울 오픈 라틴 프로 4위"), "자격·대회 줄");
    check(body.includes("수업 종목(룸바·쌈바·왈츠)은 내가 연 수업에서 저절로 보여요."), "종목 안내 = 보드 문구");
    check(body.includes(`${PROFILE.bio.length} / 500`), "소개 글 글자 수");
    check(!body.includes("소개 영상") && !body.includes("초상"), "소개 영상·초상 동의 줄 없음(열린 점 ⑥)");
    check(!(await page.getByRole("button", { name: "저장 · 회원 화면에 바로 반영" }).isDisabled()), "저장 버튼 켜짐");
    await shot(page, "I40.png");

    // 자격 하나 추가 · 지역 하나 추가 · 대회 빼기
    await page.getByRole("button", { name: "자격 추가" }).click();
    await page.getByLabel("자격 이름").fill("WDSF 심판 자격");
    await shot(page, "I40-자격-추가.png");
    await page.getByRole("button", { name: "자격 넣기" }).click();
    await page.getByRole("button", { name: "활동 지역 추가" }).click();
    await page.getByLabel("구", { exact: true }).fill("송파구");
    await page.getByRole("button", { name: "지역 넣기" }).click();
    await page.getByRole("button", { name: "2025 서울 오픈 라틴 프로 4위 빼기" }).click();
    await page.getByRole("button", { name: "저장 · 회원 화면에 바로 반영" }).click();
    await page.getByText("저장했어요. 회원 화면의 강사 프로필에 바로 보여요.").waitFor({ timeout: RENDER_TIMEOUT_MS });
    expectSent(sent, "profile", {
      photoFileId: PHOTO,
      careerYears: 10,
      regions: [{ sido: "서울", gu: "강남구" }, { sido: "서울", gu: "서초구" }, { sido: "서울", gu: "송파구" }],
      qualifications: ["댄스스포츠 지도자 2급", "WDSF 심판 자격"],
      competitions: [],
      bio: PROFILE.bio,
    });
    body = await text();
    check(body.includes("WDSF 심판 자격") && body.includes("송파구") && !body.includes("2025 서울 오픈"), "저장 뒤 칸 = 서버가 돌려준 값");
    await shot(page, "I40-저장.png");

    await page.getByLabel("경력(년)").fill("81");
    await page.getByText("경력은 0~80 사이 숫자로 적어 주세요.").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(await page.getByRole("button", { name: "저장 · 회원 화면에 바로 반영" }).isDisabled(), "경력 81 → 저장 꺼짐");
    await page.getByLabel("경력(년)").scrollIntoViewIfNeeded();
    await shot(page, "I40-경력-오류.png");

    // ---- I36 개인 일정 ----
    await page.goto(`${baseUrl}/instructor/personal-event?date=2026-11-12`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("개인 일정 넣기").first().waitFor({ timeout: RENDER_TIMEOUT_MS });
    const submit = page.getByRole("button", { name: "개인 일정 넣기" });
    check(await submit.isDisabled(), "빈 칸이면 넣기 꺼짐");
    await page.getByLabel("제목").fill("개인 연습");
    await page.getByLabel("시작 시간").fill("14:00");
    await page.getByLabel("끝 시간").fill("16:00");
    await page.getByRole("radio", { name: "매주 목" }).click();
    body = await text();
    check(body.includes("11/12 (목)"), "날짜 칸 11/12 (목)(주소 ?date=)");
    check(body.includes("학원 시간표와 대표 캘린더에는 제목 없이 「불가 시간」으로만 보여요."), "「나만 봐요」 — 학원에는 불가 시간으로만");
    check(!(await submit.isDisabled()), "제목·시간을 채우면 넣기 켜짐");
    await shot(page, "I36.png");

    await page.getByLabel("시작 시간").fill("14:05");
    await page.getByText("시간은 10분 단위로 적어 주세요.").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(await submit.isDisabled(), "14:05 → 넣기 꺼짐");
    await shot(page, "I36-시간-오류.png");
    await page.getByLabel("시작 시간").fill("14:00");

    await submit.click();
    await page.getByText("넣은 개인 일정 1개").waitFor({ timeout: RENDER_TIMEOUT_MS });
    expectSent(sent, "event", { title: "개인 연습", startsAt: "2026-11-12T05:00:00.000Z", endsAt: "2026-11-12T07:00:00.000Z", repeat: "weekly" });
    body = await text();
    check(body.includes("11/12 (목) 14:00–16:00 · 반복 매주 목"), "넣은 카드 시각은 다시 한국 시각으로");
    check(body.includes("쌈바(입문)과 60분 겹쳐요"), "서버가 알린 겹침을 보여 줌(막지 않음)");
    check((await page.getByLabel("제목").inputValue()) === "", "넣은 뒤 제목 칸 비움");
    await page.getByText("넣은 개인 일정 1개").scrollIntoViewIfNeeded();
    await shot(page, "I36-넣은-뒤.png");

    await page.getByRole("button", { name: "개인 연습 지우기" }).click();
    await page.getByText("넣은 개인 일정 1개").waitFor({ state: "detached", timeout: RENDER_TIMEOUT_MS });
    check(sent.some((item) => item.kind === "delete" && item.id === EVENT_ID), "「지우기」 → DELETE /api/instructor/personal-events/{eventId}");
    await shot(page, "I36-지운-뒤.png");

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
