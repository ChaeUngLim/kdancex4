// 강사 앱 수업 만들기(I2 → I2D · I2E) · 등록한 수업(I2S) 화면을 Expo 웹으로 띄워 장면을 찍는다
// — 로드맵 S2-2.9(앱 수업 등록 화면).
//
//   실행(mobile 폴더에서): node scripts/shot-instructor-class.mjs --out-dir <폴더> [--port 8096]
//   결과(<폴더> 안):
//     I2.png             1/2 칸을 다 채웠는데 월 20:00 이 룸바(중급)과 30분 겹침 → 겹침 상자 + 빈 시간 칩 3개, 「다음」 꺼짐
//     I2-겹침-해소.png    「월 20:30」 칩을 눌러 20:30–21:30 으로 바뀌고 「겹치는 일정 없어요 · 16회」, 「다음」 켜짐
//     I2D.png            2/2 정규 — 남 10 · 여 10, 대표가 쓴 정규 환불 공지(자동 입력, 읽기 전용) 여섯 줄, 요약 카드
//     I2S.png            수업 등록(PUT + submit) 뒤 등록한 수업 · 승인 중 · 「등록 취소」
//     I2S-취소-뒤.png     등록 취소(withdraw) → 임시 저장을 연 수업 만들기(칸 값 그대로)
//     I2E-마감일-빈칸.png  2/2 이벤트형(파티) — 환불 마감일이 비어 「수업 등록」 꺼짐 · 「비어 있으면 등록할 수 없어요」
//     I2E.png            환불 마감일 2026-12-15 를 넣은 뒤 · 취소 수수료 네 구간 + 「취소·환불 불가」 줄 · 계좌이체 안내
//
// 왜 서버 응답을 꾸며 넣나(shot-instructor-affiliation.mjs 와 같은 이유): 웹 실행에는 SecureStore 가 없어 로그인 토큰을 저장할 수 없다.
//   그래서 `/api/**` 를 가로채 계약(11 §3-4 · §4-1 · §4-2 · §4-4) 모양의 예시를 돌려주고, 화면은 주소로 바로 연다.
//   서버 동작은 S2-2.3 · S2-2.8a · S2-2.8b · S2-2.8c 의 DB 테스트가 확인했다. 화면이 보낸 본문은 기대와 다르면 exit 1 로 끝낸다.
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
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/instructor-class")));
const baseUrl = `http://localhost:${port}`;

// ---- 예시 응답. 이름·학원·시간은 보드 I2 · I2D · I2E · I2S 예시 ----
const LATIN = "11111111-1111-4111-8111-111111111111"; // 라틴하우스 강남
const AFF_LATIN = "55555555-5555-4555-8555-555555555551";
const ACCOUNT = "66666666-6666-4666-8666-666666666666";
const ROOM_A = "77777777-7777-4777-8777-777777777771";
const ROOM_B = "77777777-7777-4777-8777-777777777772";
const CLASS_IDS = ["88888888-8888-4888-8888-888888888881", "88888888-8888-4888-8888-888888888882"];
const STAFF_ME = {
  accountId: ACCOUNT,
  displayName: "이준호",
  roles: ["instructor"],
  secondFactorVerified: false,
  consoleAccess: false,
  academies: [{ academyId: LATIN, name: "라틴하우스 강남", as: "delegate", permissions: ["class_submit"], menus: [] }],
  platformMenus: [],
};
const PROFILE = {
  accountId: ACCOUNT,
  displayName: "이준호",
  activityGenre: "dance_sport",
  photo: null,
  careerYears: 10,
  bio: null,
  affiliations: [{ academyId: LATIN, name: "라틴하우스 강남", status: "active" }],
};
const CARDS = {
  items: [
    {
      affiliationId: AFF_LATIN,
      academyId: LATIN,
      academyName: "라틴하우스 강남",
      status: "active",
      source: "application",
      requestedAt: "2026-05-04T01:00:00.000000Z",
      decidedAt: "2026-05-05T01:00:00.000000Z",
      rejectReasonCode: null,
      rejectReasonText: null,
      releasedAt: null,
      calendarColorIndex: 8,
      // 앱 수업 등록 권한 — 2026-11-23 부터 소속 카드에서 읽는다(staff/me 는 웹 위임만)
      canSubmitClass: true,
    },
  ],
};
const ROOMS = {
  items: [
    { roomId: ROOM_A, branchName: "강남점", name: "A홀" },
    { roomId: ROOM_B, branchName: "강남점", name: "B홀" },
  ],
};
// 대표가 올린 환불 공지 판본(S1-3.4 정규 · S1-3.5 이벤트형 content 모양)
const REGULAR_NOTICE = {
  versionId: "99999999-9999-4999-8999-999999999991",
  kind: "regular",
  version: 3,
  content: {
    cancellableUntil: "수강 시작 전까지 언제든",
    tiers: [
      { point: "before_start", percent: 100 },
      { point: "before_one_third", percent: 67 },
      { point: "before_half", percent: 67 },
      { point: "after_half", percent: 0 },
    ],
    nonRefundableCases: "이미 들은 회차 · 기간이 끝난 수강권",
    processingBusinessDays: 5,
    ownerContact: "02-555-0101",
  },
  readOnly: true,
};
const EVENT_NOTICE = {
  versionId: "99999999-9999-4999-8999-999999999992",
  kind: "event",
  version: 1,
  content: {
    feeTiers: [
      { window: "d10_plus", percent: 0 },
      { window: "d9_d7", percent: 10 },
      { window: "d6_d3", percent: 20 },
      { window: "d2_to_deadline", percent: 30 },
    ],
    nonRefundableCases: "환불 마감일 다음 날부터",
    processingBusinessDays: 5,
    ownerContact: "02-555-0101",
  },
  readOnly: true,
};
const EVENT_KINDS = ["one_day", "event", "party", "performance", "competition"];

