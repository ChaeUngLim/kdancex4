// 대표 앱 「강사 관리」(O37)·「강사 권한」(O38) 화면을 Expo 웹으로 띄워 장면을 찍는다
// — 로드맵 S1-2.16(대표 앱 강사 소속·위임 화면).
//
//   실행(mobile 폴더에서): node scripts/shot-owner-instructors.mjs --out-dir <폴더> [--port 8093]
//   결과(<폴더> 안):
//     O37.png              강사 관리 첫 화면(소속 신청 2건 · 초대 링크 · 소속 강사 3명)
//     O37-승인-입력.png    「승인」을 눌러 고용 형태·강사 몫 비율 60% 를 넣은 상태
//     O37-승인-후.png      「승인하기」 뒤 — 아이유가 소속 강사로 옮겨 감
//     O37-초대-링크.png    「링크 공유하기」 뒤 — 만든 링크와 기한
//     O38.png              이준호 강사 권한(수업 등록·예약·명단 켜짐, 수업·포스터 등록 꺼짐)
//     O38-토글-후.png      「수업·포스터 등록」을 켠 뒤 서버 응답으로 다시 그린 상태
//
// 왜 서버 응답을 브라우저에서 꾸며 넣나(shot-owner-terms.mjs 와 같은 이유):
//   웹 실행에는 SecureStore 가 없어 로그인 토큰을 둘 수 없다(lib/session.ts). 그래서 실제 서버로는 대표 화면을
//   열 수 없다. 화면이 계약 08 모양 응답을 받았을 때 어떻게 그려지고 무엇을 보내는지를 보려는 것이므로
//   page.route 로 `/api/**` 를 가로채 계약 모양의 예시 응답을 돌려준다. 서버 쪽 동작(승인·권한 교체·감사·알림)은
//   S1-2.7·S1-2.9 의 DB 테스트가 이미 확인했다. 화면이 보낸 본문은 로그에 남기고, 기대와 다르면 exit 1 로 끝낸다.
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

const port = Number(readArg("port", "8093"));
const outDir = resolve(readArg("out-dir", join(MOBILE_DIR, "shots/owner-instructors")));
const baseUrl = `http://localhost:${port}`;

// ---- 예시 응답(계약 08 §1·§3·§4 · README §6-1 모양 그대로). 이름은 보드 예시, 연락처는 가린 값 ----
const ACADEMY_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ME = {
  accountId: "33333333-3333-4333-8333-333333333333",
  displayName: "예시 대표",
  roles: ["owner"],
  secondFactorVerified: true,
  consoleAccess: true,
  academies: [{ academyId: ACADEMY_ID, name: "예시 댄스 학원", as: "owner", permissions: ["owner"], menus: ["instructors"] }],
  platformMenus: [],
};
const aff = (n, status, name, extra = {}) => ({
  affiliationId: `55555555-5555-4555-8555-55555555555${n}`,
  status,
  source: "application",
  requestedAt: "2026-11-20T01:10:00.000Z",
  instructor: { accountId: `66666666-6666-4666-8666-66666666666${n}`, displayName: name, phoneMasked: "010-****-5678", activityGenre: null },
  message: null,
  isAcademyEmployee: false,
  permissions: [],
  ...extra,
});
const IU = aff(1, "pending", "아이유", { message: "주말 저녁 수업을 맡고 싶어요.", instructor: { accountId: "66666666-6666-4666-8666-666666666661", displayName: "아이유", phoneMasked: "010-****-5678", activityGenre: "salsa_bachata" } });
const JUNG = aff(2, "pending", "정우진", { source: "invite", message: "평일 낮 수업이 가능해요.", instructor: { accountId: "66666666-6666-4666-8666-666666666662", displayName: "정우진", phoneMasked: "010-****-1234", activityGenre: null } });
const LEE = aff(3, "active", "이준호", { permissions: ["roster_manage", "class_submit"], instructor: { accountId: "66666666-6666-4666-8666-666666666663", displayName: "이준호", phoneMasked: "010-****-2222", activityGenre: "salsa_bachata" } });
const KIM = aff(4, "active", "김하나", { isAcademyEmployee: true, permissions: ["roster_manage"] });
const PARK = aff(5, "active", "박서윤");
const ORDER = ["roster_manage", "class_manage", "class_submit"];

