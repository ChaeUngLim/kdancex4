// 강사 홈(I1) · 개인 레슨 스케줄(I10) · 개인 레슨 개설 1/2(I10B) · 2/2 열 시간(I10C) 화면을
// Expo 웹으로 띄워 장면을 찍는다 — 로드맵 S2-4.6(앱 개인 레슨·일정 화면).
//
//   실행(mobile 폴더에서): node scripts/shot-instructor-private-lesson.mjs --out-dir <폴더> [--port 8098]
//   결과(<폴더> 안):
//     I1.png              강사 홈 — 「오늘 · 11/24 (화)」 · 오늘 수업 인원(개인 레슨 · 쌈바 · 왈츠, 두 학원 섞여 시간순)
//     I10.png             개인 레슨 스케줄 — 이번 주 11/23–11/29 · 레슨 5회(두 학원) · 수강생별 남은 횟수(결제 대기 포함)
//     I10-서초.png        「라틴스텝 서초」 칩 — 그 학원 레슨만(academyId 로 다시 읽음)
//     I10-수강권-오류.png   수강권 경로가 실패해도 위 표는 그대로, 아래 카드만 「다시 시도」
//     I10B.png            개설 1/2 — 학원 셋(소속 둘 · 소속 아님 하나) · 댄스스포츠(라틴) · 종목 안내 · 10회 · 50분 · 금액
//     I10C.png            개설 2/2 — 이번 주 예약됨 · 레슨 모집 · 새로 넣은 두 시간 · 매주 반복 ✓
//     I10C-공개-뒤.png     「시간 2개를 회원에게 열었어요」
//
// 시계를 2026-11-24(화) 09:00 KST 로 고정한다 — 「오늘」·「이번 주」가 예시 데이터와 맞아야 해서다.
// 왜 서버 응답을 꾸며 넣나(shot-instructor-session.mjs 와 같은 이유): 웹 실행에는 SecureStore 가 없어 로그인 토큰을 저장할 수 없다.
//   그래서 `/api/**` 를 가로채 계약 11(§3-1 · §10-1 · §10-2 · §10-3 · §11) 모양의 예시를 돌려준다.
//   schedule·private-lesson-products(POST)는 S2-4.5 · S2-4.2 의 DB 테스트가 서버 동작을 확인했다.
//   private-lesson-passes(GET)·…/slots(POST)는 계약에만 있고 서버에는 아직 없다(EVIDENCE.md).
//   화면이 보낸 주소·본문이 기대와 다르면 exit 1 로 끝낸다.
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

const port = Number(readArg("port", "8098"));
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/instructor-private-lesson")));
const baseUrl = `http://localhost:${port}`;

// 2026-11-24(화) 09:00 KST
const NOW = new Date("2026-11-24T00:00:00Z");

// ---- 예시 응답. 이름·학원·시간은 보드 I1 · I10 · I10B · I10C 예시 ----
const GANGNAM = "11111111-1111-4111-8111-111111111111"; // 라틴하우스 강남
const SEOCHO = "11111111-1111-4111-8111-111111111112"; // 라틴스텝 서초
const HONGDAE = "11111111-1111-4111-8111-111111111113"; // 라틴 아카데미 홍대(소속 아님)
const PRODUCT = "88888888-8888-4888-8888-8888888888a1";
const A_GANGNAM = { academyId: GANGNAM, name: "라틴하우스 강남", colorIndex: 8 };
const A_SEOCHO = { academyId: SEOCHO, name: "라틴스텝 서초", colorIndex: 4 };

/** KST 날짜·시각 → UTC ISO */
const kst = (ymd, hm) => new Date(`${ymd}T${hm}:00+09:00`).toISOString().replace(".000Z", "Z");
const plus = (iso, min) => new Date(Date.parse(iso) + min * 60_000).toISOString().replace(".000Z", "Z");

