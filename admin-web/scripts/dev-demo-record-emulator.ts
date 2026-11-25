// 안드로이드 에뮬레이터 시연 영상 — 로그인 입구 · 회원 · 강사 · 대표 핵심 기능을 실제 앱(Expo Go)에서 눌러 녹화하고,
// 자막을 구워 영상 두 편을 만든다(2026-11-25 사용자 요청 「안드로이드 에뮬레이터로 제대로 시연·녹화」).
//
// 만드는 것(<폴더> 아래):
//   full.mp4·full.webm            전체 시연 한 편 — 로그인 입구 → 회원 → 강사 → 대표. 역할마다 2초 제목 카드, 화면 아래 한 줄 자막
//   highlight.mp4·highlight.webm  제출용 한 편 1분 30초(회원 30 · 강사 30 · 대표 30)
//   timeline.json                 장면 조각별 영상 파일 · 자막 · 핵심 구간 · 잘라 낼 구간(초)
//   NN-*.png                      장면 스크린샷(에뮬레이터 screencap · 웹은 Playwright)
//
// 녹화 조각(순서대로 찍는다 — 화면 녹화는 파일 하나에 최대 180초라 장면 묶음마다 끊는다):
//   entry    회원 로그인 → 바탕 3번 탭 → 강사 로그인(페이 그림) → Owner 탭(재즈 클럽 그림) → Instructor
//   member1  회원 로그인 → 홈(댄스스포츠) → 장르 바꾸기(사진 3초 전환 카드 · 라틴 사진일 때 누름) → 홈(라틴) → 수업 상세
//   member2  AI 플래너 질문·답 → 마이 → 관심 장르(사진 카드 여러 개 고르기 — 저장하지 않음) → 레벨 카드
//   inst1    강사 로그인 → 홈(오늘 수업 인원) → 회차 → 회원 관리(명단·결석 예정) → 2명 골라 레벨 정하기 → 최종 적용
//   inst2    수업 만들기 1/2 → 2/2 → 홍보 이미지(칩 · 엔진 · 만들기 · 결과)
//   inst3    검토 끝 · 수업 등록(제출 → 승인 대기)
//   ownerApp 대표 앱 로그인(Owner 탭) → 알림 → 방금 제출한 수업 승인
//   member3  회원 홈(댄스스포츠)에 그 수업이 보임
//   ownerWeb 관리자 웹(Playwright 1440×900): 로그인 → 인증 앱 등록 → 대시보드 → 강사 소속 승인 → 예약·명단 → 입점·설정·공지
//
// 실행: cd admin-web && KDANCE_DEV_ROUTES=true ./node_modules/.bin/jiti scripts/dev-demo-record-emulator.ts <폴더>
//   DEMO_PARTS=entry,member1 처럼 주면 그 조각만 다시 찍어 timeline.json 의 같은 조각을 바꾼다. DEMO_COMPOSE_ONLY=1 이면 영상만 다시 만든다.
//   먼저: scripts/dev-demo-emulator-prep.ts(오늘 수업 · 결제 수강생 · 소속 신청). 서버 :3000 · Expo :8081 · agent-server :8100,
//   에뮬레이터(emulator-5554)에 Expo Go 로 앱이 열려 있고 adb reverse(8081·3000)가 걸려 있어야 한다. 개발 DB(kdance_next)만 쓴다.
import "dotenv/config";

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { chromium, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { staffTotpPeriodSeconds } from "../lib/server/staff-auth";
import * as A from "./dev-demo-emulator-adb";

const OUT = resolve(process.argv[2] ?? ".");
const VIDEO_DIR = join(OUT, "video");
const WORK_DIR = join(OUT, "work");
const CHROME = join(homedir(), ".cache/ms-playwright/chromium-1255/chrome-linux64/chrome");
const FFMPEG = join(homedir(), ".local/bin/ffmpeg");
const WEB = "http://localhost:3000";
const COMPOSE_ONLY = process.env["DEMO_COMPOSE_ONLY"] === "1";
const PARTS = (process.env["DEMO_PARTS"] ?? "entry,member1,member2,member2b,inst1,inst2,inst3,ownerApp,member3,ownerWeb").split(",");

const MEMBER = { email: "demo-jisoo@example.com", password: "jisoo" };
const INSTRUCTOR = { username: "iuu", password: "iu" };
const OWNER = { username: "brad", password: "brad" };
// 녹화 중에 강사가 실제로 등록·제출하는 수업(일요일 낮 — 아이유·A홀·B홀 모두 비어 있는 시간)
// 2026-11-25 재녹화(홍보 이미지 버그 수정 뒤): 1차 녹화의 「라틴 차차차 입문 · 12월」(일 13:00 A홀)이 이미 공개라 같은 시각은 막힌다 → 일 15:00 룸바
const NEW_CLASS = { title: "라틴 룸바 입문 · 12월", discipline: "룸바", price: "120000", from: "2026-12-06", to: "2026-12-27", start: "15:00", end: "16:00" };
const PLANNER_QUESTION = "아이유 강사님 수업 전체 알려줘";
const PLANNER_FOLLOW_UP = "그중 라틴만";

// 사람이 따라 볼 수 있게 화면이 바뀔 때마다 멈추는 시간(ms)
const PAUSE = 2500;

// ── 타임라인 ─────────────────────────────────────────────────────────────────
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

/** 녹화 중인 조각 하나 — 녹화 시작 시각 기준으로 자막·구간을 적는다 */
class Rec {
  readonly seg: Segment;
  private openHl: { from: number; tag: string } | null = null;
  private openSkip: number | null = null;
  constructor(
    id: string,
    kind: "app" | "web",
    private readonly now: () => number,
  ) {
    this.seg = { id, kind, video: "", end: 0, captions: [], highlights: [], skips: [] };
  }
  t(): number {
    return this.now();
  }
  caption(text: string): void {
    console.log(`  [자막 ${this.t().toFixed(1)}s] ${text}`);
    this.seg.captions.push({ at: this.t(), text });
  }
  hlStart(tag: string): void {
    this.openHl = { from: this.t(), tag };
  }
  hlEnd(): void {
    if (this.openHl === null) return;
    this.seg.highlights.push({ ...this.openHl, to: this.t() });
    this.openHl = null;
  }
  skipStart(): void {
    this.openSkip = this.t();
  }
  skipEnd(): void {
    if (this.openSkip === null) return;
    this.seg.skips.push({ from: this.openSkip, to: this.t() });
    this.openSkip = null;
  }
  close(): void {
    this.hlEnd();
    this.skipEnd();
    this.seg.end = this.t();
  }
}

let shotNo = 0;
function appShot(name: string): void {
  const file = join(OUT, `${String(++shotNo).padStart(2, "0")}-${name}.png`);
  A.screencap(file);
  console.log(`  [화면] ${file}`);
}

const skipped: { scene: string; reason: string }[] = [];
/** 있으면 보여 주고 안 되면 건너뛴다(skipped.json 에 남긴다) */
async function optional(scene: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0]! : String(error);
    skipped.push({ scene, reason });
    console.log(`  [건너뜀] ${scene} — ${reason}`);
  }
}

