// 강사 아이디·비밀번호 찾기(I31B) · 소속 신청(I27) · 내 소속 신청(I27B) · 소속 학원 학원 색(I9E) 화면을 Expo 웹으로 띄워 장면을 찍는다
// — 로드맵 S2-1.10(앱 계정 찾기·소속 신청·학원 색 화면).
//
//   실행(mobile 폴더에서): node scripts/shot-instructor-affiliation.mjs --out-dir <폴더> [--port 8095]
//   결과(<폴더> 안):
//     M1B-찾기-입구.png     강사 로그인의 「아이디 찾기 | 비밀번호 찾기」가 눌리는 상태
//     I31B-본인확인.png     1단계 본인확인 칸
//     I31B-계정-없음.png    본인확인은 됐는데 강사 계정이 없는 사람(404) → 안내 + 강사 회원가입 버튼
//     I31B.png              2단계 찾은 계정 카드 + 새 비밀번호 두 칸 「일치해요」 + 「비밀번호 바꾸고 로그인」 켜짐
//     I31B-완료.png         비밀번호를 바꿨고(다른 기기 2곳 로그인 끝) 이 기기 로그인은 웹이라 못 해 완료 안내
//     I27.png               「서울」 검색 결과 3곳(소속됨 · 고를 수 있음 · 신청 대기 중) + 라틴 아카데미 홍대 선택 + 한마디
//     I27B.png              카드 3장: 승인 대기(신청 취소) · 거절됨(사유 · 다시 신청하기) · 승인됨(권한 없음 · 학원 탭에서 보기)
//     I27B-취소-뒤.png      승인 대기 신청을 취소한 뒤 목록
//     I27-다시-신청.png     거절 카드의 「다시 신청하기」 → 그 학원이 검색·선택된 채로 열린 I27
//     I9E.png               소속 학원 2곳, 첫 학원 펼침 · 12색 · 서버 카드의 calendarColorIndex(8=블루)로 처음부터 블루가 골라진 상태(저장 호출 없음)
//     I9E-색-없음.png       색이 아직 없는(null) 라틴하우스 강남을 펼친 상태 — 빈 점 · 고리 없음 · 「누르면 바로 저장돼요」
//     I9E-색-바꿈.png       라틴하우스 강남에 「앰버」를 눌러 저장한 뒤(PUT {colorIndex:2})
//
// 왜 서버 응답을 꾸며 넣나(shot-instructor.mjs 와 같은 이유): 웹 실행에는 SecureStore 가 없어 로그인 토큰을 저장할 수 없다.
//   그래서 `/api/**` 를 가로채 계약(11 §1-4·§3-1·§3-2 · 08 §2) 모양의 예시를 돌려주고, 화면은 주소로 바로 연다.
//   서버 동작은 S2-1.8·S2-1.9·S1-2.6 의 DB 테스트가 확인했다. 화면이 보낸 본문은 기대와 다르면 exit 1 로 끝낸다.
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
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/instructor-affiliation")));
const baseUrl = `http://localhost:${port}`;

