// 개발 DB 전용 — 대표 대시보드(보드 W29 · 대표 앱 홈 O6)의 결제 뒤 타일과 강사 집계(I1)가 빈 칸이 아니게 하는 시연 데이터
// (S3-5.6(대시보드 결제 타일·강사 집계)).
//
// 왜 따로 만드나: 앞 시연 수업들의 회차는 모두 11-30 이후라 「오늘 · 내일 수업」 타일이 비고, 남은 자리가 2자리 이하인 판매 단위도 없어
//   「정원 마감 임박」이 빈다. 그 두 장면을 보이려면 내일 회차가 있는 작은 수업이 하나 있어야 한다.
//
// 무엇을 넣나(모두 진짜 경로 — 수업·주문·결석 행을 SQL 로 넣지 않는다):
//   ① brad 학원(브래드 댄스 스튜디오) 정규 수업 「살사 온투 입문」 — 강사 오세린, B홀, 화·목 17:00–18:00, 11-24(화)부터 4회,
//      120,000원, 남 4 · 여 4. 등록 → 제출 → 대표 승인(POST /api/classes → submit → approve)
//   ② 시연 회원 3명이 카드로 결제 완료(주문 → 가짜 PG 입금 dev 경로 → 웹훅 확정) — 정우진(남) · 이서준(남) · 최하은(여)
//      → 남 자리 남은 2 = 「정원 마감 임박」, 오늘 신청·결제가 3건 늘고, 이번 달 신규 회원이 3명 는다
//   ③ 최하은이 내일 첫 회차에 「결석 예정」을 알린다(PUT /api/me/sessions/{sessionId}/absence) → 내일 수업 줄의 결석 예정 1
//   회원 이름은 계약 18 §8 예시(최하은·정우진)를 따랐다. 이메일은 모두 @example.com.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-dashboard.ts   (개발 서버 :3000, KDANCE_DEV_ROUTES=true)
//   두 번 돌려도 같은 결과 — 「살사 온투 입문」 수업이 이미 있으면 아무것도 하지 않는다.
//   먼저 dev-demo-owner.ts(brad) · dev-demo-console-data.ts(강사) 가 있어야 한다. 회차 날짜가 고정(11-24)이라 그날이 지나면 새로 넣을 수 없다.
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { createDb } from "../prisma/db";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = process.env["DEMO_API_BASE"] ?? "http://localhost:3000";
const CLASS_TITLE = "살사 온투 입문";
const PRICE = 120000;
const INSTRUCTOR_NAME = "오세린";
const ROOM_NAME = "B홀";
const MEMBERS = [
  { email: "demo-dash-woojin@example.com", username: "demo_dash_woojin", name: "정우진", gender: "male", birth: "1995-02-11", phone: "01000007711" },
  { email: "demo-dash-seojun@example.com", username: "demo_dash_seojun", name: "이서준", gender: "male", birth: "1991-07-30", phone: "01000007722" },
  { email: "demo-dash-haeun@example.com", username: "demo_dash_haeun", name: "최하은", gender: "female", birth: "1997-12-05", phone: "01000007733" },
] as const;
const PASSWORD = "demo-dash-1234";

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

// ---- ① 수업 등록 → 제출 → 승인 ---------------------------------------------------------------------------------
const [owner] = await q<{ user_id: string; academy_id: string }>(
  `SELECT u.id AS user_id, o.academy_id::text AS academy_id FROM auth."user" u
     JOIN staff_accounts s ON s.auth_user_id = u.id JOIN academy_owners o ON o.staff_account_id = s.id
   WHERE u.username = 'brad'`,
);
if (owner === undefined) throw new Error("brad 대표가 없다 — scripts/dev-demo-owner.ts 를 먼저 돌린다");
const [room] = await q<{ id: string }>(
  "SELECT r.id::text AS id FROM rooms r JOIN academy_branches b ON b.id = r.branch_id WHERE b.academy_id = $1 AND r.status = 'active' AND r.name = $2",
  [owner.academy_id, ROOM_NAME],
);
const [instructor] = await q<{ id: string }>(
  `SELECT s.id::text AS id FROM instructor_affiliations a JOIN staff_accounts s ON s.id = a.instructor_account_id
     JOIN instructor_profiles p ON p.staff_account_id = s.id
    WHERE a.academy_id = $1 AND a.status = 'active' AND p.activity_genre = 'salsa_bachata' AND s.display_name = $2
    ORDER BY s.id LIMIT 1`,
  [owner.academy_id, INSTRUCTOR_NAME],
);
if (room === undefined || instructor === undefined) throw new Error(`brad 학원에 ${ROOM_NAME} 또는 강사 ${INSTRUCTOR_NAME}이 없다 — dev-demo-console-data.ts 를 먼저 돌린다`);
const ownerToken = (await ctx.internalAdapter.createSession(owner.user_id)).token;

