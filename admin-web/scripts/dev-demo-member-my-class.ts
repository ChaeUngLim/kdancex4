// 개발 DB 전용 — 앱 「신청한 수업 상세(보드 M8C)」의 한 달 달력(‹ ›)을 가짜 응답이 아니라 실제 서버 데이터로 보이게 하는
// 시연 데이터(S3-4.8(앱 신청한 수업 상세 화면 · 한 달 달력)).
//
// 왜 따로 만드나: 앞 시연(dev-demo-member-activity.ts)의 결제완료 수업 「바차타 센슈얼 입문」은 12월 한 달(5회)뿐이라
//   「첫 달 ‹ 막힘 → › 로 다음 달 → 마지막 달 › 막힘」을 보일 수 없다. 보드 M8C 처럼 월·수 20:30 8주 16회짜리
//   정규 과정이 석 달에 걸쳐 있어야 한다. 앞 시연 회원의 주문 수(4건)를 바꾸면 그 스크립트의 「이미 있음」 판정이 깨지므로
//   회원도 새로 만든다.
//
// 무엇을 넣나:
//   ① 시연 회원 1명 — demo-myclass@example.com / demo-myclass-1234 — 「윤서아」(여)
//   ② brad 대표 학원(브래드 댄스 스튜디오)의 정규 수업 「바차타(초급)」 — 월·수 20:30–21:30, 다음 월요일부터 8주 16회,
//      300,000원, 남 6 · 여 6. 진짜 등록 경로(POST /api/classes → submit → 대표 approve)로 만든다
//   ③ 윤서아의 주문 1건 — 진짜 주문 경로(POST /api/orders, 여 자리 · 카드) → 가짜 PG 입금 dev 경로 → 웹훅 확정 = 결제완료.
//      그래서 내 캘린더(GET /api/me/calendar)에 이 수업 회차가 들어가고, 캘린더 → 수업명 → M8C 로 들어갈 수 있다
//   수업·주문·결제 행은 SQL 로 넣지 않는다. SQL 로 쓰는 것은 회원 행(가입 경로가 본인확인을 요구해 앞 시연들과 같은 방식)뿐이다.
//
// 왜 HTTP 로 부르나: 가짜 PG 원장은 개발 서버 프로세스의 메모리에 있다. 주문과 입금을 같은 원장에서 해야
//   웹훅 처리기가 금액을 대조할 수 있어, 떠 있는 개발 서버(:3000, KDANCE_DEV_ROUTES=true)를 부른다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-member-my-class.ts
//   두 번 돌려도 같은 결과 — 윤서아가 이미 결제완료 주문을 가지고 있으면 아무것도 하지 않는다.
//   먼저 scripts/dev-demo-owner.ts(brad) · dev-demo-console-data.ts(소속 강사)가 있어야 한다.
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { createDb } from "../prisma/db";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = process.env["DEMO_API_BASE"] ?? "http://localhost:3000";
const MEMBER = { email: "demo-myclass@example.com", password: "demo-myclass-1234", username: "demo_myclass", name: "윤서아", nickname: "서아", gender: "female", birth: "1996-11-02", phone: "01000000013" } as const;
const CLASS_TITLE = "바차타(초급)";
const PRICE = 300_000;
const WEEKS = 8;

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

// ---- 두 번째 실행: 결제완료 주문이 이미 있으면 건너뛴다 ------------------------------------------------------------
const [already] = await q<{ paid: number }>(
  `SELECT count(o.id) FILTER (WHERE o.status = 'paid')::int AS paid FROM auth."user" u JOIN members m ON m.auth_user_id = u.id
     LEFT JOIN orders o ON o.member_id = m.id WHERE u.email = $1 GROUP BY m.id`,
  [MEMBER.email],
);
if (already !== undefined && already.paid > 0) {
  console.log(`건너뜀: ${MEMBER.email} 에 결제완료 주문 ${already.paid}건이 이미 있다`);
  await finish(0);
}

// ---- 개발 서버 확인 — dev 경로가 꺼져 있으면 결제 확정을 할 수 없다 -----------------------------------------------
const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (health?.ok !== true) throw new Error(`개발 서버(${BASE})가 떠 있지 않다 — KDANCE_DEV_ROUTES=true npm run dev -- --port 3000`);

type Call = { status: number; body: Record<string, unknown> };
/** 개발 서버의 진짜 경로를 부른다. 기대한 상태 코드가 아니면 응답을 그대로 담아 던진다 */
async function call(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; expect: number[] }): Promise<Call> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await response.text();
  if (!opts.expect.includes(response.status)) throw new Error(`${method} ${path} → ${response.status} ${text}`);
  return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

