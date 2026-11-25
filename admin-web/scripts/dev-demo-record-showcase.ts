// 개발 PC 시연 영상 — 회원(앱) · 강사(앱) · 대표(웹+앱) 핵심 기능을 진짜 서버로 눌러 녹화하고, 자막을 구워 영상 두 개를 만든다(2026-11-25 사용자 요청).
//   「회원/강사/대표 핵심 기능만 앱/웹에서 시연 및 녹화」「하나의 영상」「제출용으로 각각 30초씩 1분 30초 핵심 영상도 하나」
//   「휴대폰 로그인이나 비번은 어려우니까 너가 알아서 넣어줘서 실행되게」 — 로그인 값과 2단계 인증 6자리는 이 스크립트가 넣는다.
//
// 만드는 것(<폴더> 아래):
//   full.mp4·full.webm        전체 시연(회원 → 강사 → 대표). 역할마다 2초 제목 카드, 화면 아래 한 줄 자막
//   highlight.mp4·highlight.webm  제출용 1분 30초(역할마다 30초 — 제목 1.5초 + 핵심 장면을 30초에 맞춰 살짝 빠르게/느리게)
//   timeline.json             장면별 자막·핵심 구간·잘라 낸 구간(초). 녹화 없이 영상만 다시 만들 때 쓴다
//   NN-*.png                  장면 스크린샷
//
// 흐름(녹화 순서):
//   준비  아이유 강사 이름으로 「승인 대기」 수업 1개를 진짜 경로로 올린다(POST /api/classes → submit). 이미 대기 중이면 그대로 쓴다
//   회원  앱 로그인 → 홈(댄스스포츠) → 장르 바꾸기 → 라틴 → 홈(댄스스포츠(라틴)) → 수업 상세 → 결제 화면(결제 버튼은 누르지 않는다 — PG 미연동)
//         → AI 플래너 「아이유 강사님 수업 전체 알려줘」 → 캘린더 → 마이 → 레벨 카드 → 장르를 「전체」로 되돌림
//   강사  앱 로그인(iuu) → 학원(소속·권한) → 홈 → 수업 만들기(라틴·스탠다드, 몇 칸만 — 제출 안 함) → 학원 → 마이
//   대표  앱 로그인(brad) → 알림 → 아이유 수업 승인   ※ 웹에서 인증 앱을 켜면 앱 로그인이 막히므로(서버 규칙) 앱을 먼저 녹화한다
//         웹 로그인 → 인증 앱 등록 QR → 6자리 입력 → 대시보드 → 강사 관리(소속 신청 1건 승인) → 예약·명단 → 입점·설정
//   정리  brad 의 2단계 인증을 다시 비운다(twoFactor 행 삭제 + twoFactorEnabled=false). 준비 때 만든 강사 세션도 지운다
//   편집  전체 영상은 대표 장면을 웹(로그인~소속 승인) → 앱(수업 승인) → 웹(나머지) 순서로 이어 붙인다
//
// 2단계 6자리: 화면이 부른 POST /api/auth/two-factor/enable 응답의 totpURI 에서 비밀값을 읽어 계산한다(DB 비밀값은 풀지 않는다).
//
// 실행: cd admin-web && KDANCE_DEV_ROUTES=true ./node_modules/.bin/jiti scripts/dev-demo-record-showcase.ts <폴더>
//   DEMO_COMPOSE_ONLY=1 이면 녹화 없이 <폴더>/timeline.json 과 video/ 로 영상만 다시 만든다.
//   서버: admin-web :3000(KDANCE_DEV_ROUTES=true) · Expo 웹 :8081 · agent-server :8100 이 떠 있어야 한다. 개발 DB(kdance_next)만 쓴다.
import "dotenv/config";

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { createStaffAuth, staffTotpPeriodSeconds } from "../lib/server/staff-auth";

const OUT = resolve(process.argv[2] ?? ".");
const VIDEO_DIR = join(OUT, "video");
const WORK_DIR = join(OUT, "work");
const CHROME = join(homedir(), ".cache/ms-playwright/chromium-1255/chrome-linux64/chrome");
const FFMPEG = join(homedir(), ".local/bin/ffmpeg");
const FONT = join(homedir(), ".fonts/NotoSansCJKkr-Bold.otf");
const APP = "http://localhost:8081";
const WEB = "http://localhost:3000";
const COMPOSE_ONLY = process.env["DEMO_COMPOSE_ONLY"] === "1";

// 사람이 따라 볼 수 있는 속도 — 글자 사이(ms), 동작 사이(ms), 장면마다 멈추는 시간(ms)
const TYPE_DELAY = 150;
const SLOW_MO = 300;
const PAUSE = 3800;

const MEMBER = { email: "demo-jisoo@example.com", password: "jisoo" };
const INSTRUCTOR = { username: "iuu", password: "iu", name: "아이유" };
const OWNER = { username: "brad", password: "brad" };
// 준비 단계에서 아이유 이름으로 올리는 수업 — 대표 장면에서 승인한다
const PENDING_CLASS_TITLE = "라틴 쌈바 입문 · 1월";

// ── 녹화 기록(타임라인) ─────────────────────────────────────────────────────────
// 장면 하나 = 브라우저 창 하나의 영상. 자막·핵심 구간·잘라 낼 구간을 「영상 시작부터 몇 초」로 적어 둔다.
type Caption = { at: number; text: string };
type Segment = {
  id: string;
  kind: "app" | "web";
  video: string;
  end: number;
  captions: Caption[];
  highlights: { from: number; to: number; tag: string }[];
  skips: { from: number; to: number }[];
};
type Timeline = { segments: Segment[] };

/** 녹화 중인 창 하나 — 시작 시각을 잡아 두고 자막·구간을 초 단위로 적는다 */
class Recorder {
  readonly segment: Segment;
  private readonly t0 = Date.now();
  private openHighlight: { from: number; tag: string } | null = null;
  private openSkip: number | null = null;

