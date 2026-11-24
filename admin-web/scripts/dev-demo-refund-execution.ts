// 개발 DB 전용 — 수단별 환불 실행(S4-1.5(수단별 환불 실행))이 실제 서버 데이터로 보이게 하는 시연 데이터.
// 뒤에 올 대표 환불 화면(W27·O48 「처리 끝」)·회원 환불 결과 화면(C15C)·내역(M16)이 이 「카드 부분 취소로 끝난 환불」을 읽는다.
//
// 무엇을 하나(모두 떠 있는 개발 서버(:3000)의 진짜 경로로 — 요청·환불 행을 SQL 로 넣지 않는다):
//   ① 회원 「박민준」(demo-order-minjun@example.com, dev-demo-owner-orders.ts 가 만든 카드 결제 주문)이 정규 수업 「바차타(초급)」
//      300,000원에 환불 요청을 낸다 — 사유 schedule_change 「회사 일정이 바뀌어 저녁 수업에 못 가요」.
//   ② brad 대표가 상세를 읽고 미리 채운 금액 그대로 승인한다(POST …/decision). 카드 결제분이라 서버가 가짜 PG 에
//      부분 취소를 부르고 환불이 succeeded, 요청이 completed 가 된다.
//   윤서아의 처리 전 요청(dev-demo-refund-requests.ts)과 한예린의 거절(dev-demo-refund-decisions.ts)은 건드리지 않는다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-refund-execution.ts   (개발 서버 :3000)
//   두 번 돌려도 같은 결과 — 박민준의 그 주문에 끝난(completed) 요청이 이미 있으면 건너뛴다. 승인까지 갔는데 환불이 pending 으로
//   남았으면(PG 응답을 못 받은 경우) 같은 승인을 다시 보내 같은 키로 수렴시킨다.
//   먼저 dev-demo-owner-orders.ts 가 있어야 한다.
import "dotenv/config";

import { createDb } from "../prisma/db";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = process.env["DEMO_API_BASE"] ?? "http://localhost:3000";
const MEMBER_EMAIL = "demo-order-minjun@example.com";
const CLASS_TITLE = "바차타(초급)";
const REASON_TEXT = "회사 일정이 바뀌어 저녁 수업에 못 가요";
const OWNER_MESSAGE = "일정이 바뀌셨군요. 학원 공지대로 환불해 드렸어요 — 다음 기간에 또 만나요";
// 같은 주문·같은 요청에는 늘 같은 열쇠 — 중간에 끊겨 다시 돌려도 요청·결정이 둘로 늘지 않는다
const requestKey = (orderId: string) => `demo-refund-execution-request-${orderId}`;
const decisionKey = (requestId: string) => `demo-refund-execution-decision-${requestId}`;

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

type Json = Record<string, unknown>;
/** 개발 서버의 진짜 경로를 부른다. 기대한 상태 코드가 아니면 응답을 보여 주고 멈춘다(토큰은 찍지 않는다) */
async function call(method: string, path: string, opts: { token: string; body?: unknown; key?: string; expect: number[] }): Promise<Json> {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token}` };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.key !== undefined) headers["Idempotency-Key"] = opts.key;
  const response = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await response.text();
  if (!opts.expect.includes(response.status)) {
    console.error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`);
    await finish(1);
  }
  return text === "" ? {} : (JSON.parse(text) as Json);
}

/** 환불 행·주문 합계를 한 줄로(대표·회원 화면이 보여 줄 숫자) */
async function report(requestId: string): Promise<void> {
  const rows = await q<Json>(
    `SELECT rr.status AS request_status, rf.status, rf.execution_kind, rf.requested_amount, rf.refunded_amount, rf.attempt_no,
            o.refunded_total_amount, o.status AS order_status
       FROM refund_requests rr JOIN orders o ON o.id = rr.order_id
       LEFT JOIN refunds rf ON rf.basis_kind = 'request' AND rf.basis_id = rr.id
      WHERE rr.id = $1 ORDER BY rf.attempt_no`,
    [requestId],
  );
  for (const r of rows) {
    console.log(
      `환불(박민준): 요청 ${String(r["request_status"])} · 실행 ${String(r["execution_kind"])} 시도 ${String(r["attempt_no"])} · ${String(r["status"])} · ` +
        `${String(r["refunded_amount"])}/${String(r["requested_amount"])}원 · 주문 환불 합계 ${String(r["refunded_total_amount"])}원 · 주문 ${String(r["order_status"])}`,
    );
  }
}

