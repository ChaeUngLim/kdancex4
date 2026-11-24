// 강사·대표 앱 로그인(M1B·M1C) · 강사 학원 탭(I12) · 강사 마이(I9) · 강사 가입(I31C·I31) 화면을 Expo 웹으로 띄워 장면을 찍는다
// — 로드맵 S2-1.7(앱 강사 가입·소속·프로필 화면).
//
//   실행(mobile 폴더에서): node scripts/shot-instructor.mjs --out-dir <폴더> [--port 8094]
//   결과(<폴더> 안):
//     M1B.png              강사·대표 로그인 첫 화면(강사 탭)
//     M1B-로그인-실패.png  틀린 비밀번호 → 「아이디 또는 비밀번호가 맞지 않아요.」
//     M1C.png              대표 탭(가입 버튼·안내 줄이 바뀜)
//     I12.png              학원 탭 — 라틴하우스 강남(소속됨) · 카드 · 시간표/내 수업 준비 중 · 공지 2건
//     I12-승인-대기.png    「스윙팩토리 홍대 · 승인 대기」 칩을 고른 상태
//     I9.png               마이 — 프로필 줄(이준호 강사 · 라틴하우스 강남 외 1)과 줄 목록
//     I31C.png             강사 가입 1/2 본인확인
//     I31C-이미-가입.png   이미 강사 계정이 있는 사람 → 409 문구 + 로그인 버튼
//     I31-위.png           강사 가입 2/2 위쪽 — 중복 확인 통과·비밀번호 일치·이름
//     I31.png              강사 가입 2/2 아래쪽 — 장르 하나·필수 동의까지 채워 「가입하고 시작」이 켜진 상태
//
// 왜 서버 응답을 브라우저에서 꾸며 넣나(shot-owner-instructors.mjs 와 같은 이유):
//   웹 실행에는 SecureStore 가 없어 로그인 토큰을 저장할 수 없다(lib/session.ts) — 로그인 성공 뒤 화면은 웹에서 이어지지 않는다.
//   그래서 page.route 로 `/api/**` 를 가로채 계약(README §6-1 · 08 §2 · 09 §3 · 11 §1·§2-1) 모양의 예시 응답을 돌려주고,
//   학원 탭·마이는 주소로 바로 연다. 서버 쪽 동작(가입·로그인·프로필·소속·공지)은 S2-1.2~S2-1.6·S1-4.4 의 DB 테스트가 확인했다.
//   화면이 서버에 보낸 본문은 로그에 남기고, 기대와 다르면 exit 1 로 끝낸다.
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
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/instructor")));
const baseUrl = `http://localhost:${port}`;