/** `/api/**` 를 계약 모양 예시로 답한다. 승인·권한 교체는 상태를 바꿔 다음 GET 에 반영한다 */
async function installApiMock(page, log, sent) {
  let pending = [IU, JUNG];
  let active = [LEE, KIM, PARK];
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
    const base = `/api/academies/${ACADEMY_ID}`;
    if (method === "GET" && path === "/api/staff/me") return json(200, STAFF_ME);
    if (method === "GET" && path === `${base}/affiliations`) {
      return json(200, { items: url.searchParams.get("status") === "pending" ? pending : active });
    }
    const approve = path.match(new RegExp(`^${base}/affiliations/([^/]+)/approve$`));
    if (method === "POST" && approve) {
      const body = request.postDataJSON();
      sent.push({ kind: "approve", id: approve[1], body });
      const target = pending.find((a) => a.affiliationId === approve[1]);
      if (!target) return json(404, { detail: "소속 신청을 찾을 수 없어요", code: "NOT_FOUND" });
      pending = pending.filter((a) => a !== target);
      active = [{ ...target, status: "active", isAcademyEmployee: body.isAcademyEmployee }, ...active];
      return json(200, { affiliationId: target.affiliationId, status: "active", isAcademyEmployee: body.isAcademyEmployee, shareRateBp: body.shareRateBp ?? null, decidedAt: "2026-11-21T03:00:00.000Z" });
    }
    const perm = path.match(new RegExp(`^${base}/affiliations/([^/]+)/permissions$`));
    if (method === "PUT" && perm) {
      const body = request.postDataJSON();
      sent.push({ kind: "permissions", id: perm[1], body });
      const next = ORDER.filter((p) => body.permissions.includes(p));
      active = active.map((a) => (a.affiliationId === perm[1] ? { ...a, permissions: next } : a));
      return json(200, { affiliationId: perm[1], permissions: next, changedAt: "2026-11-21T03:05:00.000Z" });
    }
    if (method === "POST" && path === `${base}/invites`) {
      sent.push({ kind: "invite", body: request.postDataJSON() });
      return json(201, { inviteId: "77777777-7777-4777-8777-777777777777", inviteUrl: "http://localhost:3000/invite/예시-1회용-토큰", expiresAt: "2026-11-28T03:00:00.000Z" });
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

/** 화면이 서버에 보낸 본문이 기대와 같은지 본다. 다르면 이유를 남기고 실패로 끝낸다 */
function expectSent(sent, index, expected) {
  const actual = JSON.stringify(sent[index] ?? null);
  const ok = actual === JSON.stringify(expected);
  console.log(`[check] ${ok ? "OK" : "FAIL"} 보낸 본문 #${index}: ${actual}`);
  if (!ok) {
    console.log(`[check]   기대: ${JSON.stringify(expected)}`);
    process.exitCode = 1;
  }
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
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installApiMock(page, apiLog, sent);
    mkdirSync(outDir, { recursive: true });

    // 장면 1 — O37 첫 화면
    await page.goto(`${baseUrl}/owner/instructors`, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.getByText("소속 신청 2건 · 승인 대기").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await shot(page, "O37.png");

    // 장면 2 — 아이유 「승인」 → 비율 칸이 비어 있으면 「승인하기」가 꺼져 있다 → 60 입력
    await page.getByRole("button", { name: "아이유 승인" }).click();
    const submit = page.getByRole("button", { name: "승인하기" });
    await submit.waitFor({ timeout: RENDER_TIMEOUT_MS });
    const disabledWhenEmpty = await submit.isDisabled();
    console.log(`[check] ${disabledWhenEmpty ? "OK" : "FAIL"} 비율이 비면 「승인하기」 꺼짐: ${disabledWhenEmpty}`);
    if (!disabledWhenEmpty) process.exitCode = 1;
    await page.getByLabel("강사 몫 비율(퍼센트)").fill("101");
    const disabledWhenOver = await submit.isDisabled();
    console.log(`[check] ${disabledWhenOver ? "OK" : "FAIL"} 101% 면 「승인하기」 꺼짐: ${disabledWhenOver}`);
    if (!disabledWhenOver) process.exitCode = 1;
    await page.getByLabel("강사 몫 비율(퍼센트)").fill("60");
    await shot(page, "O37-승인-입력.png");

    // 장면 3 — 「승인하기」 → 목록이 다시 그려진다
    await submit.click();
    await page.getByText("아이유 강사를 승인했어요 · 강사 몫 60%").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByText("소속 강사 4명").waitFor({ timeout: RENDER_TIMEOUT_MS });
    expectSent(sent, 0, { kind: "approve", id: IU.affiliationId, body: { isAcademyEmployee: false, shareRateBp: 6000 } });
    await shot(page, "O37-승인-후.png");

    // 장면 4 — 「링크 공유하기」 → 링크와 기한이 카드에 남는다(헤드리스에는 공유 창이 없다)
    await page.getByRole("button", { name: "링크 공유하기" }).click();
    await page.getByText("http://localhost:3000/invite/예시-1회용-토큰").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByRole("button", { name: "새 링크 공유하기" }).waitFor({ timeout: RENDER_TIMEOUT_MS });
    expectSent(sent, 1, { kind: "invite", body: {} });
    await page.getByText("초대 링크", { exact: true }).scrollIntoViewIfNeeded();
    await shot(page, "O37-초대-링크.png");

    // 장면 5 — 소속 강사 이준호 「권한 ›」 → O38
    await page.getByRole("button", { name: "이준호 강사 권한" }).click();
    await page.getByText("이준호 강사 권한").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.getByText("끄면 바로 막혀요").waitFor({ timeout: RENDER_TIMEOUT_MS });
    await shot(page, "O38.png");

    // 장면 6 — 「관리자 웹 · 수업·포스터 등록」 켜기 → 나머지 둘(예약·명단·수업 등록)은 그대로 실어 보낸다
    await page.getByRole("switch", { name: "관리자 웹 · 수업·포스터 등록" }).click();
    await page.waitForFunction(() => document.body.innerText.split("켜짐").length - 1 === 3, null, { timeout: RENDER_TIMEOUT_MS });
    expectSent(sent, 2, { kind: "permissions", id: LEE.affiliationId, body: { permissions: ["roster_manage", "class_manage", "class_submit"] } });
    await shot(page, "O38-토글-후.png");

    console.log(`[shot] 주소: ${page.url()}`);
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
