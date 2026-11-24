// 개발 DB 전용 — 회차 명단(S3-5.2(명단 API), 보드 W6 · W23 · I23)이 「결석 예정이 맨 위」까지 실제처럼 보이게 하는 시연 데이터.
//
// 이미 있는 것(앞 시연 스크립트들 — 특히 dev-demo-owner-orders.ts): brad 학원 「살사 온원 기초」에 결제 완료 여 2명(김서연 포함) +
// 입금 대기 남 1명. 명단 API 의 수용 ③(결제 완료 2명은 이름, 대기 1명은 숫자만) 장면이 이미 들어 있다.
// 이 스크립트가 더하는 것 — 김서연이 다가오는 첫 회차에 「결석 예정」을 알린다. 진짜 회원 경로
// (PUT /api/me/sessions/{sessionId}/absence, S3-4.3(결석 예정 토글 API))를 부른다 — attendance_marks 행을 SQL 로 넣지 않는다.
//
// 더하는 것 둘째(S3-5.4(현장 등록 인원)) — brad 대표가 같은 회차에 현장에서 받은 인원 남 1 · 여 2 를 넣는다(계약 18 §6 의 예시 값).
//   진짜 경로(PUT /api/classes/{classId}/sessions/{sessionId}/onsite-headcount)를 대표 앱처럼 Bearer 로 부른다 —
//   session_seat_counters · audit_logs 행을 SQL 로 넣지 않는다. 그래서 명단의 onsite 와 「변경 기록」(감사 1건)이 실제로 생긴다.
//
// 더하는 것 셋째(S3-5.7(관리자 웹 주문·명단 화면 W6)) — 결제 완료 회원 3명(박민지 · 최도윤 · 정해준)과 박민지의 결석 예정. 아래 ③.
//
// 실행: cd admin-web && KDANCE_DEV_ROUTES=true 로 띄운 개발 서버(:3000) 상태에서 ./node_modules/.bin/jiti scripts/dev-demo-roster.ts
//   두 번 돌려도 같은 결과 — 그 회차에 김서연의 살아 있는 결석 행이 이미 있으면 결석은 건너뛰고,
//   그 회차의 현장 인원 변경 기록이 이미 있으면 현장 인원도 건너뛴다.
//   먼저 dev-demo-owner-orders.ts 가 있어야 한다(김서연 demo-order-seoyeon@example.com 의 결제 완료 주문).
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { createDb } from "../prisma/db";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = process.env["DEMO_API_BASE"] ?? "http://localhost:3000";
const SEOYEON_EMAIL = "demo-order-seoyeon@example.com";
const CLASS_TITLE = "살사 온원 기초";

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

// 김서연의 확정 예약과, 그 판매 단위에서 지금 뒤로 가장 가까운 예정 회차
const [target] = await q<{ user_id: string; member_id: string; session_id: string; starts_at: string; class_id: string }>(
  `SELECT u.id AS user_id, m.id::text AS member_id, s.id::text AS session_id, s.starts_at::text AS starts_at, c.id::text AS class_id
     FROM auth."user" u
     JOIN members m ON m.auth_user_id = u.id
     JOIN reservations r ON r.member_id = m.id AND r.status = 'confirmed'
     JOIN class_offerings co ON co.id = r.offering_id
     JOIN classes c ON c.id = co.class_id
     JOIN class_sessions s ON s.offering_id = co.id AND s.status = 'scheduled' AND s.starts_at > now()
    WHERE u.email = $1 AND c.title = $2
    ORDER BY s.starts_at LIMIT 1`,
  [SEOYEON_EMAIL, CLASS_TITLE],
);
if (target === undefined) {
  console.error(`멈춤: 김서연의 「${CLASS_TITLE}」 확정 예약이나 다가오는 회차가 없다 — dev-demo-owner-orders.ts 를 먼저 돌린다`);
  await finish(1);
}

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (health?.ok !== true) throw new Error(`개발 서버(${BASE})가 떠 있지 않다 — KDANCE_DEV_ROUTES=true npm run dev -- --port 3000`);