/** 앱 조각 하나를 화면 녹화로 감싼다 */
async function appPart(id: string, run: (rec: Rec) => Promise<void>): Promise<Segment> {
  console.log(`── ${id} ──`);
  const sr = new A.ScreenRecording(id);
  await sr.start();
  const rec = new Rec(id, "app", () => sr.now());
  try {
    await run(rec);
  } finally {
    rec.close();
    const file = join(VIDEO_DIR, `${id}.mp4`);
    await sr.stop(file);
    rec.seg.video = file;
    console.log(`  [영상] ${id} → ${file} (${rec.seg.end.toFixed(1)}초)`);
  }
  return rec.seg;
}

/** 칸에 글자 넣기 — 한글이 있으면 붙여넣기, 아니면 한 글자씩 */
async function fill(label: string, text: string, opts: { scroll?: boolean } = {}): Promise<void> {
  await A.hideKeyboard();
  const node = opts.scroll === true ? await A.scrollTo(label, { editText: true, maxY: 1500 }) : await A.waitFor(label);
  const field = A.findAll(A.dump(), label).find((n) => n.cls.includes("EditText")) ?? node;
  A.tapNode(field);
  await A.sleep(500);
  await A.clearFocused();
  if (/[^\x20-\x7e]/.test(text)) {
    // 한글 붙여넣기는 가끔 클립보드가 깨진 글자로 넘어온다(2026-11-25 재녹화 때 한 번) — 칸 글자를 읽어 보고 다르면 다시 붙인다.
    // 깨진 글자가 남아 있으면 화면 구조 읽기(uiautomator dump)까지 멈춘다
    for (let i = 0; i < 3; i += 1) {
      await A.pasteText(text);
      await A.sleep(800);
      if (A.findAll(A.dump(), label).some((n) => n.cls.includes("EditText") && n.text === text)) break;
      await A.clearFocused();
    }
  } else await A.typeAscii(text, 2, 90);
  await A.sleep(500);
}

/** 강사·대표 로그인 화면에서 로그인 */
async function staffLogin(rec: Rec, tab: "Instructor" | "Owner", user: { username: string; password: string }): Promise<void> {
  A.openPath("/staff-login");
  await A.waitFor(/^Instructor/);
  await A.sleep(1200);
  if (tab === "Owner") {
    await A.tap(/^Owner/);
    await A.sleep(1500);
  }
  // 글자 입력은 화면 구조를 읽느라 느리다 — 전체 영상에서는 앞뒤 1초만 남기고 잘라 낸다
  rec.skipStart();
  await fill("아이디", user.username);
  await fill("비밀번호", user.password);
  await A.hideKeyboard();
  rec.skipEnd();
  await A.tap("로그인");
}

// ── 로그인 입구 ────────────────────────────────────────────────────────────────
async function partEntry(rec: Rec): Promise<void> {
  A.openPath("/login");
  await A.waitFor(/어떤 춤을 출까요/);
  rec.caption("앱 첫 화면 · 회원 로그인");
  await A.sleep(3000);
  appShot("entry-member-login");
  rec.hlStart("entry");
  rec.caption("로그인 화면 바탕을 빠르게 3번 누르면…");
  await A.sleep(1500);
  // 바탕 빈 곳(입력칸·버튼이 아닌 자리)을 600ms 안에 3번 — 한 번의 adb 호출로 이어서 누른다
  A.shell("input tap 540 1500; input tap 540 1500; input tap 540 1500");
  await A.waitFor(/^Instructor/);
  rec.caption("강사·대표 로그인으로 넘어가요 — 강사 탭은 페이 그림");
  await A.sleep(3500);
  appShot("entry-instructor-login");
  await A.tap(/^Owner/);
  rec.caption("대표 탭을 누르면 재즈 클럽 그림으로 바뀌어요");
  await A.sleep(3500);
  appShot("entry-owner-login");
  await A.tap(/^Instructor/);
  rec.caption("다시 강사 탭 — 역할마다 로그인 화면이 달라요");
  await A.sleep(2500);
  rec.hlEnd();
}