/** 받은 본문(POST·PUT) → 계약 11 §4-2 ClassRegistration */
function registrationOf(classId, body, status) {
  const event = EVENT_KINDS.includes(body.classKind);
  const notice = !event ? REGULAR_NOTICE : body.priceAmount === 0 ? null : EVENT_NOTICE;
  const room = ROOMS.items.find((r) => r.roomId === body.roomId) ?? null;
  const schedule =
    body.schedule === null
      ? null
      : { ...body.schedule, sessionCount: body.schedule.kind === "single" ? 1 : 16 };
  const capacity =
    body.capacity === null
      ? null
      : body.capacity.mode === "single"
        ? { mode: "single", male: null, female: null, any: body.capacity.any }
        : { mode: "gender_split", male: body.capacity.male, female: body.capacity.female, any: null };
  return {
    classId,
    academyId: body.academyId,
    academyName: "라틴하우스 강남",
    status,
    classKind: body.classKind,
    title: body.title,
    genre: body.genre,
    subGenre: body.subGenre,
    discipline: body.discipline,
    targetLevel: body.targetLevel,
    targetAges: body.targetAges,
    room: room === null ? null : { roomId: room.roomId, name: room.name },
    schedule,
    capacity,
    priceAmount: body.priceAmount,
    isFree: body.priceAmount === 0,
    refundDeadlineOn: event ? body.refundDeadlineOn : null,
    refundNotice: notice,
    instructor: { accountId: ACCOUNT, displayName: "이준호" },
    posterUrl: null,
    introText: null,
    revisionRequest: null,
    pendingEdit: null,
    paidCount: 0,
    submittedAt: status === "pending_approval" ? "2026-11-21T03:26:00Z" : null,
    approvedAt: null,
    createdAt: "2026-11-21T03:20:00Z",
    updatedAt: "2026-11-21T03:26:00Z",
  };
}

/**
 * 겹침 미리 보기(11 §4-1) 예시: 월요일 20:00 시작이면 이 강사의 「월 19:30–20:30 룸바(중급)」 와 30분 겹친다(보드 I2).
 * 첫 월요일 2026-12-07 19:30 KST = 10:30Z. 빈 시간 칩은 보드처럼 월 20:30 · 월 21:00 · 화 20:00.
 */
