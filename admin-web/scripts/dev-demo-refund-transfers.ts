// 개발 DB 전용 — 계좌 환불 송금 완료(S4-1.5a(계좌 환불 송금 완료·반송 처리 API))가 실제 서버 데이터로 보이게 하는 시연 데이터.
// 뒤에 올 대표 계좌 환불 송금 화면(W31·O48C 「송금 완료」 칸)과 회원 환불 결과 화면(C15C)·알림함(M21)이 이 「대표가 보낸 환불」을 읽는다.
//
// 무엇을 하나(모두 떠 있는 개발 서버(:3000)의 진짜 경로로 — 요청·환불 행을 SQL 로 넣지 않는다):
//   ① 회원 「한예린」(demo-refund-account@example.com, dev-demo-refund-accounts.ts 가 만든 간편 계좌이체 결제 주문)이
//      정규 수업 「바차타(초급)」에 다시 환불 요청을 낸다 — 사유 schedule_change 「이사를 가게 돼서 더 다닐 수 없어요」.
//      앞의 거절된 요청(dev-demo-refund-decisions.ts)은 그대로 둔다 — 거절 뒤 새 요청은 규칙상 받는다(처리 전 요청만 1건 제한).
//   ② brad 대표가 상세를 읽고 미리 채운 금액 그대로 승인한다(POST …/decision). 계좌 결제분이라 PG 를 부르지 않고
//      환불이 owner_bank_transfer pending(송금 대기)이 된다(S4-1.5).
//   ③ brad 대표가 은행에서 보냈다고 치고, 받는 사람 이름을 대조했다는 체크와 함께 「송금 완료」를 누른다(POST …/complete).
//      환불 succeeded · 요청 completed · 회원 알림 「환불금을 보냈어요」 1건.
//   「다시 입력 요청」(이름 다름·반송)은 회원이 새 계좌를 넣는 경로(§2-1 account)가 아직 없어 시연하지 않는다 — DB 테스트가 맡는다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-refund-transfers.ts   (개발 서버 :3000)
//   두 번 돌려도 같은 결과 — 한예린의 그 주문에 송금 완료된 계좌 환불이 이미 있으면 건너뛴다. 중간에 끊겼으면(승인만 됨) 남은 단계만 한다.
//   먼저 dev-demo-refund-accounts.ts · dev-demo-refund-decisions.ts 가 있어야 한다.
import "dotenv/config";

import { createDb } from "../prisma/db";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = process.env["DEMO_API_BASE"] ?? "http://localhost:3000";
const MEMBER_EMAIL = "demo-refund-account@example.com";
const CLASS_TITLE = "바차타(초급)";
const REASON_TEXT = "이사를 가게 돼서 더 다닐 수 없어요";
const OWNER_MESSAGE = "이사 잘 하세요. 학원 공지대로 넣어 주신 계좌로 보내 드릴게요";
// 같은 주문·같은 요청에는 늘 같은 열쇠 — 중간에 끊겨 다시 돌려도 요청·결정이 둘로 늘지 않는다
const requestKey = (orderId: string) => `demo-refund-transfer-request-${orderId}`;
const decisionKey = (requestId: string) => `demo-refund-transfer-decision-${requestId}`;

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

/** 한예린 주문의 계좌 환불 행과 회원 알림을 한 줄씩(대표·회원 화면이 보여 줄 숫자). 계좌번호는 찍지 않는다 */
async function report(orderId: string): Promise<void> {
  const rows = await q<Json>(
    `SELECT rr.status AS request_status, rf.status, rf.execution_kind, rf.requested_amount, rf.refunded_amount, rf.attempt_no,
            rf.transfer_completed_at IS NOT NULL AS completed, o.refunded_total_amount
       FROM refunds rf JOIN refund_requests rr ON rr.id = rf.refund_request_id JOIN orders o ON o.id = rf.order_id
      WHERE rf.order_id = $1 AND rf.execution_kind = 'owner_bank_transfer' ORDER BY rf.created_at`,
    [orderId],
  );
  for (const r of rows) {
    console.log(
      `계좌 환불(한예린): 요청 ${String(r["request_status"])} · 시도 ${String(r["attempt_no"])} · ${String(r["status"])} · ` +
        `${String(r["refunded_amount"])}/${String(r["requested_amount"])}원 · 송금 완료 기록 ${r["completed"] === true ? "있음" : "없음"} · 주문 환불 합계 ${String(r["refunded_total_amount"])}원`,
    );
  }
  const sent = await q<{ kind: string; title: string }>(
    `SELECT n.kind, n.payload->>'title' AS title FROM notifications n JOIN orders o ON o.member_id = n.recipient_member_id
      WHERE o.id = $1 AND n.kind IN ('refund_completed', 'refund_account_reinput') ORDER BY n.created_at`,
    [orderId],
  );
  for (const n of sent) console.log(`회원 알림: ${n.kind} 「${n.title}」`);
}