// ── 회원 1: 로그인 · 장르 사진 카드 · 홈 · 수업 상세 ──────────────────────────────────
async function partMember1(rec: Rec): Promise<void> {
  A.openPath("/login");
  await A.waitFor(/어떤 춤을 출까요/);
  rec.caption("회원 · 이메일과 비밀번호로 로그인");
  await A.sleep(1000);
  rec.skipStart();
  await fill("이메일", MEMBER.email);
  await fill("비밀번호", MEMBER.password);
  await A.hideKeyboard();
  rec.skipEnd();
  await A.tap("로그인");
  await A.waitFor("장르 바꾸기");
  rec.caption("회원 · 홈 — 기준 장르 「댄스스포츠」 수업 목록");
  await A.sleep(PAUSE + 1000);
  appShot("member-home-dancesport");
  A.swipe(900, 900);
  await A.sleep(1800);
  A.swipe(-900, 900);
  await A.sleep(1000);

  rec.hlStart("member-genre");
  rec.caption("회원 · 「장르 바꾸기」 — 장르 사진 카드에서 하나만 골라요");
  await A.tap("장르 바꾸기");
  await A.waitFor(/^댄스스포츠\(/);
  rec.caption("댄스스포츠 카드는 라틴 ↔ 스탠다드 사진이 3초마다 바뀌어요");
  await A.sleep(5000);
  appShot("member-genre-cards");
  // 사진이 「스탠다드 → 라틴」으로 막 바뀐 순간을 잡아 누른다 — 화면 구조를 읽는 데 약 2초가 걸려 바뀐 직후에만 누른다
  rec.caption("라틴 사진이 보일 때 누르면 「댄스스포츠(라틴)」이 골라져요");
  let previous = "";
  let tapped = false;
  for (let i = 0; i < 12 && !tapped; i += 1) {
    const card = A.findAll(A.dump(), /^댄스스포츠\((라틴|스탠다드)\)\. /)[0];
    if (card === undefined) throw new Error("댄스스포츠 사진 카드를 찾지 못했다");
    const now = card.desc.includes("(라틴)") ? "latin" : "standard";
    if (previous === "standard" && now === "latin") {
      A.tapNode(card);
      tapped = true;
    }
    previous = now;
  }
  if (!tapped) throw new Error("라틴 사진으로 바뀌는 순간을 잡지 못했다");
  await A.sleep(1500);
  const button = await A.waitFor(/로 바꾸기$/);
  if (!button.text.includes("라틴") && !button.desc.includes("라틴")) throw new Error(`라틴이 아닌 것이 골라졌다: ${button.text || button.desc}`);
  rec.caption("카드가 라틴 사진에 멈추고, 아래 세부 장르도 「라틴」");
  await A.sleep(PAUSE + 500);
  appShot("member-genre-latin-picked");
  A.tapNode(button);
  await A.waitFor("댄스스포츠(라틴)");
  rec.caption("회원 · 홈이 「댄스스포츠(라틴)」 수업만 보여 줘요");
  await A.sleep(PAUSE + 1000);
  appShot("member-home-latin");
  rec.hlEnd();

  rec.caption("회원 · 수업 카드 → 수업 상세(요일 · 회차 · 정원)");
  await A.tap(/^라틴 룸바 입문, /);
  await A.waitFor("수업 상세");
  await A.sleep(PAUSE);
  appShot("member-offering-detail");
  A.swipe(900, 900);
  await A.sleep(2200);
  A.key(4);
  await A.waitFor("장르 바꾸기");
  await A.sleep(800);
}

// ── 회원 2: AI 플래너 · 관심 장르 여러 개 · 레벨 카드 ────────────────────────────────
async function partMember2(rec: Rec): Promise<void> {
  rec.hlStart("member-planner");
  rec.caption("회원 · AI 플래너 — 강사·학원 이름으로 수업을 찾아요");
  await A.tap("AI 플래너", 20_000, { maxY: 2400 });
  await A.waitFor("AI 플래너에게 질문");
  await optional("새 대화로 비우기", async () => {
    await A.tap("새 대화", 3000);
    await A.sleep(800);
  });
  await A.sleep(1200);
  A.tapNode(A.findAll(A.dump(), "AI 플래너에게 질문").find((n) => n.cls.includes("EditText"))!);
  await A.sleep(500);
  await A.pasteText(PLANNER_QUESTION);
  await A.sleep(1200);
  await A.hideKeyboard();
  rec.caption(`회원 · 「${PLANNER_QUESTION}」`);
  await A.tap("보내기");
  rec.skipStart();
  await A.waitFor("신청하기", 120_000);
  await A.sleep(4000);
  rec.skipEnd();
  rec.caption("AI 플래너 답 — 조건 칩 + 수업 카드(신청하기)");
  await A.sleep(PAUSE + 1500);
  appShot("member-planner-answer");
  rec.hlEnd();
  await optional("AI 플래너 이어 묻기", async () => {
    // 답 아래 추천 질문 칩(앞 답의 조건을 이어받는다) 중 「주말 수업만」을 누른다
    const chip = await A.scrollTo(/^주말 수업만$/, { maxY: 2000, step: 500, tries: 4 });
    rec.caption("답 아래 추천 칩 「주말 수업만」 — 앞 답의 조건을 이어받아 좁혀요");
    await A.sleep(1500);
    A.tapNode(chip);
    rec.skipStart();
    // 답이 다 오기까지 보통 10초 안쪽 — 끝을 알리는 표시가 없어 넉넉히 기다린다
    await A.sleep(20_000);
    rec.skipEnd();
    A.swipe(1500, 900);
    await A.sleep(PAUSE + 1000);
    appShot("member-planner-follow-up");
  });
}

// ── 회원 2b: 관심 장르 여러 개 · 레벨 카드(화면 녹화 한 파일 180초 제한 때문에 나눈다) ──────────────
async function partMember2b(rec: Rec): Promise<void> {
  rec.hlStart("member-multi");
  rec.caption("회원 · 마이 → 관심 장르 — 사진 카드로 여러 개 골라요");
  await A.tap("마이", 20_000, { maxY: 2400 });
  await A.tap("관심 장르 · 지역 · 시간대");
  await A.waitFor("어떤 춤에 끌리세요?");
  await A.sleep(PAUSE);
  appShot("member-interest-before");
  // 지금 고른 3개(탱고 · 댄스스포츠 · 스윙)에 살사/바차타 카드를 더 고른다 — 저장은 하지 않는다
  const salsa = await A.waitFor(/^(살사|바차타)\. /);
  A.tapNode(salsa);
  rec.caption("살사/바차타까지 4개 — 고른 카드마다 체크가 붙어요");
  await A.sleep(PAUSE + 1000);
  appShot("member-interest-four");
  A.tapNode(salsa);
  rec.caption("다시 누르면 빠져요 · 이번엔 저장하지 않고 돌아가요");
  await A.sleep(PAUSE);
  rec.hlEnd();
  A.key(4);
  await A.waitFor("레벨 카드");
  await A.sleep(800);
  await optional("회원 레벨 카드", async () => {
    rec.caption("회원 · 레벨 카드 — 강사가 올려 준 레벨을 카드로 모아요");
    await A.tap("레벨 카드");
    await A.waitFor("카드 모음");
    await A.sleep(PAUSE + 1000);
    appShot("member-level-cards");
    A.key(4);
    await A.sleep(800);
  });
}

// ── 강사 1: 홈 · 회원 관리 · 레벨 수정 ──────────────────────────────────────────────
async function partInst1(rec: Rec): Promise<void> {
  rec.caption("강사 · 아이디로 로그인(강사 탭)");
  await staffLogin(rec, "Instructor", INSTRUCTOR);
  await A.waitFor(/^(홈|학원)$/, 20_000, { maxY: 2400 });
  await A.tap("홈", 20_000, { maxY: 2400 });
  await A.waitFor("오늘 수업 인원");
  rec.caption("강사 · 홈 — 오늘 수업 인원(참석 남·여 · 결석)");
  await A.sleep(PAUSE + 1000);
  appShot("inst-home-today");

  rec.hlStart("inst-members");
  rec.caption("강사 · 오늘 수업 → 회원 관리 — 결제한 수강생 명단");
  await A.tap(/^\d\d:\d\d 스탠다드 왈츠 · 수요 저녁/);
  await A.tap("회원 관리");
  await A.waitFor(/ 고르기$/);
  await A.sleep(PAUSE);
  rec.caption("결석 예정이 맨 위 · 성별·나이대·몇 개월째 · 연락처는 가려서");
  await A.sleep(PAUSE);
  appShot("inst-roster");
  rec.hlEnd();

  rec.hlStart("inst-level");
  rec.caption("강사 · 레벨 수정 — 수강생을 골라 레벨 정하기");
  await A.tap("나연 고르기");
  await A.sleep(700);
  await A.tap("모모 고르기");
  await A.sleep(1200);
  await A.tap(/명 레벨 올리기$/);
  await A.waitFor("최종 적용");
  await A.sleep(1500);
  await A.tap(/레벨 하나 올리기$/);
  await A.sleep(900);
  await A.tap(/레벨 하나 올리기$/);
  rec.caption("왈츠 레벨을 3(초급)으로 — 회원에게 승급 안내가 가요");
  await A.sleep(PAUSE);
  appShot("inst-level-sheet");
  await A.tap("최종 적용");
  await A.sleep(2500);
  rec.caption("최종 적용 — 내 평가 레벨 저장 · 올릴지는 회원이 골라요");
  await A.sleep(PAUSE);
  appShot("inst-level-applied");
  rec.hlEnd();
}

// ── 회원 쪽 레벨업: 나연이 승급 안내를 받아 카드 발급 연출을 본다(S6-3.10 — 보드 M25 → M25B → M25C) ──────────────
// inst1 에서 아이유가 나연·모모에게 왈츠 레벨 3 안내를 보냈다. 나연만 받는다(모모는 다음 시연용으로 남긴다).
const LEVELUP_MEMBER = { email: "demo-nayeon@example.com", password: "nayeon" };
async function partLevelUp(rec: Rec): Promise<void> {
  A.openPath("/login");
  await A.waitFor(/어떤 춤을 출까요/);
  rec.caption("회원 쪽 — 나연이 앱을 열면 승급 안내가 떠요");
  rec.skipStart();
  await fill("이메일", LEVELUP_MEMBER.email);
  await fill("비밀번호", LEVELUP_MEMBER.password);
  await A.hideKeyboard();
  rec.skipEnd();
  await A.tap("로그인");
  // 홈 위에 어두운 막 + LEVEL UP 알림(M25). 안 뜨면 GET /api/me/levels 의 pendingOffers 를 본다(EVIDENCE)
  await A.waitFor(/올려 줬어요/, 30_000);
  rec.hlStart("levelup");
  rec.caption("LEVEL UP — 아이유 강사님이 왈츠 레벨을 3(초급)으로 올려 줬어요");
  await A.sleep(5500);
  appShot("levelup-alert");
  rec.caption("화면을 누르면 — 카드를 받을지 골라요");
  A.tapXY(540, 1200);
  await A.waitFor("예, 받을게요");
  await A.sleep(3500);
  appShot("levelup-choose");
  rec.hlEnd();
  rec.hlStart("levelup-flip");
  rec.caption("「예, 받을게요」 — 카드가 뒤집히고 레벨 게이지가 차요");
  await A.tap("예, 받을게요");
  await A.sleep(1800);
  appShot("levelup-flip");
  await A.waitFor("카드 모음에 들어갔어요", 20_000);
  await A.sleep(3500);
  appShot("levelup-card");
  rec.hlEnd();
  rec.caption("카드 모음에 들어갔어요 → 확인");
  await A.sleep(1500);
  await A.tap("확인");
  await A.sleep(3500);
  appShot("levelup-toast");
  rec.caption("마이 › 레벨 카드 — 받은 카드가 모음에 1장");
  await A.tap("마이", 20_000, { maxY: 2400 });
  await A.tap("레벨 카드");
  await A.waitFor("카드 모음");
  await A.sleep(4000);
  appShot("levelup-collection");
}

// ── 강사 2: 수업 만들기 · 홍보 이미지 ───────────────────────────────────────────────
async function partInst2(rec: Rec): Promise<void> {
  rec.hlStart("inst-class");
  rec.caption(`강사 · 수업 만들기 1/2 — 댄스스포츠(라틴) · ${NEW_CLASS.discipline}`);
  A.openPath("/instructor/classes/new");
  await A.waitFor("댄스스포츠(라틴)");
  await A.sleep(1500);
  await A.tap("댄스스포츠(라틴)");
  await A.sleep(1000);
  await A.tap(NEW_CLASS.discipline);
  await A.sleep(700);
  await A.tap("정규");
  await A.tap("입문");
  await A.tap("전체");
  await A.sleep(800);
  rec.caption("수업명 · 금액 · 요일(일) · 기간 · 시각(10분 단위)");
  await fill("수업명", NEW_CLASS.title, { scroll: true });
  await fill("금액", NEW_CLASS.price, { scroll: true });
  await A.hideKeyboard();
  A.tapNode(await A.scrollTo("일", { maxY: 1900 }));
  await A.sleep(600);
  await fill("기간 시작일", NEW_CLASS.from, { scroll: true });
  await fill("기간 끝날", NEW_CLASS.to, { scroll: true });
  await fill("시작 시각", NEW_CLASS.start, { scroll: true });
  await fill("끝 시각", NEW_CLASS.end, { scroll: true });
  await A.hideKeyboard();
  A.tapNode(await A.scrollTo(/A홀$/, { maxY: 2100 }));
  rec.caption("홀을 고르면 겹치는 일정이 있는지 바로 확인해요");
  await A.sleep(PAUSE);
  appShot("inst-class-step1");
  A.tapNode(await A.scrollTo("다음"));
  await A.waitFor("다음 · 홍보 이미지");
  rec.caption("수업 만들기 2/2 — 정원 남 8 · 여 8 · 환불 공지는 대표 공지 자동");
  for (const label of ["남 정원", "여 정원"]) {
    await A.focusField(label);
    await A.clearFocused();
    await A.typeAscii("8");
  }
  await A.hideKeyboard();
  await A.sleep(PAUSE);
  appShot("inst-class-step2");
  rec.hlEnd();
  await A.tap("다음 · 홍보 이미지");
  await A.waitFor("홍보 이미지 만들기");

  rec.hlStart("inst-promo");
  rec.caption("강사 · 홍보 이미지 — 누가 · 분위기 · 장소 · 색감 칩 고르기");
  await A.sleep(1500);
  for (const chip of ["커플", "열정적인", "스튜디오", "빨간 조명"]) {
    await A.tap(chip);
    await A.sleep(700);
  }
  rec.caption("칩을 고르면 문장이 채워져요 · 엔진은 무료 FLUX.1 [schnell]");
  A.swipe(1400, 900);
  await A.sleep(PAUSE + 500);
  appShot("inst-promo-chips");
  await A.tap(/^AI 이미지 만들기/);
  await A.waitFor("만들기");
  rec.caption("하루 3번 무료 — 1번 쓸지 확인");
  await A.sleep(PAUSE);
  appShot("inst-promo-confirm");
  await A.tap("만들기");
  rec.caption("이미지를 만들고 있어요…");
  rec.skipStart();
  await A.sleep(2000);
  // 결과가 나올 때까지(만드는 중 글자가 사라질 때까지)
  for (let i = 0; i < 60; i += 1) {
    const text = A.dump().map((n) => `${n.text} ${n.desc}`).join(" ");
    // 결과 카드 배지가 「AI 생성 · 글자는 앱이 얹어요」로 바뀌면 끝(남은 횟수가 0이 되면 「다시 만들기」 버튼 없이 I42 화면이 된다 — 2026-11-25 재녹화에서 이 때문에 180초를 넘겼다)
    if (text.includes("AI 생성 · 글자는 앱이 얹어요") && !text.includes("만들고 있어요")) break;
    if (/한도|더 쓸 수 없어요/.test(text)) throw new Error("이미지 생성 한도에 걸림");
    await A.sleep(1500);
  }
  rec.skipEnd();
  A.swipe(900, 900);
  await A.sleep(1000);
  rec.caption("결과 — AI 이미지 위에 수업명·시간·가격 글자를 앱이 얹어요");
  await A.sleep(PAUSE + 2500);
  appShot("inst-promo-result");
  rec.hlEnd();
}

// ── 강사 3: 수업 등록(제출) ─────────────────────────────────────────────────────
async function partInst3(rec: Rec): Promise<void> {
  rec.hlStart("inst-submit");
  rec.caption("강사 · 검토 끝 · 수업 등록 — 대표 승인을 기다려요");
  A.tapNode(await A.scrollTo("검토 끝 · 수업 등록"));
  await A.sleep(2500);
  await A.sleep(PAUSE);
  appShot("inst-class-submitted");
  rec.hlEnd();
  await A.sleep(1000);
}

// ── 대표 앱: 방금 제출한 수업 승인 ──────────────────────────────────────────────────
async function partOwnerApp(rec: Rec): Promise<void> {
  rec.caption("대표 · 앱 로그인 — 「대표」 탭(재즈 클럽 그림)");
  await staffLogin(rec, "Owner", OWNER);
  await A.sleep(4000);
  rec.caption("대표 · 대표 앱 홈 — 해야 할 일 · 오늘 수업");
  await A.sleep(PAUSE);
  appShot("owner-app-home");
  // 대표 앱에는 아직 알림함 탭이 없다 — 휴대폰 알림을 누른 것처럼 앱 주소로 알림함을 연다
  A.openPath("/owner/notifications");
  const notice = await A.waitFor(new RegExp(NEW_CLASS.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), 30_000);
  rec.hlStart("owner-class-approve");
  rec.caption(`대표 · 알림 — 아이유 강사가 방금 올린 「${NEW_CLASS.title}」 승인 요청`);
  await A.sleep(PAUSE);
  appShot("owner-app-notifications");
  A.tapNode(notice);
  await A.waitFor("승인");
  rec.caption("대표 · 수업 내용 확인 → 「승인」");
  await A.sleep(PAUSE);
  A.swipe(700, 900);
  await A.sleep(1500);
  appShot("owner-app-class-review");
  await A.tap("승인");
  await A.waitFor(/승인했어요/);
  rec.caption("대표 · 승인 완료 — 회원에게 공개돼요");
  await A.sleep(PAUSE + 1000);
  appShot("owner-app-class-approved");
  rec.hlEnd();
}

// ── 회원 3: 홈에 새 수업 ────────────────────────────────────────────────────────
async function partMember3(rec: Rec, pool: pg.Pool): Promise<void> {
  // 회원1 에서 기준 장르를 「댄스스포츠(라틴)」으로 바꿨다 — 전체로 돌려 둬야 새 수업(라틴)이 홈 「댄스스포츠」 목록에 보인다
  await pool.query(
    `UPDATE members SET base_genre = 'dance_sport', base_sub_genre = NULL WHERE id = (SELECT m.id FROM members m JOIN auth."user" u ON u.id = m.auth_user_id WHERE u.email = $1)`,
    [MEMBER.email],
  );
  A.openPath("/login");
  await A.waitFor(/어떤 춤을 출까요/);
  rec.caption("회원 앱으로 다시 로그인해 확인");
  rec.skipStart();
  await fill("이메일", MEMBER.email);
  await fill("비밀번호", MEMBER.password);
  await A.hideKeyboard();
  rec.skipEnd();
  await A.tap("로그인");
  await A.waitFor("장르 바꾸기");
  rec.hlStart("member-new-class");
  rec.caption("회원 앱 홈 — 방금 승인된 수업이 목록에 보여요");
  const card = await A.scrollTo(new RegExp(`^${NEW_CLASS.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, `), { maxY: 2150, step: 600, tries: 12 });
  await A.sleep(PAUSE);
  appShot("member-home-new-class");
  A.tapNode(card);
  await A.waitFor("수업 상세");
  await A.sleep(PAUSE + 1000);
  appShot("member-new-class-detail");
  rec.hlEnd();
}

// ── 대표 관리자 웹(Playwright) ───────────────────────────────────────────────────
async function typeSlowly(box: Locator, text: string): Promise<void> {
  await box.click();
  await box.fill("");
  await box.pressSequentially(text, { delay: 150 });
}
async function scrollSlowly(page: Page, dy: number): Promise<void> {
  await page.mouse.move(720, 450);
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.wheel(0, dy / 6);
    await page.waitForTimeout(120);
  }
}
async function webShot(page: Page, name: string): Promise<void> {
  const file = join(OUT, `${String(++shotNo).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  [화면] ${file}`);
}