  constructor(id: string, kind: "app" | "web") {
    this.segment = { id, kind, video: "", end: 0, captions: [], highlights: [], skips: [] };
  }
  now(): number {
    return (Date.now() - this.t0) / 1000;
  }
  /** 화면 아래 자막을 바꾼다 — 다음 자막이 나올 때까지 유지된다 */
  caption(text: string): void {
    console.log(`  [자막 ${this.now().toFixed(1)}s] ${text}`);
    this.segment.captions.push({ at: this.now(), text });
  }
  /** 제출용 핵심 영상에 넣을 구간 시작·끝 */
  hlStart(tag: string): void {
    this.openHighlight = { from: this.now(), tag };
  }
  hlEnd(): void {
    if (this.openHighlight === null) return;
    this.segment.highlights.push({ ...this.openHighlight, to: this.now() });
    this.openHighlight = null;
  }
  /** 전체 영상에서 잘라 낼 구간(기다리는 시간 등) */
  skipStart(): void {
    this.openSkip = this.now();
  }
  skipEnd(): void {
    if (this.openSkip === null) return;
    this.segment.skips.push({ from: this.openSkip, to: this.now() });
    this.openSkip = null;
  }
}

let shotNo = 0;
async function shot(page: Page, name: string): Promise<void> {
  const file = join(OUT, `${String(++shotNo).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  [화면] ${file}`);
}

async function pause(page: Page, ms = PAUSE): Promise<void> {
  await page.waitForTimeout(ms);
}

/** 있으면 보여 주고, 화면이 안 열리면 건너뛴다(건너뛴 장면은 skipped.json 에 남긴다) */
const skippedScenes: { scene: string; reason: string }[] = [];
async function optional(page: Page, scene: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0]! : String(error);
    skippedScenes.push({ scene, reason });
    console.log(`  [건너뜀] ${scene} — ${reason}`);
    await page.screenshot({ path: join(OUT, `SKIP-${scene.replace(/[^\p{L}\p{N}]+/gu, "-")}.png`) }).catch(() => undefined);
  }
}

/** 사람이 치듯 한 글자씩 넣는다 */
async function typeSlowly(box: Locator, text: string): Promise<void> {
  await box.click();
  await box.fill("");
  await box.pressSequentially(text, { delay: TYPE_DELAY });
}

/** 화면 가운데에서 휠을 천천히 굴린다(목록을 훑어보는 느낌) */
async function scrollSlowly(page: Page, dy: number, steps = 6): Promise<void> {
  const size = page.viewportSize() ?? { width: 390, height: 844 };
  await page.mouse.move(size.width / 2, size.height / 2);
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, dy / steps);
    await page.waitForTimeout(120);
  }
}

/** 창 하나를 열고 녹화를 시작한다 */
async function openWindow(browser: Browser, id: string, kind: "app" | "web"): Promise<{ ctx: BrowserContext; page: Page; rec: Recorder }> {
  const size = kind === "app" ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: VIDEO_DIR, size } });
  const page = await ctx.newPage();
  const rec = new Recorder(id, kind);
  page.on("response", (r) => {
    if (r.url().includes(":3000/api/") && r.request().method() !== "OPTIONS") {
      console.log(`    [${id}] ${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}`);
    }
  });
  return { ctx, page, rec };
}

/** 창을 닫아 영상 파일을 완성하고 타임라인에 경로를 적는다 */
async function closeWindow(w: { ctx: BrowserContext; page: Page; rec: Recorder }): Promise<Segment> {
  w.rec.hlEnd();
  w.rec.skipEnd();
  w.rec.segment.end = w.rec.now();
  const video = w.page.video();
  await w.ctx.close();
  w.rec.segment.video = (await video?.path()) ?? "";
  console.log(`  [영상] ${w.rec.segment.id} → ${w.rec.segment.video} (${w.rec.segment.end.toFixed(1)}초)`);
  return w.rec.segment;
}

// ── 준비: 아이유 이름으로 승인 대기 수업 1개 ────────────────────────────────────
async function preparePendingClass(pool: pg.Pool): Promise<void> {
  const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);
  const [existing] = await q<{ id: string }>(
    `SELECT c.id::text AS id FROM classes c JOIN staff_accounts s ON s.id = c.instructor_account_id
      WHERE c.title = $1 AND c.status = 'pending_approval' AND s.display_name = $2`,
    [PENDING_CLASS_TITLE, INSTRUCTOR.name],
  );
  if (existing !== undefined) {
    console.log(`준비: 승인 대기 수업이 이미 있다(${existing.id}) — 그대로 쓴다`);
    return;
  }
  const [teacher] = await q<{ user_id: string; account_id: string; academy_id: string }>(
    `SELECT u.id AS user_id, s.id::text AS account_id, a.academy_id::text AS academy_id
       FROM auth."user" u JOIN staff_accounts s ON s.auth_user_id = u.id
       JOIN instructor_affiliations a ON a.instructor_account_id = s.id AND a.status = 'active'
      WHERE u.username = $1 LIMIT 1`,
    [INSTRUCTOR.username],
  );
  if (teacher === undefined) throw new Error("아이유(iuu) 강사의 active 소속이 없다");
  const rooms = await q<{ id: string; name: string }>(
    `SELECT r.id::text AS id, r.name FROM rooms r JOIN academy_branches b ON b.id = r.branch_id
      WHERE b.academy_id = $1 AND r.status = 'active' ORDER BY r.name`,
    [teacher.academy_id],
  );
  // 강사 세션은 이 준비에서만 쓰고 끝나면 지운다(준비가 만든 것만 정리)
  const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
  const ctx = await auth.$context;
  const token = (await ctx.internalAdapter.createSession(teacher.user_id)).token;
  const call = async (method: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${WEB}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
  };
  try {
    // 낮 시간 토요일 — 홀이 막혀 있으면(409 ROOM_CONFLICT 등) 다음 홀·다음 시간으로
    for (const start of ["14:00", "15:00", "16:00"]) {
      for (const room of rooms) {
        const end = `${String(Number(start.slice(0, 2)) + 1).padStart(2, "0")}:00`;
        const created = await call("POST", "/api/classes", {
          academyId: teacher.academy_id,
          classKind: "regular",
          title: PENDING_CLASS_TITLE,
          subGenre: "latin",
          discipline: "samba",
          targetLevel: "entry",
          targetAges: ["all"],
          roomId: room.id,
          priceAmount: 100000,
          schedule: { kind: "recurring", weekdays: ["sat"], startTime: start, endTime: end, periodFrom: "2027-01-09", periodTo: "2027-01-30" },
          capacity: { mode: "gender_split", male: 8, female: 8, any: null },
          refundDeadlineOn: null,
          introText: "쌈바 기본 바운스와 보타포고를 천천히 익혀요.",
          instructorAccountId: teacher.account_id,
        });
        if (created.status !== 201) {
          console.log(`준비: 만들기 ${room.name} ${start} → ${created.status} ${JSON.stringify(created.body["code"] ?? created.body)}`);
          continue;
        }
        const id = String(created.body["classId"]);
        const submitted = await call("POST", `/api/classes/${id}/submit`, {});
        if (submitted.status === 200) {
          console.log(`준비: 「${PENDING_CLASS_TITLE}」 · ${room.name} · 토 ${start}–${end} → 승인 대기(${id})`);
          return;
        }
        console.log(`준비: 제출 ${room.name} ${start} → ${submitted.status} ${JSON.stringify(submitted.body["code"] ?? submitted.body)}`);
        // 제출이 막힌 임시 저장본은 지운다(이 준비가 만든 것)
        await pool.query("DELETE FROM classes WHERE id = $1 AND status = 'draft'", [id]);
      }
    }
    throw new Error("승인 대기 수업을 만들지 못했다 — 홀·시간이 모두 막힘");
  } finally {
    await pool.query(`DELETE FROM auth.session WHERE token = $1`, [token]);
  }
}

