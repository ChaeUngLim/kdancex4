// 대표 앱 소속 해제(O39 · O39B)와 대타 알림 확인(O21B)을 Expo 웹으로 띄워 장면을 찍는다 — 로드맵 S2-3.10(관리자 웹·대표 앱 해제 확인 화면).
//
//   실행(mobile 폴더에서): node scripts/shot-owner-release.mjs --out-dir <폴더> [--port 8096]
//   결과(<폴더> 안):
//     O39.png            소속 해제 첫 화면 — 남은 회차 3개, 버튼 「3개 남았어요」(꺼짐)
//     O39-정함.png       회차마다 고른 뒤 — 대체 강사 후보(바쁜 강사는 못 고름) · 명단 펼침 · 버튼 「소속 해제」
//     O39B.png           확인 시트 — 묶음 셋, 첫 묶음 문구·명단, 「받는 회원 9명 · 알림은 회원마다 1건」
//     O39-해제-뒤.png    해제 뒤 결과
//     O21B.png           대표 알림함 맨 위 「대타」 알림과 「확인하기 ›」
//     O21B-확인-뒤.png   「확인하기 ›」를 누른 뒤 — 「확인했어요 · 수강생 10명에게 알림이 갔어요」
//
// 왜 서버 응답을 브라우저에서 꾸며 넣나(shot-owner-notifications.mjs 와 같은 이유):
//   웹 실행에는 SecureStore 가 없어 로그인 토큰을 둘 수 없다. 그래서 `/api/**` 를 가로채 계약 11 §8-1 · §8-2 · §9-1 · §9-2
//   모양의 예시 응답을 돌려준다. 서버 동작은 S2-3.4 · S2-3.6 · S2-3.7 DB 테스트와 관리자 웹 E2E(같은 API)가 확인했다.
//   화면이 보낸 본문·키가 기대와 다르면 [check] FAIL 을 찍고 exit 1 로 끝낸다.
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
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/owner-release")));
const baseUrl = `http://localhost:${port}`;

// ---- 예시 값 ----
const ACADEMY_ID = "11111111-1111-4111-8111-111111111111";
const AFF_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const PARK = "cccccccc-0000-4000-8000-000000000001"; // 박서윤 — 해제할 강사
const LEE = "cccccccc-0000-4000-8000-000000000002"; // 이준호 — 그 시간 비어 있음
const KIM = "cccccccc-0000-4000-8000-000000000003"; // 김하나 — 그 시간 일정 있음
const SESSIONS = [
  { sessionId: "dddddddd-0000-4000-8000-000000000001", startsAt: "2026-11-18T11:00:00Z", endsAt: "2026-11-18T12:30:00Z" },
  { sessionId: "dddddddd-0000-4000-8000-000000000002", startsAt: "2026-11-25T11:00:00Z", endsAt: "2026-11-25T12:30:00Z" },
  { sessionId: "dddddddd-0000-4000-8000-000000000003", startsAt: "2026-12-02T11:00:00Z", endsAt: "2026-12-02T12:30:00Z" },
].map((s) => ({ ...s, classId: "eeeeeeee-0000-4000-8000-000000000001", classTitle: "차차차 입문", roomName: "A실", memberCount: 9 }));
const MEMBERS = ["김서연", "이도윤", "박하린", "최민준", "정유나", "한지우", "오세린", "윤태오", "임가은"].map((displayName, i) => ({
  displayName,
  payKind: i % 3 === 2 ? "pass" : "paid",
}));
const STAFF_ME = {
  accountId: "33333333-3333-4333-8333-333333333333",
  displayName: "예시 대표",
  roles: ["owner"],
  secondFactorVerified: true,
  consoleAccess: true,
  academies: [{ academyId: ACADEMY_ID, name: "라틴하우스 강남", as: "owner", permissions: ["owner"], menus: ["instructors"] }],
  platformMenus: [],
};
const SUB_REQUEST_ID = "ffffffff-0000-4000-8000-000000000001";
const MINUTE = 60_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
/** 대표 알림함 — 맨 위 대타 수락(S2-3.4 가 쓰는 payload 모양) + 기존 소속 신청 한 줄 */
const NOTIFICATIONS = [
  {
    id: "aaaaaaaa-0000-4000-8000-000000000010",
    kind: "substitute_accepted",
    category: "approval",
    academyId: ACADEMY_ID,
    createdAt: ago(2 * MINUTE),
    readAt: null,
    payload: {
      requestId: SUB_REQUEST_ID,
      sessionId: "dddddddd-0000-4000-8000-000000000009",
      classId: "eeeeeeee-0000-4000-8000-000000000009",
      classTitle: "쌈바(입문)",
      startsAt: "2026-11-18T11:30:00Z",
      substituteAccountId: KIM,
      body: "김하나 강사가 대타를 수락했어요 · 확인하면 수강생 10명에게 알림이 가요",
    },
  },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000011",
    kind: "affiliation_requested",
    category: "approval",
    academyId: ACADEMY_ID,
    createdAt: ago(30 * MINUTE),
    readAt: ago(20 * MINUTE),
    payload: { title: "아이유 강사가 소속을 신청했어요", body: "살사·바차타 · 「주말 저녁 수업을 맡고 싶어요」", actionLabel: "확인하고 승인" },
  },
];