// ---- 읽기만: brad 대표 · 박민준 주문 ----------------------------------------------------------------------------------
const [owner] = await q<{ user_id: string; academy_id: string }>(
  `SELECT u.id AS user_id, o.academy_id::text AS academy_id
     FROM auth."user" u JOIN staff_accounts s ON s.auth_user_id = u.id JOIN academy_owners o ON o.staff_account_id = s.id
    WHERE u.username = 'brad' LIMIT 1`,
);
if (owner === undefined) throw new Error("brad 대표가 없다 — dev-demo-owner.ts 를 먼저 돌린다");

const [minjun] = await q<{ user_id: string; order_id: string; reservation_id: string; done_id: string | null; open_id: string | null }>(
  `SELECT u.id AS user_id, o.id::text AS order_id, r.id::text AS reservation_id,
          (SELECT rr.id::text FROM refund_requests rr WHERE rr.order_id = o.id AND rr.status = 'completed' LIMIT 1) AS done_id,
          (SELECT rr.id::text FROM refund_requests rr WHERE rr.order_id = o.id AND rr.status IN ('received', 'in_progress') LIMIT 1) AS open_id
     FROM auth."user" u
     JOIN members m ON m.auth_user_id = u.id
     JOIN orders o ON o.member_id = m.id AND o.status IN ('paid', 'partially_refunded')
     JOIN reservations r ON r.order_id = o.id
     JOIN class_offerings off ON off.id = o.offering_id
     JOIN classes c ON c.id = off.class_id AND c.title = $2
    WHERE u.email = $1
    ORDER BY o.created_at DESC LIMIT 1`,
  [MEMBER_EMAIL, CLASS_TITLE],
);
if (minjun === undefined) throw new Error(`${MEMBER_EMAIL} 의 결제완료 ${CLASS_TITLE} 주문이 없다 — dev-demo-owner-orders.ts 를 먼저 돌린다`);

if (minjun.done_id !== null) {
  await report(minjun.done_id);
  console.log(`건너뜀: 박민준의 ${CLASS_TITLE} 주문에 끝난 환불 요청이 이미 있다`);
  await finish(0);
}

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (health?.ok !== true) throw new Error(`개발 서버(${BASE})가 떠 있지 않다 — npm run dev -- --port 3000`);

const ownerToken = (await ctx.internalAdapter.createSession(owner.user_id)).token;
const detailPath = (requestId: string) => `/api/academies/${owner.academy_id}/refund-requests/${requestId}`;

// ---- ① 박민준의 환불 요청(처리 전 요청이 남아 있으면 그것을 쓴다 — 앞 실행이 결정 전에 끊긴 경우) --------------------
let requestId = minjun.open_id;
if (requestId === null) {
  const memberToken = (await ctx.internalAdapter.createSession(minjun.user_id)).token;
  const created = await call("POST", "/api/refund-requests", {
    token: memberToken,
    key: requestKey(minjun.order_id),
    body: { reservationId: minjun.reservation_id, reasonKind: "schedule_change", reasonText: REASON_TEXT, desiredText: "남은 회차 환불" },
    expect: [200, 201],
  });
  requestId = String(created["requestId"]);
  console.log(`환불 요청: ${CLASS_TITLE} · 박민준 · ${String(created["status"])} · 답할 기한 ${String(created["answerDueAt"])}`);
}

// ---- ② 대표가 미리 채운 금액 그대로 승인 → 카드 부분 취소 ----------------------------------------------------------------
const detail = await call("GET", detailPath(requestId), { token: ownerToken, expect: [200] });
const assist = detail["assist"] as { suggestedAmount: number; appliedPoint: string } | null;
if (assist === null) throw new Error("미리 채움값이 없다 — 공지 판본의 시점별 % 를 확인한다");
// 이미 승인됐으면(재생) 그때 정한 금액을 그대로 보낸다 — 같은 결정이라 200 재생이 되고 남은 pending 을 수렴시킨다
const decision = detail["decision"] as { amount: number | null; noticeItemCode: string } | null;
const amount = decision?.amount ?? assist.suggestedAmount;
const decided = await call("POST", `${detailPath(requestId)}/decision`, {
  token: ownerToken,
  key: decisionKey(requestId),
  body: { decision: "approve", amount, noticeItemCode: decision?.noticeItemCode ?? `tier:${assist.appliedPoint}`, memberMessage: OWNER_MESSAGE },
  expect: [200],
});
const refund = decided["refund"] as Json | null;
console.log(
  `대표 승인: 박민준 · ${amount}원(${assist.appliedPoint}) · 요청 ${String(decided["status"])} · ` +
    `환불 ${refund === null ? "없음" : `${String(refund["executionKind"])} ${String(refund["status"])} ${String(refund["refundedAmount"])}원`}`,
);
await report(requestId);
await finish(0);