// ── 회원 앱 ──────────────────────────────────────────────────────────────────
async function recordMember(browser: Browser): Promise<Segment> {
  console.log("── 회원 앱 ──");
  const w = await openWindow(browser, "member", "app");
  const { page, rec } = w;
  await page.goto(`${APP}/login`, { waitUntil: "networkidle" });
  rec.caption("회원 · 이메일과 비밀번호로 로그인");
  await pause(page, 1200);
  await typeSlowly(page.getByRole("textbox", { name: "이메일" }), MEMBER.email);
  await typeSlowly(page.getByRole("textbox", { name: "비밀번호" }), MEMBER.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await page.getByRole("heading", { name: "댄스스포츠", exact: true }).waitFor({ timeout: 20_000 });

  rec.caption("회원 · 홈 — 기준 장르 「댄스스포츠」 수업 목록");
  await pause(page);
  await shot(page, "member-home-dancesport");
  await scrollSlowly(page, 500, 8);
  await pause(page, 2000);
  await scrollSlowly(page, -500, 8);
  await pause(page, 1200);

  rec.caption("회원 · 정렬 — 추천순 · 마감 임박 · 남은 자리");
  await page.getByRole("radio", { name: "마감 임박" }).click();
  await pause(page, 2500);
  await page.getByRole("radio", { name: "남은 자리" }).click();
  await pause(page, 2500);
  await page.getByRole("radio", { name: "추천순" }).click();
  await pause(page, 1500);

  await optional(page, "회원 알림함", async () => {
    rec.caption("회원 · 알림함 — 수업 · 결제·쿠폰 · 학원 소식 · 대기");
    await page.getByRole("button", { name: "알림함 열기" }).click();
    await page.getByRole("heading", { name: "알림" }).waitFor({ timeout: 20_000 });
    await pause(page);
    await page.getByRole("button", { name: "뒤로 가기" }).click();
    await page.getByRole("button", { name: "장르 바꾸기" }).waitFor({ timeout: 20_000 });
    await pause(page, 1200);
  });

  rec.hlStart("member-genre");
  rec.caption("회원 · 지금 기준 장르는 「댄스스포츠」 전체");
  await pause(page, 2000);

  rec.caption("회원 · 「장르 바꾸기」 → 댄스스포츠 안에서 「라틴」 고르기");
  await page.getByRole("button", { name: "장르 바꾸기" }).click();
  await page.getByRole("radio", { name: "라틴", exact: true }).waitFor({ timeout: 20_000 });
  await pause(page, 1500);
  await page.getByRole("radio", { name: "라틴", exact: true }).click();
  await pause(page, 1500);
  await shot(page, "member-base-genre-latin");
  await page.getByRole("button", { name: "댄스스포츠(라틴)로 바꾸기" }).click();
  await page.getByRole("heading", { name: "댄스스포츠(라틴)" }).waitFor({ timeout: 20_000 });
  rec.caption("회원 · 홈이 「댄스스포츠(라틴)」 수업만 보여 줘요");
  await pause(page, 3000);
  await shot(page, "member-home-latin");
  rec.hlEnd();

  rec.caption("회원 · 수업 카드 → 수업 상세(요일 · 회차 · 정원)");
  await page.getByRole("button", { name: /라틴 룸바 입문/ }).click();
  await page.getByRole("heading", { name: "수업 상세" }).waitFor({ timeout: 20_000 });
  await pause(page);
  await optional(page, "회원 강사 프로필", async () => {
    rec.caption("회원 · 강사 프로필 — 이 강사의 모든 학원 수업");
    await page.getByRole("link", { name: /강사 프로필 보기/ }).click();
    await page.getByRole("heading", { name: "강사", exact: true }).waitFor({ timeout: 20_000 });
    await pause(page);
    await page.getByRole("button", { name: "뒤로 가기" }).click();
    await page.getByRole("heading", { name: "수업 상세" }).waitFor({ timeout: 20_000 });
    await pause(page, 1200);
  });
  rec.caption("회원 · 수업 상세 — 수강료 · 정원(남 · 여) · 회차 전체");
  await scrollSlowly(page, 420, 8);
  await pause(page);
  await shot(page, "member-offering-detail");
  await scrollSlowly(page, 900, 8);
  await pause(page, 1200);

  rec.caption("회원 · 결제 화면 — 결제 직전까지만 (PG 미연동이라 결제는 누르지 않아요)");
  await page.getByRole("button", { name: /결제하기/ }).click();
  await page.getByRole("heading", { name: "결제하기" }).waitFor({ timeout: 20_000 });
  await pause(page, 1500);
  await page.getByRole("radio", { name: /신용·체크카드/ }).click();
  await pause(page, 800);
  await page.getByRole("checkbox", { name: /환불 규칙과 개인정보/ }).click();
  await pause(page);
  await shot(page, "member-pay-ready");
  await page.getByRole("button", { name: "뒤로 가기" }).click();
  await pause(page, 1200);

  rec.caption("회원 · AI 플래너 — 강사 이름으로 수업 찾기");
  await page.getByRole("tab", { name: "AI 플래너" }).click();
  const question = page.getByRole("textbox", { name: "AI 플래너에게 질문" });
  await question.waitFor({ timeout: 20_000 });
  await pause(page, 1200);
  rec.hlStart("member-planner-ask");
  await typeSlowly(question, "아이유 강사님 수업 전체 알려줘");
  await pause(page, 600);
  await page.getByRole("button", { name: "보내기" }).click();
  rec.caption("회원 · AI 가 수업을 찾는 중…");
  await pause(page, 2500);
  rec.hlEnd();
  // 답을 기다리는 동안은 전체 영상에서 줄인다(자막으로 알림)
  rec.skipStart();
  const firstCard = page.getByRole("button", { name: /신청하기$/ }).first();
  const asked = rec.now();
  await firstCard.waitFor({ timeout: 90_000 });
  const waited = Math.round(rec.now() - asked);
  rec.skipEnd();
  rec.hlStart("member-planner-answer");
  // 기다린 시간이 길 때만 「줄였다」고 알린다
  rec.caption(`회원 · AI 플래너 답변 — 아이유 강사 수업을 카드로${waited >= 5 ? ` (기다린 ${waited}초는 줄였어요)` : ""}`);
  await pause(page, 3000);
  await shot(page, "member-planner-answer");
  await scrollSlowly(page, 500, 8);
  await pause(page, 2000);
  rec.hlEnd();
  await scrollSlowly(page, 900, 8);
  await pause(page, 1500);

  rec.caption("회원 · 캘린더 — 결제한 수업 회차가 날짜에 표시돼요");
  await page.getByRole("tab", { name: "캘린더" }).click();
  await page.getByRole("button", { name: "다음 달" }).waitFor({ timeout: 20_000 });
  await pause(page, 3000);
  await shot(page, "member-calendar");

  rec.caption("회원 · 마이 — 레벨 카드 모음");
  await page.getByRole("tab", { name: "마이" }).click();
  await page.getByRole("button", { name: /^레벨 카드/ }).waitFor({ timeout: 20_000 });
  await pause(page);
  await page.getByRole("button", { name: /^레벨 카드/ }).click();
  await page.getByRole("heading", { name: "카드 모음" }).waitFor({ timeout: 20_000 });
  await pause(page, 3000);
  await shot(page, "member-level-cards");
  await optional(page, "회원 내 예약·결제 내역", async () => {
    await page.getByRole("button", { name: "뒤로 가기" }).click();
    await page.getByRole("button", { name: /내 예약/ }).waitFor({ timeout: 20_000 });
    rec.caption("회원 · 내 예약 · 결제 내역 — 결제한 수업과 환불 흐름 안내");
    await page.getByRole("button", { name: /내 예약/ }).click();
    await page.getByRole("heading", { name: /내 예약/ }).waitFor({ timeout: 20_000 });
    await pause(page);
    await page.getByRole("tab", { name: "결제·환불 내역" }).click();
    await pause(page, 3000);
  });

  // 시연이 바꾼 기준 장르를 「전체」로 되돌린다 — 전체 영상에서는 잘라 낸다
  rec.skipStart();
  await page.getByRole("tab", { name: "홈" }).click();
  await page.getByRole("button", { name: "장르 바꾸기" }).click();
  await page.getByRole("radio", { name: "전체", exact: true }).click();
  await page.getByRole("button", { name: "댄스스포츠로 바꾸기" }).click();
  await page.getByRole("heading", { name: "댄스스포츠", exact: true }).waitFor({ timeout: 20_000 });
  console.log("  기준 장르를 「댄스스포츠 · 전체」로 되돌림");
  return closeWindow(w);
}

// ── 강사 앱 ──────────────────────────────────────────────────────────────────
async function recordInstructor(browser: Browser): Promise<Segment> {
  console.log("── 강사 앱 ──");
  const w = await openWindow(browser, "instructor", "app");
  const { page, rec } = w;
  await page.goto(`${APP}/staff-login`, { waitUntil: "networkidle" });
  rec.caption("강사 · 강사·대표 앱 — 「강사」 탭에서 아이디로 로그인");
  await pause(page, 1200);
  await page.getByRole("tab", { name: /Instructor/ }).click();
  await typeSlowly(page.getByRole("textbox", { name: "아이디" }), INSTRUCTOR.username);
  await typeSlowly(page.getByRole("textbox", { name: "비밀번호" }), INSTRUCTOR.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await page.getByText("수업 등록 권한 있음").waitFor({ timeout: 20_000 });
  rec.caption("강사 · 로그인하면 소속 학원 화면부터 열려요");
  await pause(page);

  rec.caption("강사 · 홈 — 오늘 수업 인원(남 · 여 · 결석)");
  await page.getByRole("tab", { name: "홈" }).click();
  await page.getByText("오늘 수업 인원").waitFor({ timeout: 20_000 });
  await pause(page, 3000);
  await shot(page, "instructor-home");

  await optional(page, "강사 하루 전체 보기", async () => {
    rec.caption("강사 · 하루 전체 보기 — 날짜를 넘기면 그날 수업과 참석 인원");
    await page.getByRole("button", { name: /하루 전체 보기/ }).click();
    await page.getByRole("heading", { name: "수업 인원 한눈에" }).waitFor({ timeout: 20_000 });
    await pause(page, 2000);
    await page.getByRole("button", { name: "다음 날" }).click();
    await pause(page);
    await shot(page, "instructor-headcount-tomorrow");
    await page.getByRole("button", { name: "뒤로 가기" }).click();
    await page.getByText("오늘 수업 인원").waitFor({ timeout: 20_000 });
    await pause(page, 1000);
  });
  await optional(page, "강사 개인 레슨 스케줄", async () => {
    rec.caption("강사 · 개인 레슨 스케줄 — 이번 주 1:1 레슨 · 수강생별 남은 횟수");
    await page.getByRole("button", { name: /개인 레슨 스케줄/ }).click();
    await page.getByRole("heading", { name: "개인 레슨 스케줄" }).waitFor({ timeout: 20_000 });
    await pause(page);
    await page.getByRole("button", { name: "뒤로 가기" }).click();
    await page.getByText("오늘 수업 인원").waitFor({ timeout: 20_000 });
    await pause(page, 1000);
  });
  await optional(page, "강사 새 반 열기 추천", async () => {
    rec.caption("강사 · 새 반 열기 추천 — 조건을 넣으면 AI 가 후보 회원 수와 근거를 보여 줘요");
    await page.getByRole("button", { name: /새 반 열기 추천/ }).click();
    await page.getByRole("button", { name: "후보 찾기" }).waitFor({ timeout: 20_000 });
    await pause(page, 2500);
    await page.getByRole("button", { name: "후보 찾기" }).click();
    await page.getByText(/^후보 \d+명/).first().waitFor({ timeout: 30_000 });
    await pause(page);
    await shot(page, "instructor-new-class-candidates");
    await page.getByRole("button", { name: "뒤로 가기" }).click();
    await page.getByText("오늘 수업 인원").waitFor({ timeout: 20_000 });
    await pause(page, 1000);
  });

  await page.getByRole("tab", { name: "수업" }).click();
  await page.getByRole("heading", { name: "수업 만들기" }).waitFor({ timeout: 20_000 });
  rec.hlStart("instructor-class-form");
  rec.caption("강사 · 수업 만들기 — 「댄스스포츠(라틴)」 고르면 라틴 5종목이 나와요");
  await pause(page, 1500);
  await page.getByRole("radio", { name: "댄스스포츠(라틴)" }).click();
  await pause(page, 1200);
  await page.getByRole("radio", { name: "룸바", exact: true }).click();
  await pause(page, 1500);
  await shot(page, "instructor-class-latin");
  rec.caption("강사 · 「댄스스포츠(스탠다드)」로 바꾸면 스탠다드 5종목으로 바뀌어요");
  await page.getByRole("radio", { name: "댄스스포츠(스탠다드)" }).click();
  await pause(page, 1200);
  await page.getByRole("radio", { name: "왈츠", exact: true }).click();
  await pause(page, 1500);
  await shot(page, "instructor-class-standard");
  rec.caption("강사 · 몇 칸 채워 보기 (시연이라 등록은 하지 않아요)");
  await page.getByRole("radio", { name: "입문", exact: true }).click();
  await page.getByRole("checkbox", { name: "2030세대" }).click();
  await typeSlowly(page.getByRole("textbox", { name: "수업명" }), "스탠다드 왈츠 기초 · 12월");
  await typeSlowly(page.getByRole("textbox", { name: "금액" }), "120000");
  await pause(page, 1000);
  rec.hlEnd();
  rec.caption("강사 · 요일 · 기간 · 시각 · 홀까지 (10분 단위)");
  await page.getByRole("checkbox", { name: "토", exact: true }).click();
  await typeSlowly(page.getByRole("textbox", { name: "기간 시작일" }), "2027-02-06");
  await typeSlowly(page.getByRole("textbox", { name: "기간 끝날" }), "2027-02-27");
  await typeSlowly(page.getByRole("textbox", { name: "시작 시각" }), "13:00");
  await typeSlowly(page.getByRole("textbox", { name: "끝 시각" }), "14:00");
  await scrollSlowly(page, 500);
  await page.getByRole("radio", { name: "강남점 B홀" }).click();
  await pause(page);
  await shot(page, "instructor-class-filled");
  rec.caption("강사 · 「다음」에서 정원을 넣고 등록하면 대표에게 승인 요청이 가요 (여기선 등록 안 함)");
  await pause(page);

  rec.hlStart("instructor-academy");
  rec.caption("강사 · 학원 — 소속 승인됨 · 수업 등록 권한 있음");
  await page.getByRole("tab", { name: "학원" }).click();
  await page.getByText("수업 등록 권한 있음").waitFor({ timeout: 20_000 });
  await pause(page, 3500);
  await shot(page, "instructor-academy");
  rec.hlEnd();
  rec.caption("강사 · 학원 — 시간표 · 내 수업 · 학원 공지 · 소속 해제");
  await scrollSlowly(page, 600, 8);
  await pause(page);
  await scrollSlowly(page, -600, 8);

  rec.caption("강사 · 마이 — 소속 학원 · 강사 소개 · 개인 일정");
  await page.getByRole("tab", { name: "마이" }).click();
  await page.getByRole("heading", { name: "마이" }).waitFor({ timeout: 20_000 });
  await pause(page, 3000);
  await shot(page, "instructor-my");
  await optional(page, "강사 프로필", async () => {
    rec.caption("강사 · 강사 소개 · 프로필 — 경력 · 활동 지역 · 소개 글 (회원 화면에 보여요)");
    await page.getByRole("button", { name: /강사 소개/ }).click();
    await page.getByRole("heading", { name: "프로필 고치기" }).waitFor({ timeout: 20_000 });
    await pause(page);
    await scrollSlowly(page, 400);
    await pause(page, 2500);
  });
  return closeWindow(w);
}

// ── 대표 앱 — 수업 승인(웹에서 인증 앱을 켜기 전에) ───────────────────────────────
async function recordOwnerApp(browser: Browser): Promise<Segment> {
  console.log("── 대표 앱 ──");
  const w = await openWindow(browser, "owner-app", "app");
  const { page, rec } = w;
  await page.goto(`${APP}/staff-login`, { waitUntil: "networkidle" });
  rec.caption("대표 · 앱에서도 — 「대표」 탭으로 로그인");
  await pause(page, 1000);
  await page.getByRole("tab", { name: /Owner/ }).click();
  await typeSlowly(page.getByRole("textbox", { name: "아이디" }), OWNER.username);
  await typeSlowly(page.getByRole("textbox", { name: "비밀번호" }), OWNER.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/staff-login"), { timeout: 20_000 });
  rec.caption("대표 · 대표 앱 홈 — 해야 할 일 · 오늘 수업");
  await pause(page);
  await shot(page, "owner-app-home");
  await scrollSlowly(page, 500, 8);
  await pause(page, 2000);
  // 대표 앱에는 아직 알림함으로 가는 탭이 없다 — 휴대폰 알림을 누른 것처럼 앱 안에서 알림함으로 옮긴다(dev-demo-record-approvals.ts 와 같음)
  await page.evaluate(() => {
    window.history.pushState({}, "", "/owner/notifications");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const notice = page.getByText(PENDING_CLASS_TITLE, { exact: false }).first();
  await notice.waitFor({ timeout: 20_000 });
  rec.hlStart("owner-class-approve");
  rec.caption(`대표 · 알림 — 아이유 강사가 올린 「${PENDING_CLASS_TITLE}」 승인 요청`);
  await pause(page, 2500);
  await shot(page, "owner-app-notifications");
  await notice.click();
  const approve = page.getByRole("button", { name: "승인", exact: true });
  await approve.waitFor({ timeout: 20_000 });
  rec.caption("대표 · 수업 내용 확인 → 「승인」");
  await pause(page, 2000);
  await scrollSlowly(page, 400);
  await pause(page, 1200);
  await shot(page, "owner-app-class-review");
  await approve.click();
  rec.caption("대표 · 수업 승인 완료 — 회원 앱에 공개돼요");
  await pause(page, 4000);
  await shot(page, "owner-app-class-approved");
  rec.hlEnd();
  return closeWindow(w);
}

// ── 대표 관리자 웹 ────────────────────────────────────────────────────────────
async function recordOwnerWeb(browser: Browser): Promise<Segment> {
  console.log("── 대표 관리자 웹 ──");
  const w = await openWindow(browser, "owner-web", "web");
  const { page, rec } = w;
  // 화면이 부른 인증 앱 등록 응답에서 비밀값을 받아 둔다(DB 는 보지 않는다)
  let totpUri: string | null = null;
  page.on("response", async (r) => {
    if (!r.url().includes("/api/auth/two-factor/enable")) return;
    const body = (await r.json().catch(() => null)) as { totpURI?: string } | null;
    if (body?.totpURI) totpUri = body.totpURI;
  });
  await page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
  rec.caption("대표 · 관리자 웹 — 「대표」로 아이디 로그인");
  await pause(page, 1200);
  await typeSlowly(page.getByRole("textbox", { name: "아이디" }), OWNER.username);
  await typeSlowly(page.getByRole("textbox", { name: "비밀번호" }), OWNER.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await page.getByText("인증 코드 6자리").first().waitFor({ timeout: 20_000 });
  for (let i = 0; i < 40 && totpUri === null; i += 1) await page.waitForTimeout(250);
  if (totpUri === null) throw new Error("인증 앱 등록 응답(totpURI)을 받지 못했다");
  rec.caption("대표 · 처음 로그인 — 인증 앱 등록(QR). 6자리는 녹화 스크립트가 계산해 넣어요");
  await pause(page, 3000);
  await shot(page, "owner-web-enroll-qr");
  // totpURI 의 secret 은 base32 — 풀어서 서버와 같은 간격으로 지금 6자리를 만든다
  const encoded = decodeURIComponent(/[?&]secret=([^&]+)/.exec(totpUri)![1]!);
  const secret = new TextDecoder().decode(base32.decode(encoded));
  const code = await createOTP(secret, { period: staffTotpPeriodSeconds() }).totp();
  for (let i = 0; i < 6; i += 1) {
    await page.getByRole("textbox", { name: `${i + 1}번째 숫자` }).pressSequentially(code[i]!, { delay: 250 });
  }
  await pause(page, 800);
  await page.getByRole("button", { name: "확인" }).click();
  await page.getByRole("heading", { name: "대시보드" }).waitFor({ timeout: 20_000 });
  rec.caption("대표 · 대시보드 — 오늘 할 일과 이번 달 돈의 흐름");
  await pause(page, 3000);
  await shot(page, "owner-web-dashboard");
  rec.caption("대표 · 해야 할 일 — 강사 소속 신청이 들어와 있어요");
  await scrollSlowly(page, 500);
  await pause(page);
  await scrollSlowly(page, -500);

  rec.hlStart("owner-affiliation");
  rec.caption("대표 · 강사 관리 — 앱에서 들어온 소속 신청");
  await page.getByRole("link", { name: "강사 관리" }).click();
  await page.getByRole("heading", { name: /소속 신청 \d+건/ }).waitFor({ timeout: 20_000 });
  await pause(page, 2500);
  await shot(page, "owner-web-instructors");
  const firstName = (await page.locator("main p", { hasText: / 강사$/ }).first().textContent())?.trim() ?? "";
  await page.getByRole("button", { name: "승인", exact: true }).first().click();
  rec.caption(`대표 · ${firstName} 승인 — 프리랜서 · 강사 몫 60%`);
  await pause(page, 1200);
  await typeSlowly(page.getByRole("textbox", { name: /강사 몫 비율/ }), "60");
  await pause(page, 1200);
  await shot(page, "owner-web-approve-form");
  await page.getByRole("button", { name: "승인하기" }).click();
  rec.caption(`대표 · 소속 승인 완료 — ${firstName}가 소속 강사 목록에 들어갔어요`);
  await pause(page, 2500);
  await scrollSlowly(page, 300);
  await pause(page, 2500);
  await shot(page, "owner-web-approved");
  rec.hlEnd();
  console.log(`  소속 승인: ${firstName}`);

  rec.caption("대표 · 예약 · 명단 — 회차별 앱 결제 · 현장 인원");
  await page.getByRole("link", { name: "예약 · 명단" }).click();
  await page.getByRole("heading", { name: "예약 · 명단", level: 1 }).waitFor({ timeout: 20_000 });
  await pause(page, 3500);
  await shot(page, "owner-web-roster");
  await optional(page, "대표 웹 다음 회차·전체 회원", async () => {
    rec.caption("대표 · 회차를 넘겨 보고, 학원 전체 회원 명단도 봐요");
    await page.getByRole("link", { name: "다음 회차" }).click();
    await pause(page, 3000);
    await page.getByRole("link", { name: /전체 회원/ }).click();
    await pause(page);
    await shot(page, "owner-web-roster-all");
  });

  rec.caption("대표 · 입점 · 설정 — 학원 정보 · 판매자 정보 · 정산 계좌");
  await page.getByRole("link", { name: "입점 · 설정" }).click();
  await page.getByRole("heading", { name: "입점 · 설정", level: 1 }).waitFor({ timeout: 20_000 });
  await pause(page, 3000);
  await scrollSlowly(page, 600);
  await pause(page, 2500);
  await shot(page, "owner-web-settings");
  await scrollSlowly(page, -600);
  for (const [link, caption, name] of [
    ["환불 · 취소 공지 ›", "대표 · 환불 · 취소 공지 — 수업에 읽기 전용으로 붙는 학원 공지", "refund-notices"],
    ["학원 공지 ›", "대표 · 학원 공지 — 소속 강사에게 보내는 공지", "staff-notices"],
    ["학원 앱 페이지 꾸미기 ›", "대표 · 학원 앱 페이지 꾸미기 — 회원 앱에 보이는 학원 소개", "app-page"],
  ] as const) {
    await optional(page, `대표 웹 ${name}`, async () => {
      await page.getByRole("link", { name: link }).click();
      await page.waitForURL((u) => u.pathname.endsWith(`/${name}`), { timeout: 20_000 });
      await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 20_000 });
      rec.caption(caption);
      await pause(page);
      await scrollSlowly(page, 400);
      await pause(page, 2000);
      await shot(page, `owner-web-${name}`);
      await page.getByRole("link", { name: "입점 · 설정" }).click();
      await page.getByRole("heading", { name: "입점 · 설정", level: 1 }).waitFor({ timeout: 20_000 });
      await pause(page, 1000);
    });
  }
  return closeWindow(w);
}

/** brad 의 2단계 인증을 녹화 전 상태(꺼짐·등록 없음)로 돌린다 */
async function resetOwnerTwoFactor(pool: pg.Pool): Promise<void> {
  const del = await pool.query(`DELETE FROM auth."twoFactor" WHERE "userId" = (SELECT id FROM auth."user" WHERE username = $1)`, [OWNER.username]);
  await pool.query(`UPDATE auth."user" SET "twoFactorEnabled" = false WHERE username = $1`, [OWNER.username]);
  console.log(`정리: brad 2단계 인증 등록 ${del.rowCount ?? 0}건 삭제 · twoFactorEnabled=false`);
}

// ── 편집(ffmpeg) ──────────────────────────────────────────────────────────────
// 이 PC 의 ffmpeg(정적 빌드)에는 drawtext 가 없다(freetype 없이 빌드됨). 그래서 글씨는 전부 ASS 자막 파일로 만들어
// libass 의 subtitles 필터로 굽는다 — 한글 글꼴은 ~/.fonts 의 Noto Sans CJK KR.
const W = 1440;
const H = 900;
const FPS = 30;
const IVORY_HEX = "0xF4F0EA";
const PLUM_HEX = "0x4A2340";
// ASS 색은 &HAABBGGRR(알파 00 = 불투명)
const ASS_IVORY = "&H00EAF0F4";
const ASS_PLUM = "&H0040234A";
const ASS_PLUM_BOX = "&H2040234A";
const ASS_WHITE = "&H00FFFFFF";
const FONT_DIR = join(homedir(), ".fonts");
const FONT_NAME = "Noto Sans CJK KR";
const X264 = ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS), "-an"];

function ff(args: string[]): void {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg 실패: ${args.join(" ")}`);
}

/** ASS 시각 형식 H:MM:SS.cc */
function assTime(s: number): string {
  const t = Math.max(0, s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = (t % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${sec}`;
}

type AssEvent = { from: number; to: number; style: "Cap" | "Label" | "Title" | "Sub"; text: string };
let assNo = 0;
/** 자막 파일 하나를 쓰고 subtitles 필터 문자열을 돌려준다 */
function assFilter(events: AssEvent[]): string {
  const file = join(WORK_DIR, `s${++assNo}.ass`);
  const style = (name: string, size: number, primary: string, back: string, borderStyle: number, outline: number, align: number, marginV: number) =>
    `Style: ${name},${FONT_NAME},${size},${primary},${primary},${back},${back},-1,0,0,0,100,100,0,0,${borderStyle},${outline},0,${align},40,40,${marginV},1`;
  const body = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // 화면 아래 자막 — 플럼 상자 위 흰 글씨
    style("Cap", 32, ASS_WHITE, ASS_PLUM_BOX, 3, 14, 2, 26),
    // 앱 장면 왼쪽 역할 이름
    style("Label", 46, ASS_PLUM, ASS_IVORY, 1, 0, 7, 0),
    // 제목 카드
    style("Title", 76, ASS_IVORY, ASS_PLUM, 1, 0, 5, 0),
    style("Sub", 32, ASS_IVORY, ASS_PLUM, 1, 0, 5, 0),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events.map((e) => `Dialogue: 0,${assTime(e.from)},${assTime(e.to)},${e.style},,0,0,0,,${e.text.replace(/\n/g, "\\N")}`),
    "",
  ].join("\n");
  writeFileSync(file, body);
  return `subtitles=filename='${file}':fontsdir='${FONT_DIR}'`;
}

/** 녹화 영상을 1440×900·30fps 로 맞춘다 — 앱은 아이보리 바탕 가운데에 휴대폰 화면(테두리 한 줄) */
function normalize(seg: Segment): string {
  const out = join(WORK_DIR, `norm-${seg.id}.mp4`);
  const vf =
    seg.kind === "app"
      ? `fps=${FPS},scale=360:780,pad=${W}:${H}:${(W - 360) / 2}:24:color=${IVORY_HEX},` +
        `drawbox=x=${(W - 360) / 2 - 3}:y=21:w=366:h=786:color=${PLUM_HEX}@0.35:t=3`
      : `fps=${FPS},scale=${W}:${H}`;
  ff(["-i", seg.video, "-vf", vf, ...X264, out]);
  return out;
}

/** 자막 시각 목록 — 각 자막은 다음 자막까지 */
function captionSpans(seg: Segment): { from: number; to: number; text: string }[] {
  return seg.captions.map((c, i) => ({ from: c.at, to: seg.captions[i + 1]?.at ?? seg.end, text: c.text }));
}

/** 정규화한 영상에서 [from,to] 를 잘라 자막을 굽는다. speed 가 1 이 아니면 그만큼 빠르게/느리게 */
function cutClip(norm: string, seg: Segment, label: string, from: number, to: number, out: string, speed = 1): void {
  const len = to - from;
  const events: AssEvent[] = captionSpans(seg)
    .filter((c) => c.to > from && c.from < to)
    .map((c) => ({ from: Math.max(0, c.from - from), to: Math.min(to, c.to) - from, style: "Cap" as const, text: c.text }));
  if (seg.kind === "app" && label !== "") events.push({ from: 0, to: len, style: "Label", text: `{\\pos(110,380)}${label}` });
  const filters = [assFilter(events), `setpts=${(1 / speed).toFixed(4)}*PTS`].join(",");
  ff(["-ss", from.toFixed(2), "-to", to.toFixed(2), "-i", norm, "-vf", filters, ...X264, out]);
}

/** 제목 카드 — 짙은 플럼 바탕에 아이보리 글씨 */
function titleCard(title: string, sub: string, seconds: number, out: string): void {
  const vf = assFilter([
    { from: 0, to: seconds, style: "Title", text: `{\\pos(${W / 2},${H / 2 - 30})}${title}` },
    { from: 0, to: seconds, style: "Sub", text: `{\\pos(${W / 2},${H / 2 + 60})}${sub}` },
  ]);
  ff(["-f", "lavfi", "-i", `color=c=${PLUM_HEX}:s=${W}x${H}:r=${FPS}:d=${seconds}`, "-vf", vf, ...X264, out]);
}

/** 잘라 낼 구간을 뺀 나머지 구간들 */
function keptRanges(seg: Segment, from = 0, to = seg.end): [number, number][] {
  const ranges: [number, number][] = [];
  let cursor = from;
  for (const s of [...seg.skips].sort((a, b) => a.from - b.from)) {
    if (s.to <= cursor || s.from >= to) continue;
    if (s.from > cursor) ranges.push([cursor, s.from]);
    cursor = Math.max(cursor, s.to);
  }
  if (cursor < to) ranges.push([cursor, to]);
  return ranges.filter(([a, b]) => b - a > 0.3);
}

function concat(parts: string[], out: string): void {
  const list = join(WORK_DIR, `${out.split("/").pop()}.txt`);
  writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
  ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
  ff(["-i", out, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", "-an", out.replace(/\.mp4$/, ".webm")]);
}

function compose(timeline: Timeline): void {
  mkdirSync(WORK_DIR, { recursive: true });
  const seg = (id: string) => timeline.segments.find((s) => s.id === id)!;
  const labels: Record<string, string> = { member: "회원 앱", instructor: "강사 앱", "owner-app": "대표 앱" };
  const norm: Record<string, string> = {};
  for (const s of timeline.segments) norm[s.id] = normalize(s);

  let clipNo = 0;
  const clip = (id: string, from: number, to: number, speed = 1) => {
    const out = join(WORK_DIR, `clip-${String(++clipNo).padStart(2, "0")}.mp4`);
    cutClip(norm[id]!, seg(id), labels[id] ?? "", from, to, out, speed);
    return out;
  };
  const card = (title: string, sub: string, seconds: number) => {
    const out = join(WORK_DIR, `card-${String(++clipNo).padStart(2, "0")}.mp4`);
    titleCard(title, sub, seconds, out);
    return out;
  };

  // ① 전체 — 회원 → 강사 → 대표(웹 앞부분 → 앱 수업 승인 → 웹 뒷부분)
  const web = seg("owner-web");
  const webSplit = web.captions.find((c) => c.text.startsWith("대표 · 예약 · 명단"))?.at ?? web.end;
  const full: string[] = [];
  full.push(card("회원 앱", "장르 고르기 · 수업 찾기 · AI 플래너", 2));
  for (const [a, b] of keptRanges(seg("member"))) full.push(clip("member", a, b));
  full.push(card("강사 앱", "오늘 수업 · 수업 만들기 · 학원 소속", 2));
  for (const [a, b] of keptRanges(seg("instructor"))) full.push(clip("instructor", a, b));
  full.push(card("대표 관리자 웹", "2단계 인증 · 강사 소속 승인 · 수업 승인", 2));
  for (const [a, b] of keptRanges(web, 0, webSplit)) full.push(clip("owner-web", a, b));
  for (const [a, b] of keptRanges(seg("owner-app"))) full.push(clip("owner-app", a, b));
  for (const [a, b] of keptRanges(web, webSplit, web.end)) full.push(clip("owner-web", a, b));
  concat(full, join(OUT, "full.mp4"));

  // ② 핵심 — 역할마다 제목 1.5초 + 핵심 구간을 28.5초에 맞춤(합 30초 × 3 = 90초)
  const TITLE_S = 1.5;
  const BODY_S = 30 - TITLE_S;
  // untilCaption 을 주면 그 자막이 시작할 때까지 핵심 구간을 늘린다(너무 짧아 느리게 늘어지지 않게)
  const role = (title: string, ranges: { id: string; tag: string; untilCaption?: string }[]) => {
    const picked = ranges.map((r) => {
      const h = seg(r.id).highlights.find((x) => x.tag === r.tag)!;
      const until = r.untilCaption === undefined ? undefined : seg(r.id).captions.find((c) => c.text.startsWith(r.untilCaption!))?.at;
      return { id: r.id, from: h.from, to: until !== undefined && until > h.to ? until : h.to };
    });
    const total = picked.reduce((sum, p) => sum + (p.to - p.from), 0);
    const speed = total / BODY_S;
    console.log(`  핵심 ${title}: 원본 ${total.toFixed(1)}초 → ${BODY_S}초 (속도 ${speed.toFixed(2)}배)`);
    return [card(title, "핵심 30초", TITLE_S), ...picked.map((p) => clip(p.id, p.from, p.to, speed))];
  };
  const highlight = [
    ...role("회원 앱", [
      { id: "member", tag: "member-genre" },
      { id: "member", tag: "member-planner-ask" },
      { id: "member", tag: "member-planner-answer" },
    ]),
    ...role("강사 앱", [
      { id: "instructor", tag: "instructor-class-form", untilCaption: "강사 · 「다음」에서" },
      { id: "instructor", tag: "instructor-academy" },
    ]),
    ...role("대표 관리자 웹", [
      { id: "owner-web", tag: "owner-affiliation" },
      { id: "owner-app", tag: "owner-class-approve" },
    ]),
  ];
  concat(highlight, join(OUT, "highlight.mp4"));
}

// ── 실행 ─────────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const timelineFile = join(OUT, "timeline.json");
if (COMPOSE_ONLY) {
  if (!existsSync(timelineFile)) throw new Error(`${timelineFile} 이 없다 — 먼저 녹화한다`);
  compose(JSON.parse(readFileSync(timelineFile, "utf8")) as Timeline);
  console.log("끝 — 영상만 다시 만듦");
  process.exit(0);
}

const url = process.env["DATABASE_URL"] ?? "";
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에서만 돈다");
const pool = new pg.Pool({ connectionString: url, max: 2 });
const browser = await chromium.launch({ executablePath: CHROME, headless: true, slowMo: SLOW_MO });
const timeline: Timeline = { segments: [] };
try {
  await preparePendingClass(pool);
  timeline.segments.push(await recordMember(browser));
  timeline.segments.push(await recordInstructor(browser));
  timeline.segments.push(await recordOwnerApp(browser));
  timeline.segments.push(await recordOwnerWeb(browser));
  writeFileSync(timelineFile, JSON.stringify(timeline, null, 2));
  writeFileSync(join(OUT, "skipped.json"), JSON.stringify(skippedScenes, null, 2));
} finally {
  // 녹화가 중간에 멈춰도 brad 의 2단계 인증과 회원 기준 장르는 원래대로 돌린다
  await resetOwnerTwoFactor(pool);
  await pool.query(
    `UPDATE members SET base_sub_genre = NULL WHERE id = (SELECT m.id FROM members m JOIN auth."user" u ON u.id = m.auth_user_id WHERE u.email = $1)`,
    [MEMBER.email],
  ).catch((e: unknown) => console.log(`정리: 회원 기준 장르 SQL 생략(${String(e)})`));
  await browser.close();
  await pool.end();
}
compose(timeline);
console.log("끝 — full.mp4 · highlight.mp4");
