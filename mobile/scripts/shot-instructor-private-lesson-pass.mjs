// 개인 레슨 수강생 상세(I20) · 회차 바꾸기(I20B) · 개인 레슨 규칙(I20C) 화면을
// Expo 웹으로 띄워 장면을 찍는다 — 로드맵 S2-4.8(앱 개인 레슨 수강생·회차·규칙 화면).
//
//   실행(mobile 폴더에서): node scripts/shot-instructor-private-lesson-pass.mjs --out-dir <폴더> [--port 8099]
//   결과(<폴더> 안):
//     I10-입구.png          개인 레슨 스케줄 — 수강생 줄에 「시간 잡기 ›」(눌림)
//     I20.png               수강생 상세 — 결제 완료 · 결제일·수단·금액 · 사용 기한 · 4회 진행 · 잡힌 회차 · 레슨 모집 3개 중 첫째 고름
//     I20-잡은-뒤.png        「11/26 (목) 21:00 으로 잡았어요」 · 잡힌 회차 2줄 · 남은 모집 2개
//     I20-결제대기.png       결제 대기 수강권 — 이름은 보이고 회차 잡기 대신 「결제가 끝나면」 안내
//     I20B.png              회차 바꾸기 — 강사 사정으로 취소 고름 · 알림 미리 보기 · 사유 · 빨간 버튼
//     I20B-취소-뒤.png       「강사 사정으로 취소했어요. 회차를 돌려줬어요 · 남은 6회.」
//     I20B-시간-바꾸기.png    시간 바꾸기 고름 · 옮길 시간 목록
//     I20B-회원-요청.png      시작 9시간 전 회차 — 「1회가 차감돼요」 미리 보기
//     I20B-회원-요청-뒤.png   서버 판정 cancelled_member_late · 남은 5회
//     I20C.png              개인 레슨 규칙 — 판본 2 · 24시간 전 · 3개월 · 추천 · 고정 규칙 · 회원 안내 4줄
//     I20C-바꿈.png          48시간 전 · 6개월로 바꾸면 안내 문장이 바로 바뀜
//     I20C-저장.png          「판본 3 으로 저장했어요」
//
// 시계를 2026-11-24(화) 09:00 KST 로 고정한다(S2-4.6 촬영과 같은 날) — 「지금은 시작 24시간 전」 판정이 예시와 맞아야 해서다.
// 왜 서버 응답을 꾸며 넣나: 웹 실행에는 SecureStore 가 없어 로그인 토큰을 저장할 수 없다(S2-1.7 부터 같은 이유).
//   그래서 `/api/**` 를 가로채 계약 11 §10-1 · §10-3 모양(admin-web zod 스키마와 같은 칸)의 예시를 돌려준다.
//   서버 동작 자체는 S2-4.7 의 DB 테스트(tests/db/private-lesson-bookings.db.test.ts)가 확인했다.
//   화면이 보낸 주소·본문·Idempotency-Key 가 기대와 다르면 exit 1 로 끝낸다.
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

const port = Number(readArg("port", "8099"));
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/instructor-private-lesson-pass")));
const baseUrl = `http://localhost:${port}`;

// 2026-11-24(화) 09:00 KST
const NOW = new Date("2026-11-24T00:00:00Z");

// ---- 예시 데이터(보드 I20 · I20B · I20C 의 이름·학원) ----
const GANGNAM = "11111111-1111-4111-8111-111111111111"; // 라틴하우스 강남
const SEOCHO = "11111111-1111-4111-8111-111111111112";
const PRODUCT = "88888888-8888-4888-8888-8888888888a1";
const PASS = "77777777-7777-4777-8777-7777777777a1"; // 김서연
const PASS_PENDING = "77777777-7777-4777-8777-7777777777a4"; // 정민호(결제 대기)
const A_GANGNAM = { academyId: GANGNAM, name: "라틴하우스 강남", colorIndex: 8 };

const kst = (ymd, hm) => new Date(`${ymd}T${hm}:00+09:00`).toISOString().replace(".000Z", "Z");
const plus = (iso, min) => new Date(Date.parse(iso) + min * 60_000).toISOString().replace(".000Z", "Z");
const uuid = (n) => `99999999-9999-4999-8999-${String(n).padStart(12, "0")}`;

