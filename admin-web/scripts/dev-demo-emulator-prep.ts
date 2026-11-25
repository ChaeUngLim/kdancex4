// 개발 DB 전용 — 안드로이드 에뮬레이터 시연 영상(dev-demo-record-emulator.ts)을 찍기 전에 화면이 빈 칸이 아니게 하는 시연 데이터(2026-11-25).
//
// 무엇을 넣나(수업·주문·결제·소속 신청은 모두 진짜 경로 — 행을 SQL 로 넣는 것은 새 시연 강사 계정 행뿐):
//   ① 아이유(iuu) 강사가 올리고 브레드(brad) 대표가 승인한 「스탠다드 왈츠 · 수요 저녁」 — 오늘(수) 20:30–21:30 부터 매주 수요일 4회,
//      K-Dance Studio A홀(막히면 B홀·다른 시각), 남 8 · 여 8. 강사 앱 홈에 「오늘 수업 인원」이 보이게 한다
//   ② 시연 회원 6명 카드 결제 완료(주문 → 가짜 PG 입금 dev 경로 → 웹훅) — 나연·모모·지효(여) · 박지호·김서준(남) · 사나(여)
//      이미 있는 개발 DB 시연 회원을 그대로 쓴다(남성 회원도 이미 있어 새로 만들지 않는다)
//   ③ 사나가 오늘 회차에 「결석 예정」을 알린다(PUT /api/me/sessions/{id}/absence) — 강사 명단 맨 위에 결석 예정이 보인다
//   (승인 대기 수업은 만들지 않는다 — 녹화 중에 아이유가 앱에서 직접 등록·제출한 수업을 대표가 승인한다)
//   ⑤ 새 시연 강사 「도하람」(지어낸 이름)이 K-Dance Studio 에 소속 신청(POST /api/instructor/affiliations) — 대표가 웹에서 승인
//
// 레벨 정하기: 아이유는 .env 의 FAKE_INSTRUCTOR_NON_MEMBER_IDS(멤버십 아님 목록)에 없다 → 서버가 멤버십 강사로 본다.
//   그래서 따로 맞출 것이 없다(결제 완료 수강생만 있으면 회원 관리 탭에서 「레벨 올리기」가 열린다).
//
// 두 번 돌려도 같은 결과: 수업·결제·신청이 이미 있으면 그 단계는 건너뛴다.
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-emulator-prep.ts   (개발 서버 :3000, KDANCE_DEV_ROUTES=true)
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { createDb } from "../prisma/db";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = process.env["DEMO_API_BASE"] ?? "http://localhost:3000";
const TODAY_CLASS = "스탠다드 왈츠 · 수요 저녁";
const NEW_INSTRUCTOR = { name: "도하람", authUserId: "demo-emu-doharam", phone: "010-****-4127" };
const MEMBERS = [
  { email: "demo-nayeon@example.com", seat: "female" },
  { email: "demo-momo@example.com", seat: "female" },
  { email: "demo-jihyo@example.com", seat: "female" },
  { email: "demo-absent-jiho@example.com", seat: "male" },
  { email: "demo-absent-seojun@example.com", seat: "male" },
  { email: "demo-sana@example.com", seat: "female" },
] as const;
const ABSENT_EMAIL = "demo-sana@example.com";

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);
// 이 스크립트가 만든 세션 — 끝나면 지운다(만든 것만 정리)
const tokens: string[] = [];
async function sessionFor(userId: string): Promise<string> {
  const token = (await ctx.internalAdapter.createSession(userId)).token;
  tokens.push(token);
  return token;
}

type Call = { status: number; body: Record<string, unknown> };
/** 개발 서버의 진짜 경로를 부른다. 기대한 상태 코드가 아니면 응답을 그대로 담아 던진다 */
async function call(method: string, path: string, opts: { token?: string; body?: unknown; expect: number[] }): Promise<Call> {
  const headers: Record<string, string> = { "Idempotency-Key": randomUUID() };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  if (!opts.expect.includes(res.status)) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (health?.ok !== true) throw new Error(`개발 서버(${BASE})가 떠 있지 않다`);

// ---- 대표·강사·학원·홀 -----------------------------------------------------------------------------------------
const [owner] = await q<{ user_id: string; academy_id: string }>(
  `SELECT u.id AS user_id, o.academy_id::text AS academy_id FROM auth."user" u JOIN staff_accounts s ON s.auth_user_id = u.id
     JOIN academy_owners o ON o.staff_account_id = s.id WHERE u.username = 'brad'`,
);
const [teacher] = await q<{ user_id: string; account_id: string }>(
  `SELECT u.id AS user_id, s.id::text AS account_id FROM auth."user" u JOIN staff_accounts s ON s.auth_user_id = u.id WHERE u.username = 'iuu'`,
);
if (owner === undefined || teacher === undefined) throw new Error("brad 또는 iuu 계정이 없다");
const rooms = await q<{ id: string; name: string }>(
  `SELECT r.id::text AS id, r.name FROM rooms r JOIN academy_branches b ON b.id = r.branch_id
    WHERE b.academy_id = $1 AND r.status = 'active' ORDER BY r.name`,
  [owner.academy_id],
);
const ownerToken = await sessionFor(owner.user_id);
const teacherToken = await sessionFor(teacher.user_id);

/** KST 오늘 날짜(YYYY-MM-DD)와 요일 */
function kstToday(): { day: string; weekday: string; plusDays: (n: number) => string } {
  const now = new Date(Date.now() + 9 * 3_600_000);
  const day = now.toISOString().slice(0, 10);
  const weekday = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][now.getUTCDay()]!;
  const plusDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString().slice(0, 10);
  return { day, weekday, plusDays };
}