function scheduleCheckOf(body) {
  const s = body.schedule;
  const existing = [
    { weekday: "mon", startTime: "19:30", endTime: "20:30", label: "룸바(중급)" },
    { weekday: "wed", startTime: "18:00", endTime: "19:00", label: "다른 학원 일정" },
  ];
  if (s.kind === "single") {
    return { sessionCount: 1, firstStartsAt: "2026-12-24T12:00:00Z", lastEndsAt: "2026-12-24T14:00:00Z", existing: [], conflicts: [], roomConflicts: [], suggestions: [] };
  }
  const overlaps = s.weekdays.includes("mon") && s.startTime < "20:30" && s.endTime > "19:30";
  const conflicts = overlaps
    ? Array.from({ length: 8 }, (_, i) => ({
        startsAt: new Date(Date.parse("2026-12-07T10:30:00Z") + i * 7 * 86_400_000).toISOString().replace(".000", ""),
        endsAt: new Date(Date.parse("2026-12-07T11:30:00Z") + i * 7 * 86_400_000).toISOString().replace(".000", ""),
        overlapMinutes: 30,
        label: "룸바(중급)",
      }))
    : [];
  return {
    sessionCount: 16,
    firstStartsAt: "2026-12-07T11:30:00Z",
    lastEndsAt: "2027-01-27T12:30:00Z",
    existing: existing.filter((e) => s.weekdays.includes(e.weekday)),
    conflicts,
    roomConflicts: [],
    suggestions: overlaps
      ? [
          { weekday: "mon", startTime: "20:30", endTime: "21:30" },
          { weekday: "mon", startTime: "21:00", endTime: "22:00" },
          { weekday: "tue", startTime: "20:00", endTime: "21:00" },
        ]
      : [],
  };
}

/** 홍보 이미지 옵션(계약 16 §4-7) — 이 스크립트는 그 화면을 지나가기만 한다(장면은 shot-instructor-promo.mjs 가 찍는다) */
const PROMO_OPTIONS = {
  genre: "dance_sport",
  genreChip: { genre: "dance_sport", label: "라틴 댄스", locked: true },
  requiredChips: [
    { key: "who", label: "누가", options: ["커플", "단체", "솔로"] },
    { key: "mood", label: "분위기", options: ["열정적인", "우아한"] },
    { key: "place", label: "장소", options: ["스튜디오", "무대"] },
    { key: "color", label: "색감·조명", options: ["빨간 조명", "푸른 밤"] },
  ],
  examples: [],
  autoConditions: [{ id: "no_text", label: "이미지 안에 글자 없음", defaultOn: true, removable: false }],
  engines: [{ id: "cloudflare_flux_schnell", label: "FLUX.1 [schnell]", speed: "빠름", etaSeconds: 5, available: true, blockedScope: null, resetsAt: null, lastPicked: false }],
  preselectedEngineId: "cloudflare_flux_schnell",
  usage: { dailyLimit: 3, used: 0, remaining: 3, resetsAt: "2026-11-21T15:00:00Z", betaPhase: true, freeQuotaExhausted: false, freeQuotaScope: null },
  lastGeneration: null,
  maxSentenceLength: 200,
};