const BUNDLE_LABEL = { substitute: "강사 변경", cancel_session: "휴강", close: "폐강" };

/** 고른 처리로 §9-1 응답을 만든다 — 서버(buildReleasePreview)와 같은 모양 */
function previewFor(decisions) {
  const byId = new Map(decisions.map((d) => [d.sessionId, d]));
  const sessions = SESSIONS.map((s) => {
    const d = byId.get(s.sessionId);
    return {
      ...s,
      decision:
        d === undefined
          ? null
          : {
              action: d.action,
              substituteAccountId: d.substituteAccountId ?? null,
              substituteName: d.substituteAccountId === LEE ? "이준호" : null,
              substituteAvailable: d.substituteAccountId === undefined ? null : d.substituteAccountId === LEE,
            },
    };
  });
  const bundles = ["substitute", "cancel_session", "close"]
    .map((action) => ({ action, list: decisions.filter((d) => d.action === action) }))
    .filter((b) => b.list.length > 0)
    .map((b) => ({
      action: b.action,
      sessionCount: b.list.length,
      memberCount: 9,
      messagePreview:
        b.action === "substitute"
          ? "「11/18 (수) 차차차 입문은 박서윤 강사 대신 이준호 강사가 진행해요. 원하면 환불을 요청할 수 있어요.」"
          : `「11/25 (수) 차차차 입문은 ${BUNDLE_LABEL[b.action]}해요. 원하면 환불을 요청할 수 있어요.」`,
      members: MEMBERS,
    }));
  const undecided = SESSIONS.filter((s) => !byId.has(s.sessionId)).map((s) => s.sessionId);
  const subsOk = decisions.every((d) => d.action !== "substitute" || d.substituteAccountId === LEE);
  return {
    affiliationId: AFF_ID,
    instructor: { accountId: PARK, displayName: "박서윤" },
    remaining: { sessions, privateLessonPasses: [] },
    bundles,
    totals: { memberCount: decisions.length === 0 ? 9 : 9, notificationCount: 9 },
    undecided,
    canRelease: undecided.length === 0 && subsOk,
  };
}