const PROFILE = {
  accountId: "66666666-6666-4666-8666-666666666666", displayName: "이준호", activityGenre: "dance_sport", photo: null,
  careerYears: 8, bio: null,
  affiliations: [{ academyId: GANGNAM, name: "라틴하우스 강남", status: "active" }, { academyId: SEOCHO, name: "라틴스텝 서초", status: "active" }],
};
const AFFILIATIONS = {
  items: [
    { affiliationId: "55555555-5555-4555-8555-555555555551", academyId: GANGNAM, academyName: "라틴하우스 강남", status: "active", source: "application", requestedAt: "2026-09-01T01:00:00Z", decidedAt: "2026-09-02T01:00:00Z", rejectReasonCode: null, rejectReasonText: null, releasedAt: null, calendarColorIndex: 8 },
    { affiliationId: "55555555-5555-4555-8555-555555555552", academyId: SEOCHO, academyName: "라틴스텝 서초", status: "active", source: "application", requestedAt: "2026-09-30T01:00:00Z", decidedAt: "2026-10-02T01:00:00Z", rejectReasonCode: null, rejectReasonText: null, releasedAt: null, calendarColorIndex: 4 },
  ],
};

function lesson(id, academy, ymd, hm, name, no, state) {
  const startsAt = kst(ymd, hm);
  return { kind: "private_lesson", id, title: "개인 레슨", startsAt, endsAt: plus(startsAt, 50), academy, student: { displayName: name }, sessionNo: no, sessionsTotal: 10, state };
}
// 이번 주 1:1 레슨(두 학원)
const WEEK_LESSONS = [
  lesson("b-01", A_SEOCHO, "2026-11-23", "19:00", "박지훈", 2, "done"),
  lesson("b-02", A_GANGNAM, "2026-11-24", "18:00", "김서연", 3, "booked"),
  lesson("b-03", A_GANGNAM, "2026-11-26", "20:00", "이수아", 1, "booked"),
  lesson("b-04", A_SEOCHO, "2026-11-28", "14:00", "박지훈", 3, "booked"),
  lesson("b-05", A_GANGNAM, "2026-11-28", "15:30", "김서연", 4, "booked"),
];
function openSlot(id, ymd, hm) {
  const startsAt = kst(ymd, hm);
  return { kind: "private_lesson_open", id, startsAt, endsAt: plus(startsAt, 50), academy: A_GANGNAM };
}
const OPEN_SLOTS = [openSlot("s-01", "2026-11-26", "21:00"), openSlot("s-02", "2026-11-28", "17:00"), openSlot("s-03", "2026-11-29", "13:00")];
function session(id, academy, hm, title, room, male, female) {
  const startsAt = kst("2026-11-24", hm);
  return {
    kind: "class_session", id, classId: `c-${id}`, title, startsAt, endsAt: plus(startsAt, 60), academy, room, status: "scheduled",
    isSubstitute: false, paid: { male, female, any: null }, capacity: { male: 6, female: 6, any: null },
  };
}
const TODAY_SESSIONS = [session("s-samba", A_GANGNAM, "20:30", "쌈바(입문)", "A홀", 5, 5), session("s-waltz", A_SEOCHO, "22:00", "왈츠(초급)", "B홀", 4, 6)];

function pass(id, academy, name, used, extra = {}) {
  return {
    passId: id, academyId: academy.academyId, academyName: academy.name, productClassId: PRODUCT, lessonMinutes: 50,
    student: { displayName: name }, nameVisible: true, discipline: "cha_cha_cha", status: "active",
    sessionsTotal: 10, sessionsUsed: used, remainingSessions: 10 - used, paidAt: "2026-11-01T03:00:00Z", validUntil: "2027-02-01T14:59:59Z",
    nextBooking: null, awaitingPayment: null, ...extra,
  };
}
const PASSES = [
  pass("p-01", A_GANGNAM, "김서연", 4),
  pass("p-02", A_SEOCHO, "박지훈", 3),
  pass("p-03", A_GANGNAM, "이수아", 1),
  pass("p-04", A_GANGNAM, "정민호", 0, { status: "pending_payment", paidAt: null, awaitingPayment: { until: "2026-11-26T14:59:00Z" } }),
  pass("p-05", A_GANGNAM, "환불한회원", 2, { status: "refunded" }), // 화면에 나오면 안 된다
];
const ACADEMIES = {
  items: [
    { academyId: GANGNAM, name: "라틴하우스 강남", region: { sido: "서울", gu: "강남구" }, genres: ["dance_sport"], affiliation: { affiliationId: "55555555-5555-4555-8555-555555555551", status: "active" }, canSubmitClass: true, canOpenPrivateLesson: true },
    { academyId: SEOCHO, name: "라틴스텝 서초", region: { sido: "서울", gu: "서초구" }, genres: ["dance_sport"], affiliation: { affiliationId: "55555555-5555-4555-8555-555555555552", status: "active" }, canSubmitClass: false, canOpenPrivateLesson: true },
    { academyId: HONGDAE, name: "라틴 아카데미 홍대", region: { sido: "서울", gu: "마포구" }, genres: ["dance_sport", "salsa_bachata"], affiliation: null, canSubmitClass: false, canOpenPrivateLesson: false },
  ],
};