// ---- brad 대표 · 학원 · 홀 · 살사/바차타 소속 강사 ---------------------------------------------------------------------
const [owner] = await q<{ user_id: string; academy_id: string }>(
  `SELECT u.id AS user_id, o.academy_id FROM auth."user" u
     JOIN staff_accounts s ON s.auth_user_id = u.id JOIN academy_owners o ON o.staff_account_id = s.id
   WHERE u.username = 'brad'`,
);
if (owner === undefined) throw new Error("brad 대표가 없다 — scripts/dev-demo-owner.ts 를 먼저 돌린다");
const ownerToken = (await ctx.internalAdapter.createSession(owner.user_id)).token;

/**
 * 「다음 월요일」(KST) — 오늘이 월요일이어도 다음 주 월요일.
 * 8주 16회가 오늘 기준 석 달에 걸치게 해서 첫 달·다음 달·마지막 달이 서로 다르게 한다.
 */
function nextMondayKst(): { from: string; to: string } {
  const kstNow = new Date(Date.now() + 9 * 3_600_000);
  const toMonday = (8 - kstNow.getUTCDay()) % 7 || 7;
  const monday = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate() + toMonday));
  // 8주째 수요일까지 = 월요일 + 7×7 + 2일
  const lastWednesday = new Date(monday.getTime() + ((WEEKS - 1) * 7 + 2) * 86_400_000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return { from: day(monday), to: day(lastWednesday) };
}

/**
 * 이미 게시된 「바차타(초급)」이 있으면 그대로 쓴다(두 번째 실행이 회원 단계에서 끊겼을 때).
 * 없으면 진짜 등록 경로로 만든다 — 강사·홀 일정이 겹치면 서버가 거절하므로 다음 강사·홀 조합으로 다시 시도한다.
 */
async function ensureClass(): Promise<{ classId: string; offeringId: string }> {
  const [existing] = await q<{ class_id: string; offering_id: string }>(
    `SELECT c.id::text AS class_id, o.id::text AS offering_id FROM classes c JOIN class_offerings o ON o.class_id = c.id
      WHERE c.academy_id = $1 AND c.title = $2 AND c.status = 'published' ORDER BY c.created_at DESC LIMIT 1`,
    [owner!.academy_id, CLASS_TITLE],
  );
  if (existing !== undefined) return { classId: existing.class_id, offeringId: existing.offering_id };

  const rooms = await q<{ id: string }>(
    "SELECT r.id FROM rooms r JOIN academy_branches b ON b.id = r.branch_id WHERE b.academy_id = $1 AND r.status = 'active' ORDER BY r.name",
    [owner!.academy_id],
  );
  const instructors = await q<{ id: string; name: string }>(
    `SELECT s.id, s.display_name AS name FROM instructor_affiliations a JOIN staff_accounts s ON s.id = a.instructor_account_id
       JOIN instructor_profiles p ON p.staff_account_id = s.id
      WHERE a.academy_id = $1 AND a.status = 'active' AND p.activity_genre = 'salsa_bachata' ORDER BY s.display_name, s.id`,
    [owner!.academy_id],
  );
  if (rooms.length === 0 || instructors.length === 0) throw new Error("brad 학원에 홀 또는 살사/바차타 강사가 없다 — dev-demo-console-data.ts 를 먼저 돌린다");
  const period = nextMondayKst();
  const failures: string[] = [];
  for (const instructor of instructors) {
    for (const room of rooms) {
      try {
        const created = await call("POST", "/api/classes", {
          token: ownerToken,
          headers: { "Idempotency-Key": randomUUID() },
          body: {
            academyId: owner!.academy_id,
            classKind: "regular",
            title: CLASS_TITLE,
            subGenre: "bachata",
            discipline: null,
            targetLevel: "beginner",
            targetAges: ["all"],
            roomId: room.id,
            priceAmount: PRICE,
            schedule: { kind: "recurring", weekdays: ["mon", "wed"], startTime: "20:30", endTime: "21:30", periodFrom: period.from, periodTo: period.to },
            capacity: { mode: "gender_split", male: 6, female: 6, any: null },
            refundDeadlineOn: null,
            introText: "바차타 기본 스텝부터 턴까지 8주 동안 차근차근 익혀요.",
            instructorAccountId: instructor.id,
          },
          expect: [201],
        });
        const classId = String(created.body["classId"]);
        await call("POST", `/api/classes/${classId}/submit`, { token: ownerToken, body: {}, expect: [200] });
        // 대표가 직접 올린 수업은 제출과 동시에 게시될 수 있다 — 그때는 승인을 건너뛴다
        const [state] = await q<{ status: string }>("SELECT status FROM classes WHERE id = $1", [classId]);
        if (state?.status !== "published") {
          await call("POST", `/api/academies/${owner!.academy_id}/classes/${classId}/approve`, { token: ownerToken, body: {}, expect: [200] });
        }
        const [offering] = await q<{ id: string }>("SELECT id::text AS id FROM class_offerings WHERE class_id = $1", [classId]);
        console.log(`게시: ${CLASS_TITLE} · 강사 ${instructor.name} · ${period.from}~${period.to} 월·수 20:30 · 판매 단위 ${offering!.id}`);
        return { classId, offeringId: offering!.id };
      } catch (error) {
        // 등록 단계에서 막힌 경우(일정 겹침 등)만 다음 조합으로 넘어간다
        const message = error instanceof Error ? error.message : String(error);
        if (!message.startsWith("POST /api/classes →")) throw error;
        failures.push(`${instructor.name}: ${message.slice(0, 160)}`);
      }
    }
  }
  throw new Error(`수업을 등록하지 못했다:\n  ${failures.join("\n  ")}`);
}