const PROFILE = {
  accountId: "66666666-6666-4666-8666-666666666666", displayName: "이준호", activityGenre: "dance_sport", photo: null,
  careerYears: 8, bio: null, affiliations: [{ academyId: GANGNAM, name: "라틴하우스 강남", status: "active" }],
};
const AFFILIATIONS = {
  items: [
    { affiliationId: "55555555-5555-4555-8555-555555555551", academyId: GANGNAM, academyName: "라틴하우스 강남", status: "active", source: "application", requestedAt: "2026-09-01T01:00:00Z", decidedAt: "2026-09-02T01:00:00Z", rejectReasonCode: null, rejectReasonText: null, releasedAt: null, calendarColorIndex: 8 },
  ],
};

function booking(n, ymd, hm, status, deducted) {
  const startsAt = kst(ymd, hm);
  return { bookingId: uuid(100 + n), slotId: uuid(200 + n), startsAt, endsAt: plus(startsAt, 50), status, deducted };
}
function slot(n, ymd, hm) {
  const startsAt = kst(ymd, hm);
  return { slotId: uuid(300 + n), startsAt, endsAt: plus(startsAt, 50), roomName: "연습실" };
}

/** 촬영마다 새로 만드는 서버 쪽 상태(잡기·취소가 바꾼다) */
function freshState() {
  return {
    pass: {
      passId: PASS, academyId: GANGNAM, academyName: "라틴하우스 강남", productClassId: PRODUCT, lessonMinutes: 50,
      student: { displayName: "김서연" }, nameVisible: true, discipline: "cha_cha_cha", status: "active",
      sessionsTotal: 10, sessionsUsed: 4, remainingSessions: 6, paidAt: "2026-10-06T03:00:00Z", validUntil: "2027-01-05T14:59:59Z",
      nextBooking: null, awaitingPayment: null,
      payment: { paidAt: "2026-10-06T03:00:00Z", method: "card", amount: 600000 },
      rule: { version: 2, changeDeadlineHours: 24, validityMonths: 3 },
      bookings: [
        booking(1, "2026-10-13", "18:00", "done", true),
        booking(2, "2026-10-20", "18:00", "done", true),
        booking(3, "2026-10-27", "18:00", "done", true),
        booking(4, "2026-11-03", "18:00", "done", true),
        // 시작 9시간 전 — 회원 요청 취소면 1회 차감(24시간 규칙)
        booking(5, "2026-11-24", "18:00", "booked", false),
      ],
      openSlots: [slot(1, "2026-11-26", "21:00"), slot(2, "2026-11-28", "17:00"), slot(3, "2026-11-29", "13:00")],
    },
    pendingPass: {
      passId: PASS_PENDING, academyId: GANGNAM, academyName: "라틴하우스 강남", productClassId: PRODUCT, lessonMinutes: 50,
      student: { displayName: "정민호" }, nameVisible: true, discipline: "rumba", status: "pending_payment",
      sessionsTotal: 10, sessionsUsed: 0, remainingSessions: 10, paidAt: null, validUntil: null,
      nextBooking: null, awaitingPayment: { until: "2026-11-26T14:59:00Z" },
      payment: null, rule: { version: 2, changeDeadlineHours: 24, validityMonths: 3 }, bookings: [], openSlots: [slot(1, "2026-11-26", "21:00")],
    },
    rule: { version: 2, changeDeadlineHours: 24, validityMonths: 3, effectiveFrom: "2026-11-20T01:00:00Z" },
  };
}