/** `/api/**` 를 계약 모양 예시로 답한다 */
async function installApiMock(page, log, sent, state) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    log.push(`${method} ${path}${url.search}`);
    const json = (status, body) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "access-control-allow-origin": "*" } });
    const body = () => request.postDataJSON();
    const key = () => request.headers()["idempotency-key"] ?? null;
    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT" } });
    }
    if (method === "GET" && path === "/api/instructor/me/profile") return json(200, PROFILE);
    if (method === "GET" && path === "/api/instructor/affiliations") return json(200, AFFILIATIONS);
    if (method === "GET" && path === "/api/instructor/schedule") {
      const q = url.searchParams;
      sent.push({ kind: "schedule", from: q.get("from"), to: q.get("to"), include: q.get("include"), academyId: q.get("academyId") });
      const include = new Set((q.get("include") ?? "").split(","));
      const academyId = q.get("academyId");
      const from = q.get("from");
      const to = q.get("to");
      let items = [];
      if (include.has("sessions")) items.push(...TODAY_SESSIONS);
      if (include.has("private")) items.push(...WEEK_LESSONS);
      if (include.has("open")) items.push(...OPEN_SLOTS, ...state.opened);
      // 기간·학원 거르기(서버와 같은 규칙: KST 날짜 from~to, academyId 는 학원 붙은 항목만)
      const day = (iso) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);
      items = items.filter((i) => day(i.startsAt) >= from && day(i.startsAt) <= to && (academyId === null || i.academy?.academyId === academyId));
      items.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      return json(200, { from, to, items, overlaps: [] });
    }
    if (method === "GET" && path === "/api/instructor/private-lesson-passes") {
      sent.push({ kind: "passes", search: url.search });
      if (state.passesFail) return json(404, { detail: "없는 경로예요.", code: "NOT_FOUND" });
      const academyId = url.searchParams.get("academyId");
      return json(200, { items: PASSES.filter((p) => academyId === null || p.academyId === academyId) });
    }
    if (method === "GET" && path === "/api/instructor/academies") return json(200, ACADEMIES);
    if (method === "POST" && path === "/api/instructor/private-lesson-products") {
      const b = body();
      sent.push({ kind: "product", body: b, idempotencyKey: key() });
      return json(201, {
        classId: PRODUCT, academyId: b.academyId, academyName: "라틴하우스 강남", genre: "dance_sport", subGenre: b.subGenre,
        lessonMinutes: b.lessonMinutes, sessionCount: b.sessionCount, priceAmount: b.priceAmount, status: "open",
        rule: { version: 1, changeDeadlineHours: 24, validityMonths: 3 }, refundNoticeVersionId: null, payoutAcademy: "라틴하우스 강남",
      });
    }
    if (method === "POST" && path === `/api/instructor/private-lesson-products/${PRODUCT}/slots`) {
      const b = body();
      sent.push({ kind: "slots", body: b, idempotencyKey: key() });
      const created = b.slots.map((s, i) => ({ slotId: `n-${i}`, startsAt: s.startsAt, endsAt: s.endsAt, status: "open" }));
      state.opened.push(...created.map((c) => ({ kind: "private_lesson_open", id: c.slotId, startsAt: c.startsAt, endsAt: c.endsAt, academy: A_GANGNAM })));
      return json(201, { created, repeatGroupId: "dddddddd-dddd-4ddd-8ddd-dddddddddd01" });
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

/** 화면 전체를 찍는다 — 스크롤 본문을 펼친 높이로 맞춘다. 시트(모달)가 열려 있으면 화면 크기 그대로 찍는다 */
async function shot(page, name, { expand = true } = {}) {
  await page.waitForTimeout(500);
  const height = expand
    ? await page.evaluate(() => {
        const scrollers = [...document.querySelectorAll("div")].filter((el) => el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== "visible");
        const extra = scrollers.reduce((max, el) => Math.max(max, el.scrollHeight - el.clientHeight), 0);
        return window.innerHeight + extra;
      })
    : VIEWPORT.height;
  await page.setViewportSize({ width: VIEWPORT.width, height: Math.max(VIEWPORT.height, height) });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, name), fullPage: true });
  await page.setViewportSize(VIEWPORT);
  console.log(`[shot] 저장: ${join(outDir, name)} (높이 ${Math.max(VIEWPORT.height, height)})`);
}