async function installApiMock(page, log) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postData();
    log.push({ method, path, search: url.search, body, key: request.headers()["idempotency-key"] ?? null });
    const json = (status, payload) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload), headers: { "access-control-allow-origin": "*" } });
    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT" } });
    }
    if (method === "GET" && path === "/api/staff/me") return json(200, STAFF_ME);
    if (method === "POST" && path === `/api/academies/${ACADEMY_ID}/affiliations/${AFF_ID}/release-preview`) {
      return json(200, previewFor(JSON.parse(body ?? "{}").sessionDecisions ?? []));
    }
    if (method === "GET" && /^\/api\/sessions\/[^/]+\/substitute-candidates$/.test(path)) {
      return json(200, {
        sessionId: path.split("/")[3],
        items: [
          { accountId: LEE, displayName: "이준호", genre: "dance_sport", available: true, unavailableReason: null },
          { accountId: KIM, displayName: "김하나", genre: "dance_sport", available: false, unavailableReason: "busy" },
        ],
      });
    }
    if (method === "POST" && path === `/api/academies/${ACADEMY_ID}/affiliations/${AFF_ID}/release`) {
      return json(200, { status: "released", releasedAt: new Date().toISOString(), sessions: { substituted: 1, cancelled: 1, closed: 1 }, notified: { memberCount: 9, notificationCount: 9 } });
    }
    if (method === "GET" && path === "/api/staff/notifications") return json(200, { items: NOTIFICATIONS, nextCursor: null });
    if (method === "POST" && /^\/api\/staff\/notifications\/[^/]+\/read$/.test(path)) {
      const item = NOTIFICATIONS.find((i) => i.id === path.split("/")[4]);
      return json(200, { ...item, readAt: new Date().toISOString() });
    }
    if (method === "POST" && path === `/api/academies/${ACADEMY_ID}/substitute-requests/${SUB_REQUEST_ID}/confirm`) {
      return json(200, { requestId: SUB_REQUEST_ID, status: "confirmed", session: { sessionId: "dddddddd-0000-4000-8000-000000000009", instructor: { accountId: KIM, displayName: "김하나" } }, notifiedMemberCount: 10 });
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

async function shot(page, name, fullPage = false) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, name), fullPage });
  console.log(`[shot] 저장: ${join(outDir, name)}`);
}

