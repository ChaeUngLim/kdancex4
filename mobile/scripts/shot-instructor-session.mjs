// 강사 앱 회차 상세(I6B) · 수강생 공지(I13 · I13B) · 대타(I14 · I14B · I14C) · 소속 해제(I28 · I28B) 화면을
// Expo 웹으로 띄워 장면을 찍는다 — 로드맵 S2-3.8(앱 변경·대타·공지 화면).
//
//   실행(mobile 폴더에서): node scripts/shot-instructor-session.mjs --out-dir <폴더> [--port 8097]
//   결과(<폴더> 안):
//     I6B.png            회차 상세 · 수업 관리 — 머리 두 줄 · 수업 관리|회원 관리 · 인원 줄 · 메뉴 넷 · 대타 요청
//     I13.png            공지 쓰기 — 받는 사람 10명(남 4 · 여 6) · 종류 칩 · 제목 · 내용 · 앱 알림 켜짐
//     I13B.png           공지 미리보기 — 알림함 모양 + 수업 상세 「강사 공지」 모양 · 「10명에게 보내기」
//     I13-보낸-뒤.png     보낸 뒤 「공지를 보냈어요 · 10명」
//     I14.png            대타 요청 — 후보 셋(둘 고름 · 한 명은 「그 시간에 일정이 있어요」) · 전할 말 · 진행 네 칸
//     I14B.png           요청 진행 상황 — 요청 ✓ · 김하나 수락 ✓ · 대표 확인 기다림 · 수강생 공지 · 「요청 취소」
//     I14B-취소-뒤.png    취소 뒤 「요청을 취소했어요」 · 버튼 없음
//     I14C.png           받은 대타 요청 — 「이준호 강사가 대타를 부탁했어요」 · 수강생·전할 말·정산 · 거절|수락하기
//     I14C-수락-뒤.png    수락 뒤 「수락했어요 · 대표가 확인하면…」
//     I28.png            소속 해제 — 수업 둘 중 하나만 정해 버튼 꺼짐 「2가지를 정하면 해제할 수 있어요」
//     I28B.png           확인 시트 — 처리별 묶음 · 받는 회원 명단 · 「받는 회원 12명 · 알림은 회원마다 1건」
//     I28-요청-뒤.png     요청 뒤 「해제를 요청했어요」
//
// 왜 서버 응답을 꾸며 넣나(shot-instructor-class.mjs 와 같은 이유): 웹 실행에는 SecureStore 가 없어 로그인 토큰을 저장할 수 없다.
//   그래서 `/api/**` 를 가로채 계약 11(§4-2 · §4-6 · §6-3 · §8 · §3-3 · §9-1) 모양의 예시를 돌려주고, 화면은 주소로 바로 연다.
//   서버 동작은 S2-3.4 · S2-3.5 · S2-3.6 · S2-1.4 의 DB 테스트가 확인했다. 화면이 보낸 본문이 기대와 다르면 exit 1 로 끝낸다.
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

const port = Number(readArg("port", "8097"));
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/instructor-session")));
const baseUrl = `http://localhost:${port}`;

// ---- 예시 응답. 이름·학원·시간은 보드 I6B · I14 · I14B · I14C · I28 · I28B 예시 ----
const LATIN = "11111111-1111-4111-8111-111111111111"; // 라틴하우스 강남
const CLASS_ID = "88888888-8888-4888-8888-888888888881";
const SESSION_ID = "99999999-9999-4999-8999-999999999901";
const ROOM_A = "77777777-7777-4777-8777-777777777771";
const JUNHO = "66666666-6666-4666-8666-666666666666";
const HANA = "66666666-6666-4666-8666-666666666601";
const SEOYUN = "66666666-6666-4666-8666-666666666602";
const HAEUN = "66666666-6666-4666-8666-666666666603";
const REQ_MINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
const REQ_RECEIVED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02";
const AFF_SEOCHO = "55555555-5555-4555-8555-555555555552";
const WALTZ = "88888888-8888-4888-8888-888888888891";
const CHACHA = "88888888-8888-4888-8888-888888888892";

