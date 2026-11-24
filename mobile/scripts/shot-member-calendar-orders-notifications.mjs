// 회원 앱 「캘린더(M11) · 내 예약·결제 내역(M16) · 알림함(M21)」을 Expo 웹으로 띄워 장면을 찍는다
// — 로드맵 S3-4.7(앱 캘린더·알림함·내역 화면).
//
//   실행(mobile 폴더에서): node scripts/shot-member-calendar-orders-notifications.mjs --out-dir <폴더> [--port 8096]
//   결과(<폴더> 안):
//     M11.png             캘린더 — 하루 수업 3개: 참석(토글 가능) · 내가 켠 결석 예정 · 강사가 표시한 결석(못 끔)
//     M11-강사표시.png     같은 날을 아래로 내린 것 — 강사가 표시한 결석(역할만, 토글 막힘)
//     M11-결석-예정.png    첫 수업을 「결석」으로 바꾼 뒤 — PUT 이 나가고 다시 읽은 목록에서 「결석 예정」
//     M16.png             내 예약 · 결제 내역 「예약」 탭 — 입금 대기·결제완료·부분 환불 카드 + 「지난 주문 2건」
//     M16-결제환불.png     「결제·환불 내역」 탭 — 주문마다 금액·환불액·상태
//     M16E.png            주문이 없을 때 — 「아직 신청한 수업이 없어요」 + 수업 찾기
//     M21.png             알림함 「전체」 — 오늘·어제·이번 주 묶음, 안 읽음 굵은 제목·점, 행동 문구
//     M21-결제칩.png       칩 「결제·쿠폰」 — 결제 알림만
//     M21E.png            알림이 없을 때 — 「새 알림이 없어요」
//
// 왜 서버 응답을 브라우저에서 꾸며 넣나(shot-owner-notifications.mjs 와 같은 이유):
//   웹 실행에는 로그인 토큰을 오래 둘 곳이 없어 page.route 로 `/api/**` 를 가로채 계약 04 §1·§2·§4-1·§5·§9 모양의
//   예시 응답을 돌려준다. 서버 쪽 동작은 S3-4.2·S3-4.3·S3-4.5·S3-4.6 DB 테스트가 확인했다.
//   화면이 보낸 요청(PUT 경로·쿼리)이나 화면 글자가 기대와 다르면 [check] FAIL 을 찍고 exit 1 로 끝낸다.
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
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/member-calendar-orders-notifications")));
const baseUrl = `http://localhost:${port}`;

// ---- 시각 — 장면이 늘 같게 나오도록 지금에서 센다 ----
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (ms) => new Date(Date.now() + ms).toISOString();
const ago = (ms) => new Date(Date.now() - ms).toISOString();
/** KST 달력 날짜(연·월·일) */
function kst(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * HOUR);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// ---- 예시 응답(계약 04 모양 그대로) ----
const SESSION_A = "5e550000-0000-4000-8000-00000000000a";
const SESSION_B = "5e550000-0000-4000-8000-00000000000b";
const SESSION_C = "5e550000-0000-4000-8000-00000000000c";
// 세 회차를 30·40·50분 뒤로 둬 같은 날·시작 전이 되게 한다(자정 직전 실행만 예외 — 그때는 다시 돌린다)
function calendarItems(absentSessions) {
  const base = [
    { id: SESSION_A, entry: "e1", title: "살사 온원 입문", academy: "라틴하우스 강남", seq: 3, starts: at(30 * MINUTE), mark: null },
    { id: SESSION_B, entry: "e2", title: "바차타 센슈얼 입문", academy: "라틴하우스 강남", seq: 5, starts: at(40 * MINUTE), mark: "member" },
    { id: SESSION_C, entry: "e3", title: "쌈바 입문", academy: "라틴스텝 서초", seq: 2, starts: at(50 * MINUTE), mark: "instructor" },
  ];
  return base.map((s) => {
    const memberMark = absentSessions.has(s.id);
    const kind = s.mark === "instructor" ? "instructor" : memberMark ? "member" : null;
    return {
      entryId: s.entry,
      reservationId: `res-${s.entry}`,
      offeringId: `off-${s.entry}`,
      sessionId: s.id,
      sessionSeq: s.seq,
      title: s.title,
      academyName: s.academy,
      startsAt: s.starts,
      endsAt: new Date(new Date(s.starts).getTime() + 90 * MINUTE).toISOString(),
      absence: kind === null ? null : { markId: `mark-${s.entry}`, markedByKind: kind, disputeStatus: "none", canToggle: kind === "member" },
    };
  });
}

