// 개발 DB 전용 — 대표 주문·결제 목록(S3-5.1(대표 주문 목록 API), 보드 W10 · O45)이 빈 표가 아니라 여러 회원·여러 상태로
// 보이게 하는 시연 데이터.
//
// 이미 있는 것(앞 시연 스크립트들이 brad 학원 「브래드 댄스 스튜디오」에 넣은 주문 9건): 결제완료 · 입금 대기 · 만료 · 입금 전 취소.
// 이 스크립트가 더하는 것 — 회원 2명과 그 주문, 모두 진짜 경로(주문 → 가짜 PG 입금 dev 경로 → 웹훅 확정 · 회원 취소 경로)로:
//   - 김서연(여) · 살사 온원 기초 · 카드 → 결제완료
//   - 박민준(남) · 바차타(초급) · 카드 → 결제완료
//   「환불」 주문은 넣지 않는다 — 회원 예약 취소 경로(POST /api/reservations/{id}/cancel)가 개발 서버에서 500 을 내서
//     (2026-11-23 실측, 증거 S3-5.1 logs/demo-run-2-fail.log) 진짜 경로로 만들 수 없다. 상태를 SQL 로 바꾸지 않는다.
//   「부분 환불」은 넣지 않는다 — 주문을 partially_refunded 로 만드는 서버 경로가 아직 없다(환불 슬라이스 M4, S4-1.7b).
//
// 왜 HTTP 로 부르나: 가짜 PG 원장은 개발 서버 프로세스의 메모리에 있어, 주문과 입금을 같은 서버에서 해야 웹훅이 금액을 대조한다.
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-owner-orders.ts   (개발 서버 :3000, KDANCE_DEV_ROUTES=true)
//   두 번 돌려도 같은 결과 — 김서연·박민준이 이미 주문을 가지고 있으면 아무것도 하지 않는다.
//   먼저 dev-demo-owner.ts(brad) · dev-demo-console-data.ts · dev-demo-member-catalog.ts · dev-demo-member-my-class.ts 가 있어야 한다.
//   (바차타 센슈얼 입문은 시연용으로 정원이 다 차 있어 자리가 남은 두 수업을 쓴다)
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { createDb } from "../prisma/db";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = process.env["DEMO_API_BASE"] ?? "http://localhost:3000";
const SEOYEON = { email: "demo-order-seoyeon@example.com", password: "demo-order-1234", username: "demo_order_seoyeon", name: "김서연", nickname: "김서연", gender: "female", birth: "1998-04-21", phone: "01000005678" } as const;
const MINJUN = { email: "demo-order-minjun@example.com", password: "demo-order-1234", username: "demo_order_minjun", name: "박민준", nickname: "박민준", gender: "male", birth: "1993-10-09", phone: "01000004321" } as const;

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
const [already] = await q<{ n: number }>(
  `SELECT count(o.id)::int AS n FROM auth."user" u JOIN members m ON m.auth_user_id = u.id JOIN orders o ON o.member_id = m.id
    WHERE u.email = ANY($1::text[])`,
  [[SEOYEON.email, MINJUN.email]],
);
if ((already?.n ?? 0) >= 2) {
  console.log(`건너뜀: 시연 회원 김서연·박민준의 주문 ${already!.n}건이 이미 있다`);
  await finish(0);
}
if ((already?.n ?? 0) === 1) {
  console.error("멈춤: 주문이 1건만 있다(앞 실행이 중간에 끊김). 덮어쓰지 않는다");
  await finish(1);
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

// ---- 수업 찾기 — 앞 시연 스크립트가 만든 게시 수업 -------------------------------------------------------------
const offerings = await q<{ title: string; offering_id: string }>(
  `SELECT c.title, o.id::text AS offering_id FROM classes c JOIN class_offerings o ON o.class_id = c.id
    WHERE c.status = 'published' AND c.title = ANY($1::text[])`,
  [["살사 온원 기초", "바차타(초급)"]],
);
const offeringOf = (title: string): string => {
  const found = offerings.find((o) => o.title === title);
  if (found === undefined) throw new Error(`게시 수업 「${title}」이 없다 — dev-demo-member-catalog.ts · dev-demo-member-my-class.ts 를 먼저 돌린다`);
  return found.offering_id;
};

// ---- 시연 회원 — 앞 시연들과 같은 방식(가입을 마친 회원 행). 이미 있으면(앞 실행이 주문 전에 끊김) 그 회원을 쓴다 ----
async function createMember(m: typeof SEOYEON | typeof MINJUN): Promise<{ token: string }> {
  const [found] = await q<{ user_id: string }>(
    `SELECT u.id AS user_id FROM auth."user" u JOIN members mb ON mb.auth_user_id = u.id WHERE u.email = $1`,
    [m.email],
  );
  if (found !== undefined) return { token: (await ctx.internalAdapter.createSession(found.user_id)).token };
  const user = await ctx.internalAdapter.createUser(
    { email: m.email, name: m.name, emailVerified: true, username: m.username, displayUsername: m.username },
    { method: "admin" },
  );
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(m.password) });
  const memberId = randomUUID();
  await q(
    `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at,
                          base_genre, available_from, available_to, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), 'salsa_bachata', '18:00'::time, '23:00'::time, now())`,
    [memberId, user.id, m.name, m.gender, m.birth, m.phone, `demo-ci-${randomUUID()}`, m.nickname],
  );
  await q("INSERT INTO member_interest_genres (member_id, genre) VALUES ($1, 'salsa_bachata')", [memberId]);
  await q("INSERT INTO member_regions (member_id, region_sido, region_gu) VALUES ($1, '서울', '강남구')", [memberId]);
  return { token: (await ctx.internalAdapter.createSession(user.id)).token };
}

/** 주문 → 가짜 PG 입금 → 웹훅 확정까지(결제완료). 주문 id 를 돌려준다 */
async function payByCard(token: string, offeringId: string, seatKind: "male" | "female"): Promise<string> {
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
  return order.orderId;
}

const seoyeon = await createMember(SEOYEON);
const seoyeonOrder = await payByCard(seoyeon.token, offeringOf("살사 온원 기초"), "female");
const minjun = await createMember(MINJUN);
const minjunOrder = await payByCard(minjun.token, offeringOf("바차타(초급)"), "male");

const rows = await q<{ nickname: string; title: string; status: string; amount: number }>(
  `SELECT m.nickname, c.title, o.status, o.total_amount AS amount FROM orders o JOIN members m ON m.id = o.member_id
     JOIN class_offerings co ON co.id = o.offering_id JOIN classes c ON c.id = co.class_id WHERE o.id = ANY($1::uuid[]) ORDER BY m.nickname`,
  [[seoyeonOrder, minjunOrder]],
);
for (const row of rows) console.log(`주문: ${row.nickname} · ${row.title} · ${row.amount}원 · ${row.status}`);
await finish(0);