const CLASS = {
  classId: CLASS_ID, academyId: LATIN, academyName: "라틴하우스 강남", status: "published", classKind: "regular",
  title: "쌈바(입문)", genre: "dance_sport", subGenre: "latin", discipline: "samba", targetLevel: "entry", targetAges: ["all"],
  room: { roomId: ROOM_A, name: "A홀" },
  schedule: { kind: "recurring", weekdays: ["mon", "wed"], startTime: "20:30", endTime: "21:30", periodFrom: "2026-11-02", periodTo: "2026-12-23", sessionCount: 16 },
  capacity: { mode: "gender_split", male: 6, female: 6, any: null }, priceAmount: 300000, isFree: false, refundDeadlineOn: null,
  refundNotice: null, instructor: { accountId: JUNHO, displayName: "이준호" }, revisionRequest: null, submittedAt: "2026-10-20T03:00:00Z",
};
// 11/18 (수) 20:30–21:30 KST = 11:30Z–12:30Z
const SESSION = {
  sessionId: SESSION_ID, seq: 12, startsAt: "2026-11-18T11:30:00Z", endsAt: "2026-11-18T12:30:00Z", status: "scheduled",
  room: { roomId: ROOM_A, name: "A홀" }, instructor: { accountId: JUNHO, displayName: "이준호" }, isSubstitute: false,
  confirmedMemberCount: 10, substituteRequest: null,
};
const RECIPIENTS = { recipientCount: 10, male: 4, female: 6, excluded: "결제 대기·대기 신청은 받지 않아요" };
const CANDIDATES = {
  sessionId: SESSION_ID,
  items: [
    { accountId: HANA, displayName: "김하나", genre: "dance_sport", available: true, unavailableReason: null },
    { accountId: SEOYUN, displayName: "박서윤", genre: "dance_sport", available: true, unavailableReason: null },
    { accountId: HAEUN, displayName: "최하은", genre: "dance_sport", available: false, unavailableReason: "busy" },
  ],
};
const SESSION_OUT = {
  sessionId: SESSION_ID, classId: CLASS_ID, classTitle: "쌈바(입문)", startsAt: SESSION.startsAt, endsAt: SESSION.endsAt,
  roomName: "A홀", memberCount: { male: 4, female: 6, any: 0 },
};
const MESSAGE = "이번 회차만 부탁드려요. 진도는 베이직 3번까지 나갔어요.";

/** 내가 보낸 요청 — 상태(open·accepted·cancelled)에 맞춰 timeline 을 만든다(substitute-request-queries.ts timelineOf 와 같은 규칙) */
function myRequest(status) {
  const timeline = [{ step: "requested", at: "2026-11-12T01:20:00Z" }];
  if (status !== "open") timeline.push({ step: "accepted", at: "2026-11-12T02:05:00Z" });
  if (status === "cancelled") timeline.push({ step: "cancelled", at: "2026-11-12T03:00:00Z" });
  return {
    requestId: REQ_MINE, session: SESSION_OUT, status, candidateStatus: null,
    requestedBy: { accountId: JUNHO, displayName: "이준호" },
    acceptedBy: status === "open" ? null : { accountId: HANA, displayName: "김하나" },
    message: MESSAGE, timeline,
  };
}
/** 받은 요청(김하나 입장) — 후보 상태 invited → accepted */
function receivedRequest(candidateStatus) {
  const accepted = candidateStatus === "accepted";
  return {
    requestId: REQ_RECEIVED, session: SESSION_OUT, status: accepted ? "accepted" : "open", candidateStatus,
    requestedBy: { accountId: JUNHO, displayName: "이준호" },
    acceptedBy: accepted ? { accountId: HANA, displayName: "김하나" } : null,
    message: MESSAGE,
    timeline: accepted ? [{ step: "requested", at: "2026-11-12T01:20:00Z" }, { step: "accepted", at: "2026-11-12T02:05:00Z" }] : [{ step: "requested", at: "2026-11-12T01:20:00Z" }],
  };
}