const RECEIPT = { academyUrl: null, companyUrl: null, cashReceiptIssued: false };
const ORDERS = [
  { orderId: "0rd00000-0000-4000-8000-000000000001", status: "pending", offeringId: "off-1", title: "살사 온투 기초 · 12월 정규", academyName: "살사홀릭 강남", seatKind: "female", method: "virtual_account", totalAmount: 180000, refundedAmount: 0, createdAt: ago(1 * HOUR), paidAt: null, dueAt: at(23 * HOUR), receipt: RECEIPT },
  { orderId: "0rd00000-0000-4000-8000-000000000002", status: "paid", offeringId: "off-2", title: "바차타 센슈얼 입문 · 11월", academyName: "라틴하우스 강남", seatKind: "male", method: "card", totalAmount: 90000, refundedAmount: 0, createdAt: ago(26 * HOUR), paidAt: ago(26 * HOUR), dueAt: null, receipt: RECEIPT },
  { orderId: "0rd00000-0000-4000-8000-000000000003", status: "partially_refunded", offeringId: "off-3", title: "스윙 원데이 · 9/27 (일)", academyName: "스윙팩토리 홍대", seatKind: "male", method: "card", totalAmount: 30000, refundedAmount: 15000, createdAt: ago(5 * 24 * HOUR), paidAt: ago(5 * 24 * HOUR), dueAt: null, receipt: RECEIPT },
  { orderId: "0rd00000-0000-4000-8000-000000000004", status: "expired", offeringId: "off-4", title: "탱고 밀롱가 입문", academyName: "탱고온 신촌", seatKind: "female", method: "virtual_account", totalAmount: 60000, refundedAmount: 0, createdAt: ago(9 * 24 * HOUR), paidAt: null, dueAt: null, receipt: RECEIPT },
  { orderId: "0rd00000-0000-4000-8000-000000000005", status: "cancelled", offeringId: "off-5", title: "룸바 중급", academyName: "라틴스텝 서초", seatKind: "any", method: "virtual_account", totalAmount: 120000, refundedAmount: 0, createdAt: ago(12 * 24 * HOUR), paidAt: null, dueAt: null, receipt: RECEIPT },
];

const NOTIFICATIONS = [
  { id: "n1", kind: "payment_deadline_soon", createdAt: ago(10 * MINUTE), readAt: null, orderId: ORDERS[0].orderId, payload: { title: "입금 기한이 1시간 남았어요", offeringTitle: "살사 온투 기초 · 12월 정규", amount: 180000, dueAt: at(50 * MINUTE) } },
  { id: "n2", kind: "absence_marked", createdAt: ago(40 * MINUTE), readAt: null, orderId: null, payload: { title: "쌈바 입문 2회차가 결석으로 표시됐어요", body: "강사가 표시했어요 · 48시간 안에 이의를 걸 수 있어요" } },
  { id: "n3", kind: "session_cancelled", createdAt: ago(70 * MINUTE), readAt: ago(60 * MINUTE), orderId: null, payload: { title: "룸바(중급) 휴강", body: "강사 사정으로 휴강해요. 다른 회차 옮기기·환불 중 골라 주세요" } },
  { id: "n4", kind: "payment_confirmed_member", createdAt: ago(26 * HOUR), readAt: ago(25 * HOUR), orderId: ORDERS[1].orderId, payload: { title: "바차타 센슈얼 입문 · 11월", amount: 90000, firstSessionStartsAt: at(2 * 24 * HOUR) } },
  { id: "n5", kind: "class_announcement", createdAt: ago(4 * 24 * HOUR), readAt: ago(4 * 24 * HOUR), orderId: null, payload: { title: "스윙 원데이 준비물 안내", body: "운동화와 물을 챙겨 오세요" } },
];