// ---- 예시 응답. 이름·학원·날짜는 보드 I31B·I27·I27B·I9E 예시 ----
const LATIN = "11111111-1111-4111-8111-111111111111"; // 라틴하우스 강남(소속됨)
const LATIN_HONGDAE = "22222222-2222-4222-8222-222222222222"; // 라틴 아카데미 홍대(거절됨 → 다시 신청 가능)
const JAMSIL = "33333333-3333-4333-8333-333333333333"; // 댄스스포츠센터 잠실(승인 대기)
const SEOCHO = "44444444-4444-4444-8444-444444444444"; // 라틴스텝 서초(소속됨)
const ACCOUNT = "66666666-6666-4666-8666-666666666666";
const AFF = {
  latin: "55555555-5555-4555-8555-555555555551",
  hongdae: "55555555-5555-4555-8555-555555555552",
  jamsil: "55555555-5555-4555-8555-555555555553",
  seocho: "55555555-5555-4555-8555-555555555554",
  newHongdae: "55555555-5555-4555-8555-555555555559",
};
const STAFF_ME = {
  accountId: ACCOUNT,
  displayName: "이준호",
  roles: ["instructor"],
  secondFactorVerified: false,
  consoleAccess: false,
  // 라틴하우스 강남만 앱 수업 등록 권한(class_submit) — 라틴스텝 서초는 「수업 등록 권한 없음」
  academies: [{ academyId: LATIN, name: "라틴하우스 강남", as: "delegate", permissions: ["class_submit"], menus: [] }],
  platformMenus: [],
};
const card = (affiliationId, academyId, academyName, status, requestedAt, decidedAt, extra = {}) => ({
  affiliationId,
  academyId,
  academyName,
  status,
  source: "application",
  requestedAt,
  decidedAt,
  rejectReasonCode: null,
  rejectReasonText: null,
  releasedAt: null,
  calendarColorIndex: null,
  // 앱 수업 등록 권한 — 2026-11-23 부터 소속 카드의 canSubmitClass 로 읽는다(staff/me 는 웹 위임만). 라틴하우스 강남만 켜져 있다
  canSubmitClass: status === "active" && academyId === LATIN,
  ...extra,
});
// 08 §2 카드 — 학원마다 가장 최근 행 하나. 서버 순서는 최근 신청이 위
function affiliationCards(state) {
  const items = [];
  if (state.jamsilPending) items.push(card(AFF.jamsil, JAMSIL, "댄스스포츠센터 잠실", "pending", "2026-11-09T01:00:00.000000Z", null));
  else items.push(card(AFF.jamsil, JAMSIL, "댄스스포츠센터 잠실", "withdrawn", "2026-11-09T01:00:00.000000Z", "2026-11-21T01:00:00.000000Z"));
  items.push(
    card(AFF.hongdae, LATIN_HONGDAE, "라틴 아카데미 홍대", "rejected", "2026-11-06T01:00:00.000000Z", "2026-11-08T01:00:00.000000Z", {
      rejectReasonCode: "not_recruiting",
    }),
  );
  items.push(card(AFF.seocho, SEOCHO, "라틴스텝 서초", "active", "2026-09-28T01:00:00.000000Z", "2026-10-02T01:00:00.000000Z", {
      // 08 §2 calendarColorIndex — 승인 때 서버가 붙인 색(8 = 블루, 보드 I9E 와 같음). I9E 는 이 값으로 처음 상태를 그린다
      calendarColorIndex: 8,
    }),
  );
  items.push(card(AFF.latin, LATIN, "라틴하우스 강남", "active", "2026-05-04T01:00:00.000000Z", "2026-05-05T01:00:00.000000Z"));
  return { items };
}
// 11 §3-1 검색 결과. 거절된 학원은 affiliation.status = rejected(다시 신청 가능)
const SEARCH = [
  { academyId: LATIN, name: "라틴하우스 강남", region: { sido: "서울", gu: "강남구" }, genres: ["dance_sport"], affiliation: { affiliationId: AFF.latin, status: "active" }, canSubmitClass: true, canOpenPrivateLesson: true },
  { academyId: LATIN_HONGDAE, name: "라틴 아카데미 홍대", region: { sido: "서울", gu: "마포구" }, genres: ["dance_sport", "salsa_bachata"], affiliation: { affiliationId: AFF.hongdae, status: "rejected" }, canSubmitClass: false, canOpenPrivateLesson: false },
  { academyId: JAMSIL, name: "댄스스포츠센터 잠실", region: { sido: "서울", gu: "송파구" }, genres: ["dance_sport"], affiliation: { affiliationId: AFF.jamsil, status: "pending" }, canSubmitClass: false, canOpenPrivateLesson: false },
];
const PROFILE = {
  accountId: ACCOUNT,
  displayName: "이준호",
  activityGenre: "dance_sport",
  photo: null,
  careerYears: 10,
  regions: [{ sido: "서울", gu: "강남구" }],
  qualifications: [],
  competitions: [],
  bio: null,
  disciplines: [],
  businessRegistration: { number: null, hasEvidence: false },
  affiliations: [
    { academyId: LATIN, name: "라틴하우스 강남", status: "active" },
    { academyId: SEOCHO, name: "라틴스텝 서초", status: "active" },
  ],
};
const VERIFY_TOKEN = "fake-verification-token-예시";
const LOOKUP = { nameMasked: "이*호", phoneMasked: "010-****-5821", username: "junho_latin", joinedOn: "2026-05-03", academyNames: ["라틴하우스 강남"], academyCount: 2 };