const created = await call("POST", "/api/classes", {
  token: ownerToken,
  headers: { "Idempotency-Key": randomUUID() },
  body: {
    academyId: owner.academy_id,
    classKind: "regular",
    title: CLASS_TITLE,
    subGenre: "salsa",
    discipline: null,
    targetLevel: "entry",
    targetAges: ["all"],
    roomId: room.id,
    priceAmount: PRICE,
    // 화·목 저녁 이른 시간 — 다른 시연 수업(저녁 18:30 이후)과 홀·강사 일정이 겹치지 않게
    schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime: "17:00", endTime: "18:00", periodFrom: "2026-11-24", periodTo: "2026-12-03" },
    capacity: { mode: "gender_split", male: 4, female: 4, any: null },
    refundDeadlineOn: null,
    introText: "살사 온투(On2) 기본 스텝을 4회에 익혀요.",
    instructorAccountId: instructor.id,
  },
  expect: [201],
});
const classId = String(created.body["classId"]);
await call("POST", `/api/classes/${classId}/submit`, { token: ownerToken, body: {}, expect: [200] });
// 대표가 직접 올린 수업은 제출과 동시에 게시될 수 있다 — 그때는 승인을 건너뛴다
const [state] = await q<{ status: string }>("SELECT status FROM classes WHERE id = $1", [classId]);
if (state?.status !== "published") {
  await call("POST", `/api/academies/${owner.academy_id}/classes/${classId}/approve`, { token: ownerToken, body: {}, expect: [200] });
}
const [offering] = await q<{ id: string }>("SELECT id::text AS id FROM class_offerings WHERE class_id = $1", [classId]);
console.log(`게시: ${CLASS_TITLE} · 강사 ${INSTRUCTOR_NAME} · ${ROOM_NAME} · 화·목 17:00 · 11-24부터 4회 · 남 4 · 여 4 · 판매 단위 ${offering!.id}`);

// ---- ② 시연 회원 3명 결제 완료 -----------------------------------------------------------------------------------
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
     VALUES ($1, $2, $3, $4, $5, $6, $7, $3, now(), 'salsa_bachata', '17:00'::time, '23:00'::time, now())`,
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
      body: { offeringId: offering!.id, seatKind, method: "card", noticesAcknowledged: true },
      expect: [201],
    })
  ).body as { orderId: string; payment: { amount: number } };
  const [payment] = await q<{ id: string }>("SELECT gateway_payment_id AS id FROM payments WHERE order_id = $1", [order.orderId]);
  if (payment === undefined) throw new Error(`결제 행이 없다: ${order.orderId}`);
  await call("POST", `/api/dev/fake-pg/payments/${encodeURIComponent(payment.id)}/deposit`, { body: { amount: order.payment.amount }, expect: [200] });
}

const tokens: Record<string, string> = {};
for (const m of MEMBERS) {
  const { token } = await memberToken(m);
  tokens[m.name] = token;
  await payByCard(token, m.gender);
  console.log(`결제 완료: ${m.name}(${m.gender === "male" ? "남" : "여"}) · ${CLASS_TITLE} · ${PRICE}원 · 카드`);
}

// ---- ③ 최하은 — 내일 첫 회차 결석 예정 ------------------------------------------------------------------------------
const [first] = await q<{ id: string; starts_at: string }>(
  "SELECT id::text AS id, starts_at::text AS starts_at FROM class_sessions WHERE offering_id = $1 AND status = 'scheduled' ORDER BY starts_at LIMIT 1",
  [offering!.id],
);
const absence = await call("PUT", `/api/me/sessions/${first!.id}/absence`, { token: tokens["최하은"], expect: [200, 201] });
console.log(`결석 예정: 최하은 · ${CLASS_TITLE} · ${first!.starts_at} 회차 → ${absence.status}`);
await finish(0);
