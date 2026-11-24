// 개발 DB 전용 — 강사 앱 「오늘 결석」(I26) 화면이 빈 칸이 아니게 하는 시연 데이터(S3-5.9b(앱 강사 결석 표시 화면)).
//
// 왜 따로 만드나: 결석 표시는 수업이 **시작한 뒤**에만 된다(계약 04 §6-1 #3). 앞 스크립트들의 오늘 회차(17:00 · 20:30)는
//   아직 시작 전이라 I26 의 「강사가 표시한 결석」·「이의」 줄을 만들 수 없다. 그래서 몇 분 뒤 시작하는 회차를 하나 만들고,
//   시작 시각까지 기다린 뒤 진짜 경로로 결석·이의를 쌓는다.
//
// 무엇을 넣나(모두 진짜 경로 — 수업·주문·결석·이의 행을 SQL 로 넣지 않는다):
//   ① brad 학원(라틴하우스 강남) 정규 수업 「살사 LA 입문」 — 강사 오세린(보드 I26 예시 「쌈바(입문)」은 댄스스포츠라 살사·바차타 강사가 맡을 수 없어 장르에 맞는 이름으로 바꿨다), 빈 홀(A홀 → 막히면 B홀),
//      오늘 하루 1회(지금부터 약 7~17분 뒤 시작, 60분), 60,000원, 남 6 · 여 6. 대표가 등록 → 제출(→ 필요하면 승인)
//   ② 시연 회원 5명 카드 결제 완료(주문 → 가짜 PG 입금 dev 경로 → 웹훅) — 최하은(여) · 정우진(남) · 김서준(남) · 이수아(여) · 박지호(남)
//      이름은 보드 I26 예시(최하은 · 정우진)와 spec 예시 이름을 따랐다. 이메일은 모두 @example.com
//   ③ 시작 전: 최하은이 「결석 예정」을 알린다(PUT /api/me/sessions/{id}/absence)
//   ④ 시작 시각까지 기다린다
//   ⑤ 시작 뒤: 오세린 강사가 정우진 · 김서준을 결석으로 표시(POST …/absences) → 두 회원이 이의 신청(POST /api/me/attendance-marks/{id}/dispute)
//      → 강사가 김서준 이의는 「유지」(POST /api/attendance-marks/{id}/dispute/resolve reject). 정우진 이의는 화면에서 처리하도록 남긴다
//   → I26: 자리 5명 · 오늘 결석 3명 (남 2 · 여 1) / 최하은(알림) · 정우진(이의 들어옴) · 김서준(이의 결과 · 결석 유지)
//      「다른 수강생 결석 표시」 후보: 이수아 · 박지호
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-instructor-absences.ts   (개발 서버 :3000, KDANCE_DEV_ROUTES=true)
//   두 번 돌려도 같은 결과 — 「살사 LA 입문」 수업이 이미 있으면 아무것도 하지 않는다.
//   먼저 dev-demo-owner.ts(brad) · dev-demo-console-data.ts(홀·강사) 가 있어야 한다.
//   회차 시각이 「지금 + 몇 분」이라 날짜마다 다르게 들어간다. 결석 표시는 그 회차가 끝나고 48시간까지 된다.
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { createDb } from "../prisma/db";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = process.env["DEMO_API_BASE"] ?? "http://localhost:3000";
const CLASS_TITLE = "살사 LA 입문";
const PRICE = 60000;
const INSTRUCTOR_NAME = "오세린";
const ROOMS = ["A홀", "B홀"] as const;
// 지금부터 최소 이만큼 뒤에 시작한다(등록·결제할 시간). 수업 시각은 10분 단위만 받으므로 10분 단위로 올린다
const LEAD_MINUTES = 7;
const MEMBERS = [
  { email: "demo-absent-haeun@example.com", username: "demo_absent_haeun", name: "최하은", gender: "female", birth: "1996-03-14", phone: "01000007711" },
  { email: "demo-absent-woojin@example.com", username: "demo_absent_woojin", name: "정우진", gender: "male", birth: "1991-07-02", phone: "01000007722" },
  { email: "demo-absent-seojun@example.com", username: "demo_absent_seojun", name: "김서준", gender: "male", birth: "1988-12-20", phone: "01000007733" },
  { email: "demo-absent-sua@example.com", username: "demo_absent_sua", name: "이수아", gender: "female", birth: "2001-05-09", phone: "01000007744" },
  { email: "demo-absent-jiho@example.com", username: "demo_absent_jiho", name: "박지호", gender: "male", birth: "1984-02-27", phone: "01000007755" },
] as const;
const PASSWORD = "demo-absent-1234";
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);