function listItem(p) {
  const { payment: _p, rule: _r, bookings: _b, openSlots: _o, ...rest } = p;
  return rest;
}
function notice(h, m) {
  return [`레슨 시작 ${h}시간 전까지 바꾸거나 취소할 수 있어요`, "그 뒤에 취소하거나 오지 않으면 1회가 차감돼요", `수강권은 결제일부터 ${m}개월 안에 써요`, "남은 회차 환불은 학원에 문의해요"];
}

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
    const pass = state.pass;
    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT" } });
    }
    if (method === "GET" && path === "/api/instructor/me/profile") return json(200, PROFILE);
    if (method === "GET" && path === "/api/instructor/affiliations") return json(200, AFFILIATIONS);
    if (method === "GET" && path === "/api/instructor/schedule") return json(200, { from: url.searchParams.get("from"), to: url.searchParams.get("to"), items: [], overlaps: [] });
    if (method === "GET" && path === "/api/instructor/private-lesson-passes") return json(200, { items: [listItem(pass), listItem(state.pendingPass)] });
    if (method === "GET" && path === `/api/instructor/private-lesson-passes/${PASS}`) return json(200, pass);
    if (method === "GET" && path === `/api/instructor/private-lesson-passes/${PASS_PENDING}`) return json(200, state.pendingPass);
    if (method === "POST" && path === `/api/instructor/private-lesson-passes/${PASS}/bookings`) {
      const b = body();
      sent.push({ kind: "book", body: b, idempotencyKey: key() });
      const s = pass.openSlots.find((o) => o.slotId === b.slotId);
      if (!s) return json(409, { detail: "그 시간은 이미 예약됐거나 닫혔어요", code: "SLOT_NOT_OPEN" });
      pass.openSlots = pass.openSlots.filter((o) => o.slotId !== b.slotId);
      const nb = { bookingId: uuid(106), slotId: s.slotId, startsAt: s.startsAt, endsAt: s.endsAt, status: "booked", deducted: false };
      pass.bookings = [...pass.bookings, nb];
      return json(201, { bookingId: nb.bookingId, slotId: s.slotId, status: "booked", remainingToBook: 4 });
    }
    const m = /^\/api\/instructor\/private-lesson-bookings\/([^/]+)\/(reschedule|cancel)$/.exec(path);
    if (method === "POST" && m) {
      const b = body();
      sent.push({ kind: m[2], bookingId: m[1], body: b, idempotencyKey: key() });
      const target = pass.bookings.find((x) => x.bookingId === m[1]);
      if (!target) return json(404, { detail: "회차를 찾을 수 없어요", code: "NOT_FOUND" });
      if (m[2] === "cancel") {
        const late = b.by === "member" && Date.parse(target.startsAt) - NOW.getTime() < 24 * 3_600_000;
        const status = b.by === "instructor" ? "cancelled_instructor" : late ? "cancelled_member_late" : "cancelled_member_free";
        pass.bookings = pass.bookings.map((x) => (x.bookingId === m[1] ? { ...x, status, deducted: late } : x));
        if (late) {
          pass.sessionsUsed += 1;
          pass.remainingSessions -= 1;
        }
        return json(200, { bookingId: m[1], status, deducted: late, sessionsUsed: pass.sessionsUsed, remainingSessions: pass.remainingSessions });
      }
      return json(200, { bookingId: m[1], slotId: b.slotId, startsAt: target.startsAt, endsAt: target.endsAt, status: "booked" });
    }
    if (method === "GET" && path === "/api/instructor/private-lesson-rules") {
      sent.push({ kind: "rule-get", search: url.search });
      const r = state.rule;
      return json(200, { academyId: GANGNAM, ...r, memberNotice: notice(r.changeDeadlineHours, r.validityMonths), current: { academyId: GANGNAM, ...r }, isDefault: false });
    }
    if (method === "POST" && path === "/api/instructor/private-lesson-rules") {
      const b = body();
      sent.push({ kind: "rule-save", body: b, idempotencyKey: key() });
      const r = state.rule;
      const same = r.changeDeadlineHours === b.changeDeadlineHours && r.validityMonths === b.validityMonths;
      if (!same) state.rule = { version: r.version + 1, changeDeadlineHours: b.changeDeadlineHours, validityMonths: b.validityMonths, effectiveFrom: NOW.toISOString() };
      const n = state.rule;
      return json(same ? 200 : 201, { academyId: GANGNAM, ...n, memberNotice: notice(n.changeDeadlineHours, n.validityMonths) });
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
  const state = freshState();
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await page.clock.setFixedTime(NOW);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installApiMock(page, apiLog, sent, state);
    mkdirSync(outDir, { recursive: true });
    const text = () => page.evaluate(() => document.body.innerText);
    const wait = (t) => page.getByText(t).first().waitFor({ timeout: RENDER_TIMEOUT_MS });

    // ---- I10 입구 ----
    await page.goto(`${baseUrl}/instructor/private-lessons`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await wait("정민호");
    check((await page.getByRole("button", { name: "김서연 수강생 상세" }).count()) === 1, "I10 수강권 줄이 눌리는 버튼(김서연 수강생 상세)");
    check((await text()).includes("시간 잡기 ›") && !(await text()).includes("시간 잡기, 준비 중"), "「시간 잡기 ›」가 준비 중이 아님");
    await shot(page, "I10-입구.png");

    // ---- I20 ----
    await page.getByRole("button", { name: "김서연 수강생 상세" }).click();
    await page.waitForURL(new RegExp(`/instructor/private-lessons/passes/${PASS}$`), { timeout: RENDER_TIMEOUT_MS });
    await wait("다음 회차 잡기");
    let body = await text();
    check(body.includes("김서연") && body.includes("결제 완료") && body.includes("라틴 10회 수강권 · 50분 · 라틴하우스 강남"), "머리: 김서연 · 결제 완료 · 라틴 10회 수강권 · 50분 · 학원");
    check(body.includes("10/6 (화) 결제 · 신용카드 · 600,000원"), "결제 줄: 10/6 (화) 결제 · 신용카드 · 600,000원");
    check(body.includes("사용 기한 2027-01-05 (화)까지 · 결제일부터 3개월"), "사용 기한 2027-01-05 (화)까지 · 결제일부터 3개월");
    check(body.includes("4회 진행 · 남은 6회") && body.includes("마지막 레슨 11/3 (화) 18:00 · 4/10회"), "회차 4회 진행 · 남은 6회 · 마지막 레슨 11/3 · 4/10회");
    check(body.includes("잡힌 회차") && body.includes("11/24 (화) 18:00–18:50") && body.includes("5/10회 · 예약됨"), "잡힌 회차 5/10회 11/24 18:00");
    check(body.includes("다음 회차 잡기 · 6/10회") && body.includes("11/26 (목) 21:00–21:50") && body.includes("라틴하우스 강남 연습실"), "다음 회차 잡기 6/10회 · 레슨 모집 시간 · 연습실");
    check(body.includes("시작 24시간 전까지는 바꾸거나 취소해도 회차가 그대로예요"), "이 수강권 규칙(24시간) 상자");
    check(await page.getByRole("button", { name: "시간을 골라 주세요" }).isDisabled(), "시간을 고르기 전에는 잡기 꺼짐");
    await page.getByRole("radio", { name: "11/26 (목) 21:00–21:50" }).click();
    check((await page.getByRole("radio", { name: "11/26 (목) 21:00–21:50" }).getAttribute("aria-checked")) === "true", "첫 시간 골라짐(aria-checked)");
    await shot(page, "I20.png");

    await page.getByRole("button", { name: "11/26 (목) 21:00 으로 잡기" }).click();
    await wait("11/26 (목) 21:00 으로 잡았어요. 김서연 님에게 알림이 갔어요.");
    let s = sent.filter((x) => x.kind === "book").at(-1);
    check(JSON.stringify(s?.body) === JSON.stringify({ slotId: uuid(301) }) && typeof s?.idempotencyKey === "string" && s.idempotencyKey.length >= 8, `잡기 본문·Idempotency-Key: ${JSON.stringify(s)}`);
    await wait("6/10회 · 예약됨");
    body = await text();
    check(body.includes("다음 회차 잡기 · 7/10회") && !body.includes("11/26 (목) 21:00–21:50 라틴") , "잡은 뒤 다시 읽음: 7/10회 · 잡은 시간은 모집 목록에서 빠짐");
    await shot(page, "I20-잡은-뒤.png");

    // ---- I20B 강사 사정 취소(방금 잡은 6회차) ----
    await page.getByRole("button", { name: "6회차 11/26 (목) 21:00 바꾸기·취소" }).click();
    await page.waitForURL(/\/bookings\//, { timeout: RENDER_TIMEOUT_MS });
    await wait("무엇을 할까요");
    body = await text();
    check(body.includes("김서연 · 6/10회") && body.includes("예약됨") && body.includes("11/26 (목) 21:00–21:50 · 라틴하우스 강남"), "머리: 김서연 · 6/10회 · 예약됨 · 시간");
    check(body.includes("지금은 시작 24시간 전이라 차감 없이 취소돼요"), "회원 요청 줄: 60시간 전이라 차감 없음");
    check(body.includes("결제·환불 문의는 라틴하우스 강남 대표가 받아요. 강사는 회차만 정리해요."), "환불은 대표 안내");
    await page.getByRole("radio", { name: "강사 사정으로 취소" }).click();
    check(await page.getByRole("button", { name: "취소 사유를 적어 주세요" }).isDisabled(), "강사 사정은 사유가 비면 꺼짐(서버 필수)");
    await page.getByLabel("취소 사유").fill("대회 심사 일정이 생겼어요");
    body = await text();
    check(body.includes("[개인 레슨] 이준호 강사") && body.includes("11/26 (목) 21:00 레슨이 강사 사정으로 취소됐어요. 회차는 그대로 남아 있어요 (남은 6회).") && body.includes("사유: 대회 심사 일정이 생겼어요"), "알림 미리 보기(강사 이름 · 남은 6회 · 사유)");
    await shot(page, "I20B.png");
    await page.getByRole("button", { name: "강사 사정으로 취소하기" }).click();
    await wait("강사 사정으로 취소했어요. 회차를 돌려줬어요 · 남은 6회.");
    s = sent.filter((x) => x.kind === "cancel").at(-1);
    check(s?.bookingId === uuid(106) && JSON.stringify(s.body) === JSON.stringify({ by: "instructor", reason: "대회 심사 일정이 생겼어요" }), `강사 사정 취소 본문: ${JSON.stringify(s)}`);
    await wait("취소됨");
    body = await text();
    check(body.includes("김서연 · 회차 돌려줌") && !body.includes("찾지 못했어요") && !body.includes("이미 지나갔거나") && body.includes("김서연 님 화면으로"), "다시 읽은 뒤: 취소됨 · 회차 돌려줌 · 결과 문구 유지");
    await shot(page, "I20B-취소-뒤.png");

    // ---- I20B 시간 바꾸기 · 회원 요청(5회차, 시작 9시간 전) ----
    await page.goto(`${baseUrl}/instructor/private-lessons/passes/${PASS}/bookings/${uuid(105)}`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await wait("무엇을 할까요");
    body = await text();
    check(body.includes("김서연 · 5/10회") && body.includes("시작 24시간 전이 지나 1회가 차감돼요"), "5회차: 기한이 지나 1회 차감 안내");
    await page.getByRole("radio", { name: "시간 바꾸기" }).click();
    await page.getByRole("radio", { name: "11/28 (토) 17:00–17:50" }).click();
    body = await text();
    check(body.includes("11/24 (화) 18:00 레슨이 11/28 (토) 17:00 으로 바뀌었어요. 회차는 그대로예요 (5/10회).") && (await page.getByRole("button", { name: "11/28 (토) 17:00 으로 바꾸기" }).isEnabled()), "시간 바꾸기 미리 보기 · 버튼 켜짐");
    await shot(page, "I20B-시간-바꾸기.png");
    await page.getByRole("radio", { name: "회원 요청으로 취소" }).click();
    body = await text();
    check(body.includes("기한이 지나 1회가 차감됐어요 (남은 5회).") && body.includes("취소 사유 · 선택 · 회원에게 보여요"), "회원 요청: 차감 미리 보기 · 사유 선택");
    check(await page.getByRole("button", { name: "회원 요청으로 취소하기" }).isEnabled(), "회원 요청은 사유 없이도 켜짐");
    await shot(page, "I20B-회원-요청.png");
    await page.getByRole("button", { name: "회원 요청으로 취소하기" }).click();
    await wait("회원 요청으로 취소했어요. 기한이 지나 1회 차감 · 남은 5회.");
    s = sent.filter((x) => x.kind === "cancel").at(-1);
    check(s?.bookingId === uuid(105) && JSON.stringify(s.body) === JSON.stringify({ by: "member" }), `회원 요청 취소 본문(사유 없으면 뺌): ${JSON.stringify(s)}`);
    check(sent.filter((x) => x.kind === "reschedule").length === 0, "시간 바꾸기는 고르기만 하고 보내지 않음");
    await wait("취소됨");
    body = await text();
    check(body.includes("김서연 · 5/10회") && !body.includes("이미 지나갔거나"), "다시 읽은 뒤: 취소됨 · 차감된 회차라 5/10회 번호 유지");
    await shot(page, "I20B-회원-요청-뒤.png");

    // ---- 결제 대기 수강권 ----
    await page.goto(`${baseUrl}/instructor/private-lessons/passes/${PASS_PENDING}`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await wait("정민호");
    body = await text();
    check(body.includes("결제 대기 · 11/26 23:59까지") && body.includes("결제가 끝나면 다음 회차를 잡을 수 있어요.") && !body.includes("다음 회차 잡기"), "결제 대기: 이름 보임 · 마감 · 잡기 없음");
    await shot(page, "I20-결제대기.png");

    // ---- I20C ----
    await page.goto(`${baseUrl}/instructor/private-lessons/passes/${PASS}`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await wait("규칙 바꾸기 ›");
    await page.getByRole("button", { name: "규칙 바꾸기 ›" }).click();
    await page.waitForURL(/\/private-lessons\/rules/, { timeout: RENDER_TIMEOUT_MS });
    await wait("회원에게 이렇게 보여요");
    check(sent.filter((x) => x.kind === "rule-get").at(-1)?.search === `?academyId=${GANGNAM}`, "규칙 GET ?academyId=");
    body = await text();
    check(body.includes("라틴하우스 강남 · 개인 레슨 수강권") && body.includes("지금 판본 2 · 11/20 부터"), "머리: 학원 · 판본 2");
    check((await page.getByRole("radio", { name: "24시간 전" }).getAttribute("aria-checked")) === "true" && (await page.getByRole("radio", { name: "3개월 · 추천" }).getAttribute("aria-checked")) === "true", "24시간 전 · 3개월 · 추천 골라짐");
    check(body.includes("1회 차감") && body.includes("회차를 돌려줘요") && body.split("바꿀 수 없어요").length - 1 === 2 && body.includes("금액은 학원 대표가 정해요"), "고정 규칙 셋");
    check(body.includes("· 레슨 시작 24시간 전까지 바꾸거나 취소할 수 있어요") && body.includes("· 수강권은 결제일부터 3개월 안에 써요"), "회원 안내 4줄");
    check(await page.getByRole("button", { name: "저장" }).isDisabled(), "바꾼 게 없으면 저장 꺼짐");
    await shot(page, "I20C.png");
    await page.getByRole("radio", { name: "48시간 전" }).click();
    await page.getByRole("radio", { name: "6개월" }).click();
    body = await text();
    check(body.includes("· 레슨 시작 48시간 전까지 바꾸거나 취소할 수 있어요") && body.includes("· 수강권은 결제일부터 6개월 안에 써요"), "칩을 바꾸면 안내 문장이 바로 바뀜");
    await shot(page, "I20C-바꿈.png");
    await page.getByRole("button", { name: "저장" }).click();
    await wait("판본 3 으로 저장했어요. 이제부터 결제하는 수강권에 적용돼요.");
    s = sent.filter((x) => x.kind === "rule-save").at(-1);
    check(JSON.stringify(s?.body) === JSON.stringify({ academyId: GANGNAM, changeDeadlineHours: 48, validityMonths: 6 }) && typeof s?.idempotencyKey === "string" && s.idempotencyKey.length >= 8, `규칙 저장 본문·키: ${JSON.stringify(s)}`);
    await wait("지금 판본 3");
    await shot(page, "I20C-저장.png");

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