function check(ok, label) {
  console.log(`[check] ${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
}

function lastSent(sent, kind) {
  return [...sent].reverse().find((item) => item.kind === kind) ?? null;
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
  const state = { passesFail: false, opened: [] };
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await page.clock.setFixedTime(NOW);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installApiMock(page, apiLog, sent, state);
    mkdirSync(outDir, { recursive: true });
    const text = () => page.evaluate(() => document.body.innerText);

    // ---- I1 강사 홈 ----
    await page.goto(`${baseUrl}/instructor`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("오늘 수업 인원").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByText("쌈바(입문)").waitFor({ timeout: RENDER_TIMEOUT_MS });
    let s = lastSent(sent, "schedule");
    check(s?.from === "2026-11-24" && s.to === "2026-11-24" && s.include === "sessions,private" && s.academyId === null, `오늘 일정 주소: ${JSON.stringify(s)}`);
    let body = await text();
    check(body.includes("오늘 · 11/24 (화)") && body.includes("강사 · 라틴하우스 강남 외 1"), "머리: 오늘 · 11/24 (화) · 강사 · 라틴하우스 강남 외 1");
    const order = ["18:00", "20:30", "22:00"].map((t) => body.indexOf(t));
    check(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), "두 학원이 섞여 시간순 18:00 → 20:30 → 22:00");
    check(body.includes("개인 레슨 · 1:1") && body.includes("김서연 · 라틴하우스 강남") && body.includes("3/10회") && body.includes("확정"), "개인 레슨 줄: 김서연 · 3/10회 · 확정");
    check(body.includes("라틴하우스 강남 A홀") && body.includes("남 5 · 여 5") && body.includes("라틴스텝 서초 B홀") && body.includes("남 4 · 여 6"), "수업 줄: 학원·홀 · 결제 인원 남·여");
    check(await page.getByRole("button", { name: "하루 전체 보기, 준비 중" }).isDisabled(), "「하루 전체 보기」는 준비 중(I5D 전)");
    const homeTab = page.getByRole("tab", { name: "홈", exact: true });
    check((await homeTab.getAttribute("aria-selected")) === "true" && !(await homeTab.isDisabled()), `하단 탭 홈 선택·켜짐(aria-selected=${await homeTab.getAttribute("aria-selected")})`);
    await shot(page, "I1.png");

    // ---- I10 개인 레슨 스케줄 ----
    await page.getByRole("button", { name: /^개인 레슨 스케줄/ }).click();
    await page.waitForURL(/\/instructor\/private-lessons$/, { timeout: RENDER_TIMEOUT_MS });
    await page.getByText("수강생별 남은 횟수", { exact: true }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByText("정민호").waitFor({ timeout: RENDER_TIMEOUT_MS });
    s = lastSent(sent, "schedule");
    check(s?.from === "2026-11-23" && s.to === "2026-11-29" && s.include === "private" && s.academyId === null, `이번 주 주소(월~일, private, 전체): ${JSON.stringify(s)}`);
    check(lastSent(sent, "passes")?.search === "", "수강권 전체(학원 거르지 않음)");
    body = await text();
    check(body.includes("11/23 – 11/29 · 이번 주"), "주 제목 11/23 – 11/29 · 이번 주");
    check(body.includes("1:1 레슨 5회 · 수강생 4명 · 오늘 1회 · 결제 대기 1"), "요약 줄(환불 수강권은 세지 않음)");
    check(["월 11/23", "화 11/24", "목 11/26", "토 11/28"].every((t) => body.includes(t)) && body.includes("완료") && body.includes("오늘"), "날짜 칸 · 완료 · 오늘");
    check(body.includes("10회권 · 남은 6회") && body.includes("10회권 · 결제 대기 · 11/26 23:59까지") && !body.includes("환불한회원"), "남은 횟수 · 결제 대기 마감 · 환불 수강권 숨김");
    check(body.includes("수강생 이름은 멤버십에서 보여요. 끝나면 시간·횟수만 남아요."), "멤버십 안내 문장");
    await shot(page, "I10.png");

    // 학원 칩 — 서초만
    await page.getByRole("radio", { name: "라틴스텝 서초" }).click();
    await page.getByText("1:1 레슨 2회").waitFor({ timeout: RENDER_TIMEOUT_MS });
    s = lastSent(sent, "schedule");
    check(s?.academyId === SEOCHO && lastSent(sent, "passes")?.search === `?academyId=${SEOCHO}`, "칩을 누르면 academyId 로 다시 읽음(일정 · 수강권)");
    body = await text();
    check(!body.includes("김서연") && body.includes("박지훈"), "서초 레슨(박지훈)만");
    await shot(page, "I10-서초.png");

    // 수강권 경로 실패 — 위 표는 그대로
    state.passesFail = true;
    await page.getByRole("radio", { name: "전체" }).click();
    await page.getByText("수강생별 남은 횟수를 불러오지 못했어요.").waitFor({ timeout: RENDER_TIMEOUT_MS });
    body = await text();
    check(body.includes("1:1 레슨 5회 · 수강생 3명 · 오늘 1회") && !body.includes("결제 대기 1"), "수강권 실패: 수강생은 이번 주 레슨 이름(3명)으로 세고 결제 대기 칸은 뺌");
    check((await page.getByRole("button", { name: "다시 시도" }).count()) === 1, "수강권 카드에만 「다시 시도」");
    await shot(page, "I10-수강권-오류.png");
    state.passesFail = false;

    // ---- I10B 개설 1/2 ----
    await page.getByRole("button", { name: "+ 개인 레슨 열기" }).click();
    await page.waitForURL(/\/private-lessons\/new$/, { timeout: RENDER_TIMEOUT_MS });
    await page.getByText("라틴 아카데미 홍대").waitFor({ timeout: RENDER_TIMEOUT_MS });
    body = await text();
    check(body.includes("소속 아님 · 대표 승인 뒤 개설할 수 있어요") && (await page.getByRole("button", { name: "라틴 아카데미 홍대 소속 신청" }).count()) === 1, "소속 아닌 학원은 소속 신청");
    const gangnamPick = page.getByRole("radio", { name: "라틴하우스 강남 고르기" });
    check((await gangnamPick.getAttribute("aria-checked")) === "true" && (await gangnamPick.innerText()).includes("✓ 선택"), "첫 소속 학원이 골라져 있음(✓ 선택 · aria-checked)");
    check(["댄스스포츠(라틴)", "댄스스포츠(스탠다드)", "룸바", "차차차", "쌈바", "파소도블레", "자이브"].every((t) => body.includes(t)), "세부 장르 칩 + 종목 안내(회원이 고름)");
    check(await page.getByRole("button", { name: "다음 · 열 시간 정하기" }).isDisabled(), "금액 비면 다음 꺼짐");
    await page.getByLabel("수강권 금액(원)").fill("600000");
    body = await text();
    check(body.includes("회원 결제는 라틴하우스 강남으로 들어가요. 강사 정산도 이 학원에서 받아요."), "판매자 안내(고른 학원)");
    check(body.includes("10회 600,000원"), "10회 600,000원");
    await shot(page, "I10B.png");

    // ---- I10C 개설 2/2 ----
    await page.getByRole("button", { name: "다음 · 열 시간 정하기" }).click();
    await page.waitForURL(/\/private-lessons\/[^/]+\/slots/, { timeout: RENDER_TIMEOUT_MS });
    const product = lastSent(sent, "product");
    check(
      JSON.stringify(product?.body) === JSON.stringify({ academyId: GANGNAM, subGenre: "latin", lessonMinutes: 50, sessionCount: 10, priceAmount: 600000 }),
      `상품 열기 본문: ${JSON.stringify(product?.body)}`,
    );
    check(typeof product?.idempotencyKey === "string" && product.idempotencyKey.length >= 8, "상품 열기 Idempotency-Key 있음");
    await page.getByText("21:00 레슨 모집").waitFor({ timeout: RENDER_TIMEOUT_MS });
    s = lastSent(sent, "schedule");
    check(s?.include === "private,open" && s.academyId === GANGNAM && s.from === "2026-11-23", "이 학원 이번 주(private,open)");
    body = await text();
    check(body.includes("라틴 10회 수강권 · 50분 · 600,000원 · 결제는 이 학원으로"), "상품 요약 줄");
    check(body.includes("18:00 예약됨") && body.includes("15:30 예약됨") && body.includes("13:00 레슨 모집") && !body.includes("14:00 예약됨"), "강남 예약됨 · 레슨 모집만(서초 레슨 없음)");
    // 새 시간 두 개 — 수 19:00, 금 20:10. 틀린 값 먼저
    await page.getByRole("button", { name: "+ 시간 추가 · 10분 단위 (예: 21:10)" }).click();
    await page.getByRole("radio", { name: "수 11/25" }).click();
    await page.getByLabel("시작 시각").fill("19:05");
    await page.getByRole("button", { name: "넣기" }).click();
    check((await text()).includes("10분 단위만 열 수 있어요(예: 21:10)."), "19:05 → 10분 단위 안내");
    check(await page.getByRole("radio", { name: "월 11/23" }).isDisabled(), "지난 날(월)은 못 고름");
    await page.getByLabel("시작 시각").fill("19:00");
    await page.getByRole("button", { name: "넣기" }).click();
    await page.getByRole("button", { name: "+ 시간 추가 · 10분 단위 (예: 21:10)" }).click();
    await page.getByRole("radio", { name: "금 11/27" }).click();
    await page.getByLabel("시작 시각").fill("20:10");
    await page.getByRole("button", { name: "넣기" }).click();
    body = await text();
    check(body.includes("19:00 새로 열 시간") && body.includes("20:10 새로 열 시간") && body.includes("매주 반복 ✓"), "새 시간 둘 · 매주 반복 ✓");
    await shot(page, "I10C.png");

    await page.getByRole("button", { name: "회원에게 공개 · 2개" }).click();
    await page.getByText("시간 2개를 회원에게 열었어요.").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const slots = lastSent(sent, "slots");
    check(
      JSON.stringify(slots?.body) ===
        JSON.stringify({ slots: [{ startsAt: "2026-11-25T10:00:00Z", endsAt: "2026-11-25T10:50:00Z" }, { startsAt: "2026-11-27T11:10:00Z", endsAt: "2026-11-27T12:00:00Z" }], repeatWeeks: 8 }),
      `열 시간 본문(KST→UTC · 50분 · 8주): ${JSON.stringify(slots?.body)}`,
    );
    check(typeof slots?.idempotencyKey === "string" && slots.idempotencyKey.length >= 8, "열 시간 Idempotency-Key 있음");
    await page.getByText("19:00 레슨 모집").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check((await text()).includes("20:10 레슨 모집"), "공개 뒤 다시 읽어 「레슨 모집」으로 보임");
    await shot(page, "I10C-공개-뒤.png");

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