async function finish(code = 0): Promise<never> {
  await db.close();
  await pool.end();
  process.exit(code);
}

// ---- 두 번째 실행이면 건너뛴다 ----------------------------------------------------------------------------------
const [already] = await q<{ id: string }>("SELECT id::text AS id FROM classes WHERE title = $1", [CLASS_TITLE]);
if (already !== undefined) {
  console.log(`건너뜀: 「${CLASS_TITLE}」 수업이 이미 있다(${already.id})`);
  await finish(0);
}

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (health?.ok !== true) throw new Error(`개발 서버(${BASE})가 떠 있지 않다 — KDANCE_DEV_ROUTES=true npm run dev -- --port 3000`);

type Call = { status: number; body: Record<string, unknown> };
/** 개발 서버의 진짜 경로를 부른다. 기대한 상태 코드가 아니면 응답을 그대로 보여 주고 멈춘다 */
async function call(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; expect: number[] }): Promise<Call> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await response.text();
  if (!opts.expect.includes(response.status)) throw new Error(`${method} ${path} → ${response.status} ${text}`);
  return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

// ---- ① 시작 시각 정하기 — KST 로 지금 + LEAD_MINUTES 를 10분 단위로 올린다(등록 규칙: 시각은 10분 단위) -----------------------------------------------
const nowKst = new Date(Date.now() + 9 * 3600_000);
const startMinutes = Math.ceil((nowKst.getUTCHours() * 60 + nowKst.getUTCMinutes() + LEAD_MINUTES) / 10) * 10;
if (startMinutes + 60 >= 24 * 60) throw new Error("자정 가까이에는 하루 안에 끝나는 회차를 만들 수 없다 — 내일 다시 돌린다");
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const today = nowKst.toISOString().slice(0, 10);
const weekday = WEEKDAY_KEYS[nowKst.getUTCDay()]!;

const [owner] = await q<{ user_id: string; academy_id: string }>(
  `SELECT u.id AS user_id, o.academy_id::text AS academy_id FROM auth."user" u
     JOIN staff_accounts s ON s.auth_user_id = u.id JOIN academy_owners o ON o.staff_account_id = s.id
   WHERE u.username = 'brad'`,
);
if (owner === undefined) throw new Error("brad 대표가 없다 — scripts/dev-demo-owner.ts 를 먼저 돌린다");
// 강사 고르는 기준은 dev-demo-instructor-today.ts 와 같다(I1·I7 의 오세린 — 같은 날 앞뒤 수업 「‹ 이전 · 다음 ›」이 이어지게)
const [instructor] = await q<{ id: string; user_id: string }>(
  `SELECT s.id::text AS id, s.auth_user_id AS user_id FROM instructor_affiliations a JOIN staff_accounts s ON s.id = a.instructor_account_id
     JOIN instructor_profiles p ON p.staff_account_id = s.id
    WHERE a.academy_id = $1 AND a.status = 'active' AND p.activity_genre = 'salsa_bachata' AND s.display_name = $2
    ORDER BY s.id LIMIT 1`,
  [owner.academy_id, INSTRUCTOR_NAME],
);
if (instructor === undefined) throw new Error(`brad 학원에 강사 ${INSTRUCTOR_NAME}이 없다 — dev-demo-console-data.ts 를 먼저 돌린다`);
const ownerToken = (await ctx.internalAdapter.createSession(owner.user_id)).token;
const instructorToken = (await ctx.internalAdapter.createSession(instructor.user_id)).token;

