// 개발 DB 전용 — 환불 계좌 저장(S4-1.2a(환불 계좌 저장 API(본인 명의 확인)))이 빈 표가 아니라 실제 서버 데이터로 보이게 하는 시연 데이터.
// 뒤에 올 회원 환불 계좌 입력 화면(C9A)·대표 계좌 환불 송금 화면(W31·O48C)이 이 계좌(가린 값)를 읽는다.
//
// 무엇을 넣나:
//   ① 시연 회원 1명 — demo-refund-account@example.com / demo-refund-1234 — 「한예린」(여)
//      앞 시연 회원들은 모두 카드로 결제해 계좌 환불 대상이 없다. 그들의 주문 수를 바꾸면 그 스크립트의 「이미 있음」 판정이 깨지므로 새로 만든다
//   ② 한예린의 주문 1건 — 앞 시연(dev-demo-member-my-class.ts)이 게시한 정규 수업 「바차타(초급)」(300,000원), 여 자리 · 간편 계좌이체.
//      진짜 주문 경로(POST /api/orders) → 가짜 PG 입금 dev 경로 → 웹훅 확정 = 결제완료
//   ③ 그 주문의 환불 계좌 — 진짜 경로 POST /api/refund-accounts, KB국민은행 · 예금주 한예린(본인확인 이름과 같음).
//      계좌번호는 실제로 없는 시험 번호다. 응답에는 가린 값만 온다
//   수업·주문·결제·계좌 행은 SQL 로 넣지 않는다. SQL 로 쓰는 것은 회원 행(가입 경로가 본인확인을 요구해 앞 시연들과 같은 방식)뿐이다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-refund-accounts.ts
//   두 번 돌려도 같은 결과 — 한예린의 주문에 쓰는(active) 환불 계좌가 이미 있으면 아무것도 하지 않는다.
//   먼저 scripts/dev-demo-member-my-class.ts(바차타(초급) 게시)가 있어야 하고, 개발 서버(:3000, KDANCE_DEV_ROUTES=true)가 떠 있어야 한다.
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { createDb } from "../prisma/db";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = process.env["DEMO_API_BASE"] ?? "http://localhost:3000";
const MEMBER = { email: "demo-refund-account@example.com", password: "demo-refund-1234", username: "demo_refund_account", name: "한예린", nickname: "예린", gender: "female", birth: "1997-03-14", phone: "01000000021" } as const;
const CLASS_TITLE = "바차타(초급)";
// 시연용 시험 번호(실제 계좌 아님). 하이픈은 서버가 걷어 낸다
const ACCOUNT = { bankCode: "004", accountNumber: "123456-78-907890" } as const;

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

// ---- 두 번째 실행: 쓰는 환불 계좌가 이미 있으면 건너뛴다 ---------------------------------------------------------------
const [already] = await q<{ masked: string }>(
  `SELECT ra.account_masked AS masked FROM auth."user" u JOIN members m ON m.auth_user_id = u.id
     JOIN refund_accounts ra ON ra.member_id = m.id AND ra.status = 'active' WHERE u.email = $1 LIMIT 1`,
  [MEMBER.email],
);
if (already !== undefined) {
  console.log(`건너뜀: ${MEMBER.email} 의 환불 계좌(${already.masked})가 이미 있다`);
  await finish(0);
}

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (health?.ok !== true) throw new Error(`개발 서버(${BASE})가 떠 있지 않다 — KDANCE_DEV_ROUTES=true npm run dev -- --port 3000`);

type Call = { status: number; body: Record<string, unknown> };
/** 개발 서버의 진짜 경로를 부른다. 기대한 상태 코드가 아니면 응답을 그대로 담아 던진다 */
async function call(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; expect: number[] }): Promise<Call> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  const response = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await response.text();
  if (!opts.expect.includes(response.status)) throw new Error(`${method} ${path} → ${response.status} ${text}`);
  return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

// ---- 시연 회원 — 앞 시연들과 같은 방식(가입을 마친 회원 행). 이미 있으면(앞 실행이 중간에 끊김) 그 회원을 쓴다 -------------
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

// ---- 결제완료 주문(간편 계좌이체). 앞 실행이 입금까지 끝냈으면 그 주문을 쓴다 ------------------------------------------
async function ensurePaidOrder(): Promise<string> {
  const [paid] = await q<{ id: string }>(
    `SELECT o.id::text AS id FROM orders o JOIN payments p ON p.order_id = o.id AND p.status = 'paid' AND p.method = 'easy_transfer'
      WHERE o.member_id = $1 AND o.status = 'paid' ORDER BY o.created_at DESC LIMIT 1`,
    [member.memberId],
  );
  if (paid !== undefined) return paid.id;
  const [offering] = await q<{ id: string }>(
    `SELECT off.id::text AS id FROM class_offerings off JOIN classes c ON c.id = off.class_id
      WHERE c.title = $1 AND c.status = 'published' ORDER BY off.created_at DESC LIMIT 1`,
    [CLASS_TITLE],
  );
  if (offering === undefined) throw new Error(`게시된 ${CLASS_TITLE} 가 없다 — dev-demo-member-my-class.ts 를 먼저 돌린다`);
  const order = (
    await call("POST", "/api/orders", {
      token: member.token,
      headers: { "Idempotency-Key": randomUUID() },
      body: { offeringId: offering.id, seatKind: "female", method: "easy_transfer", noticesAcknowledged: true },
      expect: [201],
    })
  ).body as { orderId: string; payment: { amount: number } };
  const [payment] = await q<{ id: string }>("SELECT gateway_payment_id AS id FROM payments WHERE order_id = $1", [order.orderId]);
  if (payment === undefined) throw new Error(`결제 행이 없다: ${order.orderId}`);
  await call("POST", `/api/dev/fake-pg/payments/${encodeURIComponent(payment.id)}/deposit`, { body: { amount: order.payment.amount }, expect: [200] });
  const [state] = await q<{ status: string }>("SELECT status FROM orders WHERE id = $1", [order.orderId]);
  console.log(`주문: ${CLASS_TITLE} · ${MEMBER.name} · 간편 계좌이체 ${order.payment.amount}원 = ${state?.status}`);
  if (state?.status !== "paid") throw new Error(`주문이 결제완료가 아니다: ${state?.status}`);
  return order.orderId;
}
const orderId = await ensurePaidOrder();

// ---- 진짜 경로로 환불 계좌 저장 — 예금주는 본인확인 이름 그대로 ------------------------------------------------------------
const saved = await call("POST", "/api/refund-accounts", {
  token: member.token,
  body: { orderId, bankCode: ACCOUNT.bankCode, accountNumber: ACCOUNT.accountNumber, holderName: MEMBER.name },
  expect: [201],
});
console.log(`환불 계좌: ${MEMBER.name} · ${String(saved.body["accountMasked"])} · 본인 명의 ${String(saved.body["holderMatchesIdentity"])} · ${String(saved.body["refundAccountId"])}`);
await finish(0);
