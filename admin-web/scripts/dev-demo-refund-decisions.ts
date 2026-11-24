// 개발 DB 전용 — 대표 환불 입력(S4-1.4(대표 환불 입력))이 빈 칸이 아니라 실제 서버 데이터로 보이게 하는 시연 데이터.
// 뒤에 올 대표 환불 화면(O48·W27 「처리 끝」 탭)과 회원 환불 상태·근거 화면(C15A)이 이 결정을 읽는다.
//
// 무엇을 하나(모두 떠 있는 개발 서버(:3000)의 진짜 경로로 — 요청·결정 행을 SQL 로 넣지 않는다):
//   ① 앞 시연(dev-demo-refund-accounts.ts)의 회원 「한예린」(demo-refund-account@example.com)이 간편 계좌이체로 결제한
//      정규 수업 「바차타(초급)」 300,000원에 환불 요청을 낸다 — 사유 personal 「단순 변심이에요」, 이미 넣은 환불 계좌로.
//   ② brad 대표가 그 요청의 상세(GET …/refund-requests/{id})를 읽고, 근거 공지 항목 「환불이 안 되는 경우 · 수강 시작 뒤 단순 변심」을
//      골라 거절한다(POST …/decision, 대표 한마디 포함).
//   ③ 윤서아의 처리 전 요청(dev-demo-refund-requests.ts)은 **결정하지 않는다** — 대표 목록(W27)의 처리 전 칸에 남겨 둔다.
//      상세만 읽어 미리 채움·근거 항목·환불 상한을 로그로 보여 준다(읽기는 상태를 바꾸지 않는다).
//
// 왜 승인이 아니라 거절인가: 승인 뒤의 환불 실행(카드 부분 취소·계좌 송금 대기)은 S4-1.5 가 붙인다. 지금 승인하면
//   「승인했지만 실행 행이 없는」 요청이 개발 DB 에 남아 뒤 Task 의 화면과 어긋난다. 거절은 그 자리에서 끝나는 상태다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-refund-decisions.ts   (개발 서버 :3000)
//   두 번 돌려도 같은 결과 — 한예린의 그 주문에 거절된 요청이 이미 있으면 결정은 건너뛴다(상세 읽기만 다시 한다).
//   먼저 dev-demo-refund-requests.ts · dev-demo-refund-accounts.ts 가 있어야 한다.
import "dotenv/config";

import { createDb } from "../prisma/db";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = process.env["DEMO_API_BASE"] ?? "http://localhost:3000";
const YERIN_EMAIL = "demo-refund-account@example.com";
const SEOA_EMAIL = "demo-myclass@example.com";
const CLASS_TITLE = "바차타(초급)";
const REASON_TEXT = "단순 변심이에요";
const OWNER_MESSAGE = "수강 시작 뒤 단순 변심은 학원 공지의 「환불이 안 되는 경우」라 이번에는 환불이 어려워요";
// 같은 주문에는 늘 같은 열쇠 — 중간에 끊겨 다시 돌려도 요청·결정이 둘로 늘지 않는다
const requestKey = (orderId: string) => `demo-refund-decision-request-${orderId}`;
const decisionKey = (requestId: string) => `demo-refund-decision-${requestId}`;

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

// ---- 읽기만: brad 대표 · 한예린 주문 · 윤서아 요청 ------------------------------------------------------------------
const [owner] = await q<{ user_id: string; academy_id: string }>(
  `SELECT u.id AS user_id, o.academy_id::text AS academy_id
     FROM auth."user" u JOIN staff_accounts s ON s.auth_user_id = u.id JOIN academy_owners o ON o.staff_account_id = s.id
    WHERE u.username = 'brad' LIMIT 1`,
);
if (owner === undefined) throw new Error("brad 대표가 없다 — dev-demo-owner.ts 를 먼저 돌린다");

const [yerin] = await q<{ user_id: string; order_id: string; reservation_id: string; account_id: string | null; rejected: number; open_id: string | null }>(
  `SELECT u.id AS user_id, o.id::text AS order_id, r.id::text AS reservation_id,
          (SELECT ra.id::text FROM refund_accounts ra WHERE ra.order_id = o.id AND ra.status = 'active' LIMIT 1) AS account_id,
          (SELECT count(*)::int FROM refund_requests rr WHERE rr.order_id = o.id AND rr.status = 'rejected') AS rejected,
          (SELECT rr.id::text FROM refund_requests rr WHERE rr.order_id = o.id AND rr.status IN ('received', 'in_progress') LIMIT 1) AS open_id
     FROM auth."user" u
     JOIN members m ON m.auth_user_id = u.id
     JOIN orders o ON o.member_id = m.id AND o.status = 'paid'
     JOIN reservations r ON r.order_id = o.id AND r.status = 'confirmed'
     JOIN class_offerings off ON off.id = o.offering_id
     JOIN classes c ON c.id = off.class_id AND c.title = $2
    WHERE u.email = $1
    ORDER BY o.created_at DESC LIMIT 1`,
  [YERIN_EMAIL, CLASS_TITLE],
);
if (yerin === undefined) throw new Error(`${YERIN_EMAIL} 의 결제완료 ${CLASS_TITLE} 주문이 없다 — dev-demo-refund-accounts.ts 를 먼저 돌린다`);