// ---- ② 수업 등록 → 제출 → 승인. 홀이 그 시각에 막혀 있으면(409 ROOM_CONFLICT) 다음 홀로 ------------------------------------
let classId = "";
for (const roomName of ROOMS) {
  const [room] = await q<{ id: string }>(
    "SELECT r.id::text AS id FROM rooms r JOIN academy_branches b ON b.id = r.branch_id WHERE b.academy_id = $1 AND r.status = 'active' AND r.name = $2",
    [owner.academy_id, roomName],
  );
  if (room === undefined) continue;
  const created = await call("POST", "/api/classes", {
    token: ownerToken,
    headers: { "Idempotency-Key": randomUUID() },
    body: {
      academyId: owner.academy_id,
      classKind: "regular",
      title: CLASS_TITLE,
      // 강사 오세린의 활동 장르(살사·바차타) 안의 세부 장르여야 등록된다
      subGenre: "salsa",
      discipline: null,
      targetLevel: "entry",
      targetAges: ["all"],
      roomId: room.id,
      priceAmount: PRICE,
      schedule: { kind: "recurring", weekdays: [weekday], startTime: hhmm(startMinutes), endTime: hhmm(startMinutes + 60), periodFrom: today, periodTo: today },
      capacity: { mode: "gender_split", male: 6, female: 6, any: null },
      refundDeadlineOn: null,
      introText: "살사 LA 스타일 기본 스텝과 턴을 익혀요.",
      instructorAccountId: instructor.id,
    },
    expect: [201],
  });
  const id = String(created.body["classId"]);
  const submitted = await call("POST", `/api/classes/${id}/submit`, { token: ownerToken, body: {}, expect: [200, 409] });
  if (submitted.status === 409) {
    console.log(`${roomName} 은 ${hhmm(startMinutes)} 에 막혀 있다(${JSON.stringify(submitted.body["code"])}) — 다음 홀로`);
    continue;
  }
  classId = id;
  console.log(`등록: ${CLASS_TITLE} · ${roomName} · ${today} ${hhmm(startMinutes)}–${hhmm(startMinutes + 60)} · 강사 ${INSTRUCTOR_NAME}`);
  break;
}
if (classId === "") throw new Error("빈 홀이 없다 — 몇 분 뒤 다시 돌린다");
const [state] = await q<{ status: string }>("SELECT status FROM classes WHERE id = $1", [classId]);
if (state?.status !== "published") {
  await call("POST", `/api/academies/${owner.academy_id}/classes/${classId}/approve`, { token: ownerToken, body: {}, expect: [200] });
}
const [offering] = await q<{ id: string }>("SELECT id::text AS id FROM class_offerings WHERE class_id = $1", [classId]);
const offeringId = offering!.id;
const [session] = await q<{ id: string; starts_at: Date }>(
  "SELECT id::text AS id, starts_at FROM class_sessions WHERE offering_id = $1 ORDER BY starts_at LIMIT 1",
  [offeringId],
);
const sessionId = session!.id;

// ---- ③ 시연 회원 5명 결제 완료 -----------------------------------------------------------------------------------
/** 가입을 마친 회원 행(앞 시연 스크립트들과 같은 방식). 이미 있으면 그 회원을 쓴다 */
async function memberToken(m: (typeof MEMBERS)[number]): Promise<{ token: string; memberId: string }> {
  const [found] = await q<{ user_id: string; member_id: string }>(
    "SELECT u.id AS user_id, mb.id::text AS member_id FROM auth.\"user\" u JOIN members mb ON mb.auth_user_id = u.id WHERE u.email = $1",
    [m.email],
  );
  if (found !== undefined) return { token: (await ctx.internalAdapter.createSession(found.user_id)).token, memberId: found.member_id };
  const user = await ctx.internalAdapter.createUser(
    { email: m.email, name: m.name, emailVerified: true, username: m.username, displayUsername: m.username },
    { method: "admin" },
  );
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(PASSWORD) });
  const memberId = randomUUID();
  await q(
    `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at,
                          base_genre, available_from, available_to, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $3, now(), 'salsa_bachata', '09:00'::time, '23:00'::time, now())`,
    [memberId, user.id, m.name, m.gender, m.birth, m.phone, `demo-ci-${randomUUID()}`],
  );
  await q("INSERT INTO member_interest_genres (member_id, genre) VALUES ($1, 'salsa_bachata')", [memberId]);
  await q("INSERT INTO member_regions (member_id, region_sido, region_gu) VALUES ($1, '서울', '강남구')", [memberId]);
  return { token: (await ctx.internalAdapter.createSession(user.id)).token, memberId };
}