/** 아이유가 수업을 만들어 제출한다. 홀·시각이 막히면 다음 조합으로. 돌려주는 값은 classId */
async function submitAsTeacher(title: string, body: Record<string, unknown>, slots: { start: string; end: string }[]): Promise<string> {
  for (const slot of slots) {
    for (const room of rooms) {
      const schedule = { ...(body["schedule"] as Record<string, unknown>), startTime: slot.start, endTime: slot.end };
      const created = await call("POST", "/api/classes", {
        token: teacherToken,
        body: { ...body, title, roomId: room.id, schedule, academyId: owner!.academy_id, instructorAccountId: teacher!.account_id },
        expect: [201, 409, 422],
      });
      if (created.status !== 201) {
        console.log(`  만들기 ${room.name} ${slot.start} → ${created.status} ${JSON.stringify(created.body["code"] ?? created.body)}`);
        continue;
      }
      const classId = String(created.body["classId"]);
      const submitted = await call("POST", `/api/classes/${classId}/submit`, { token: teacherToken, body: {}, expect: [200, 409] });
      if (submitted.status === 200) {
        console.log(`  제출: 「${title}」 · ${room.name} · ${slot.start}–${slot.end} (${classId})`);
        return classId;
      }
      console.log(`  제출 ${room.name} ${slot.start} → 409 ${JSON.stringify(submitted.body["code"])}`);
      // 제출이 막힌 임시 저장본은 지운다(이 스크립트가 방금 만든 것)
      await pool.query("DELETE FROM classes WHERE id = $1 AND status = 'draft'", [classId]);
    }
  }
  throw new Error(`「${title}」 — 홀·시각이 모두 막힘`);
}

const common = {
  classKind: "regular",
  targetAges: ["all"],
  capacity: { mode: "gender_split", male: 8, female: 8, any: null },
  refundDeadlineOn: null,
};

// ---- ① 오늘 저녁 수업(아이유 제출 → 브레드 승인) ---------------------------------------------------------------------
const today = kstToday();
let [todayClass] = await q<{ id: string; status: string }>(
  "SELECT id::text AS id, status FROM classes WHERE title = $1 AND instructor_account_id = $2 ORDER BY created_at DESC LIMIT 1",
  [TODAY_CLASS, teacher.account_id],
);
if (todayClass === undefined) {
  const id = await submitAsTeacher(
    TODAY_CLASS,
    {
      ...common,
      subGenre: "standard",
      discipline: "waltz",
      targetLevel: "entry",
      priceAmount: 200000,
      schedule: { kind: "recurring", weekdays: [today.weekday], periodFrom: today.day, periodTo: today.plusDays(21) },
      introText: "왈츠 박스 스텝과 라이즈 앤 폴을 수요일 저녁마다 익혀요.",
    },
    [
      { start: "20:30", end: "21:30" },
      { start: "21:00", end: "22:00" },
      { start: "20:00", end: "21:00" },
    ],
  );
  todayClass = { id, status: "pending_approval" };
}
if (todayClass.status !== "published") {
  const [now] = await q<{ status: string }>("SELECT status FROM classes WHERE id = $1", [todayClass.id]);
  if (now?.status !== "published") {
    await call("POST", `/api/academies/${owner.academy_id}/classes/${todayClass.id}/approve`, { token: ownerToken, body: {}, expect: [200] });
  }
  console.log(`① 승인: 「${TODAY_CLASS}」`);
} else console.log(`① 이미 공개: 「${TODAY_CLASS}」`);
const [offering] = await q<{ id: string }>("SELECT id::text AS id FROM class_offerings WHERE class_id = $1", [todayClass.id]);
const offeringId = offering!.id;
const [firstSession] = await q<{ id: string; starts_at: Date }>(
  "SELECT id::text AS id, starts_at FROM class_sessions WHERE offering_id = $1 ORDER BY starts_at LIMIT 1",
  [offeringId],
);

