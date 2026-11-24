// 대표 앱 「수업 승인」(O5)과 수업 등록 알림(O5P) 장면을 Expo 웹으로 띄워 찍는다 — 로드맵 S2-2.11(대표 앱 수업 승인 화면).
//
//   실행(mobile 폴더에서): node scripts/shot-owner-class-approval.mjs --out-dir <폴더> [--port 8096]
//   결과(<폴더> 안):
//     O5P.png               알림함 — 수업 등록 알림 「[수업 등록] 이준호 강사」 · 본문 · 수강료 · 「확인하고 승인 ›」
//     O5.png                알림을 누른 뒤 — 승인 화면(승인 대기 · 줄 여덟 개 · 수정 요청 | 승인)
//     O5-사유-빈칸.png       「수정 요청」 → 사유 없이 「보내기」 — 「사유를 적어야 보낼 수 있어요」, 서버에 안 보냄
//     O5-수정요청-뒤.png     사유를 적어 보낸 뒤 — 「수정 요청을 보냈어요」, 상태 「임시 저장」
//     O5-승인-뒤.png         다시 연 승인 화면에서 「승인」 — 「승인했어요 · 회원에게 공개됐어요」, 상태 「공개」
//     O5-이미-승인됨.png     이미 공개된 수업의 알림을 늦게 눌렀을 때 — 버튼 없이 안내만
//
// 왜 서버 응답을 브라우저에서 꾸며 넣나(shot-owner-notifications.mjs 와 같은 이유):
//   웹 실행에는 SecureStore 가 없어 로그인 토큰을 둘 수 없다(lib/session.ts). 그래서 page.route 로 `/api/**` 를
//   가로채 계약 11 §4-2·§4-5 · 계약 10 §2 모양의 예시 응답을 돌려준다. 승인·수정 요청의 서버 동작은
//   S2-2.7 DB 테스트(class-approval.db.test.ts)가 확인했다. 화면이 보낸 요청(경로·본문)이 기대와 다르면
//   [check] FAIL 을 찍고 exit 1 로 끝낸다.
//
// 휴대폰 푸시 자체(잠금 화면의 알림)는 S7-1 이 보낸다. 앱이 그리는 O5P 의 몫은 「같은 글자가 알림함에 남고,
// 누르면 O5 가 열린다」이므로 그 장면을 찍는다.
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
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/owner-class-approval")));
const baseUrl = `http://localhost:${port}`;

// ---- 예시 응답 ----
const ACADEMY_ID = "11111111-1111-4111-8111-111111111111";
const CLASS_ID = "22222222-2222-4222-8222-222222222222";
const PUBLISHED_CLASS_ID = "22222222-2222-4222-8222-222222222299";
const NOTIFICATION_ID = "aaaaaaaa-0000-4000-8000-000000000011";
const STAFF_ME = {
  accountId: "33333333-3333-4333-8333-333333333333",
  displayName: "예시 대표",
  roles: ["owner"],
  secondFactorVerified: true,
  consoleAccess: true,
  academies: [{ academyId: ACADEMY_ID, name: "라틴하우스 강남", as: "owner", permissions: ["owner"], menus: ["instructors"] }],
  platformMenus: [],
};
const SCHEDULE = { kind: "recurring", weekdays: ["mon", "wed"], startTime: "20:30", endTime: "21:30", periodFrom: "2026-11-02", periodTo: "2026-12-23" };
const MINUTE = 60_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

/** 계약 11 §4-2 ClassRegistration — 강사가 제출해 승인 대기인 정규 수업. 제출 시각은 KST 오후 12:26 */
function pendingClass(classId = CLASS_ID) {
  return {
    classId,
    academyId: ACADEMY_ID,
    academyName: "라틴하우스 강남",
    status: "pending_approval",
    classKind: "regular",
    title: "쌈바(입문) · 11월",
    genre: "dance_sport",
    subGenre: "latin",
    discipline: "samba",
    targetLevel: "entry",
    targetAges: ["all"],
    room: { roomId: "44444444-4444-4444-8444-444444444444", name: "A홀" },
    schedule: { ...SCHEDULE, sessionCount: 16 },
    capacity: { mode: "gender_split", male: 10, female: 10, any: null },
    priceAmount: 300000,
    isFree: false,
    refundDeadlineOn: null,
    refundNotice: null,
    instructor: { accountId: "55555555-5555-4555-8555-555555555555", displayName: "이준호" },
    posterUrl: null,
    introText: null,
    revisionRequest: null,
    pendingEdit: null,
    paidCount: 0,
    submittedAt: "2026-11-21T03:26:00Z",
    approvedAt: null,
    createdAt: "2026-11-21T03:00:00Z",
    updatedAt: "2026-11-21T03:26:00Z",
  };
}

