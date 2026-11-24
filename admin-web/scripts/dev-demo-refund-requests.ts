// 개발 DB 전용 — 정규 과정 환불 요청(S4-1.2(환불 요청 생성·철회))이 빈 목록이 아니라 실제 서버 데이터로 보이게 하는 시연 데이터.
// 뒤에 올 대표 환불 목록(W27·O22)·회원 환불 상태 화면(C15A·C15B)이 이 요청을 읽는다.
//
// 무엇을 넣나:
//   앞 시연(dev-demo-member-my-class.ts)의 회원 「윤서아」(demo-myclass@example.com)가 결제완료한 정규 수업 「바차타(초급)」에
//   환불 요청 1건 — 사유 「일정이 바뀌어 더 다닐 수 없어요」 · 바라는 것 「남은 회차 환불」(계약 12 §2-1 예시 문구).
//   진짜 경로 POST /api/refund-requests 를 떠 있는 개발 서버(:3000)로 부른다. 요청 행을 SQL 로 넣지 않는다.
//   카드 결제 주문이라 환불 계좌는 넣지 않는다(카드는 원거래 취소).
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-refund-requests.ts
//   두 번 돌려도 같은 결과 — 윤서아의 그 예약에 환불 요청이 이미 있으면 아무것도 하지 않는다(같은 열쇠 재생도 200 이다).
//   먼저 scripts/dev-demo-member-my-class.ts 가 있어야 한다.
import "dotenv/config";

import { createDb } from "../prisma/db";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = process.env["DEMO_API_BASE"] ?? "http://localhost:3000";
const MEMBER_EMAIL = "demo-myclass@example.com";
const CLASS_TITLE = "바차타(초급)";
// 같은 예약에는 늘 같은 열쇠를 쓴다 — 중간에 끊겨 다시 돌려도 요청이 둘로 늘지 않는다
const keyFor = (reservationId: string) => `demo-refund-${reservationId}`;

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

// ---- 윤서아의 결제완료 「바차타(초급)」 예약(읽기만) ---------------------------------------------------------------
const [target] = await q<{ user_id: string; reservation_id: string; existing: number }>(
  `SELECT u.id AS user_id, r.id::text AS reservation_id,
          (SELECT count(*)::int FROM refund_requests rr WHERE rr.reservation_id = r.id) AS existing
     FROM auth."user" u
     JOIN members m ON m.auth_user_id = u.id
     JOIN reservations r ON r.member_id = m.id AND r.status = 'confirmed'
     JOIN orders o ON o.id = r.order_id AND o.status = 'paid'
     JOIN class_offerings off ON off.id = r.offering_id
     JOIN classes c ON c.id = off.class_id AND c.title = $2
    WHERE u.email = $1
    ORDER BY r.created_at DESC LIMIT 1`,
  [MEMBER_EMAIL, CLASS_TITLE],
);
if (target === undefined) throw new Error(`${MEMBER_EMAIL} 의 결제완료 ${CLASS_TITLE} 예약이 없다 — dev-demo-member-my-class.ts 를 먼저 돌린다`);
if (target.existing > 0) {
  console.log(`건너뜀: ${CLASS_TITLE} 예약(${target.reservation_id})에 환불 요청 ${target.existing}건이 이미 있다`);
  await finish(0);
}

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (health?.ok !== true) throw new Error(`개발 서버(${BASE})가 떠 있지 않다 — npm run dev -- --port 3000`);

// ---- 진짜 경로로 환불 요청 ------------------------------------------------------------------------------------------
const token = (await ctx.internalAdapter.createSession(target.user_id)).token;
const response = await fetch(`${BASE}/api/refund-requests`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": keyFor(target.reservation_id) },
  body: JSON.stringify({
    reservationId: target.reservation_id,
    reasonKind: "schedule_change",
    reasonText: "일정이 바뀌어 더 다닐 수 없어요",
    desiredText: "남은 회차 환불",
  }),
});
const text = await response.text();
if (response.status !== 201 && response.status !== 200) {
  console.error(`POST /api/refund-requests → ${response.status} ${text}`);
  await finish(1);
}
const outcome = JSON.parse(text) as { requestId: string; status: string; answerDueAt: string };
console.log(`환불 요청: ${CLASS_TITLE} · 윤서아 · ${outcome.status} · 답할 기한 ${outcome.answerDueAt} · ${outcome.requestId}`);
await finish(0);