/** 주문 → 가짜 PG 입금 → 웹훅 확정까지(결제 완료) */
async function payByCard(token: string, seatKind: "male" | "female"): Promise<void> {
  const order = (
    await call("POST", "/api/orders", {
      token,
      headers: { "Idempotency-Key": randomUUID() },
      body: { offeringId, seatKind, method: "card", noticesAcknowledged: true },
      expect: [201],
    })
  ).body as { orderId: string; payment: { amount: number } };
  const [payment] = await q<{ id: string }>("SELECT gateway_payment_id AS id FROM payments WHERE order_id = $1", [order.orderId]);
  if (payment === undefined) throw new Error(`결제 행이 없다: ${order.orderId}`);
  await call("POST", `/api/dev/fake-pg/payments/${encodeURIComponent(payment.id)}/deposit`, { body: { amount: order.payment.amount }, expect: [200] });
}

const people: Record<string, { token: string; memberId: string }> = {};
for (const m of MEMBERS) {
  people[m.name] = await memberToken(m);
  await payByCard(people[m.name]!.token, m.gender);
  console.log(`결제 완료: ${m.name}(${m.gender === "male" ? "남" : "여"}) · ${CLASS_TITLE} · ${PRICE}원 · 카드`);
}

// ---- ④ 시작 전 — 최하은이 결석 예정을 알린다 --------------------------------------------------------------------------
const planned = await call("PUT", `/api/me/sessions/${sessionId}/absence`, { token: people["최하은"]!.token, expect: [200, 201] });
console.log(`결석 예정: 최하은 → ${planned.status}`);

// ---- ⑤ 시작 시각까지 기다린다(결석 표시는 시작 뒤에만 된다) -------------------------------------------------------------
const waitMs = session!.starts_at.getTime() - Date.now() + 5_000;
if (waitMs > 0) {
  console.log(`시작(${hhmm(startMinutes)})까지 ${Math.ceil(waitMs / 1000)}초 기다린다`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

// ---- ⑥ 시작 뒤 — 강사가 정우진 · 김서준을 결석으로 표시하고, 두 회원이 이의를 건다. 김서준 이의는 강사가 유지 ----------------------
const marks: Record<string, string> = {};
for (const name of ["정우진", "김서준"]) {
  const marked = await call("POST", `/api/classes/${classId}/sessions/${sessionId}/absences`, {
    token: instructorToken,
    body: { memberId: people[name]!.memberId },
    expect: [201],
  });
  marks[name] = String(marked.body["markId"]);
  console.log(`결석 표시: ${name} · 강사 ${INSTRUCTOR_NAME} → ${marked.status}`);
}
const reasons: Record<string, string> = { 정우진: "그날 수업에 갔어요", 김서준: "늦게 들어갔는데 끝까지 했어요" };
for (const name of ["정우진", "김서준"]) {
  const disputed = await call("POST", `/api/me/attendance-marks/${marks[name]}/dispute`, { token: people[name]!.token, body: { reason: reasons[name] }, expect: [200] });
  console.log(`이의 신청: ${name} 「${reasons[name]}」 → ${disputed.status}`);
}
const rejected = await call("POST", `/api/attendance-marks/${marks["김서준"]}/dispute/resolve`, {
  token: instructorToken,
  body: { decision: "reject", note: "수업 끝까지 자리에 없었어요" },
  expect: [200],
});
console.log(`이의 처리: 김서준 → 결석 유지(${rejected.status}). 정우진 이의는 화면에서 처리하도록 남김`);
console.log(`I26 주소: /instructor/sessions/${sessionId}/absences?classId=${classId}`);
await finish(0);