/** 알림함 첫 줄 — 제출 때 서버가 쓰는 payload 모양 그대로(class-registration.ts submit, 계약 11 §4-3) */
const CLASS_SUBMITTED = {
  id: NOTIFICATION_ID,
  kind: "class_submitted",
  category: "approval",
  academyId: ACADEMY_ID,
  createdAt: ago(2 * MINUTE),
  readAt: null,
  payload: { classId: CLASS_ID, instructorName: "이준호", title: "쌈바(입문) · 11월", schedule: SCHEDULE, priceAmount: 300000 },
};

/** `/api/**` 를 계약 모양 예시로 답한다. 수업 상태는 state 에 두고 승인·수정 요청으로 바꾼다 */
async function installApiMock(page, log, state) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postData();
    log.push({ method, path, search: url.search, body });
    const json = (status, payload) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload), headers: { "access-control-allow-origin": "*" } });
    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT" } });
    }
    if (method === "GET" && path === "/api/staff/me") return json(200, STAFF_ME);
    if (method === "GET" && path === "/api/staff/notifications") return json(200, { items: [CLASS_SUBMITTED], nextCursor: null });
    if (method === "POST" && path === `/api/staff/notifications/${NOTIFICATION_ID}/read`) {
      return json(200, { ...CLASS_SUBMITTED, readAt: new Date().toISOString() });
    }
    const classMatch = path.match(/^\/api\/classes\/([^/]+)$/);
    if (method === "GET" && classMatch) {
      const item = state.classes.get(classMatch[1]);
      return item ? json(200, item) : json(404, { detail: "수업을 찾을 수 없어요", code: "NOT_FOUND" });
    }
    const actionMatch = path.match(/^\/api\/academies\/([^/]+)\/classes\/([^/]+)\/(approve|request-revision)$/);
    if (method === "POST" && actionMatch) {
      const [, academyId, classId, action] = actionMatch;
      const item = state.classes.get(classId);
      if (!item || academyId !== item.academyId) return json(404, { detail: "수업을 찾을 수 없어요", code: "NOT_FOUND" });
      if (action === "approve") {
        const next = { ...item, status: "published", approvedAt: new Date().toISOString() };
        state.classes.set(classId, next);
        return json(200, next);
      }
      const reason = (JSON.parse(body ?? "{}").reason ?? "").trim();
      if (reason === "") return json(422, { detail: "입력값을 확인해 주세요", code: "VALIDATION_FAILED", fields: [{ field: "reason", message: "사유를 적어야 보낼 수 있어요" }] });
      const next = { ...item, status: "draft", revisionRequest: { reason, at: new Date().toISOString() } };
      state.classes.set(classId, next);
      return json(200, next);
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
  await page.screenshot({ path: join(outDir, name), fullPage: true });
  console.log(`[shot] 저장: ${join(outDir, name)}`);
}