// ---- 예시 응답. 이름·학원은 보드 I9·I12 예시, 연락처는 가린 값 ----
const LATIN = "11111111-1111-4111-8111-111111111111";
const SALSA = "22222222-2222-4222-8222-222222222222";
const SWING = "33333333-3333-4333-8333-333333333333";
const BALLROOM = "44444444-4444-4444-8444-444444444444";
const ACCOUNT = "66666666-6666-4666-8666-666666666666";
const STAFF_ME = {
  accountId: ACCOUNT,
  displayName: "이준호",
  roles: ["instructor"],
  secondFactorVerified: false,
  consoleAccess: false,
  academies: [{ academyId: LATIN, name: "라틴하우스 강남", as: "delegate", permissions: ["class_submit"], menus: [] }],
  platformMenus: [],
};
const card = (n, academyId, academyName, status, extra = {}) => ({
  affiliationId: `55555555-5555-4555-8555-55555555555${n}`,
  academyId,
  academyName,
  status,
  source: "application",
  requestedAt: `2026-10-0${n}T01:00:00.000000Z`,
  decidedAt: status === "pending" ? null : `2026-10-0${n}T05:00:00.000000Z`,
  rejectReasonCode: null,
  rejectReasonText: null,
  releasedAt: null,
  // 앱 수업 등록 권한 — 2026-11-23 부터 소속 카드의 canSubmitClass 로 읽는다(staff/me 는 웹 위임만). 라틴하우스 강남만 켜져 있다
  canSubmitClass: status === "active" && academyId === LATIN,
  ...extra,
});
// 학원마다 가장 최근 행 하나(08 §2). 거절된 학원은 칩에 나오지 않아야 한다
const AFFILIATIONS = {
  items: [
    card(4, SWING, "스윙팩토리 홍대", "pending"),
    card(3, BALLROOM, "볼룸스튜디오 강남", "rejected", { rejectReasonCode: "genre_mismatch" }),
    card(2, LATIN, "라틴하우스 강남", "active"),
    card(1, SALSA, "살사클럽 홍대", "active"),
  ],
};
const NOTICES = {
  [LATIN]: [
    { noticeId: "77777777-7777-4777-8777-777777777771", academyId: LATIN, academyName: "라틴하우스 강남", category: "class_cancelled", title: "10월 9일(목) 한글날 전체 휴강", body: "한글날은 모든 수업을 쉬어요.", publishedAt: "2026-10-02T01:00:00.000000Z", readAt: null },
    { noticeId: "77777777-7777-4777-8777-777777777772", academyId: LATIN, academyName: "라틴하우스 강남", category: "class_changed", title: "B홀 바닥 공사 10/20~22 · A홀로 옮겨요", body: "공사 기간에는 A홀에서 해요.", publishedAt: "2026-10-08T01:00:00.000000Z", readAt: "2026-10-08T03:00:00.000000Z" },
  ],
  [SALSA]: [],
};
const PROFILE = {
  accountId: ACCOUNT,
  displayName: "이준호",
  activityGenre: "dance_sport",
  photo: null,
  careerYears: 10,
  regions: [{ sido: "서울", gu: "강남구" }],
  qualifications: ["댄스스포츠 지도자 2급"],
  competitions: [],
  bio: "라틴 10년, 대회 심사 경력이 있어요.",
  disciplines: [],
  businessRegistration: { number: null, hasEvidence: false },
  affiliations: [
    { academyId: LATIN, name: "라틴하우스 강남", status: "active" },
    { academyId: SALSA, name: "살사클럽 홍대", status: "active" },
    { academyId: SWING, name: "스윙팩토리 홍대", status: "pending" },
  ],
};
const VERIFY_TOKEN = "fake-verification-token-예시";