const CARDS = {
  items: [
    {
      affiliationId: AFF_SEOCHO, academyId: "11111111-1111-4111-8111-111111111112", academyName: "라틴스텝 서초", status: "active",
      source: "application", requestedAt: "2026-09-30T01:00:00Z", decidedAt: "2026-10-02T01:00:00Z",
      rejectReasonCode: null, rejectReasonText: null, releasedAt: null, calendarColorIndex: 3,
    },
  ],
};
// 남은 회차: 왈츠(초급) 화 21:10–22:10 6회(12/1 부터, 10명) · 차차차(입문) 금 19:00–20:00 2회(3명)
const WALTZ_SESSIONS = Array.from({ length: 6 }, (_, i) => ({
  sessionId: `99999999-9999-4999-8999-9999999991${String(i).padStart(2, "0")}`,
  classId: WALTZ, classTitle: "왈츠(초급)",
  startsAt: new Date(Date.parse("2026-12-01T12:10:00Z") + i * 7 * 86_400_000).toISOString().replace(".000", ""),
  endsAt: new Date(Date.parse("2026-12-01T13:10:00Z") + i * 7 * 86_400_000).toISOString().replace(".000", ""),
  roomName: "B실", memberCount: 10,
}));
const CHACHA_SESSIONS = Array.from({ length: 2 }, (_, i) => ({
  sessionId: `99999999-9999-4999-8999-9999999992${String(i).padStart(2, "0")}`,
  classId: CHACHA, classTitle: "차차차(입문)",
  startsAt: new Date(Date.parse("2026-12-04T10:00:00Z") + i * 7 * 86_400_000).toISOString().replace(".000", ""),
  endsAt: new Date(Date.parse("2026-12-04T11:00:00Z") + i * 7 * 86_400_000).toISOString().replace(".000", ""),
  roomName: "A실", memberCount: 3,
}));
const WALTZ_MEMBERS = ["김서연", "이도윤", "박하린", "최민준", "정유나", "한지우", "오세린", "윤태오", "임가은", "서지안"];
const CHACHA_MEMBERS = ["김서연", "문하준", "배수아"]; // 김서연은 두 수업 모두 — 받는 회원은 한 명으로 센다
const ACTION_TEXT = {
  substitute: (title) => `「${title} 은 대표가 정한 대체 강사가 진행해요. 원하면 환불을 요청할 수 있어요.」`,
  cancel_session: (title) => `「${title} 수업이 휴강해요. 7일 안에 다른 회차로 옮기거나 환불을 골라 주세요.」`,
  close: (title) => `「${title} 남은 회차가 폐강돼요. 남은 회차만큼 환불돼요.」`,
};

/** 계약 11 §9-1 release-preview 응답을 받은 결정으로 계산한다 */
function releasePreviewOf(body) {
  const decisions = body.sessionDecisions ?? [];
  const actionOf = (id) => decisions.find((d) => d.sessionId === id)?.action ?? null;
  const sessions = [...WALTZ_SESSIONS, ...CHACHA_SESSIONS].map((s) => ({
    ...s,
    decision: actionOf(s.sessionId) === null ? null : { action: actionOf(s.sessionId), substituteAccountId: null, substituteName: null, substituteAvailable: null },
  }));
  const bundles = [];
  for (const action of ["substitute", "cancel_session", "close"]) {
    const picked = sessions.filter((s) => s.decision?.action === action);
    if (picked.length === 0) continue;
    const titles = [...new Set(picked.map((s) => s.classTitle))];
    const names = [...new Set(picked.flatMap((s) => (s.classId === WALTZ ? WALTZ_MEMBERS : CHACHA_MEMBERS)))];
    bundles.push({
      action, sessionCount: picked.length, memberCount: names.length, messagePreview: ACTION_TEXT[action](titles.join(" · ")),
      members: names.map((n, i) => ({ displayName: n, payKind: i === 2 ? "pass" : "paid" })),
    });
  }
  const everyone = new Set(bundles.flatMap((b) => b.members.map((m) => m.displayName)));
  const undecided = sessions.filter((s) => s.decision === null).map((s) => s.sessionId);
  return {
    affiliationId: AFF_SEOCHO, instructor: { accountId: JUNHO, displayName: "이준호" },
    remaining: { sessions, privateLessonPasses: [] },
    bundles, totals: { memberCount: everyone.size, notificationCount: everyone.size }, undecided, canRelease: false,
  };
}