function check(ok, label) {
  console.log(`[check] ${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
}

const bodyText = (page) => page.evaluate(() => document.body.innerText);
const actionCalls = (log, action) => log.filter((r) => r.method === "POST" && r.path.endsWith(`/classes/${CLASS_ID}/${action}`));

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
  const pageErrors = [];
  const state = {
    classes: new Map([
      [CLASS_ID, pendingClass()],
      [PUBLISHED_CLASS_ID, { ...pendingClass(PUBLISHED_CLASS_ID), status: "published", approvedAt: "2026-11-21T04:00:00Z" }],
    ]),
  };
  try {
    mkdirSync(outDir, { recursive: true });
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installApiMock(page, apiLog, state);

    // ---- 장면 1: O5P — 알림함의 수업 등록 알림 ----
    await page.goto(`${baseUrl}/owner/notifications`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("[수업 등록] 이준호 강사").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const listText = await bodyText(page);
    check(listText.includes("쌈바(입문) · 11월 · 월·수 20:30–21:30 · 11/2~12/23"), "본문 「수업명 · 요일 시간 · 기간」(spec FR-050a 문구)");
    check(listText.includes("수강료 300,000원"), "본문 둘째 줄 「수강료 300,000원」");
    check(listText.includes("확인하고 승인 ›"), "행동 글자 「확인하고 승인 ›」");
    check(!listText.includes("관리자 웹에서 확인해요"), "수업 등록 알림은 앱 화면으로 간다(웹 안내 없음)");
    await shot(page, "O5P.png");

    // ---- 장면 2: O5 — 알림을 누르면 승인 화면 ----
    await page.getByRole("button", { name: /^안 읽음\. \[수업 등록\] 이준호 강사/ }).click();
    await page.getByText("이준호 강사가 등록했어요 · 오후 12:26").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(new URL(page.url()).pathname === `/owner/classes/${CLASS_ID}`, `알림 → ${new URL(page.url()).pathname}(O5)`);
    check(apiLog.some((r) => r.method === "POST" && r.path === `/api/staff/notifications/${NOTIFICATION_ID}/read`), "누른 알림을 읽음 처리했다");
    const o5 = await bodyText(page);
    for (const piece of ["승인 대기", "쌈바(입문) · 11월", "댄스스포츠(라틴) · 쌈바", "정규 · 대상 레벨 입문", "월·수 20:30–21:30", "11월 2일 – 12월 23일 · 8주 16회", "라틴하우스 강남 · A홀", "남 10 · 여 10", "300,000원"]) {
      check(o5.includes(piece), `O5 줄: ${piece}`);
    }
    check((await page.getByRole("button", { name: "수정 요청" }).count()) === 1 && (await page.getByRole("button", { name: "승인", exact: true }).count()) === 1, "버튼 둘: 수정 요청 | 승인");
    await shot(page, "O5.png");

    // ---- 장면 3: 수정 요청 — 사유 빈칸으로 보내기 ----
    await page.getByRole("button", { name: "수정 요청" }).click();
    await page.getByLabel("수정 요청 사유").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByRole("button", { name: "수정 요청 보내기" }).click();
    await page.getByText("사유를 적어야 보낼 수 있어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check(actionCalls(apiLog, "request-revision").length === 0, "사유가 비면 서버에 보내지 않는다");
    await shot(page, "O5-사유-빈칸.png");

    // ---- 장면 4: 사유를 적어 보낸 뒤 ----
    await page.getByLabel("수정 요청 사유").fill("  금액을 한 번 더 확인해 주세요  ");
    await page.getByRole("button", { name: "수정 요청 보내기" }).click();
    await page.getByText("수정 요청을 보냈어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const revision = actionCalls(apiLog, "request-revision");
    check(revision.length === 1 && revision[0].path === `/api/academies/${ACADEMY_ID}/classes/${CLASS_ID}/request-revision`, `수정 요청 경로 ${revision[0]?.path}`);
    check(revision[0]?.body === JSON.stringify({ reason: "금액을 한 번 더 확인해 주세요" }), `수정 요청 본문(앞뒤 공백 뗌) ${revision[0]?.body}`);
    const afterRevision = await bodyText(page);
    check(afterRevision.includes("임시 저장") && afterRevision.includes("보낸 사유: 「금액을 한 번 더 확인해 주세요」"), "상태 「임시 저장」 · 보낸 사유 표시");
    check((await page.getByRole("button", { name: "승인", exact: true }).count()) === 0, "수정 요청 뒤에는 승인 버튼이 없다");
    await shot(page, "O5-수정요청-뒤.png");

    // ---- 장면 5: 승인 대기 수업을 다시 열어 승인 ----
    state.classes.set(CLASS_ID, pendingClass());
    await page.goto(`${baseUrl}/owner/classes/${CLASS_ID}`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByRole("button", { name: "승인", exact: true }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByRole("button", { name: "승인", exact: true }).click();
    await page.getByText("승인했어요 · 회원에게 공개됐어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const approve = actionCalls(apiLog, "approve");
    check(approve.length === 1 && approve[0].path === `/api/academies/${ACADEMY_ID}/classes/${CLASS_ID}/approve` && approve[0].body === "{}", `승인 경로·본문 ${approve[0]?.path} ${approve[0]?.body}`);
    const afterApprove = await bodyText(page);
    check(afterApprove.includes("공개") && afterApprove.includes("이준호 강사에게 「승인됐어요」 알림이 갔어요"), "상태 「공개」 · 강사 알림 안내");
    check((await page.getByRole("button", { name: "수정 요청" }).count()) === 0, "승인 뒤에는 버튼이 없다");
    await shot(page, "O5-승인-뒤.png");

    // ---- 장면 6: 이미 공개된 수업을 늦게 열었을 때 ----
    await page.goto(`${baseUrl}/owner/classes/${PUBLISHED_CLASS_ID}`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("이미 승인해 회원에게 공개된 수업이에요.").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check((await page.getByRole("button", { name: "승인", exact: true }).count()) === 0, "이미 공개된 수업에는 승인 버튼이 없다");
    check(actionCalls(apiLog, "approve").length === 1, "늦게 연 화면은 서버에 아무것도 보내지 않는다");
    await shot(page, "O5-이미-승인됨.png");
    await page.close();

    console.log(`[shot] 가로챈 API 호출:\n  ${apiLog.map((r) => `${r.method} ${r.path}${r.search}${r.body ? ` ${r.body}` : ""}`).join("\n  ")}`);
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
