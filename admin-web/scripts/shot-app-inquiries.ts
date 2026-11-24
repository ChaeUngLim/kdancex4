// 개발 PC 전용 — 앱 문의 화면(회원 M22 · 강사 I16)을 진짜 서버·개발 DB 데이터로 찍는다(S7-2.8(앱 문의 화면)).
//
// 가짜 응답을 만들지 않는다. 앱(Expo 웹 :8081)이 부르는 `/api/**` 를 진짜 서버(admin-web :3000)로 넘기면서
// 그 사람의 Better Auth 세션 토큰을 `Authorization: Bearer` 로 붙일 뿐이다(S7-1.8 의 shot 스크립트와 같은 방법).
//   왜 붙여 주나: 웹 실행에서는 토큰이 메모리에만 있어 밖에서 넣을 수 없다(mobile/lib/session.ts). 토큰은 로그에 찍지 않는다.
//
// 먼저 넣을 데이터: scripts/dev-demo-inquiries.ts(서아의 문의 2건 · 오세린의 결석 문의 · 브래드의 답변)
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/shot-app-inquiries.ts <증거 폴더>
//   결과: <폴더>/shots/01-M22-new-inquiry.png · 02-I16-new-inquiry.png(verify 2장)
//         <폴더>/screens/03-M22-my-inquiries.png · 04-M22-conversation.png · 05-I16-sent.png(상태 장면)
//   05 장면은 화면의 「문의 보내기」를 진짜로 누른다. 같은 글이 이미 있으면 다시 보내지 않고 목록만 찍는다(두 번 돌려도 문의가 늘지 않음).
//   화면에 기대한 글자가 없으면 [check] FAIL 을 찍고 exit 1.
import "dotenv/config";

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type Page } from "@playwright/test";

import { createStaffAuth } from "../lib/server/staff-auth";

const OUT = process.argv[2] ?? ".";
const CHROME = join(homedir(), ".cache/ms-playwright/chromium-1255/chrome-linux64/chrome");
const APP = "http://localhost:8081";
const API = "http://localhost:3000";
const MEMBER_EMAIL = "demo-myclass@example.com";
const INSTRUCTOR_NAME = "오세린";
const ACADEMY_NAME = "브래드 댄스 스튜디오";
// 05 장면에서 강사가 화면으로 보내는 글 — 보드 I16 의 예시 글을 이 학원 수업에 맞춘 것
const INSTRUCTOR_BODY = "11월 정산에 환불 1건이 잡혔어요. 어느 회원의 어떤 회차 환불인지 근거를 볼 수 있을까요?";

const url = process.env["DATABASE_URL"] ?? "";
// 개발 DB 에서만 세션을 만든다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에서만 돈다");

const pg = await import("pg");
const pool = new pg.default.Pool({ connectionString: url, max: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;

async function sessionFor(sql: string, params: unknown[], what: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(sql, params);
  if (rows[0] === undefined) throw new Error(`${what} 이 없다 — dev-demo-inquiries.ts 와 그 앞 시연을 먼저 돌린다`);
  return (await ctx.internalAdapter.createSession(rows[0].id)).token;
}
const memberToken = await sessionFor(`SELECT id FROM auth."user" WHERE email = $1`, [MEMBER_EMAIL], MEMBER_EMAIL);
const instructorToken = await sessionFor(
  `SELECT s.auth_user_id AS id FROM staff_accounts s
     JOIN instructor_affiliations f ON f.instructor_account_id = s.id AND f.status = 'active'
     JOIN academies a ON a.id = f.academy_id AND a.name = $2
    WHERE s.display_name = $1 AND s.status = 'active' ORDER BY s.created_at LIMIT 1`,
  [INSTRUCTOR_NAME, ACADEMY_NAME],
  `${ACADEMY_NAME} 소속 강사 ${INSTRUCTOR_NAME}`,
);

let failed = false;
async function expectText(page: Page, text: string): Promise<void> {
  // 웹 라우터는 앞 화면(마이)을 숨긴 채 남겨 두므로 보이는 것만 센다
  const ok = await page.getByText(text, { exact: false }).filter({ visible: true }).first().isVisible().catch(() => false);
  console.log(`[check] ${ok ? "PASS" : "FAIL"} ${text}`);
  if (!ok) failed = true;
}

/** 한 사람의 토큰을 붙여 /api/** 를 진짜 서버로 넘기는 새 페이지 */
async function pageFor(browser: Browser, token: string, who: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname + new URL(req.url()).search;
    const headers = { ...req.headers(), authorization: `Bearer ${token}` };
    const res = await route.fetch({ url: `${API}${path}`, headers });
    console.log(`[api] ${who} ${req.method()} ${path} → ${res.status()}`);
    await route.fulfill({ response: res });
  });
  return page;
}