/** `/api/**` 를 계약 모양 예시로 답한다. state 에 요청 상태를 들고 있다 */
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
    if (method === "GET" && path === `/api/classes/${CLASS_ID}`) return json(200, CLASS);
    if (method === "GET" && path === `/api/classes/${CLASS_ID}/sessions`) {
      const substituteRequest = state.mine === null ? null : { requestId: REQ_MINE, status: state.mine };
      return json(200, { items: [{ ...SESSION, substituteRequest }] });
    }
    if (method === "GET" && path === `/api/classes/${CLASS_ID}/announcement-recipients`) {
      sent.push({ kind: "recipients", search: url.search });
      return json(200, RECIPIENTS);
    }
    if (method === "POST" && path === `/api/classes/${CLASS_ID}/announcements`) {
      sent.push({ kind: "announce", body: body(), idempotencyKey: key() });
      return json(201, { announcementId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01", recipientCount: 10, createdAt: "2026-11-21T06:00:00Z" });
    }
    if (method === "GET" && path === `/api/sessions/${SESSION_ID}/substitute-candidates`) return json(200, CANDIDATES);
    if (method === "POST" && path === "/api/instructor/substitute-requests") {
      sent.push({ kind: "substitute", body: body(), idempotencyKey: key() });
      // 보드 I14B 처럼 김하나 강사가 바로 수락한 상태를 보여 주려고, 만든 뒤 목록에서는 accepted 로 돌려준다
      state.mine = "accepted";
      return json(201, { requestId: REQ_MINE, sessionId: SESSION_ID, status: "open", candidates: [], steps: ["requested", "accepted", "owner_confirmed", "members_notified"] });
    }
    if (method === "GET" && path === "/api/instructor/substitute-requests") {
      const role = url.searchParams.get("role");
      if (role === "requested") return json(200, { items: state.mine === null ? [] : [myRequest(state.mine)] });
      if (role === "received") return json(200, { items: [receivedRequest(state.received)] });
    }
    const verb = /^\/api\/instructor\/substitute-requests\/([^/]+)\/(accept|decline|cancel)$/.exec(path);
    if (method === "POST" && verb) {
      const [, id, action] = verb;
      sent.push({ kind: action, id, body: body() });
      if (action === "cancel") state.mine = "cancelled";
      if (action === "accept") state.received = "accepted";
      if (action === "decline") state.received = "declined";
      return json(200, { requestId: id, status: action === "cancel" ? "cancelled" : action === "accept" ? "accepted" : "open" });
    }
    if (method === "GET" && path === "/api/instructor/affiliations") return json(200, CARDS);
    if (method === "POST" && path === `/api/instructor/affiliations/${AFF_SEOCHO}/release-preview`) {
      sent.push({ kind: "release-preview", body: body() });
      return json(200, releasePreviewOf(body()));
    }
    if (method === "POST" && path === `/api/instructor/affiliations/${AFF_SEOCHO}/release-requests`) {
      sent.push({ kind: "release-request", body: body(), idempotencyKey: key() });
      return json(201, { requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccc01", status: "requested", requestedAt: "2026-11-21T06:10:00Z", remainingSessionCount: 8 });
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
  const state = { mine: null, received: "invited" };
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installApiMock(page, apiLog, sent, state);
    mkdirSync(outDir, { recursive: true });
    const text = () => page.evaluate(() => document.body.innerText);
    const sessionUrl = `${baseUrl}/instructor/sessions/${SESSION_ID}?classId=${CLASS_ID}`;

    // ---- I6B 회차 상세 ----
    await page.goto(sessionUrl, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("수강생 공지 보내기").waitFor({ timeout: RENDER_TIMEOUT_MS });
    let body = await text();
    check(body.includes("쌈바(입문)") && body.includes("11/18 (수) 20:30–21:30 · 라틴하우스 강남 A홀"), "머리: 수업명 · 11/18 (수) 20:30–21:30 · 라틴하우스 강남 A홀");
    check(body.includes("정원 남 6 · 여 6 · 결제 10명 · 수업 전 인원은 「회원 관리」에서"), "인원 줄");
    check(["시간 · 장소 변경", "휴강 알리기", "오늘 결석자", "대타 요청"].every((t) => body.includes(t)), "메뉴 넷 + 대타 요청");
    check((await page.getByRole("button", { name: "시간 · 장소 변경, 준비 중" }).isDisabled()) && (await page.getByRole("button", { name: "휴강 알리기, 준비 중" }).isDisabled()), "맡은 Task 없는 줄은 「준비 중」으로 꺼짐");
    await shot(page, "I6B.png");

    // ---- I13 공지 쓰기 ----
    await page.getByRole("button", { name: "수강생 공지 보내기" }).click();
    await page.waitForURL(/\/announce\?classId=/, { timeout: RENDER_TIMEOUT_MS });
    await page.getByText("받는 사람").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(lastSent(sent, "recipients")?.search === `?sessionId=${SESSION_ID}`, "받는 사람 수를 이 회차로 읽음(?sessionId=)");
    body = await text();
    check(body.includes("쌈바(입문) 수강생 10명") && body.includes("남 4 · 여 6") && body.includes("결제 대기·대기 신청은 받지 않아요"), "받는 사람 10명 · 남 4 · 여 6 · 제외 안내");
    check(["일반", "준비물", "진도·복습"].every((t) => body.includes(t)) && !body.includes("휴강 공지"), "종류 칩 셋(변경·휴강 없음)");
    await page.getByRole("button", { name: "미리보기" }).click();
    check((await text()).includes("제목을 적어 주세요."), "빈 제목이면 미리보기로 안 넘어가고 안내");
    await page.getByRole("radio", { name: "준비물" }).click();
    await page.getByLabel("공지 제목").fill("다음 주는 개인 매트를 챙겨 주세요");
    await page.getByLabel("공지 내용").fill("11/25(수) 수업은 바닥 동작이 많아요. 개인 매트나 큰 수건을 챙겨 오세요.");
    check((await page.getByRole("switch", { name: "앱 알림으로도 보내기" }).getAttribute("aria-checked")) === "true", "앱 알림 기본 켜짐");
    await shot(page, "I13.png");

    // ---- I13B 미리보기 → 보내기 ----
    await page.getByRole("button", { name: "미리보기" }).click();
    await page.getByText("회원 알림함에 이렇게 보여요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    body = await text();
    check(body.includes("수업 상세 「강사 공지」에 이렇게 남아요") && body.includes("쌈바(입문) · 이준호 강사"), "알림함 모양 + 수업 상세 모양");
    check((await page.getByRole("button", { name: "10명에게 보내기" }).count()) === 1, "「10명에게 보내기」");
    await shot(page, "I13B.png");
    await page.getByRole("button", { name: "10명에게 보내기" }).click();
    await page.getByText("공지를 보냈어요 · 10명").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const announce = lastSent(sent, "announce");
    check(
      JSON.stringify(announce?.body) ===
        JSON.stringify({ sessionId: SESSION_ID, kind: "supplies", title: "다음 주는 개인 매트를 챙겨 주세요", body: "11/25(수) 수업은 바닥 동작이 많아요. 개인 매트나 큰 수건을 챙겨 오세요.", pushToo: true }),
      `공지 본문: ${JSON.stringify(announce?.body)}`,
    );
    check(typeof announce?.idempotencyKey === "string" && announce.idempotencyKey.length >= 8, "공지 Idempotency-Key");
    await shot(page, "I13-보낸-뒤.png");

    // ---- I14 대타 요청 ----
    await page.goto(sessionUrl, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByRole("button", { name: "대타 요청" }).click();
    await page.waitForURL(/\/substitute\?classId=/, { timeout: RENDER_TIMEOUT_MS });
    await page.getByText("누구에게 알릴까요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const sendButton = page.getByRole("button", { name: "대타 강사를 골라 주세요" });
    check(await sendButton.isDisabled(), "아무도 안 고르면 보내기 꺼짐");
    check(await page.getByRole("checkbox", { name: "최하은 강사, 그 시간에 일정이 있어요" }).isDisabled(), "일정 있는 강사는 고를 수 없음");
    body = await text();
    check(body.includes("그 시간에 일정이 있어요") && !/수업|개인 일정|다른 학원/.test(body.split("최하은 강사")[1]?.split("전할 말")[0] ?? ""), "무슨 일정인지는 안 보임");
    await page.getByRole("checkbox", { name: "김하나 강사" }).click();
    await page.getByRole("checkbox", { name: "박서윤 강사" }).click();
    await page.getByLabel("전할 말").fill(MESSAGE);
    check(body.includes("이 회차의 정산은 실제로 수업한 강사 몫으로 잡혀요."), "정산 안내");
    await shot(page, "I14.png");

    // ---- I14B 진행 상황 ----
    await page.getByRole("button", { name: "2명에게 대타 요청 보내기" }).click();
    await page.waitForURL(/\/substitute-status\?classId=/, { timeout: RENDER_TIMEOUT_MS });
    await page.getByText("대표 확인을 기다려요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const sub = lastSent(sent, "substitute");
    check(JSON.stringify(sub?.body) === JSON.stringify({ sessionId: SESSION_ID, candidateAccountIds: [HANA, SEOYUN], message: MESSAGE }), `대타 요청 본문: ${JSON.stringify(sub?.body)}`);
    check(typeof sub?.idempotencyKey === "string" && sub.idempotencyKey.length >= 8, "대타 요청 Idempotency-Key");
    body = await text();
    check(
      ["요청을 보냈어요", "11/12 (목) 10:20", "김하나 강사가 수락했어요", "11/12 (목) 11:05 · 먼저 수락한 강사로 정해졌어요", "라틴하우스 강남 대표에게 알림이 갔어요", "수강생 10명에게 「이번 회차는 김하나 강사가 진행해요」"].every((t) => body.includes(t)),
      "네 단계 글자(요청 · 수락 · 대표 확인 · 수강생 공지)",
    );
    check(body.includes("대표가 확인하기 전까지는 요청을 취소할 수 있어요."), "취소 안내");
    await shot(page, "I14B.png");
    await page.getByRole("button", { name: "요청 취소" }).click();
    await page.getByText("요청을 취소했어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(lastSent(sent, "cancel")?.id === REQ_MINE && JSON.stringify(lastSent(sent, "cancel")?.body) === "{}", "「요청 취소」 → cancel 본문 {}");
    check((await page.getByRole("button", { name: "요청 취소" }).count()) === 0, "취소 뒤 버튼 없음");
    await shot(page, "I14B-취소-뒤.png");

    // ---- I14C 받은 대타 요청 ----
    await page.goto(`${baseUrl}/instructor/substitutes/${REQ_RECEIVED}`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("이준호 강사가 대타를 부탁했어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    body = await text();
    check(["11/18 (수) 20:30–21:30 · 쌈바(입문)", "남 4 · 여 6", MESSAGE, "이 회차는 내 몫으로 잡혀요", "다른 강사가 먼저 수락하면 이 요청은 닫혀요."].every((t) => body.includes(t)), "I14C 카드 · 수강생 · 전할 말 · 정산 · 안내");
    check((await page.getByRole("button", { name: "거절" }).count()) === 1 && (await page.getByRole("button", { name: "수락하기" }).count()) === 1, "거절 | 수락하기");
    await shot(page, "I14C.png");
    await page.getByRole("button", { name: "수락하기" }).click();
    await page.getByText("수락했어요 · 대표가 확인하면 수강생에게 알림이 가요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(lastSent(sent, "accept")?.id === REQ_RECEIVED && JSON.stringify(lastSent(sent, "accept")?.body) === "{}", "「수락하기」 → accept 본문 {}");
    await shot(page, "I14C-수락-뒤.png");

    // ---- I28 소속 해제 ----
    await page.goto(`${baseUrl}/instructor/affiliations/${AFF_SEOCHO}/release`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("해제하기 전에 정할 것 2가지").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(JSON.stringify(sent.find((s) => s.kind === "release-preview")?.body) === JSON.stringify({ sessionDecisions: [], privateLessonDecisions: [] }), "처음 미리 보기는 빈 선택");
    body = await text();
    check(body.includes("라틴스텝 서초") && body.includes("10/2 (금)부터 소속"), "학원 카드 · 10/2 (금)부터 소속");
    check(body.includes("① 이후 회차 · 왈츠(초급)") && body.includes("화 21:10–22:10 · 남은 6회 · 결제 10명") && body.includes("② 이후 회차 · 차차차(입문)"), "수업별 카드 둘(회차 묶음)");
    await page.getByRole("radio", { name: "대체 강사" }).first().click();
    check((await text()).includes("대체 강사는 대표가 정해요"), "대체 강사 안내");
    const releaseButton = page.getByRole("button", { name: "2가지를 정하면 해제할 수 있어요" });
    check(await releaseButton.isDisabled(), "하나만 정하면 버튼 꺼짐");
    await shot(page, "I28.png");

    // ---- I28B 확인 시트 ----
    await page.getByRole("radio", { name: "휴강" }).nth(1).click();
    await page.getByRole("button", { name: "해제 요청" }).click();
    await page.getByText("해제를 요청할까요?").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const decided = lastSent(sent, "release-preview")?.body;
    check(
      decided?.sessionDecisions.length === 8 &&
        decided.sessionDecisions.filter((d) => d.action === "substitute").length === 6 &&
        decided.sessionDecisions.filter((d) => d.action === "cancel_session").length === 2 &&
        decided.sessionDecisions.every((d) => d.substituteAccountId === undefined),
      "시트 미리 보기: 왈츠 6회 substitute · 차차차 2회 cancel_session(대체 강사 id 없음)",
    );
    body = await text();
    check(body.includes("받는 회원 12명 · 알림은 회원마다 1건") && body.includes("김서연") && body.includes("서지안"), "받는 회원 12명(두 수업 겹치는 1명 한 번) · 명단");
    await shot(page, "I28B.png", { expand: false });
    await page.getByRole("button", { name: "해제 요청 보내기" }).click();
    await page.getByText("해제를 요청했어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const req = lastSent(sent, "release-request");
    check(
      req?.body.sessionChoices.length === 8 && JSON.stringify(req.body.privateLessonChoices) === "[]" && req.body.note === null &&
        req.body.sessionChoices.every((c) => Object.keys(c).join(",") === "sessionId,action"),
      "해제 요청 본문: sessionChoices 8 · privateLessonChoices [] · note null",
    );
    check(typeof req?.idempotencyKey === "string" && req.idempotencyKey.length >= 8, "해제 요청 Idempotency-Key");
    await shot(page, "I28-요청-뒤.png");

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