/** `/api/**` 를 계약 모양 예시로 답한다. 화면이 보낸 요청을 log 에 남겨 나중에 대조한다 */
async function installApiMock(page, log, scenario) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    log.push({ method, path, search: url.search });
    const json = (status, payload) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload), headers: { "access-control-allow-origin": "*" } });
    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,PUT,DELETE" } });
    }
    if (method === "GET" && path === "/api/me/calendar") return json(200, { items: calendarItems(scenario.absent) });
    const absence = path.match(/^\/api\/me\/sessions\/([^/]+)\/absence$/);
    if (absence && method === "PUT") {
      const id = decodeURIComponent(absence[1]);
      const created = !scenario.absent.has(id);
      scenario.absent.add(id);
      return json(created ? 201 : 200, { markId: `mark-${id}`, sessionId: id, reservationId: "res", markedByKind: "member", markedAt: new Date().toISOString(), disputeStatus: "none", canToggle: true });
    }
    if (absence && method === "DELETE") {
      scenario.absent.delete(decodeURIComponent(absence[1]));
      return json(200, { sessionId: decodeURIComponent(absence[1]), absence: null });
    }
    if (method === "GET" && path === "/api/me/orders") return json(200, { items: scenario.empty ? [] : ORDERS, nextCursor: null });
    if (method === "GET" && path === "/api/me/notifications") return json(200, { items: scenario.empty ? [] : NOTIFICATIONS, nextCursor: null });
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

const bodyText = (page) => page.evaluate(() => document.body.innerText);

