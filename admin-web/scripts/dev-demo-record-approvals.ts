// 개발 PC 시연 녹화 — 「강사 소속 승인」·「강사 수업 승인」을 진짜 서버로 처음부터 끝까지 누른다(2026-11-23 사용자 요청).
//   지금 실제 코드로 도는 주요 기능 둘이다. 결제(M3)·정산(M5)·멤버십(M6)·AI 에이전트(MX)는 마일스톤이 끝날 때 같은 방식으로 더한다.
//
// 흐름(강사 창 ↔ 대표 창을 번갈아):
//   강사 ① 가입(가짜 본인확인) → ② 「브래드 댄스 스튜디오」에 소속 신청
//   대표 ③ 앱 로그인 → 해야 할 일 → 강사 관리에서 승인(프리랜서 · 몫 60%) → ④ 그 강사 권한에서 「수업 등록」 켜기
//   강사 ⑤ 수업 만들기(살사 · 정규 · 화요일 20:30~21:30 · A홀) → 정원 → 수업 등록
//   대표 ⑥ 홈 → 승인 대기 수업 → 수업 승인 → 「공개」
// 실행마다 새 강사를 만들므로 몇 번이고 다시 돌릴 수 있다(학원·홀·환불 공지는 scripts/dev-demo-owner.ts 와 개발 DB 준비분).
//
// 실행: cd admin-web && KDANCE_DEV_ROUTES=true ./node_modules/.bin/jiti scripts/dev-demo-record-approvals.ts <폴더>
//   DEMO_HEADLESS=1 이면 창 없이(시험 실행), DEMO_RECORD=1 이면 강사·대표 창을 각각 영상으로 <폴더>/video/ 에 남긴다.
import "dotenv/config";

import { homedir } from "node:os";
import { join } from "node:path";

import { chromium, type BrowserContext, type Locator, type Page } from "@playwright/test";
import pg from "pg";

const OUT = process.argv[2] ?? ".";
const CHROME = join(homedir(), ".cache/ms-playwright/chromium-1255/chrome-linux64/chrome");
const APP = "http://localhost:8081";
const HEADLESS = process.env["DEMO_HEADLESS"] === "1";
const RECORD = process.env["DEMO_RECORD"] === "1";
const VIDEO_DIR = join(OUT, "video");
const PAUSE = HEADLESS ? 600 : 1800;
const ACADEMY = "브래드 댄스 스튜디오";

/**
 * 개발 DB 준비 — ① 앞 시연 실행이 남긴 「승인 대기」 신청(시연 이름 목록)은 철회로 돌려 화면에 겹치지 않게 하고
 * ② 이 학원에 아직 없는 시연 이름 하나를 고른다(같은 이름이 둘이면 화면에서 누구를 눌러야 할지 모호하다). 다 쓰였으면 이름 뒤에 번호를 붙인다.
 */
async function pickUnusedName(): Promise<string> {
  const url = process.env["DATABASE_URL"] ?? "";
  if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에서만 돈다");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const { rowCount } = await pool.query(
      `UPDATE instructor_affiliations a SET status = 'withdrawn', updated_at = now()
         FROM staff_accounts s WHERE s.id = a.instructor_account_id AND a.status = 'pending' AND s.display_name = ANY($1)`,
      [NAMES],
    );
    console.log(`앞 실행이 남긴 대기 신청 ${rowCount ?? 0}건을 철회로 돌림`);
    const { rows } = await pool.query<{ display_name: string }>(
      `SELECT DISTINCT s.display_name FROM instructor_affiliations a JOIN staff_accounts s ON s.id = a.instructor_account_id
         JOIN academies ac ON ac.id = a.academy_id WHERE ac.name = $1 AND a.status IN ('pending', 'active')`,
      [ACADEMY],
    );
    const used = new Set(rows.map((r) => r.display_name));
    return NAMES.find((n) => !used.has(n)) ?? `${NAMES[0]}${used.size}`;
  } finally {
    await pool.end();
  }
}

// 이번 실행의 새 강사 — 이름은 가상, 아이디·사람 키는 실행마다 다르게
const TAG = Date.now().toString(36).slice(-5);
// 이름은 실행마다 목록에서 하나 — 앞 실행이 남긴 같은 이름의 신청과 화면에서 섞이지 않게
const NAMES = ["윤하늘", "강다온", "서지우", "임채린", "오세린", "문하율", "백도윤", "홍예나"];
const INSTRUCTOR = { name: await pickUnusedName(), username: `haneul${TAG}`, password: "Demo-pass-2026!", personKey: `demo-haneul-${TAG}` };
const CLASS_TITLE = `살사 온원 입문 · 12월 (${TAG})`;