// ① 결석 예정 — 회원 앱처럼 Bearer 로 진짜 경로를 부른다(토큰은 찍지 않는다)
const [live] = await q<{ id: string }>(
  "SELECT id::text AS id FROM attendance_marks WHERE member_id = $1 AND session_id = $2 AND cancelled_at IS NULL",
  [target!.member_id, target!.session_id],
);
if (live !== undefined) {
  console.log(`건너뜀: 김서연은 「${CLASS_TITLE}」 ${target!.starts_at} 회차에 이미 결석 예정이다`);
} else {
  const token = (await ctx.internalAdapter.createSession(target!.user_id)).token;
  const response = await fetch(`${BASE}/api/me/sessions/${target!.session_id}/absence`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  if (response.status !== 200 && response.status !== 201) {
    console.error(`PUT 결석 예정 → ${response.status} ${text}`);
    await finish(1);
  }
  console.log(`결석 예정: 김서연 · ${CLASS_TITLE} · ${target!.starts_at} 회차 → ${response.status}`);
}

// ② 현장 등록 인원 — brad 대표가 같은 회차에 남 1 · 여 2 를 넣는다(대표 앱 O40 처럼 Bearer)
const ONSITE = { male: 1, female: 2 } as const;
const [changedBefore] = await q<{ n: number }>(
  "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'session.onsite_headcount_changed' AND target_id = $1",
  [target!.session_id],
);
const onsiteDone = (changedBefore?.n ?? 0) > 0;
if (onsiteDone) {
  console.log(`건너뜀: 「${CLASS_TITLE}」 ${target!.starts_at} 회차에 현장 인원 변경 기록이 이미 ${changedBefore!.n}건 있다`);
}
const [brad] = await q<{ user_id: string }>(
  `SELECT u.id AS user_id FROM auth."user" u
     JOIN staff_accounts s ON s.auth_user_id = u.id
     JOIN academy_owners o ON o.staff_account_id = s.id
     JOIN classes c ON c.academy_id = o.academy_id AND c.id = $1
    WHERE u.username = 'brad'`,
  [target!.class_id],
);
if (brad === undefined) {
  console.error(`멈춤: 「${CLASS_TITLE}」 학원의 대표 brad 를 찾지 못했다`);
  await finish(1);
}
const ownerToken = (await ctx.internalAdapter.createSession(brad!.user_id)).token;
if (!onsiteDone) {
  const onsiteResponse = await fetch(`${BASE}/api/classes/${target!.class_id}/sessions/${target!.session_id}/onsite-headcount`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify(ONSITE),
  });
  const onsiteText = await onsiteResponse.text();
  if (onsiteResponse.status !== 200) {
    console.error(`PUT 현장 등록 인원 → ${onsiteResponse.status} ${onsiteText.slice(0, 300)}`);
    await finish(1);
  }
  const seats = (JSON.parse(onsiteText) as { seats: { seatKind: string; onsite: number; remaining: number }[] }).seats;
  console.log(
    `현장 등록 인원: brad 대표 · ${CLASS_TITLE} · ${target!.starts_at} 회차 → ${onsiteResponse.status} · ` +
      seats.map((x) => `${x.seatKind} 현장 ${x.onsite}·남은 자리 ${x.remaining}`).join(" / "),
  );
}

// ③ S3-5.7(관리자 웹 주문·명단 화면 W6) — 명단 표가 보드처럼 여러 줄로 보이게 결제 완료 회원 3명을 더한다.
//   이름·관심 장르는 보드 W6 예시(박민지 「살사」 · 최도윤 「살사 · 탱고」 · 정해준 「스윙 · 살사」)를 따랐다. 한지우는 넣지 않는다 —
//   여 자리가 현장 인원 2를 빼면 1자리만 남아서다(넣으면 409 SEAT_SOLD_OUT).
//   진짜 경로만 쓴다: 주문(POST /api/orders) → 가짜 PG 입금(dev 경로) → 웹훅 확정. 박민지는 그 회차에 결석 예정을 알린다
//   (보드의 「결석 예정」 배지 줄). 이미 그 수업 확정 예약이 있는 회원은 건너뛴다(두 번 돌려도 같은 결과).
const MORE_MEMBERS = [
  { email: "demo-roster-minji@example.com", username: "demo_roster_minji", name: "박민지", gender: "female", birth: "1996-04-18", phone: "01000008811", genres: ["salsa_bachata"], absent: true },
  { email: "demo-roster-doyoon@example.com", username: "demo_roster_doyoon", name: "최도윤", gender: "male", birth: "1993-09-02", phone: "01000008822", genres: ["salsa_bachata", "argentine_tango"], absent: false },
  { email: "demo-roster-haejun@example.com", username: "demo_roster_haejun", name: "정해준", gender: "male", birth: "1989-12-21", phone: "01000008833", genres: ["swing", "salsa_bachata"], absent: false },
] as const;
const PASSWORD = "demo-roster-1234";