/** `/api/**` 를 계약 모양 예시로 답한다. state 로 계정 유무·승인 대기 여부를 바꾼다 */
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
    if (method === "POST" && path === "/api/dev/identity/fake-verify") {
      sent.push({ kind: "fake-verify", body: request.postDataJSON() });
      return json(200, { verificationToken: VERIFY_TOKEN, expiresAt: "2026-11-21T10:10:00.000Z" });
    }
    if (method === "POST" && path === "/api/instructor/account-recovery/lookup") {
      sent.push({ kind: "lookup", body: request.postDataJSON() });
      if (state.account === "none") return json(404, { detail: "이 본인확인으로 가입한 강사 계정이 없어요", code: "NOT_FOUND" });
      return json(200, LOOKUP);
    }
    if (method === "POST" && path === "/api/instructor/account-recovery/reset-password") {
      sent.push({ kind: "reset", body: request.postDataJSON() });
      return json(200, { ok: true, sessionsRevoked: 2 });
    }
    if (method === "POST" && path === "/api/auth/sign-in/username") {
      sent.push({ kind: "sign-in", body: request.postDataJSON() });
      // 웹에는 토큰 보관소가 없어 성공해도 저장이 안 된다 — 이 장면은 「바로 로그인 못 함 → 완료 안내」 갈래를 본다
      return json(401, { code: "INVALID_USERNAME_OR_PASSWORD", message: "Invalid username or password" });
    }
    if (method === "GET" && path === "/api/staff/me") return json(200, STAFF_ME);
    if (method === "GET" && path === "/api/instructor/me/profile") return json(200, PROFILE);
    if (method === "GET" && path === "/api/instructor/affiliations") return json(200, affiliationCards(state));
    if (method === "GET" && path === "/api/instructor/staff-notices") return json(200, { items: [], nextCursor: null });
    if (method === "GET" && path === "/api/instructor/academies") {
      const q = (url.searchParams.get("q") ?? "").trim();
      const items = SEARCH.filter((item) => q === "" || item.name.includes(q) || item.region.sido.includes(q) || item.region.gu.includes(q));
      return json(200, { items });
    }
    if (method === "POST" && path === "/api/instructor/affiliations") {
      const body = request.postDataJSON();
      sent.push({ kind: "apply", body });
      return json(201, { affiliationId: AFF.newHongdae, academyId: body.academyId, status: "pending", source: "application", requestedAt: "2026-11-21T01:00:00.000000Z" });
    }
    const withdrawMatch = /^\/api\/instructor\/affiliations\/([^/]+)\/withdraw$/.exec(path);
    if (method === "POST" && withdrawMatch) {
      sent.push({ kind: "withdraw", id: withdrawMatch[1] });
      state.jamsilPending = false;
      return json(200, { affiliationId: withdrawMatch[1], status: "withdrawn", withdrawnAt: "2026-11-21T01:00:00.000000Z" });
    }
    const colorMatch = /^\/api\/instructor\/affiliations\/([^/]+)\/color$/.exec(path);
    if (method === "PUT" && colorMatch) {
      const body = request.postDataJSON();
      sent.push({ kind: "color", id: colorMatch[1], body });
      return json(200, { affiliationId: colorMatch[1], colorIndex: body.colorIndex });
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
  const state = { account: "found", jamsilPending: true };
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installApiMock(page, apiLog, sent, state);
    mkdirSync(outDir, { recursive: true });
    const text = () => page.evaluate(() => document.body.innerText);

    // ---- M1B → I31B 입구 ----
    await page.goto(`${baseUrl}/staff-login`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    const findEntry = page.getByRole("button", { name: "아이디 찾기, 비밀번호 찾기" });
    await findEntry.waitFor({ timeout: RENDER_TIMEOUT_MS });
    check((await page.getByText("준비 중").count()) === 0, "강사 탭의 찾기 줄에 「준비 중」이 없음(눌림)");
    await shot(page, "M1B-찾기-입구.png");
    await findEntry.click();
    await page.getByText("찾는 방법은 휴대폰 본인확인 하나예요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await shot(page, "I31B-본인확인.png");

    const fillIdentity = async () => {
      await page.getByLabel("이름").last().fill("이준호");
      await page.getByLabel("생년월일").last().fill("1990-03-02");
      await page.getByLabel("휴대폰 번호").last().fill("01012345821");
      await page.getByLabel("시험용 사람 키").last().fill("seed-instructor-1");
      await page.getByRole("button", { name: "본인확인하고 계정 찾기" }).click();
    };

    // 본인확인은 됐는데 강사 계정이 없는 사람(404)
    state.account = "none";
    await fillIdentity();
    await page.getByText("본인확인한 분으로 가입한 강사 계정이 없어요.").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByRole("button", { name: "강사 회원가입하러 가기" }).scrollIntoViewIfNeeded();
    expectSent(sent, "lookup", { verificationToken: VERIFY_TOKEN });
    await shot(page, "I31B-계정-없음.png");

    // 계정을 찾는다 → 2단계
    state.account = "found";
    await page.getByRole("button", { name: "본인확인하고 계정 찾기" }).click();
    await page.getByText("본인확인한 분의 강사 계정을 찾았어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    let body = await text();
    check(body.includes("junho_latin") && body.includes("2026-05-03 (일) 가입 · 라틴하우스 강남 외 1"), "찾은 계정 카드: 아이디 · 가입일(요일) · 학원 1 + 외 1");
    check(body.includes("이*호 · 010-****-5821"), "이름·전화는 가린 값 그대로");
    const resetButton = page.getByRole("button", { name: "비밀번호 바꾸고 로그인" });
    check(await resetButton.isDisabled(), "새 비밀번호가 비면 「비밀번호 바꾸고 로그인」 꺼짐");
    await page.getByLabel("새 비밀번호", { exact: true }).fill("junho_latin");
    await page.getByText("영문·숫자·기호를 섞어 주세요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByLabel("새 비밀번호", { exact: true }).fill("Latin!2027y");
    await page.getByLabel("새 비밀번호 한 번 더").fill("Latin!2027");
    check(await resetButton.isDisabled(), "두 칸이 다르면 꺼짐");
    await page.getByLabel("새 비밀번호 한 번 더").fill("Latin!2027y");
    await page.getByText("일치해요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(!(await resetButton.isDisabled()), "규칙 통과 + 일치하면 켜짐");
    await page.getByText("비밀번호를 잊었다면 새로 정해요").scrollIntoViewIfNeeded();
    await shot(page, "I31B.png");

    await resetButton.click();
    await page.getByText("junho_latin 비밀번호를 새로 정했어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    expectSent(sent, "reset", { verificationToken: VERIFY_TOKEN, newPassword: "Latin!2027y" });
    expectSent(sent, "sign-in", { username: "junho_latin", password: "Latin!2027y" });
    check((await text()).includes("로그인돼 있던 기기 2곳의 로그인을 끝냈어요."), "sessionsRevoked 2 → 「기기 2곳」 안내");
    await shot(page, "I31B-완료.png");

    // ---- I27 소속 신청 ----
    await page.goto(`${baseUrl}/instructor/affiliations/apply`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("검색 결과 3곳").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByLabel("학원 검색어").fill("라틴");
    await page.getByRole("button", { name: "학원 검색" }).click();
    await page.getByText("검색 결과 2곳").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(apiLog.some((line) => line.includes("/api/instructor/academies?q=%EB%9D%BC%ED%8B%B4")), "「검색」을 누르면 q=라틴 으로 다시 읽음");
    // 보드처럼 3곳이 보이게 시(서울)로 다시 찾는다 — 서버는 이름·시·구 부분 일치(11 §3-1)
    await page.getByLabel("학원 검색어").fill("서울");
    await page.getByRole("button", { name: "학원 검색" }).click();
    await page.getByText("검색 결과 3곳").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const applyButton = page.getByRole("button", { name: "학원을 고르면 소속 신청" });
    check(await applyButton.isDisabled(), "학원을 고르기 전에는 신청 버튼 꺼짐");
    check(await page.getByRole("radio", { name: "라틴하우스 강남, 소속됨" }).isDisabled(), "소속됨 학원은 고를 수 없음");
    check(await page.getByRole("radio", { name: "댄스스포츠센터 잠실, 신청 대기 중" }).isDisabled(), "신청 대기 중 학원은 고를 수 없음");
    await page.getByRole("radio", { name: "라틴 아카데미 홍대", exact: true }).click();
    await page.getByLabel("대표에게 한마디").fill("라틴 10년, 대회 심사 경력이 있어요. 평일 저녁 수업이 가능해요.");
    const submit = page.getByRole("button", { name: "라틴 아카데미 홍대에 소속 신청" });
    check(!(await submit.isDisabled()), "고르면 「라틴 아카데미 홍대에 소속 신청」 켜짐");
    check((await text()).includes("활동 장르 · 댄스스포츠"), "활동 장르는 프로필의 댄스스포츠 그대로");
    await shot(page, "I27.png");
    await submit.click();
    await page.waitForURL(/\/instructor\/affiliations$/, { timeout: RENDER_TIMEOUT_MS });
    expectSent(sent, "apply", { academyId: LATIN_HONGDAE, message: "라틴 10년, 대회 심사 경력이 있어요. 평일 저녁 수업이 가능해요." });

    // ---- I27B 내 소속 신청 ----
    await page.getByText("대표가 고른 사유").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByText("라틴스텝 서초").waitFor({ timeout: RENDER_TIMEOUT_MS });
    body = await text();
    check(body.includes("11/9 (월) 신청 · 대표가 확인하면 알려 드려요"), "승인 대기 카드: 11/9 (월) 신청");
    check(body.includes("11/6 (금) 신청 · 11/8 (일) 거절") && body.includes("지금은 강사를 모집하지 않아요"), "거절 카드: 날짜 둘 + 사유 not_recruiting 문구");
    check(body.includes("10/2 (금) 승인 · 수업 등록 권한 없음"), "승인 카드: 라틴스텝 서초 10/2 승인 · 권한 없음");
    check(body.indexOf("댄스스포츠센터 잠실") < body.indexOf("라틴 아카데미 홍대") && body.indexOf("라틴 아카데미 홍대") < body.indexOf("라틴스텝 서초"), "카드 순서: 승인 대기 → 거절됨 → 승인됨");
    await shot(page, "I27B.png");

    await page.getByRole("button", { name: "댄스스포츠센터 잠실 신청 취소" }).click();
    await page.getByText("댄스스포츠센터 잠실").waitFor({ state: "detached", timeout: RENDER_TIMEOUT_MS });
    check(sent.some((item) => item.kind === "withdraw" && item.id === AFF.jamsil), "「신청 취소」 → withdraw 경로(잠실 소속 id)");
    await shot(page, "I27B-취소-뒤.png");

    await page.getByRole("button", { name: "라틴 아카데미 홍대 다시 신청하기" }).click();
    await page.getByRole("button", { name: "라틴 아카데미 홍대에 소속 신청" }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(apiLog.some((line) => line.includes("/api/instructor/academies?q=%EB%9D%BC%ED%8B%B4%20%EC%95%84%EC%B9%B4%EB%8D%B0%EB%AF%B8%20%ED%99%8D%EB%8C%80")), "다시 신청하기 → 그 학원 이름으로 검색");
    await shot(page, "I27-다시-신청.png");

    // ---- I9E 소속 학원 · 학원 색 ----
    await page.goto(`${baseUrl}/instructor/my`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByRole("button", { name: "소속 학원 2곳" }).click();
    await page.getByText("이 학원 색").waitFor({ timeout: RENDER_TIMEOUT_MS });
    body = await text();
    check(!body.includes("댄스스포츠센터 잠실") && !body.includes("라틴 아카데미 홍대"), "소속됨 학원만(대기·거절·철회 없음)");
    check(["로즈", "코랄", "앰버", "올리브", "그린", "민트", "틸", "스카이", "블루", "인디고", "퍼플", "마젠타"].every((name) => body.includes(name)), "12색이 처음부터 모두 보임");
    check((await page.getByRole("radio").count()) === 12, "펼친 학원은 하나(색 버튼 12개)");
    // 처음 상태 = 서버 카드의 calendarColorIndex. 아무것도 누르지 않았는데 라틴스텝 서초(첫 학원)가 블루로 골라져 있다
    check(body.includes("소속 승인 · 블루"), "처음 상태: 라틴스텝 서초 줄에 「소속 승인 · 블루」(카드 calendarColorIndex 8)");
    check((await page.getByRole("radio", { name: "블루", checked: true }).count()) === 1, "처음 상태: 「블루」 색 버튼이 골라짐(checked)");
    check((await page.getByRole("radio", { checked: true }).count()) === 1, "처음 상태: 골라진 색은 하나뿐");
    check(!sent.some((item) => item.kind === "color"), "처음 상태를 그리려고 저장(PUT)을 부르지 않음");
    await shot(page, "I9E.png");

    // 색이 없는(null) 학원 — 라틴하우스 강남을 펼친다
    await page.getByRole("button", { name: /^라틴하우스 강남 학원 색, 펼치기$/ }).click();
    await page.getByText("색 12가지 · 무지개 순 · 누르면 바로 저장돼요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check((await page.getByRole("radio", { checked: true }).count()) === 0, "색 없음(null): 골라진 색 버튼 없음");
    await shot(page, "I9E-색-없음.png");

    await page.getByRole("radio", { name: "앰버" }).click();
    await page.getByText("소속 승인 · 앰버").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const colorSent = [...sent].reverse().find((item) => item.kind === "color");
    check(colorSent?.id === AFF.latin && JSON.stringify(colorSent?.body) === JSON.stringify({ colorIndex: 2 }), `학원 색 PUT 본문: ${JSON.stringify(colorSent)}`);
    check((await page.getByRole("radio", { name: "앰버", checked: true }).count()) === 1, "저장 뒤 「앰버」가 골라짐");
    await shot(page, "I9E-색-바꿈.png");

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