async function partOwnerWeb(): Promise<Segment> {
  console.log("── ownerWeb ──");
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, slowMo: 300 });
  const size = { width: 1440, height: 900 };
  const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: VIDEO_DIR, size } });
  // 개발 모드 「N」 표시(next dev 의 devIndicators)는 설정 파일을 바꾸지 않고 녹화 창에서만 숨긴다 — 표시는 nextjs-portal 요소 안에 그려진다
  await ctx.addInitScript(() => {
    const hide = () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal{display:none!important}";
      document.head.appendChild(style);
    };
    if (document.head) hide();
    else document.addEventListener("DOMContentLoaded", hide);
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const rec = new Rec("ownerWeb", "web", () => (Date.now() - t0) / 1000);
  const pause = (ms = 3800) => page.waitForTimeout(ms);
  let totpUri: string | null = null;
  page.on("response", async (r) => {
    if (!r.url().includes("/api/auth/two-factor/enable")) return;
    const body = (await r.json().catch(() => null)) as { totpURI?: string } | null;
    if (body?.totpURI) totpUri = body.totpURI;
  });
  try {
    await page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
    rec.caption("대표 · 관리자 웹 — 아이디 로그인");
    await pause(1200);
    await typeSlowly(page.getByRole("textbox", { name: "아이디" }), OWNER.username);
    await typeSlowly(page.getByRole("textbox", { name: "비밀번호" }), OWNER.password);
    await page.getByRole("button", { name: "로그인" }).click();
    await page.getByText("인증 코드 6자리").first().waitFor({ timeout: 20_000 });
    for (let i = 0; i < 40 && totpUri === null; i += 1) await page.waitForTimeout(250);
    if (totpUri === null) throw new Error("인증 앱 등록 응답(totpURI)을 받지 못했다");
    rec.caption("대표 · 웹은 2단계 인증 필수 — 처음엔 인증 앱 등록(6자리는 녹화 스크립트가 계산)");
    await pause(3000);
    await webShot(page, "owner-web-enroll-qr");
    // totpURI 의 secret(base32)을 풀어 서버와 같은 간격으로 지금 6자리를 만든다(DB 비밀값은 풀지 않는다)
    const encoded = decodeURIComponent(/[?&]secret=([^&]+)/.exec(totpUri)![1]!);
    const secret = new TextDecoder().decode(base32.decode(encoded));
    const code = await createOTP(secret, { period: staffTotpPeriodSeconds() }).totp();
    for (let i = 0; i < 6; i += 1) {
      await page.getByRole("textbox", { name: `${i + 1}번째 숫자` }).pressSequentially(code[i]!, { delay: 250 });
    }
    await pause(800);
    await page.getByRole("button", { name: "확인" }).click();
    await page.getByRole("heading", { name: "대시보드" }).waitFor({ timeout: 20_000 }).catch(async (error: unknown) => {
      await page.screenshot({ path: join(OUT, "SKIP-owner-web-after-2fa.png") });
      throw error;
    });
    rec.caption("대표 · 대시보드 — 오늘 할 일과 이번 달 흐름");
    await pause(3000);
    await webShot(page, "owner-web-dashboard");
    await scrollSlowly(page, 500);
    await pause(2500);
    await scrollSlowly(page, -500);

    rec.hlStart("owner-affiliation");
    rec.caption("대표 · 강사 관리 — 앱에서 들어온 소속 신청");
    await page.getByRole("link", { name: "강사 관리" }).click();
    await page.getByRole("heading", { name: /소속 신청 \d+건/ }).waitFor({ timeout: 20_000 });
    await pause(2500);
    await webShot(page, "owner-web-instructors");
    const firstName = (await page.locator("main p", { hasText: / 강사$/ }).first().textContent())?.trim() ?? "";
    await page.getByRole("button", { name: "승인", exact: true }).first().click();
    rec.caption(`대표 · ${firstName} 승인 — 프리랜서 · 강사 몫 60%`);
    await pause(1200);
    await typeSlowly(page.getByRole("textbox", { name: /강사 몫 비율/ }), "60");
    await pause(1200);
    await webShot(page, "owner-web-approve-form");
    await page.getByRole("button", { name: "승인하기" }).click();
    rec.caption(`대표 · 소속 승인 완료 — ${firstName}가 소속 강사가 됐어요`);
    await pause(2500);
    await scrollSlowly(page, 300);
    await pause(2000);
    await webShot(page, "owner-web-approved");
    rec.hlEnd();

    rec.caption("대표 · 예약 · 명단 — 회차별 앱 결제 · 현장 인원");
    await page.getByRole("link", { name: "예약 · 명단" }).click();
    await page.getByRole("heading", { name: "예약 · 명단", level: 1 }).waitFor({ timeout: 20_000 });
    await pause(3500);
    await webShot(page, "owner-web-roster");
    rec.caption("대표 · 입점 · 설정 — 학원 정보 · 판매자 정보 · 정산 계좌");
    await page.getByRole("link", { name: "입점 · 설정" }).click();
    await page.getByRole("heading", { name: "입점 · 설정", level: 1 }).waitFor({ timeout: 20_000 });
    await pause(3000);
    await scrollSlowly(page, 600);
    await pause(2500);
    await webShot(page, "owner-web-settings");
    await scrollSlowly(page, -600);
    for (const [link, caption, name] of [
      ["학원 공지 ›", "대표 · 학원 공지 — 소속 강사에게 보내는 공지", "staff-notices"],
      ["학원 앱 페이지 꾸미기 ›", "대표 · 학원 앱 페이지 꾸미기 — 회원 앱에 보이는 학원 소개", "app-page"],
    ] as const) {
      try {
        await page.getByRole("link", { name: link }).click();
        await page.waitForURL((u) => u.pathname.endsWith(`/${name}`), { timeout: 20_000 });
        await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 20_000 });
        rec.caption(caption);
        await pause();
        await scrollSlowly(page, 400);
        await pause(2000);
        await webShot(page, `owner-web-${name}`);
        await page.getByRole("link", { name: "입점 · 설정" }).click();
        await page.getByRole("heading", { name: "입점 · 설정", level: 1 }).waitFor({ timeout: 20_000 });
        await pause(1000);
      } catch (error) {
        skipped.push({ scene: `대표 웹 ${name}`, reason: error instanceof Error ? error.message.split("\n")[0]! : String(error) });
      }
    }
  } finally {
    rec.close();
    const video = page.video();
    await ctx.close();
    rec.seg.video = (await video?.path()) ?? "";
    await browser.close();
  }
  console.log(`  [영상] ownerWeb → ${rec.seg.video} (${rec.seg.end.toFixed(1)}초)`);
  return rec.seg;
}