/** 개발 서버의 진짜 경로 — 기대한 상태 코드가 아니면 응답을 보여 주고 멈춘다 */
async function call(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; expect: number[] }) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await response.text();
  if (!opts.expect.includes(response.status)) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`);
  return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

const [offering] = await q<{ id: string }>("SELECT offering_id::text AS id FROM class_sessions WHERE id = $1", [target!.session_id]);
for (const m of MORE_MEMBERS) {
  const [paid] = await q<{ id: string }>(
    `SELECT r.id FROM reservations r JOIN members mb ON mb.id = r.member_id JOIN auth."user" u ON u.id = mb.auth_user_id
      WHERE u.email = $1 AND r.offering_id = $2 AND r.status = 'confirmed'`,
    [m.email, offering!.id],
  );
  if (paid !== undefined) {
    console.log(`건너뜀: ${m.name} — 「${CLASS_TITLE}」 결제를 이미 마쳤다`);
    continue;
  }
  // 가입을 마친 회원 행(앞 시연 스크립트들과 같은 방식 — 회원 가입 경로는 본인확인(유료 예외)이 필요해 시연에서는 행을 만든다)
  let [found] = await q<{ user_id: string }>(`SELECT u.id AS user_id FROM auth."user" u JOIN members mb ON mb.auth_user_id = u.id WHERE u.email = $1`, [m.email]);
  if (found === undefined) {
    const user = await ctx.internalAdapter.createUser(
      { email: m.email, name: m.name, emailVerified: true, username: m.username, displayUsername: m.username },
      { method: "admin" },
    );
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(PASSWORD) });
    const memberId = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at,
                            base_genre, available_from, available_to, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $3, now(), 'salsa_bachata', '18:00'::time, '23:00'::time, now())`,
      [memberId, user.id, m.name, m.gender, m.birth, m.phone, `demo-ci-${randomUUID()}`],
    );
    for (const genre of m.genres) await q("INSERT INTO member_interest_genres (member_id, genre) VALUES ($1, $2)", [memberId, genre]);
    await q("INSERT INTO member_regions (member_id, region_sido, region_gu) VALUES ($1, '서울', '강남구')", [memberId]);
    found = { user_id: user.id };
  }
  const token = (await ctx.internalAdapter.createSession(found.user_id)).token;
  const order = (
    await call("POST", "/api/orders", {
      token,
      headers: { "Idempotency-Key": randomUUID() },
      body: { offeringId: offering!.id, seatKind: m.gender, method: "card", noticesAcknowledged: true },
      expect: [201],
    })
  ).body as { orderId: string; payment: { amount: number } };
  const [payment] = await q<{ id: string }>("SELECT gateway_payment_id AS id FROM payments WHERE order_id = $1", [order.orderId]);
  await call("POST", `/api/dev/fake-pg/payments/${encodeURIComponent(payment!.id)}/deposit`, { body: { amount: order.payment.amount }, expect: [200] });
  console.log(`결제 완료: ${m.name}(${m.gender === "male" ? "남" : "여"}) · ${CLASS_TITLE} · 카드`);
  if (m.absent) {
    const absence = await call("PUT", `/api/me/sessions/${target!.session_id}/absence`, { token, expect: [200, 201] });
    console.log(`결석 예정: ${m.name} · ${CLASS_TITLE} · ${target!.starts_at} 회차 → ${absence.status}`);
  }
}
await finish(0);