const [seoa] = await q<{ request_id: string }>(
  `SELECT rr.id::text AS request_id FROM refund_requests rr JOIN members m ON m.id = rr.member_id JOIN auth."user" u ON u.id = m.auth_user_id
    WHERE u.email = $1 AND rr.status IN ('received', 'in_progress') ORDER BY rr.created_at DESC LIMIT 1`,
  [SEOA_EMAIL],
);

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (health?.ok !== true) throw new Error(`개발 서버(${BASE})가 떠 있지 않다 — npm run dev -- --port 3000`);

const ownerToken = (await ctx.internalAdapter.createSession(owner.user_id)).token;
const detailPath = (requestId: string) => `/api/academies/${owner.academy_id}/refund-requests/${requestId}`;

/** 상세의 핵심만 한 줄로(대표 화면 O48 이 보여 줄 숫자) */
function summarize(who: string, d: Json): void {
  const items = (d["noticeItems"] as { code: string; label: string }[]).map((i) => i.code).join(", ");
  const assist = d["assist"] as { suggestedAmount: number; appliedPoint: string } | null;
  const decision = d["decision"] as { kind: string; noticeItemCode: string } | null;
  console.log(
    `상세(${who}): ${String(d["status"])} · 결제 ${String(d["paidAmount"])}원(${String(d["paymentMethod"])}) · 환불 상한 ${String(d["refundableAmount"])}원 · ` +
      `미리 채움 ${assist === null ? "없음(옛 공지 판본)" : `${assist.suggestedAmount}원(${assist.appliedPoint})`} · 근거 항목 [${items}] · ` +
      `계좌 ${String((d["refundAccount"] as Json)["accountMasked"])} · 결정 ${decision === null ? "없음" : `${decision.kind}(${decision.noticeItemCode})`}`,
  );
}

// ---- ③ 윤서아 요청은 상세만 읽는다(결정하지 않음) ------------------------------------------------------------------
if (seoa !== undefined) summarize("윤서아", await call("GET", detailPath(seoa.request_id), { token: ownerToken, expect: [200] }));
else console.log("참고: 윤서아의 처리 전 환불 요청이 없다 — dev-demo-refund-requests.ts 를 돌리면 대표 목록의 처리 전 칸이 채워진다");

// ---- 이미 거절까지 끝났으면 건너뛴다 --------------------------------------------------------------------------------
if (yerin.rejected > 0 && yerin.open_id === null) {
  const [done] = await q<{ id: string }>("SELECT id::text FROM refund_requests WHERE order_id = $1 AND status = 'rejected' LIMIT 1", [yerin.order_id]);
  summarize("한예린", await call("GET", detailPath(done!.id), { token: ownerToken, expect: [200] }));
  console.log(`건너뜀: 한예린의 ${CLASS_TITLE} 주문에 거절된 환불 요청이 이미 있다`);
  await finish(0);
}

// ---- ① 한예린의 환불 요청(처리 전 요청이 남아 있으면 그것을 쓴다 — 앞 실행이 결정 전에 끊긴 경우) --------------------
let requestId = yerin.open_id;
if (requestId === null) {
  if (yerin.account_id === null) throw new Error("한예린 주문에 쓰는 환불 계좌가 없다 — dev-demo-refund-accounts.ts 를 먼저 돌린다");
  const memberToken = (await ctx.internalAdapter.createSession(yerin.user_id)).token;
  const created = await call("POST", "/api/refund-requests", {
    token: memberToken,
    key: requestKey(yerin.order_id),
    body: { reservationId: yerin.reservation_id, reasonKind: "personal", reasonText: REASON_TEXT, desiredText: "전액 환불", refundAccountId: yerin.account_id },
    expect: [200, 201],
  });
  requestId = String(created["requestId"]);
  console.log(`환불 요청: ${CLASS_TITLE} · 한예린 · ${String(created["status"])} · 답할 기한 ${String(created["answerDueAt"])}`);
}

// ---- ② 대표가 상세를 읽고 근거 항목을 골라 거절 ----------------------------------------------------------------------
const detail = await call("GET", detailPath(requestId), { token: ownerToken, expect: [200] });
summarize("한예린 · 결정 전", detail);
const noRefundCase = (detail["noticeItems"] as { code: string }[]).find((i) => i.code === "no_refund_case");
if (noRefundCase === undefined) throw new Error("근거 항목에 「환불이 안 되는 경우」가 없다 — 공지 판본을 확인한다");

const decided = await call("POST", `${detailPath(requestId)}/decision`, {
  token: ownerToken,
  key: decisionKey(requestId),
  body: { decision: "reject", noticeItemCode: noRefundCase.code, memberMessage: OWNER_MESSAGE },
  expect: [200],
});
console.log(`대표 결정: 한예린 · ${String(decided["decisionKind"])} · 상태 ${String(decided["status"])} · 근거 ${String(decided["noticeItemCode"])}`);
summarize("한예린 · 결정 뒤", await call("GET", detailPath(requestId), { token: ownerToken, expect: [200] }));
await finish(0);