async function newPage(browser, apiLog, pageErrors, scenario) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installApiMock(page, apiLog, scenario);
  return page;
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
  const pageErrors = [];
  try {
    mkdirSync(outDir, { recursive: true });
    const scenario = { absent: new Set([SESSION_B]), empty: false };

    // ---- 장면 M11: 캘린더 — 수업 있는 날을 고른다 ----
    const page = await newPage(browser, apiLog, pageErrors, scenario);
    await page.goto(`${baseUrl}/calendar`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByRole("button", { name: "다음 달" }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    const day = kst(at(30 * MINUTE));
    const today = kst(new Date().toISOString());
    if (day.month !== today.month) await page.getByRole("button", { name: "다음 달" }).click();
    await page.getByRole("button", { name: `${day.month}월 ${day.day}일, 수업 3개` }).click();
    await page.getByText("쌈바 입문").waitFor({ timeout: RENDER_TIMEOUT_MS });
    let text = await bodyText(page);
    check(text.includes("수업 3개"), "고른 날 머리 「수업 3개」");
    check((await page.getByRole("radio", { name: /참석$/ }).count()) === 3 && (await page.getByRole("radio", { name: /결석$/ }).count()) === 3, "수업마다 참석·결석 토글 하나씩(3개)");
    check(text.includes("결석 예정") && text.includes("강사가 결석으로 표시했어요"), "내가 켠 결석 예정 · 강사 표시(역할만) 문구");
    check((await page.getByRole("radio", { name: "쌈바 입문 참석" }).isDisabled()), "강사가 표시한 결석은 회원이 끌 수 없다(참석 칸 막힘)");
    await shot(page, "M11.png");

    // ---- 장면 M11-강사표시: 아래로 내려 강사가 표시한 결석 줄을 본다 ----
    await page.getByText("강사가 결석으로 표시했어요").scrollIntoViewIfNeeded();
    await shot(page, "M11-강사표시.png");

    // ---- 장면 M11-결석-예정: 첫 수업을 결석으로 ----
    await page.getByRole("radio", { name: "살사 온원 입문 결석" }).click();
    await page.waitForFunction(() => (document.body.innerText.match(/결석 예정/g) ?? []).length >= 2, null, { timeout: RENDER_TIMEOUT_MS });
    const put = apiLog.find((r) => r.method === "PUT");
    check(put !== undefined && put.path === `/api/me/sessions/${SESSION_A}/absence`, `결석 → PUT /api/me/sessions/{살사 회차}/absence: ${put?.path}`);
    const calendarCalls = apiLog.filter((r) => r.path === "/api/me/calendar");
    check(calendarCalls.length >= 2 && calendarCalls[0].search.includes("from=") && calendarCalls[0].search.includes("to="), `토글 뒤 캘린더를 다시 읽는다(${calendarCalls.length}회, ${calendarCalls[0]?.search})`);
    await shot(page, "M11-결석-예정.png");

    // ---- 장면 M16: 마이 탭 → 내 예약 · 결제 내역 ----
    await page.getByRole("tab", { name: "마이" }).click();
    await page.getByText("살사 온투 기초 · 12월 정규").waitFor({ timeout: RENDER_TIMEOUT_MS });
    text = await bodyText(page);
    check(new URL(page.url()).pathname === "/my/orders", `마이 탭 → ${new URL(page.url()).pathname}`);
    check(text.includes("입금 대기") && text.includes("결제완료") && text.includes("부분 환불"), "상태 태그 입금 대기 · 결제완료 · 부분 환불");
    check(text.includes("지난 주문 2건") && !text.includes("탱고 밀롱가 입문"), "만료·입금 전 취소는 「지난 주문 2건」으로 접힘");
    check(text.includes("계좌 보기") && text.includes("예약 3"), "입금 대기에 「계좌 보기」, 세그먼트 「예약 3」");
    const ordersCall = apiLog.find((r) => r.path === "/api/me/orders");
    check(ordersCall !== undefined && ordersCall.search.includes("limit=20"), `GET /api/me/orders${ordersCall?.search}`);
    await shot(page, "M16.png");

    // ---- 장면 M16-결제환불 ----
    await page.getByRole("tab", { name: "결제·환불 내역" }).click();
    await page.getByText("환불 −15,000원").waitFor({ timeout: RENDER_TIMEOUT_MS });
    text = await bodyText(page);
    check(text.includes("탱고 밀롱가 입문") && text.includes("입금 기한 지남") && text.includes("입금 전 취소"), "결제·환불 내역에는 지난 주문까지 5건 모두");
    await shot(page, "M16-결제환불.png");
    await page.close();

    // ---- 장면 M21: 홈의 「알림」 → 알림함 ----
    const page2 = await newPage(browser, apiLog, pageErrors, scenario);
    await page2.goto(`${baseUrl}/notifications`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page2.getByText("입금 기한이 1시간 남았어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    text = await bodyText(page2);
    const chips = await page2.getByRole("tab").allInnerTexts();
    check(JSON.stringify(chips.slice(0, 5)) === JSON.stringify(["전체", "수업", "결제·쿠폰", "학원 소식", "대기"]), `칩 다섯: ${JSON.stringify(chips.slice(0, 5))}`);
    check(text.includes("오늘") && text.includes("어제") && text.includes("이번 주"), "오늘 · 어제 · 이번 주 묶음");
    check(text.includes("결제 완료 · 바차타 센슈얼 입문 · 11월"), "결제 확인 알림 제목 「결제 완료 · 수업명」");
    check(text.includes("계좌 보기 ›") && text.includes("캘린더 보기 ›"), "행동 문구(계좌 보기 · 캘린더 보기)");
    check((await page2.locator('[aria-label^="안 읽음."]').count()) === 2, "안 읽음 2줄");
    await shot(page2, "M21.png");

    // ---- 장면 M21-결제칩 ----
    await page2.getByRole("tab", { name: "결제·쿠폰 알림" }).click();
    await page2.waitForFunction(() => !document.body.innerText.includes("쌈바 입문 2회차"), null, { timeout: RENDER_TIMEOUT_MS });
    text = await bodyText(page2);
    check(text.includes("입금 기한이 1시간 남았어요") && text.includes("결제 완료") && !text.includes("휴강"), "결제·쿠폰 칩에는 결제 알림 2건만");
    await shot(page2, "M21-결제칩.png");

    // 알림 행동 문구 → 계좌 보기(결제 뒤 화면)
    await page2.getByRole("tab", { name: "전체 알림" }).click();
    await page2.getByRole("button", { name: /^안 읽음\. 입금 기한이 1시간 남았어요/ }).click();
    await page2.waitForURL(/\/checkout\//, { timeout: RENDER_TIMEOUT_MS });
    check(new URL(page2.url()).pathname === `/checkout/${ORDERS[0].orderId}`, `계좌 보기 › → ${new URL(page2.url()).pathname}`);
    await page2.close();

    // ---- 빈 화면 M16E · M21E ----
    const emptyScenario = { absent: new Set(), empty: true };
    const page3 = await newPage(browser, apiLog, pageErrors, emptyScenario);
    await page3.goto(`${baseUrl}/my/orders`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page3.getByText("아직 신청한 수업이 없어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    check((await bodyText(page3)).includes("수업 찾기") && (await bodyText(page3)).includes("예약 0"), "M16E 「수업 찾기」 · 「예약 0」");
    await shot(page3, "M16E.png");
    await page3.goto(`${baseUrl}/notifications`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page3.getByText("새 알림이 없어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await shot(page3, "M21E.png");
    await page3.close();

    console.log(`[shot] 가로챈 API 호출:\n  ${apiLog.map((r) => `${r.method} ${r.path}${r.search}`).join("\n  ")}`);
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