// ── 편집(ffmpeg) — dev-demo-record-showcase.ts 와 같은 방식(ASS 자막 + subtitles 필터, 아이보리 바탕 가운데 휴대폰) ──
const W = 1440;
const H = 900;
const FPS = 30;
const IVORY_HEX = "0xF4F0EA";
const PLUM_HEX = "0x4A2340";
const ASS_IVORY = "&H00EAF0F4";
const ASS_PLUM = "&H0040234A";
const ASS_PLUM_BOX = "&H2040234A";
const ASS_WHITE = "&H00FFFFFF";
const FONT_DIR = join(homedir(), ".fonts");
const FONT_NAME = "Noto Sans CJK KR";
const X264 = ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS), "-an"];
// 앱 화면 크기(1080×2400 → 높이 800) · 위치
const PHONE_W = 360;
const PHONE_H = 800;
const PHONE_X = (W - PHONE_W) / 2;
const PHONE_Y = 18;

function ff(args: string[]): void {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg 실패: ${args.join(" ").slice(0, 400)}`);
}
function assTime(s: number): string {
  const t = Math.max(0, s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = (t % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${sec}`;
}
type AssEvent = { from: number; to: number; style: "Cap" | "Label" | "Title" | "Sub"; text: string };
let assNo = 0;
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
    style("Cap", 32, ASS_WHITE, ASS_PLUM_BOX, 3, 14, 2, 26),
    style("Label", 46, ASS_PLUM, ASS_IVORY, 1, 0, 7, 0),
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