let shotNo = 0;
async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(PAUSE);
  const file = join(OUT, `${String(++shotNo).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`[화면] ${file}`);
}

async function typeSlowly(box: Locator, text: string): Promise<void> {
  await box.click();
  await box.fill("");
  await box.pressSequentially(text, { delay: HEADLESS ? 0 : 90 });
}

/** 한 단계를 이름 붙여 돌린다 — 실패하면 그 순간 화면을 남기고 멈춘다 */
async function step(page: Page, name: string, run: () => Promise<void>): Promise<void> {
  console.log(`▶ ${name}`);
  try {
    await run();
  } catch (error) {
    await page.screenshot({ path: join(OUT, `FAIL-${name}.png`), fullPage: true });
    console.log(`✖ ${name} 실패 — FAIL-${name}.png`);
    throw error;
  }
}

async function newPhone(ctxOpts: { label: string }): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    ...(RECORD ? { recordVideo: { dir: VIDEO_DIR, size: { width: 390, height: 844 } } } : {}),
  });
  const page = await ctx.newPage();
  page.on("response", (r) => {
    if (r.url().includes(":3000/api/") && r.request().method() !== "OPTIONS") {
      console.log(`  [${ctxOpts.label}] ${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}`);
    }
  });
  return { ctx, page };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: HEADLESS, slowMo: HEADLESS ? 0 : 250 });
const teacher = await newPhone({ label: "강사" });
const owner = await newPhone({ label: "대표" });
const t = teacher.page;
const o = owner.page;

// ── 강사 ① 가입 ──────────────────────────────────────────────────────────────
await step(t, "강사-가입", async () => {
  await t.goto(`${APP}/staff-login`, { waitUntil: "networkidle" });
  await t.getByRole("button", { name: "강사 회원가입" }).click();
  await typeSlowly(t.getByRole("textbox", { name: "이름" }), INSTRUCTOR.name);
  await t.getByRole("radio", { name: "여" }).click();
  await typeSlowly(t.getByRole("textbox", { name: "생년월일" }), "1994-07-15");
  await typeSlowly(t.getByRole("textbox", { name: "휴대폰 번호" }), "01055557777");
  await typeSlowly(t.getByRole("textbox", { name: "시험용 사람 키" }), INSTRUCTOR.personKey);
  await shot(t, "teacher-identity");
  await t.getByRole("button", { name: /본인확인하고 다음/ }).click();
  await typeSlowly(t.getByRole("textbox", { name: "아이디" }), INSTRUCTOR.username);
  await t.getByRole("button", { name: "아이디 중복 확인" }).click();
  await typeSlowly(t.getByRole("textbox", { name: "비밀번호", exact: true }), INSTRUCTOR.password);
  await typeSlowly(t.getByRole("textbox", { name: "비밀번호 한 번 더" }), INSTRUCTOR.password);
  await typeSlowly(t.getByRole("textbox", { name: "회원에게 보이는 이름" }), INSTRUCTOR.name);
  await t.getByRole("radio", { name: "살사/바차타" }).click();
  await t.getByRole("checkbox", { name: "전체 동의" }).click();
  await shot(t, "teacher-signup");
  await t.getByRole("button", { name: "가입하고 시작" }).click();
  await t.getByText("학원 찾아 소속 신청").waitFor({ timeout: 20_000 });
  await shot(t, "teacher-academy-empty");
});

// ── 강사 ② 소속 신청 ─────────────────────────────────────────────────────────
await step(t, "강사-소속신청", async () => {
  await t.getByText("학원 찾아 소속 신청").click();
  await typeSlowly(t.getByRole("textbox", { name: "학원 검색어" }), "브래드");
  await t.getByRole("button", { name: "학원 검색" }).click();
  await t.getByRole("radio", { name: ACADEMY }).click();
  await typeSlowly(t.getByRole("textbox", { name: "대표에게 한마디" }), "살사 온원 5년 차예요. 화·목 저녁 수업 가능해요.");
  await shot(t, "teacher-apply");
  await t.getByRole("button", { name: /소속 신청/ }).last().click();
  await t.waitForTimeout(1500);
  await shot(t, "teacher-apply-done");
});

// ── 대표 ③ 소속 승인 ─────────────────────────────────────────────────────────
await step(o, "대표-소속승인", async () => {
  await o.goto(`${APP}/staff-login`, { waitUntil: "networkidle" });
  await o.getByRole("tab", { name: /Owner/ }).click();
  await typeSlowly(o.getByRole("textbox", { name: "아이디" }), "brad");
  await typeSlowly(o.getByRole("textbox", { name: "비밀번호" }), "brad");
  await o.getByRole("button", { name: "로그인" }).click();
  await o.getByText(`${INSTRUCTOR.name} 강사 소속 신청`).waitFor({ timeout: 20_000 });
  await shot(o, "owner-home-todo");
  await o.getByText(`${INSTRUCTOR.name} 강사 소속 신청`).click();
  await o.getByRole("button", { name: `${INSTRUCTOR.name} 승인` }).waitFor({ timeout: 20_000 });
  await shot(o, "owner-instructors");
});

// ── 대표 ③-2 승인(프리랜서 · 몫 60%) → ④ 수업 등록 권한 켜기 ────────────────────
await step(o, "대표-승인하기", async () => {
  await o.getByRole("button", { name: `${INSTRUCTOR.name} 승인` }).click();
  await o.getByRole("radio", { name: "프리랜서 · 사업자" }).click();
  await typeSlowly(o.getByRole("textbox", { name: "강사 몫 비율(퍼센트)" }), "60");
  await shot(o, "owner-approve-form");
  await o.getByText("승인하기", { exact: true }).click();
  await o.getByText(`${INSTRUCTOR.name} 강사를 승인했어요`, { exact: false }).waitFor({ timeout: 20_000 });
  await shot(o, "owner-approved");
  const permissionRow = o.getByRole("button", { name: `${INSTRUCTOR.name} 강사 권한` });
  await permissionRow.waitFor({ state: "attached", timeout: 20_000 });
  await permissionRow.scrollIntoViewIfNeeded();
  await shot(o, "owner-active-list");
  await permissionRow.click();
  await o.getByLabel("수업 등록", { exact: true }).click();
  await o.waitForTimeout(1500);
  await shot(o, "owner-permission-class-submit");
});

// ── 강사 ⑤ 수업 만들기 → 등록 ────────────────────────────────────────────────
await step(t, "강사-수업등록", async () => {
  // 앱이 처음 읽어 둔 권한을 그대로 쓰므로, 강사가 앱을 다시 열어 로그인한다(승인·권한이 새로 반영된다)
  await t.goto(`${APP}/staff-login`, { waitUntil: "networkidle" });
  await typeSlowly(t.getByRole("textbox", { name: "아이디" }), INSTRUCTOR.username);
  await typeSlowly(t.getByRole("textbox", { name: "비밀번호" }), INSTRUCTOR.password);
  await t.getByRole("button", { name: "로그인" }).click();
  await t.getByText(ACADEMY).first().waitFor({ timeout: 20_000 });
  await shot(t, "teacher-academy-joined");
  await t.getByRole("tab", { name: "수업" }).click();
  await t.getByRole("textbox", { name: "수업명" }).waitFor({ timeout: 20_000 });
  const pick = async (label: string) => t.getByText(label, { exact: true }).first().click();
  await pick("살사");
  await pick("정규");
  await pick("입문");
  await pick("2030세대");
  await typeSlowly(t.getByRole("textbox", { name: "수업명" }), CLASS_TITLE);
  await typeSlowly(t.getByRole("textbox", { name: "금액" }), "200000");
  await pick("강남점 A홀");
  await pick("화");
  await typeSlowly(t.getByRole("textbox", { name: "기간 시작일" }), "2026-12-01");
  await typeSlowly(t.getByRole("textbox", { name: "기간 끝날" }), "2026-12-22");
  await typeSlowly(t.getByRole("textbox", { name: "시작 시각" }), "20:30");
  await typeSlowly(t.getByRole("textbox", { name: "끝 시각" }), "21:30");
  await t.waitForTimeout(1500);
  // 같은 홀·시간에 이미 수업이 있으면 「겹침」 안내와 빈 시간 제안이 뜬다 — 제안 중 첫 번째를 눌러 피한다
  if (await t.getByText("겹침", { exact: true }).isVisible()) {
    await shot(t, "teacher-class-overlap");
    await t.getByText(/^[월화수목금토일] \d{2}:\d{2}$/).first().click();
    await t.waitForTimeout(1500);
  }
  await shot(t, "teacher-class-step1");
  await t.getByRole("button", { name: "다음" }).click();
  await t.getByRole("button", { name: /수업 등록/ }).waitFor({ timeout: 20_000 });
  // 정원 — 남녀 따로면 6·6, 아니면 12
  if (await t.getByLabel("남 정원", { exact: true }).count()) {
    await typeSlowly(t.getByLabel("남 정원", { exact: true }), "6");
    await typeSlowly(t.getByLabel("여 정원", { exact: true }), "6");
  } else {
    await typeSlowly(t.getByLabel("정원 정원", { exact: true }), "12");
  }
  await shot(t, "teacher-class-step2");
  await t.getByRole("button", { name: "수업 등록" }).click();
  await t.waitForTimeout(2500);
  await shot(t, "teacher-class-submitted");
});

// ── 대표 ⑥ 알림 → 수업 승인 ─────────────────────────────────────────────────
await step(o, "대표-수업승인", async () => {
  // 대표 앱에는 아직 알림함으로 가는 탭이 없다(하단 탭은 뒤 Task). 휴대폰 알림을 누른 것처럼 앱 안에서 알림함으로 옮긴다
  await o.evaluate(() => {
    window.history.pushState({}, "", "/owner/notifications");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await o.getByText(CLASS_TITLE, { exact: false }).first().waitFor({ timeout: 20_000 });
  await shot(o, "owner-notifications");
  await o.getByText(CLASS_TITLE, { exact: false }).first().click();
  await o.getByRole("button", { name: "승인", exact: true }).waitFor({ timeout: 20_000 });
  await shot(o, "owner-class-review");
  await o.getByRole("button", { name: "승인", exact: true }).click();
  await o.waitForTimeout(2500);
  await shot(o, "owner-class-approved");
});

console.log("끝 — 소속 승인·수업 승인 한 바퀴");
if (RECORD) {
  await teacher.ctx.close();
  await owner.ctx.close();
}
await browser.close();