/** `/api/**` 를 계약 모양 예시로 답한다. mode 로 본인확인 결과를 바꾼다 */
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
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT" } });
    }
    if (method === "POST" && path === "/api/auth/sign-in/username") {
      sent.push({ kind: "sign-in", body: request.postDataJSON() });
      // Better Auth 가 틀린 아이디·비밀번호에 주는 401(우리 오류 모양이 아니다)
      return json(401, { code: "INVALID_USERNAME_OR_PASSWORD", message: "Invalid username or password" });
    }
    if (method === "POST" && path === "/api/auth/sign-out") {
      sent.push({ kind: "sign-out" });
      return json(200, { success: true });
    }
    if (method === "GET" && path === "/api/staff/me") return json(200, STAFF_ME);
    if (method === "GET" && path === "/api/instructor/affiliations") return json(200, AFFILIATIONS);
    if (method === "GET" && path === "/api/instructor/staff-notices") {
      const academyId = url.searchParams.get("academyId");
      return json(200, { items: (NOTICES[academyId] ?? []).slice(0, Number(url.searchParams.get("limit") ?? 20)), nextCursor: null });
    }
    if (method === "GET" && path === "/api/instructor/me/profile") return json(200, PROFILE);
    if (method === "POST" && path === "/api/dev/identity/fake-verify") {
      sent.push({ kind: "fake-verify", body: request.postDataJSON() });
      return json(200, { verificationToken: VERIFY_TOKEN, expiresAt: "2026-11-21T10:10:00.000Z" });
    }
    if (method === "POST" && path === "/api/instructor/signup/identity-check") {
      sent.push({ kind: "identity-check", body: request.postDataJSON() });
      if (state.identity === "already") {
        return json(409, { detail: "이미 가입한 강사예요. 그 아이디로 로그인해 주세요", code: "INSTRUCTOR_ALREADY_REGISTERED", maskedUsername: "jun***tin", hasInstructorRole: true });
      }
      return json(200, { eligible: true, nameMasked: "이*호", phoneMasked: "010-****-5821", ageVerified: true });
    }
    if (method === "GET" && path === "/api/instructor/signup/username-available") {
      const name = url.searchParams.get("username");
      return json(200, name === "taken01" ? { available: false, reason: "taken" } : { available: true });
    }
    if (method === "POST" && path === "/api/instructor/signup") {
      const body = request.postDataJSON();
      sent.push({ kind: "signup", body });
      return json(201, { accountId: ACCOUNT, username: body.username, displayName: body.displayName, activityGenre: body.activityGenre, roles: ["instructor"], membership: null, next: "sign_in" });
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
  const state = { identity: "ok" };
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installApiMock(page, apiLog, sent, state);
    mkdirSync(outDir, { recursive: true });

    // ---- M1B 로그인 ----
    await page.goto(`${baseUrl}/staff-login`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("누구나 가입 · 1년 무료 체험은 본인확인 1인 1회").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const loginButton = page.getByRole("button", { name: "로그인", exact: true });
    check(await loginButton.isDisabled(), "아이디·비밀번호가 비면 「로그인」 꺼짐");
    // 웹(react-native-web)은 tab 의 selected 상태를 aria 로 내보내지 않는다 — 강사 탭에만 있는 가입 버튼으로 본다
    check((await page.getByRole("button", { name: "강사 회원가입" }).count()) === 1, "처음 열면 강사 탭이 골라져 있음(「강사 회원가입」 버튼)");
    await shot(page, "M1B.png");

    await page.getByLabel("아이디", { exact: true }).fill("junholatin");
    await page.getByLabel("비밀번호", { exact: true }).fill("wrong-pass1!");
    await loginButton.click();
    await page.getByText("아이디 또는 비밀번호가 맞지 않아요.").waitFor({ timeout: RENDER_TIMEOUT_MS });
    expectSent(sent, "sign-in", { username: "junholatin", password: "wrong-pass1!" });
    await shot(page, "M1B-로그인-실패.png");

    await page.getByRole("tab", { name: "Owner 대표" }).click();
    await page.getByText("입점 신청을 운영자가 승인하면 계정이 열려요 · 로그인 때 휴대폰 인증").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check((await page.getByText("아이디 또는 비밀번호가 맞지 않아요.").count()) === 0, "탭을 바꾸면 오류 문구가 지워짐");
    await shot(page, "M1C.png");

    // ---- I12 학원 탭 ----
    await page.goto(`${baseUrl}/instructor/academy`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("10월 9일(목) 한글날 전체 휴강").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check((await page.getByText("볼룸스튜디오 강남").count()) === 0, "거절된 학원은 칩에 없음");
    check((await page.getByText("수업 등록 권한 있음").count()) === 1, "class_submit 위임이 있는 학원 → 「수업 등록 권한 있음」");
    await shot(page, "I12.png");

    await page.getByRole("radio", { name: "살사클럽 홍대", exact: true }).click();
    await page.getByText("아직 이 학원에서 받은 공지가 없어요.").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check((await page.getByText("수업 등록 권한 없음").count()) === 1, "위임이 없는 학원 → 「수업 등록 권한 없음」");
    check(apiLog.some((line) => line.includes(`academyId=${SALSA}`)), "칩을 바꾸면 그 학원 공지를 새로 읽음");

    await page.getByRole("radio", { name: "스윙팩토리 홍대, 승인 대기" }).click();
    await page.getByText("대표가 승인하면 이 학원의 시간표와 공지가 열려요.").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(!apiLog.some((line) => line.includes(`academyId=${SWING}`)), "승인 대기 학원은 공지를 부르지 않음");
    await shot(page, "I12-승인-대기.png");

    // ---- I9 마이 ----
    await page.getByRole("tab", { name: "마이" }).click();
    await page.getByText("이준호 강사").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByText("라틴하우스 강남 외 1").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check((await page.getByText("소속 학원 2곳").count()) === 1, "소속 학원 수 = 소속됨 2(승인 대기 제외)");
    check((await page.getByText("댄스스포츠").count()) >= 1, "활동 장르 「댄스스포츠」");
    await shot(page, "I9.png");

    await page.getByRole("button", { name: "로그아웃" }).click();
    await page.getByText("누구나 가입 · 1년 무료 체험은 본인확인 1인 1회").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(sent.some((item) => item.kind === "sign-out"), "로그아웃 → 서버 sign-out 호출 뒤 로그인 화면");

    // ---- I31C 본인확인 → I31 가입 ----
    await page.getByRole("button", { name: "강사 회원가입" }).click();
    await page.getByText("강사 계정은 한 사람당 하나예요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await shot(page, "I31C.png");

    const fillIdentity = async () => {
      await page.getByLabel("이름").fill("이준호");
      await page.getByLabel("생년월일").fill("1990-03-02");
      await page.getByLabel("휴대폰 번호").fill("01012345821");
      await page.getByLabel("시험용 사람 키").fill("seed-instructor-1");
      await page.getByRole("button", { name: "본인확인하고 다음 · 아이디 만들기" }).click();
    };
    state.identity = "already";
    await fillIdentity();
    await page.getByText("이미 가입한 강사예요. 그 아이디로 로그인해 주세요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByRole("button", { name: "그 아이디로 로그인하러 가기" }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    expectSent(sent, "identity-check", { verificationToken: VERIFY_TOKEN });
    await page.getByRole("button", { name: "그 아이디로 로그인하러 가기" }).scrollIntoViewIfNeeded();
    await shot(page, "I31C-이미-가입.png");

    state.identity = "ok";
    await page.getByRole("button", { name: "본인확인하고 다음 · 아이디 만들기" }).click();
    await page.getByText("본인확인 완료 · 이*호 · 010-****-5821").waitFor({ timeout: RENDER_TIMEOUT_MS });
    // 웹 Stack 은 앞 화면(로그인)을 DOM 에 남겨 둔다 — 같은 이름 칸이 둘이면 맨 뒤(지금 화면)를 쓴다
    const submit = page.getByRole("button", { name: "가입하고 시작" });
    check(await submit.isDisabled(), "빈 양식이면 「가입하고 시작」 꺼짐");
    await page.getByLabel("아이디", { exact: true }).last().fill("taken01");
    await page.getByRole("button", { name: "아이디 중복 확인" }).click();
    await page.getByText("이미 쓰는 아이디예요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByLabel("아이디", { exact: true }).last().fill("junholatin");
    await page.getByRole("button", { name: "아이디 중복 확인" }).click();
    await page.getByText("쓸 수 있는 아이디예요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByLabel("비밀번호", { exact: true }).last().fill("junholatin");
    await page.getByText("영문·숫자·기호를 섞어 주세요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByLabel("비밀번호", { exact: true }).last().fill("Latin!2026x");
    await page.getByLabel("비밀번호 한 번 더").fill("Latin!2026x");
    await page.getByText("일치해요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByLabel("회원에게 보이는 이름").fill("이준호");
    await page.getByRole("radio", { name: "댄스스포츠" }).click();
    await page.getByRole("radio", { name: "스윙댄스" }).click();
    // 고른 칩 앞에는 「✓」가 붙는다(Chip). 웹은 radio 의 checked 를 aria 로 내보내지 않아 글자로 본다
    const bodyText = await page.evaluate(() => document.body.innerText);
    check(bodyText.includes("✓ 스윙댄스") && !bodyText.includes("✓ 댄스스포츠"), "활동 장르는 하나만 골라짐(마지막에 누른 스윙댄스)");
    await page.getByRole("radio", { name: "댄스스포츠" }).click();
    await page.getByText("본인확인 완료 · 이*호 · 010-****-5821").scrollIntoViewIfNeeded();
    await shot(page, "I31-위.png");
    await page.getByRole("checkbox", { name: "[필수] 입점 이용약관 (학원·강사)" }).click();
    check(await submit.isDisabled(), "필수 동의가 하나 빠지면 「가입하고 시작」 꺼짐");
    await page.getByRole("checkbox", { name: "[필수] 개인정보 수집·이용" }).click();
    check(!(await submit.isDisabled()), "모두 채우면 「가입하고 시작」 켜짐");
    await shot(page, "I31.png");

    // 가입 → (웹은 토큰 저장소가 없어) 이어서 로그인이 401 로 실패 → 로그인 화면으로 보낸다
    await submit.click();
    await page.waitForURL(/\/staff-login/, { timeout: RENDER_TIMEOUT_MS });
    expectSent(sent, "signup", {
      verificationToken: VERIFY_TOKEN,
      username: "junholatin",
      password: "Latin!2026x",
      displayName: "이준호",
      activityGenre: "dance_sport",
      businessRegistrationNumber: null,
      consents: { merchantTerms: true, merchantPrivacyCollection: true, marketing: false },
    });

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