/** 녹화 영상을 1440×900·30fps 로 — 앱은 아이보리 바탕 가운데 휴대폰 화면(테두리 한 줄) */
function normalize(seg: Segment): string {
  const out = join(WORK_DIR, `norm-${seg.id}.mp4`);
  // 자막·구간만 고쳐 다시 만들 때(DEMO_REUSE_NORM=1)는 이미 맞춘 영상을 그대로 쓴다
  if (process.env["DEMO_REUSE_NORM"] === "1" && existsSync(out)) return out;
  if (seg.kind === "web") {
    ff(["-i", seg.video, "-vf", `fps=${FPS},scale=${W}:${H}`, ...X264, out]);
    return out;
  }
  const base =
    // 화면 녹화는 화면이 멈춰 있으면 프레임을 쓰지 않아 끝이 짧아진다 — 마지막 프레임을 늘려 녹화 길이(seg.end)에 맞춘다
    `[0:v]tpad=stop_mode=clone:stop_duration=15,fps=${FPS},trim=duration=${seg.end.toFixed(2)},setpts=PTS-STARTPTS,` +
    `scale=${PHONE_W}:${PHONE_H},pad=${W}:${H}:${PHONE_X}:${PHONE_Y}:color=${IVORY_HEX},` +
    `drawbox=x=${PHONE_X - 3}:y=${PHONE_Y - 3}:w=${PHONE_W + 6}:h=${PHONE_H + 6}:color=${PLUM_HEX}@0.35:t=3`;
  ff(["-i", seg.video, "-filter_complex", `${base}[v]`, "-map", "[v]", ...X264, out]);
  return out;
}
function captionSpans(seg: Segment): { from: number; to: number; text: string }[] {
  return seg.captions.map((c, i) => ({ from: c.at, to: seg.captions[i + 1]?.at ?? seg.end, text: c.text }));
}
function cutClip(norm: string, seg: Segment, label: string, from: number, to: number, out: string, speed = 1): void {
  const len = to - from;
  const events: AssEvent[] = captionSpans(seg)
    .filter((c) => c.to > from && c.from < to)
    .map((c) => ({ from: Math.max(0, c.from - from), to: Math.min(to, c.to) - from, style: "Cap" as const, text: c.text }));
  if (seg.kind === "app" && label !== "") events.push({ from: 0, to: len, style: "Label", text: `{\\pos(110,360)}${label}` });
  const filters = [assFilter(events), `setpts=${(1 / speed).toFixed(4)}*PTS`].join(",");
  ff(["-ss", from.toFixed(2), "-to", to.toFixed(2), "-i", norm, "-vf", filters, ...X264, out]);
}
function titleCard(title: string, sub: string, seconds: number, out: string): void {
  const vf = assFilter([
    { from: 0, to: seconds, style: "Title", text: `{\\pos(${W / 2},${H / 2 - 30})}${title}` },
    { from: 0, to: seconds, style: "Sub", text: `{\\pos(${W / 2},${H / 2 + 60})}${sub}` },
  ]);
  ff(["-f", "lavfi", "-i", `color=c=${PLUM_HEX}:s=${W}x${H}:r=${FPS}:d=${seconds}`, "-vf", vf, ...X264, out]);
}
/** 잘라 낼 구간을 뺀 나머지(기다리는 구간은 앞뒤 1초만 남긴다) */
function keptRanges(seg: Segment, from = 0, to = seg.end): [number, number][] {
  const ranges: [number, number][] = [];
  let cursor = from;
  for (const s of [...seg.skips].sort((a, b) => a.from - b.from)) {
    const sFrom = s.from + 1;
    const sTo = s.to - 1;
    if (sTo <= sFrom || sTo <= cursor || sFrom >= to) continue;
    if (sFrom > cursor) ranges.push([cursor, sFrom]);
    cursor = Math.max(cursor, sTo);
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
  const seg = (id: string) => {
    const s = timeline.segments.find((x) => x.id === id);
    if (s === undefined) throw new Error(`timeline 에 ${id} 조각이 없다`);
    return s;
  };
  const has = (id: string) => timeline.segments.some((x) => x.id === id);
  const labels: Record<string, string> = {
    entry: "로그인",
    member1: "회원 앱",
    member2: "회원 앱",
    member2b: "회원 앱",
    levelup: "회원 앱",
    member3: "회원 앱",
    inst1: "강사 앱",
    inst2: "강사 앱",
    inst3: "강사 앱",
    ownerApp: "대표 앱",
  };
  const norm: Record<string, string> = {};
  for (const s of timeline.segments) norm[s.id] = normalize(s);
  let clipNo = 0;
  const clip = (id: string, from: number, to: number, speed = 1) => {
    const out = join(WORK_DIR, `clip-${String(++clipNo).padStart(3, "0")}.mp4`);
    cutClip(norm[id]!, seg(id), labels[id] ?? "", from, to, out, speed);
    return out;
  };
  const card = (title: string, sub: string, seconds: number) => {
    const out = join(WORK_DIR, `card-${String(++clipNo).padStart(3, "0")}.mp4`);
    titleCard(title, sub, seconds, out);
    return out;
  };
  const highlightOnly = process.env["DEMO_HIGHLIGHT_ONLY"] === "1";
  const whole = (id: string, from?: number, to?: number) => (has(id) && !highlightOnly ? keptRanges(seg(id), from, to).map(([a, b]) => clip(id, a, b)) : []);

  // ① 전체 한 편 — 로그인 입구 → 회원 → 강사 → 대표(웹 앞부분 → 앱 수업 승인 → 회원 홈 → 웹 뒷부분)
  const full: string[] = [];
  full.push(card("K-DanceX4 시연", "안드로이드 에뮬레이터 · 로그인 입구 → 회원 → 강사 → 대표", 2.5));
  full.push(...whole("entry"));
  full.push(card("회원 앱", "장르 사진 카드 · AI 플래너 · 관심 장르", 2));
  full.push(...whole("member1"), ...whole("member2"), ...whole("member2b"));
  full.push(card("강사 앱", "회원 관리 · 레벨 수정 · 수업 등록 · 홍보 이미지", 2));
  // 레벨업(회원 쪽 카드 발급) 장면은 full 에 넣지 않는다 — 2026-11-25 코디네이터 지시: 별도 에이전트의 levelup.mp4 를 따로 끼운다
  full.push(...whole("inst1"), ...whole("inst2"), ...whole("inst3"));
  full.push(card("대표", "관리자 웹 · 대표 앱 — 소속 승인 · 수업 승인", 2));
  const web = has("ownerWeb") ? seg("ownerWeb") : null;
  const webSplit = web?.captions.find((c) => c.text.startsWith("대표 · 예약 · 명단"))?.at ?? web?.end ?? 0;
  if (web !== null) full.push(...whole("ownerWeb", 0, webSplit));
  full.push(...whole("ownerApp"), ...whole("member3"));
  if (web !== null) full.push(...whole("ownerWeb", webSplit, web.end));
  if (!highlightOnly) concat(full, join(OUT, "full.mp4"));

  // ①-2 레벨업 카드 발급 단독 영상 — 제목 카드 + 알림이 뜬 순간(1.5초 앞)부터 카드 모음까지
  if (has("levelup") && !highlightOnly) {
    // 구간(초)은 이번 녹화의 timeline.json 을 보고 골랐다 — 알림 → 받기 → 뒤집힘·게이지 → 확인 → 토스트 → 카드 모음.
    // 카드가 다 나온 뒤 멈춰 있는 몇 초와 마이로 가는 이동은 빼서 30초대로 맞춘다
    const LEVELUP_RANGES: [number, number][] = [[24.5, 45.5], [49.5, 55.0], [60.5, 68.0]];
    const parts = LEVELUP_RANGES.map(([a, b]) => clip("levelup", a, Math.min(b, seg("levelup").end)));
    concat([card("회원 · 레벨업 카드 발급", "강사가 올려 준 레벨 → 카드 받기 → 카드 모음", 2), ...parts], join(OUT, "levelup.mp4"));
  }

  // ② 핵심 한 편 — 역할마다 제목 1.5초 + 핵심 구간을 28.5초에 맞춤(합 90초)
  const TITLE_S = 1.5;
  const BODY_S = 30 - TITLE_S;
  // 핵심 구간은 이번 녹화의 자막 시각(timeline.json)을 보고 고른 「조각 id · 시작 · 끝(초)」이다.
  // 기다리는 장면(화면 구조 읽기 · AI 응답 대기)을 빼고 장면이 바뀌는 순간만 남겨 1.2~1.6배 안쪽으로 맞춘다.
  // 다시 녹화하면 시각이 바뀌므로 timeline.json 의 자막 시각을 보고 이 표를 고친다.
  const role = (title: string, ranges: [string, number, number][]) => {
    const picked = ranges.filter(([id]) => has(id)).map(([id, from, to]) => ({ id, from, to: Math.min(to, seg(id).end) }));
    const total = picked.reduce((sum, p) => sum + (p.to - p.from), 0);
    const speed = total / BODY_S;
    console.log(`  핵심 ${title}: 원본 ${total.toFixed(1)}초 → ${BODY_S}초 (속도 ${speed.toFixed(2)}배)`);
    return [card(title, "핵심 30초", TITLE_S), ...picked.map((p) => clip(p.id, p.from, p.to, speed))];
  };
  const highlight = [
    // 회원: 로그인 3번 탭(강사 페이 · 대표 재즈 클럽) → 장르 사진 카드(라틴 사진일 때 누름) → 관심 장르 여러 개 → AI 플래너
    ...role("회원 앱", [
      ["entry", 5.4, 18.0],
      ["member1", 36.6, 42.5],
      ["member1", 53.5, 63.0],
      ["member2b", 12.7, 16.5],
      ["member2", 14.9, 17.5],
      ["member2", 27.4, 32.0],
    ]),
    // 강사: 회원 관리 명단 → 레벨 정하기·최종 적용 → 앱 안에 뜬 홍보 이미지 결과 → 수업 등록
    ...role("강사 앱", [
      ["inst1", 40.0, 47.0],
      ["inst1", 47.3, 52.0],
      ["inst1", 62.0, 74.1],
      ["inst2", 134.5, 143.0],
      ["inst3", 0, 6.0],
    ]),
    // 대표: 웹 강사 소속 승인 → 앱 수업 승인 → 회원 홈에 공개
    ...role("대표", [
      ["ownerWeb", 25.4, 37.0],
      ["ownerApp", 33.5, 51.0],
      ["member3", 44.0, 56.0],
    ]),
  ];
  concat(highlight, join(OUT, "highlight.mp4"));
}

// ── 실행 ─────────────────────────────────────────────────────────────────────
mkdirSync(VIDEO_DIR, { recursive: true });
const timelineFile = join(OUT, "timeline.json");
const timeline: Timeline = existsSync(timelineFile) ? (JSON.parse(readFileSync(timelineFile, "utf8")) as Timeline) : { segments: [] };
if (COMPOSE_ONLY) {
  compose(timeline);
  console.log("끝 — 영상만 다시 만듦");
  process.exit(0);
}

const url = process.env["DATABASE_URL"] ?? "";
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에서만 돈다");
const pool = new pg.Pool({ connectionString: url, max: 2 });
// 조각마다 스크린샷 번호대(entry 01~, member1 11~ …, 레벨업은 강사 1 바로 뒤 46~)
const SHOT_BASE: Record<string, number> = { entry: 0, member1: 10, member2: 20, member2b: 30, inst1: 40, levelup: 45, inst2: 50, inst3: 60, ownerApp: 70, member3: 80, ownerWeb: 90 };
const order = ["entry", "member1", "member2", "member2b", "inst1", "levelup", "inst2", "inst3", "ownerApp", "member3", "ownerWeb"];
const save = (s: Segment) => {
  timeline.segments = [...timeline.segments.filter((x) => x.id !== s.id), s].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  writeFileSync(timelineFile, JSON.stringify(timeline, null, 2));
};
try {
  for (const part of PARTS) {
    shotNo = SHOT_BASE[part] ?? 0;
    if (part === "entry") save(await appPart("entry", partEntry));
    if (part === "member1") save(await appPart("member1", partMember1));
    if (part === "member2") save(await appPart("member2", partMember2));
    if (part === "member2b") save(await appPart("member2b", partMember2b));
    if (part === "inst1") save(await appPart("inst1", partInst1));
    if (part === "levelup") save(await appPart("levelup", partLevelUp));
    if (part === "inst2") save(await appPart("inst2", partInst2));
    if (part === "inst3") save(await appPart("inst3", partInst3));
    if (part === "ownerApp") save(await appPart("ownerApp", partOwnerApp));
    if (part === "member3") save(await appPart("member3", (rec) => partMember3(rec, pool)));
    if (part === "ownerWeb") save(await partOwnerWeb());
  }
} finally {
  writeFileSync(join(OUT, "skipped.json"), JSON.stringify(skipped, null, 2));
  if (PARTS.includes("ownerWeb")) {
    // brad 의 2단계 인증을 녹화 전 상태(꺼짐·등록 없음)로 돌린다
    const del = await pool.query(`DELETE FROM auth."twoFactor" WHERE "userId" = (SELECT id FROM auth."user" WHERE username = $1)`, [OWNER.username]);
    await pool.query(`UPDATE auth."user" SET "twoFactorEnabled" = false WHERE username = $1`, [OWNER.username]);
    console.log(`정리: brad 2단계 인증 등록 ${del.rowCount ?? 0}건 삭제 · twoFactorEnabled=false`);
  }
  // 회원 기준 장르를 「댄스스포츠 · 전체」로 돌린다
  await pool.query(
    `UPDATE members SET base_genre = 'dance_sport', base_sub_genre = NULL WHERE id = (SELECT m.id FROM members m JOIN auth."user" u ON u.id = m.auth_user_id WHERE u.email = $1)`,
    [MEMBER.email],
  );
  await pool.end();
}
console.log("녹화 끝 — 영상은 DEMO_COMPOSE_ONLY=1 로 만든다");