function check(ok, label) {
  console.log(`[check] ${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
}

const bodyText = (page) => page.evaluate(() => document.body.innerText);

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
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installApiMock(page, apiLog);

    // ---- 장면 1: O39 첫 화면 ----
    await page.goto(`${baseUrl}/owner/release/${AFF_ID}`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("박서윤 강사 · 게시된 회차 3개가 남아 있어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    let text = await bodyText(page);
    check(text.includes("11월 18일 (수) · 차차차 입문") && text.includes("수 20:00–21:30 · A실 · 예약 9명"), "회차 카드 제목·둘째 줄(KST)");
    check((text.match(/아직 고르지 않았어요/g) ?? []).length === 3, "처음엔 세 회차 모두 「아직 고르지 않았어요」");
    check(text.includes("3개 남았어요"), "버튼 「3개 남았어요」");
    const firstPreview = apiLog.find((r) => r.path.endsWith("/release-preview"));
    check(firstPreview !== undefined && JSON.parse(firstPreview.body).sessionDecisions.length === 0, `처음 미리 보기는 빈 선택: ${firstPreview?.body}`);
    await shot(page, "O39.png");

    // ---- 장면 2: 회차마다 고르기 ----
    const cards = page.locator('[aria-label$="· 차차차 입문"]');
    await cards.nth(0).getByText("대체 강사", { exact: true }).click();
    await page.getByRole("radio", { name: /이준호 강사/ }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    check((await page.getByRole("radio", { name: /김하나 강사/ }).getAttribute("aria-disabled")) === "true", "그 시간에 일정이 있는 김하나는 고를 수 없다");
    await page.getByRole("radio", { name: /이준호 강사/ }).click();
    await cards.nth(1).getByText("휴강", { exact: true }).click();
    await page.getByText("예약한 9명에게 휴강 알림 · 명단 보기 ▾").click();
    await page.getByText("김서연").first().waitFor({ timeout: RENDER_TIMEOUT_MS });
    await cards.nth(2).getByText("폐강", { exact: true }).click();
    text = await bodyText(page);
    check(text.includes("이준호 강사 · 그 시간 비어 있음"), "대체 강사 이준호 · 그 시간 비어 있음");
    check(text.includes("예약한 9명에게 강사 변경 알림"), "대체 회차 알림 줄");
    check(!text.includes("남았어요") && text.includes("소속 해제"), "모두 정하면 버튼 「소속 해제」");
    const rosterCall = apiLog.filter((r) => r.path.endsWith("/release-preview")).at(-1);
    check(JSON.stringify(JSON.parse(rosterCall.body).sessionDecisions) === JSON.stringify([{ sessionId: SESSIONS[1].sessionId, action: "cancel_session" }]), `명단 보기는 그 회차 하나로 미리 보기: ${rosterCall.body}`);
    await shot(page, "O39-정함.png", true);

    // ---- 장면 3: O39B 확인 시트 ----
    await page.getByRole("button", { name: "소속 해제", exact: true }).click();
    await page.getByText("알림을 보내고 해제할까요?").waitFor({ timeout: RENDER_TIMEOUT_MS });
    text = await bodyText(page);
    check(text.includes("받는 회원 9명 · 알림은 회원마다 1건"), "합계 「받는 회원 9명 · 알림은 회원마다 1건」(열린 점 ⑯)");
    check(text.includes("박서윤 강사 대신 이준호 강사가 진행해요") && text.includes("대체 강사 이준호에게 배정 알림이 가요"), "첫 묶음 문구와 배정 알림 안내");
    check(["강사 변경", "휴강", "폐강"].every((t) => text.includes(t)), "묶음 셋(강사 변경 · 휴강 · 폐강)");
    const sheetCall = apiLog.filter((r) => r.path.endsWith("/release-preview")).at(-1);
    const sent = JSON.parse(sheetCall.body).sessionDecisions;
    check(
      JSON.stringify(sent) ===
        JSON.stringify([
          { sessionId: SESSIONS[0].sessionId, action: "substitute", substituteAccountId: LEE },
          { sessionId: SESSIONS[1].sessionId, action: "cancel_session" },
          { sessionId: SESSIONS[2].sessionId, action: "close" },
        ]),
      `시트 미리 보기 본문: ${sheetCall.body}`,
    );
    await shot(page, "O39B.png");

    // ---- 장면 4: 해제 ----
    await page.getByRole("button", { name: "알림 보내고 해제" }).click();
    await page.getByText("박서윤 강사의 소속을 해제했어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    const releaseCall = apiLog.find((r) => r.method === "POST" && r.path.endsWith("/release"));
    check(releaseCall !== undefined && releaseCall.key !== null && JSON.stringify(JSON.parse(releaseCall.body).sessionDecisions) === JSON.stringify(sent), `해제 본문·키(Idempotency-Key ${releaseCall?.key ? "있음" : "없음"}): ${releaseCall?.body}`);
    check((await bodyText(page)).includes("받는 회원 9명에게 알림 9건을 보냈어요"), "해제 결과 문구");
    await shot(page, "O39-해제-뒤.png");

    // ---- 장면 5: O21B 대타 알림 ----
    await page.goto(`${baseUrl}/owner/notifications`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("11/18 쌈바(입문) · 김하나 강사가 대타를 수락했어요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    text = await bodyText(page);
    check(text.includes("확인하면 수강생 10명에게 알림이 가요") && text.includes("확인하기 ›") && text.includes("대타"), "대타 줄 — 배지 · 내용 · 「확인하기 ›」");
    await shot(page, "O21B.png");

    // ---- 장면 6: 「확인하기 ›」 ----
    await page.getByRole("button", { name: /김하나 강사가 대타를 수락했어요/ }).click();
    await page.getByText("확인했어요 · 수강생 10명에게 알림이 갔어요", { exact: true }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    const confirmCall = apiLog.find((r) => r.method === "POST" && r.path.endsWith("/confirm"));
    check(confirmCall !== undefined && confirmCall.path === `/api/academies/${ACADEMY_ID}/substitute-requests/${SUB_REQUEST_ID}/confirm`, `대표 확인 경로: ${confirmCall?.path}`);
    await shot(page, "O21B-확인-뒤.png");
    await page.close();

    console.log(`[shot] 가로챈 API 호출:\n  ${apiLog.map((r) => `${r.method} ${r.path}${r.search}${r.body ? ` ${r.body}` : ""}${r.key ? " (Idempotency-Key 있음)" : ""}`).join("\n  ")}`);
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