// ---- ② 시연 회원 6명 결제 완료 ---------------------------------------------------------------------------------
for (const m of MEMBERS) {
  const [found] = await q<{ user_id: string; member_id: string; name: string; paid: number }>(
    `SELECT u.id AS user_id, mb.id::text AS member_id, mb.name,
            (SELECT count(*)::int FROM orders o WHERE o.member_id = mb.id AND o.offering_id = $2 AND o.status = 'paid') AS paid
       FROM auth."user" u JOIN members mb ON mb.auth_user_id = u.id WHERE u.email = $1`,
    [m.email, offeringId],
  );
  if (found === undefined) throw new Error(`시연 회원이 없다: ${m.email}`);
  if (found.paid > 0) {
    console.log(`② 이미 결제: ${found.name}`);
    continue;
  }
  const token = await sessionFor(found.user_id);
  const order = (
    await call("POST", "/api/orders", { token, body: { offeringId, seatKind: m.seat, method: "card", noticesAcknowledged: true }, expect: [201] })
  ).body as { orderId: string; payment: { amount: number } };
  const [payment] = await q<{ id: string }>("SELECT gateway_payment_id AS id FROM payments WHERE order_id = $1", [order.orderId]);
  await call("POST", `/api/dev/fake-pg/payments/${encodeURIComponent(payment!.id)}/deposit`, { body: { amount: order.payment.amount }, expect: [200] });
  console.log(`② 결제 완료: ${found.name}(${m.seat === "male" ? "남" : "여"}) · ${order.payment.amount}원`);
}

// ---- ③ 사나 — 오늘 회차 결석 예정 -------------------------------------------------------------------------------
if (firstSession !== undefined && firstSession.starts_at.getTime() > Date.now()) {
  const [sana] = await q<{ user_id: string }>(`SELECT id AS user_id FROM auth."user" WHERE email = $1`, [ABSENT_EMAIL]);
  const planned = await call("PUT", `/api/me/sessions/${firstSession.id}/absence`, { token: await sessionFor(sana!.user_id), expect: [200, 201, 409] });
  console.log(`③ 결석 예정(사나) → ${planned.status}`);
}

// ---- ⑤ 새 시연 강사 소속 신청 --------------------------------------------------------------------------------------
let [newbie] = await q<{ user_id: string; account_id: string }>(
  "SELECT s.auth_user_id AS user_id, s.id::text AS account_id FROM staff_accounts s JOIN auth.\"user\" u ON u.id = s.auth_user_id WHERE u.username = $1",
  ["demo_doharam"],
);
if (newbie === undefined) {
  // 강사 가입 경로는 본인확인을 요구해 앞 시연들처럼 계정 행만 직접 만든다(로그인 비밀번호는 두지 않는다 — 신청만 한다)
  const user = await ctx.internalAdapter.createUser(
    { email: "demo-doharam@example.com", name: NEW_INSTRUCTOR.name, emailVerified: true, username: "demo_doharam", displayUsername: "demo_doharam" },
    { method: "admin" },
  );
  const [row] = await q<{ id: string }>(
    `INSERT INTO staff_accounts (id, auth_user_id, display_name, phone_masked, status, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'active', now()) RETURNING id::text AS id`,
    [user.id, NEW_INSTRUCTOR.name, NEW_INSTRUCTOR.phone],
  );
  await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'instructor')", [row!.id]);
  await q(
    "INSERT INTO instructor_profiles (staff_account_id, activity_genre, career_years, signup_completed_at, updated_at) VALUES ($1, 'dance_sport', 4, now(), now())",
    [row!.id],
  );
  newbie = { user_id: user.id, account_id: row!.id };
  console.log(`⑤ 시연 강사 계정: ${NEW_INSTRUCTOR.name}`);
}
const [open] = await q<{ status: string }>(
  "SELECT status FROM instructor_affiliations WHERE instructor_account_id = $1 AND academy_id = $2 AND status IN ('pending','active')",
  [newbie.account_id, owner.academy_id],
);
if (open === undefined) {
  await call("POST", "/api/instructor/affiliations", {
    token: await sessionFor(newbie.user_id),
    body: { academyId: owner.academy_id, message: "댄스스포츠 라틴 4년 차예요. 주말 오후 수업 가능해요." },
    expect: [201],
  });
  console.log(`⑤ 소속 신청: ${NEW_INSTRUCTOR.name} → K-Dance Studio`);
} else console.log(`⑤ 이미 ${open.status}: ${NEW_INSTRUCTOR.name}`);

await pool.query("DELETE FROM auth.session WHERE token = ANY($1)", [tokens]);
console.log(`끝 — 오늘 회차 ${firstSession?.starts_at.toISOString()} · 판매 단위 ${offeringId}`);
await db.close();
await pool.end();