const { offeringId } = await ensureClass();

// ---- 시연 회원 — 앞 시연들과 같은 방식(가입을 마친 회원 행). 이미 있으면(앞 실행이 주문 전에 끊김) 그 회원을 쓴다 -------------
async function ensureMember(): Promise<{ memberId: string; token: string }> {
  const [found] = await q<{ user_id: string; member_id: string }>(
    `SELECT u.id AS user_id, m.id::text AS member_id FROM auth."user" u JOIN members m ON m.auth_user_id = u.id WHERE u.email = $1`,
    [MEMBER.email],
  );
  if (found !== undefined) return { memberId: found.member_id, token: (await ctx.internalAdapter.createSession(found.user_id)).token };
  const user = await ctx.internalAdapter.createUser(
    { email: MEMBER.email, name: MEMBER.name, emailVerified: true, username: MEMBER.username, displayUsername: MEMBER.username },
    { method: "admin" },
  );
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(MEMBER.password) });
  const memberId = randomUUID();
  await q(
    `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at,
                          base_genre, available_from, available_to, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), 'salsa_bachata', '18:00'::time, '23:00'::time, now())`,
    [memberId, user.id, MEMBER.name, MEMBER.gender, MEMBER.birth, MEMBER.phone, `demo-ci-${randomUUID()}`, MEMBER.nickname],
  );
  await q("INSERT INTO member_interest_genres (member_id, genre) VALUES ($1, 'salsa_bachata')", [memberId]);
  await q("INSERT INTO member_regions (member_id, region_sido, region_gu) VALUES ($1, '서울', '강남구')", [memberId]);
  console.log(`회원: ${MEMBER.email}(${MEMBER.name})`);
  return { memberId, token: (await ctx.internalAdapter.createSession(user.id)).token };
}
const member = await ensureMember();

// ---- 주문 → 가짜 PG 입금 → 웹훅 확정(결제완료) ---------------------------------------------------------------------
const order = (
  await call("POST", "/api/orders", {
    token: member.token,
    headers: { "Idempotency-Key": randomUUID() },
    body: { offeringId, seatKind: "female", method: "card", noticesAcknowledged: true },
    expect: [201],
  })
).body as { orderId: string; payment: { amount: number } };
// PG 쪽 결제 번호는 dev 입금 경로 주소에 들어간다(읽기만)
const [payment] = await q<{ id: string }>("SELECT gateway_payment_id AS id FROM payments WHERE order_id = $1", [order.orderId]);
if (payment === undefined) throw new Error(`결제 행이 없다: ${order.orderId}`);
await call("POST", `/api/dev/fake-pg/payments/${encodeURIComponent(payment.id)}/deposit`, { body: { amount: order.payment.amount }, expect: [200] });

// ---- 확인: 주문 상태 · 수업 상세의 회차 · 내 캘린더 -----------------------------------------------------------------
const [status] = await q<{ status: string }>("SELECT status FROM orders WHERE id = $1", [order.orderId]);
const detail = await call("GET", `/api/offerings/${offeringId}`, { token: member.token, expect: [200] });
const sessions = (detail.body["sessions"] ?? []) as { startsAt: string }[];
const calendar = await call("GET", "/api/me/calendar", { token: member.token, expect: [200] });
const mine = ((calendar.body["items"] ?? []) as { offeringId: string }[]).filter((e) => e.offeringId === offeringId);
console.log(`주문: ${CLASS_TITLE} = ${status?.status} · ${order.payment.amount}원`);
console.log(`회차: ${sessions.length}개 · ${sessions[0]?.startsAt} ~ ${sessions.at(-1)?.startsAt} · 내 캘린더(기본 범위) ${mine.length}개`);
await finish(status?.status === "paid" ? 0 : 1);