// ---- 읽기만: brad 대표 · 한예린 주문과 그 주문의 계좌 환불 --------------------------------------------------------------
const [owner] = await q<{ user_id: string; academy_id: string }>(
  `SELECT u.id AS user_id, o.academy_id::text AS academy_id
     FROM auth."user" u JOIN staff_accounts s ON s.auth_user_id = u.id JOIN academy_owners o ON o.staff_account_id = s.id
    WHERE u.username = 'brad' LIMIT 1`,
);
if (owner === undefined) throw new Error("brad 대표가 없다 — dev-demo-owner.ts 를 먼저 돌린다");

const [yerin] = await q<{ user_id: string; order_id: string; reservation_id: string; account_id: string | null; open_id: string | null; done_refund: string | null; pending_refund: string | null }>(
  `SELECT u.id AS user_id, o.id::text AS order_id, r.id::text AS reservation_id,
          (SELECT ra.id::text FROM refund_accounts ra WHERE ra.order_id = o.id AND ra.status = 'active' LIMIT 1) AS account_id,
          (SELECT rr.id::text FROM refund_requests rr WHERE rr.order_id = o.id AND rr.status IN ('received', 'in_progress') LIMIT 1) AS open_id,
          (SELECT rf.id::text FROM refunds rf WHERE rf.order_id = o.id AND rf.execution_kind = 'owner_bank_transfer' AND rf.status = 'succeeded' LIMIT 1) AS done_refund,
          (SELECT rf.id::text FROM refunds rf WHERE rf.order_id = o.id AND rf.execution_kind = 'owner_bank_transfer' AND rf.status = 'pending' LIMIT 1) AS pending_refund
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
if (yerin === undefined) throw new Error(`${MEMBER_EMAIL} 의 결제완료 ${CLASS_TITLE} 주문이 없다 — dev-demo-refund-accounts.ts 를 먼저 돌린다`);

if (yerin.done_refund !== null) {
  await report(yerin.order_id);
  console.log(`건너뜀: 한예린의 ${CLASS_TITLE} 주문에 송금 완료된 계좌 환불이 이미 있다`);
  await finish(0);
}

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (health?.ok !== true) throw new Error(`개발 서버(${BASE})가 떠 있지 않다 — npm run dev -- --port 3000`);

const ownerToken = (await ctx.internalAdapter.createSession(owner.user_id)).token;
const detailPath = (requestId: string) => `/api/academies/${owner.academy_id}/refund-requests/${requestId}`;

let refundId = yerin.pending_refund;
if (refundId === null) {
  // ---- ① 한예린의 새 환불 요청(처리 전 요청이 남아 있으면 그것을 쓴다 — 앞 실행이 결정 전에 끊긴 경우) ------------------
  let requestId = yerin.open_id;
  if (requestId === null) {
    // 계좌 결제분 요청은 이 주문의 쓰는(active) 환불 계좌를 함께 보낸다(dev-demo-refund-accounts.ts 가 저장한 것)
    if (yerin.account_id === null) throw new Error("한예린의 환불 계좌가 없다 — dev-demo-refund-accounts.ts 를 먼저 돌린다");
    const memberToken = (await ctx.internalAdapter.createSession(yerin.user_id)).token;
    const created = await call("POST", "/api/refund-requests", {
      token: memberToken,
      key: requestKey(yerin.order_id),
      body: { reservationId: yerin.reservation_id, reasonKind: "schedule_change", reasonText: REASON_TEXT, desiredText: "남은 회차 환불", refundAccountId: yerin.account_id },
      expect: [200, 201],
    });
    requestId = String(created["requestId"]);
    console.log(`환불 요청: ${CLASS_TITLE} · 한예린 · ${String(created["status"])} · 답할 기한 ${String(created["answerDueAt"])}`);
  }

  // ---- ② 대표가 미리 채운 금액 그대로 승인 → 계좌분은 송금 대기 --------------------------------------------------------
  const detail = await call("GET", detailPath(requestId), { token: ownerToken, expect: [200] });
  const assist = detail["assist"] as { suggestedAmount: number; appliedPoint: string } | null;
  if (assist === null) throw new Error("미리 채움값이 없다 — 공지 판본의 시점별 % 를 확인한다");
  const decided = await call("POST", `${detailPath(requestId)}/decision`, {
    token: ownerToken,
    key: decisionKey(requestId),
    body: { decision: "approve", amount: assist.suggestedAmount, noticeItemCode: `tier:${assist.appliedPoint}`, memberMessage: OWNER_MESSAGE },
    expect: [200],
  });
  const refund = decided["refund"] as Json | null;
  if (refund === null) throw new Error("승인했는데 환불 행이 없다(0원 승인?) — 공지의 시점별 % 를 확인한다");
  refundId = String(refund["refundId"]);
  console.log(`대표 승인: 한예린 · ${assist.suggestedAmount}원(${assist.appliedPoint}) · 환불 ${String(refund["executionKind"])} ${String(refund["status"])}`);
}

// ---- ③ 대표가 은행에서 보낸 뒤 「송금 완료」(이름 대조 체크) ------------------------------------------------------------
const completed = await call("POST", `/api/academies/${owner.academy_id}/refund-transfers/${refundId}/complete`, {
  token: ownerToken,
  body: { nameChecked: true },
  expect: [200],
});
console.log(`송금 완료: ${String(completed["status"])} · ${String(completed["completedAt"])}`);
await report(yerin.order_id);
await finish(0);