mkdirSync(join(OUT, "shots"), { recursive: true });
mkdirSync(join(OUT, "screens"), { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

// ---- 회원 M22 -----------------------------------------------------------------------------------------------
const member = await pageFor(browser, memberToken, "회원");
// 마이 → 고객센터·문의 로 들어간다(입구 연결도 함께 확인)
await member.goto(`${APP}/my`);
await member.getByRole("button", { name: /고객센터 · 문의/ }).first().click({ timeout: 90_000 });
await member.getByText("어디에 물어볼까요?").waitFor({ timeout: 60_000 });
await member.getByText("바차타(초급)").first().waitFor({ timeout: 30_000 });
await member.getByRole("radio", { name: /일정 변경/ }).click();
await member.getByLabel("문의 내용").fill("12월 7일(월) 수업을 같은 주 수요일 반으로 옮길 수 있을까요?");
for (const t of ["새 문의", "내 문의 ", "학원 · 수업", "앱 이용", "내 예약에서 고르기", "바차타(초급)", "수업 문의", "환불 요청", "일정 변경", "브래드 댄스 스튜디오 대표에게만 가요", "AI 없이 바로 대표에게", "문의 보내기"]) await expectText(member, t);
// 폼이 한 화면보다 길어 키를 늘려 한 장에 담는다(너비는 그대로 390)
await member.setViewportSize({ width: 390, height: 1240 });
await member.screenshot({ path: join(OUT, "shots/01-M22-new-inquiry.png") });
await member.setViewportSize({ width: 390, height: 844 });

await member.getByRole("tab", { name: /내 문의/ }).click();
await member.getByText("답변 완료").first().waitFor({ timeout: 30_000 });
for (const t of ["브래드 댄스 스튜디오", "답변 완료", "운영팀(앱 이용)", "답변 대기", "수업 문의", "계정"]) await expectText(member, t);
await member.screenshot({ path: join(OUT, "screens/03-M22-my-inquiries.png") });

// 서아는 같은 학원에 답을 받은 수업 문의가 둘 있다 — 가장 최근 것(맨 위)을 펼친다
await member.getByRole("button", { name: /브래드 댄스 스튜디오, 수업 문의, 답변 완료/ }).first().click();
await member.getByText("브래드 댄스 스튜디오 대표 ·").first().waitFor({ timeout: 30_000 });
for (const t of ["나 ·", "브래드 댄스 스튜디오 대표 ·"]) await expectText(member, t);
await member.screenshot({ path: join(OUT, "screens/04-M22-conversation.png") });

// ---- 강사 I16 -----------------------------------------------------------------------------------------------
const teacher = await pageFor(browser, instructorToken, "강사");
await teacher.goto(`${APP}/instructor/my`);
await teacher.getByRole("button", { name: /고객센터 · 문의/ }).first().click({ timeout: 90_000 });
await teacher.getByText("어디에 물어볼까요?").waitFor({ timeout: 60_000 });
await teacher.getByRole("radio", { name: new RegExp(ACADEMY_NAME) }).waitFor({ timeout: 30_000 });
await teacher.getByLabel("문의 내용").fill(INSTRUCTOR_BODY);
for (const t of ["운영 문의", "소속 학원 대표", "정산 근거 · 정원 · 결석", "어느 학원 대표에게 보낼까요?", ACADEMY_NAME, "정산 금액 근거", "정원", "결석", "관련 정산 · 선택", "준비 중", `${ACADEMY_NAME} 대표에게만 가요`]) await expectText(teacher, t);
await teacher.setViewportSize({ width: 390, height: 1240 });
await teacher.screenshot({ path: join(OUT, "shots/02-I16-new-inquiry.png") });
await teacher.setViewportSize({ width: 390, height: 844 });

// 같은 글을 이미 보냈으면(두 번째 실행) 다시 보내지 않는다 — 목록 미리보기(앞 40자)로 본다
const mine = (await (await fetch(`${API}/api/inquiries?limit=50`, { headers: { authorization: `Bearer ${instructorToken}` } })).json()) as {
  items: { lastMessagePreview: string }[];
};
const already = mine.items.some((i) => INSTRUCTOR_BODY.startsWith(i.lastMessagePreview.replace(/…$/, "")));
if (already) {
  console.log("[send] 건너뜀(같은 글이 이미 있음) — 내 문의 탭만 연다");
  await teacher.getByRole("tab", { name: /내 문의/ }).click();
} else {
  await teacher.getByRole("button", { name: "문의 보내기" }).click();
  await teacher.getByText("문의를 보냈어요").waitFor({ timeout: 30_000 });
  console.log("[send] 화면에서 보냄");
  await expectText(teacher, "1영업일 안에 답해요");
}
await teacher.getByText("정산 금액 근거 ·").first().waitFor({ timeout: 30_000 });
for (const t of [ACADEMY_NAME, "정산 금액 근거 ·", "결석 ·", "답변 대기"]) await expectText(teacher, t);
await teacher.screenshot({ path: join(OUT, "screens/05-I16-sent.png") });

await browser.close();
await pool.end();
process.exit(failed ? 1 : 0);