/** `/api/**` 를 계약 모양 예시로 답한다. state.classes 에 만든 수업을 들고 있다 */
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
    if (method === "GET" && path === "/api/staff/me") return json(200, STAFF_ME);
    if (method === "GET" && path === "/api/instructor/me/profile") return json(200, PROFILE);
    if (method === "GET" && path === "/api/instructor/affiliations") return json(200, CARDS);
    if (method === "GET" && path === `/api/instructor/affiliations/${AFF_LATIN}/rooms`) return json(200, ROOMS);
    if (method === "POST" && path === "/api/classes/schedule-check") {
      const body = request.postDataJSON();
      sent.push({ kind: "schedule-check", body });
      return json(200, scheduleCheckOf(body));
    }
    if (method === "POST" && path === "/api/classes") {
      const body = request.postDataJSON();
      sent.push({ kind: "create", body, idempotencyKey: request.headers()["idempotency-key"] ?? null });
      const classId = CLASS_IDS[state.created++];
      state.classes[classId] = registrationOf(classId, body, "draft");
      return json(201, state.classes[classId]);
    }
    // SX-6.9: 2/2 의 「다음 · 홍보 이미지」 뒤 화면(홍보 이미지·소개 문구)이 읽는 두 경로 — 아무것도 만들지 않은 상태
    if (method === "GET" && path === "/api/ai/promo-image/options") return json(200, PROMO_OPTIONS);
    const assetsMatch = /^\/api\/classes\/([^/]+)\/promo-assets$/.exec(path);
    if (method === "GET" && assetsMatch) {
      return json(200, { classId: assetsMatch[1], coverSource: null, coverFileId: null, coverUrl: null, introText: null, introSource: null, aiGenerated: false,
        aiMarks: { cover: null, intro: null }, aiImageGenerationId: null, introDraftId: null, reviewedAt: null, textOverlay: { source: "class_data" } });
    }
    const match = /^\/api\/classes\/([^/]+)(?:\/(submit|withdraw))?$/.exec(path);
    if (match) {
      const [, classId, verb] = match;
      const current = state.classes[classId];
      if (!current) return json(404, { detail: "수업을 찾을 수 없어요", code: "NOT_FOUND" });
      if (method === "GET" && !verb) return json(200, current);
      if (method === "PUT" && !verb) {
        const body = request.postDataJSON();
        sent.push({ kind: "put", id: classId, body });
        state.classes[classId] = registrationOf(classId, body, "draft");
        return json(200, state.classes[classId]);
      }
      if (method === "POST" && verb === "submit") {
        sent.push({ kind: "submit", id: classId, body: request.postDataJSON() });
        state.classes[classId] = { ...current, status: "pending_approval", submittedAt: "2026-11-21T03:26:00Z" };
        return json(200, state.classes[classId]);
      }
      if (method === "POST" && verb === "withdraw") {
        sent.push({ kind: "withdraw", id: classId, body: request.postDataJSON() });
        state.classes[classId] = { ...current, status: "draft", submittedAt: null };
        return json(200, state.classes[classId]);
      }
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

/** 화면 전체를 찍는다 — 스크롤 본문이 길어 보드처럼 한 장에 다 보이게, 스크롤 영역을 펼친 높이로 다시 맞춘다 */
async function shot(page, name) {
  await page.waitForTimeout(500);
  const height = await page.evaluate(() => {
    const scrollers = [...document.querySelectorAll("div")].filter((el) => el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== "visible");
    const extra = scrollers.reduce((max, el) => Math.max(max, el.scrollHeight - el.clientHeight), 0);
    return window.innerHeight + extra;
  });
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
  const state = { created: 0, classes: {} };
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installApiMock(page, apiLog, sent, state);
    mkdirSync(outDir, { recursive: true });
    const text = () => page.evaluate(() => document.body.innerText);

    // ---- I2 정규 수업 1/2 ----
    await page.goto(`${baseUrl}/instructor/classes/new`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("장르 · 세부 장르").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check((await text()).includes("1 / 2"), "머리에 1 / 2");
    await page.getByRole("radio", { name: "댄스스포츠(라틴)" }).click();
    await page.getByRole("radio", { name: "쌈바" }).click();
    check((await page.getByRole("radio", { name: "정규", checked: true }).count()) === 1, "수업 구분 처음 값 정규");
    await page.getByRole("radio", { name: "입문" }).click();
    await page.getByRole("checkbox", { name: "전체" }).click();
    await page.getByLabel("수업명").fill("쌈바(입문) · 12월");
    await page.getByLabel("금액").fill("300000");
    await page.getByRole("checkbox", { name: "월" }).click();
    await page.getByRole("checkbox", { name: "수" }).click();
    await page.getByLabel("기간 시작일").fill("2026-12-07");
    await page.getByLabel("기간 끝날").fill("2027-01-27");
    await page.getByLabel("시작 시각").fill("20:00");
    await page.getByLabel("끝 시각").fill("21:00");
    await page.getByRole("radio", { name: "강남점 A홀" }).click();
    await page.getByText("월 19:30 룸바(중급)과 30분 겹쳐요.", { exact: false }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    const checkBody = lastSent(sent, "schedule-check")?.body;
    check(
      JSON.stringify(checkBody) ===
        JSON.stringify({ academyId: LATIN, roomId: ROOM_A, excludeClassId: null, schedule: { kind: "recurring", weekdays: ["mon", "wed"], startTime: "20:00", endTime: "21:00", periodFrom: "2026-12-07", periodTo: "2027-01-27" } }),
      `겹침 미리 보기 본문: ${JSON.stringify(checkBody)}`,
    );
    const nextButton = page.getByRole("button", { name: "다음" });
    check(await nextButton.isDisabled(), "겹치면 「다음」 꺼짐(겹친 채 저장 버튼 없음)");
    let chipCount = 0;
    for (const label of ["월 20:30", "월 21:00", "화 20:00"]) chipCount += await page.getByRole("radio", { name: label, exact: true }).count();
    check(chipCount === 3, "빈 시간 칩 3개: 월 20:30 · 월 21:00 · 화 20:00");
    await shot(page, "I2.png");

    await page.getByRole("radio", { name: "월 20:30" }).click();
    await page.getByText("겹치는 일정 없어요 · 16회").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check((await page.getByLabel("시작 시각").inputValue()) === "20:30" && (await page.getByLabel("끝 시각").inputValue()) === "21:30", "칩을 누르면 20:30–21:30 으로 바뀜");
    check(!(await nextButton.isDisabled()), "겹침이 풀리면 「다음」 켜짐");
    await shot(page, "I2-겹침-해소.png");

    // ---- I2D 정규 2/2 ----
    await nextButton.click();
    await page.getByText("환불 · 취소 공지").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const created = lastSent(sent, "create");
    check(created !== null && typeof created.idempotencyKey === "string" && created.idempotencyKey.length >= 8, "「다음」 → POST /api/classes + Idempotency-Key");
    check(
      JSON.stringify(created?.body) ===
        JSON.stringify({
          academyId: LATIN, classKind: "regular", title: "쌈바(입문) · 12월", genre: "dance_sport", subGenre: "latin", discipline: "samba",
          targetLevel: "entry", targetAges: ["all"], roomId: ROOM_A, priceAmount: 300000,
          schedule: { kind: "recurring", weekdays: ["mon", "wed"], startTime: "20:30", endTime: "21:30", periodFrom: "2026-12-07", periodTo: "2027-01-27" },
          capacity: { mode: "gender_split", male: 0, female: 0 }, refundDeadlineOn: null, introText: null,
        }),
      `임시 저장 본문: ${JSON.stringify(created?.body)}`,
    );
    // SX-6.9 부터 2/2 의 주 버튼은 「다음 · 홍보 이미지」다 — 저장(PUT) 뒤 홍보 이미지 화면을 지나 거기서 「검토 끝 · 수업 등록」
    const registerButton = page.getByRole("button", { name: "다음 · 홍보 이미지" });
    check(await registerButton.isDisabled(), "정원 0 이면 「다음 · 홍보 이미지」 꺼짐");
    await page.getByLabel("남 정원", { exact: true }).fill("10");
    for (let i = 0; i < 10; i += 1) await page.getByRole("button", { name: "여 정원 하나 늘리기" }).click();
    let body = await text();
    check(body.includes("2 / 2"), "머리에 2 / 2");
    check(body.includes("수강 시작 전까지 언제든") && body.includes("시작 전 100% · 1/3 전 67%") && body.includes("요청 확인 뒤 5영업일 이내") && body.includes("앱 문의"), "정규 공지 여섯 줄(대표 판본 그대로)");
    check(body.includes("월·수 20:30–21:30 · 8주 16회 · 300,000원") && body.includes("라틴하우스 강남 A홀 · 정규 · 입문 · 남 10 · 여 10"), "요약 카드");
    check((await page.getByRole("textbox").count()) === 2, "2단계 입력 칸은 정원 둘뿐(공지는 고칠 수 없음)");
    check(!(await registerButton.isDisabled()), "정원을 넣으면 「수업 등록」 켜짐");
    await shot(page, "I2D.png");

    // ---- I2S 등록한 수업 ----
    await registerButton.click();
    await page.waitForURL(/\/instructor\/classes\/promo\?classId=/, { timeout: RENDER_TIMEOUT_MS });
    await page.getByText("자동으로 더해지는 조건").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByRole("tab", { name: "2 검토·고치기" }).click();
    await page.getByRole("button", { name: "검토 끝 · 수업 등록" }).click();
    await page.waitForURL(new RegExp(`/instructor/classes/${CLASS_IDS[0]}$`), { timeout: RENDER_TIMEOUT_MS });
    await page.getByText("승인 중").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const put = lastSent(sent, "put");
    check(put?.id === CLASS_IDS[0] && JSON.stringify(put?.body.capacity) === JSON.stringify({ mode: "gender_split", male: 10, female: 10 }), "「수업 등록」 → PUT(정원 남 10 · 여 10)");
    check(JSON.stringify(lastSent(sent, "submit")?.body) === "{}" && lastSent(sent, "submit")?.id === CLASS_IDS[0], "그다음 submit 본문 {}");
    body = await text();
    check(
      ["쌈바(입문) · 12월", "댄스스포츠(라틴) · 쌈바", "정규 · 대상 레벨 입문", "월·수 20:30–21:30", "12월 7일 – 1월 27일 · 8주 16회", "라틴하우스 강남 · A홀", "남 10 · 여 10", "300,000원", "취소하면 임시 저장으로 돌아가 다시 고칠 수 있어요."].every((line) => body.includes(line)),
      "I2S 줄 여덟 개 + 안내",
    );
    await shot(page, "I2S.png");

    await page.getByRole("button", { name: "등록 취소" }).click();
    await page.waitForURL(/\/instructor\/classes\/new\?classId=/, { timeout: RENDER_TIMEOUT_MS });
    await page.getByLabel("수업명").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(lastSent(sent, "withdraw")?.id === CLASS_IDS[0] && JSON.stringify(lastSent(sent, "withdraw")?.body) === "{}", "「등록 취소」 → withdraw 본문 {}");
    check((await page.getByLabel("수업명").inputValue()) === "쌈바(입문) · 12월", "임시 저장으로 돌아와 칸 값 그대로");
    check((await page.getByRole("radio", { name: "강남점 A홀", checked: true }).count()) === 1, "홀도 그대로 골라짐");
    await shot(page, "I2S-취소-뒤.png");

    // ---- I2E 이벤트형(파티) ----
    await page.goto(`${baseUrl}/instructor/classes/new`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("장르 · 세부 장르").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByRole("radio", { name: "댄스스포츠(라틴)" }).click();
    await page.getByRole("radio", { name: "차차차" }).click();
    await page.getByRole("radio", { name: "파티" }).click();
    await page.getByRole("checkbox", { name: "2030세대" }).click();
    await page.getByRole("checkbox", { name: "4050세대" }).click();
    await page.getByLabel("수업명").fill("라틴 크리스마스 파티");
    await page.getByLabel("금액").fill("30000");
    await page.getByLabel("개최일").fill("2026-12-24");
    await page.getByLabel("시작 시각").fill("21:00");
    await page.getByLabel("끝 시각").fill("23:00");
    await page.getByRole("radio", { name: "강남점 A홀" }).click();
    await page.getByText("겹치는 일정 없어요 · 1회").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(lastSent(sent, "schedule-check")?.body.schedule.kind === "single", "이벤트형은 하루 일정(single)으로 미리 보기");
    await page.getByRole("button", { name: "다음" }).click();
    await page.getByText("취소 수수료").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const eventCreate = lastSent(sent, "create");
    check(eventCreate?.body.classKind === "party" && eventCreate?.body.targetLevel === null && JSON.stringify(eventCreate?.body.targetAges) === '["gen_2030","gen_4050"]', "이벤트형 본문: party · 레벨 없음 · 연령 2개");
    await page.getByLabel("남 정원", { exact: true }).fill("20");
    await page.getByLabel("여 정원", { exact: true }).fill("20");
    check(await page.getByRole("button", { name: "다음 · 홍보 이미지" }).isDisabled(), "환불 마감일이 비면 「다음 · 홍보 이미지」 꺼짐");
    check((await text()).includes("비어 있으면 등록할 수 없어요"), "「비어 있으면 등록할 수 없어요」");
    await shot(page, "I2E-마감일-빈칸.png");
    await page.getByLabel("환불 마감일").fill("2026-12-15");
    await page.getByText("12월 15일 (화)").waitFor({ timeout: RENDER_TIMEOUT_MS });
    body = await text();
    check(body.includes("개최일 12월 24일 (목) 당일이나 그 전 날짜만"), "개최일 안내 12월 24일 (목)");
    check(["10일 전까지", "9일 전 ~ 7일 전", "6일 전 ~ 3일 전", "2일 전 ~ 환불 마감일", "취소 · 환불 불가"].every((line) => body.includes(line)) && body.includes("30%"), "취소 수수료 네 구간 + 불가 줄");
    check(body.includes("행사는 계좌이체로만 결제받아요."), "계좌이체 안내");
    check(!(await page.getByRole("button", { name: "다음 · 홍보 이미지" }).isDisabled()), "마감일을 넣으면 켜짐");
    await shot(page, "I2E.png");

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
