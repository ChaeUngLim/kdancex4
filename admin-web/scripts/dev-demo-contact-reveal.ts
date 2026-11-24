// 개발 DB 전용 — 연락처 전체 열람(S3-5.3(연락처 전체 열람), 보드 W6 「연락처 전체 보기」 · O45)의 시연 데이터.
//
// 이 스크립트가 더하는 것 — brad 대표가 「살사 온원 기초」 다가오는 첫 회차 명단에서 김서연의 연락처를
// 사유 「수업 변경 안내 전화」로 한 번 열어 본다. 진짜 경로(POST /api/academies/{academyId}/members/{memberId}/contact-reveal)를
// 대표 앱처럼 Bearer 로 부른다 — audit_logs 행을 SQL 로 넣지 않는다. 그래서 감사 기록(운영자 콘솔 P8)에 열람 1건이 실제로 남는다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-contact-reveal.ts   (개발 서버 :3000)
//   두 번 돌려도 같은 결과 — brad 대표가 김서연을 연 감사 행이 이미 있으면 아무것도 하지 않는다
//   (이 경로는 부를 때마다 1건이 남는 경로라, 시연 스크립트 쪽에서 「이미 있으면 건너뜀」을 맡는다).
//   먼저 dev-demo-owner-orders.ts 가 있어야 한다(김서연 demo-order-seoyeon@example.com 의 결제 완료 주문).
//   전체 번호·토큰은 화면에 찍지 않는다(가린 번호만).
import "dotenv/config";

import { maskPhone } from "../lib/domain/member-privacy";
import { createDb } from "../prisma/db";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = process.env["DEMO_API_BASE"] ?? "http://localhost:3000";
const SEOYEON_EMAIL = "demo-order-seoyeon@example.com";
const CLASS_TITLE = "살사 온원 기초";
const REASON = "수업 변경 안내 전화";

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

// brad 대표 · 그 학원 · 김서연 · 「살사 온원 기초」의 다가오는 첫 회차(열람 맥락)
const [target] = await q<{ user_id: string; staff_id: string; academy_id: string; member_id: string; session_id: string }>(
  `SELECT u.id AS user_id, s.id::text AS staff_id, o.academy_id::text AS academy_id, m.id::text AS member_id, ses.id::text AS session_id
     FROM auth."user" u
     JOIN staff_accounts s ON s.auth_user_id = u.id
     JOIN academy_owners o ON o.staff_account_id = s.id
     JOIN classes c ON c.academy_id = o.academy_id AND c.title = $2
     JOIN class_offerings co ON co.class_id = c.id
     JOIN class_sessions ses ON ses.offering_id = co.id AND ses.status = 'scheduled' AND ses.starts_at > now()
     JOIN reservations r ON r.offering_id = co.id AND r.status = 'confirmed'
     JOIN members m ON m.id = r.member_id
     JOIN auth."user" mu ON mu.id = m.auth_user_id AND mu.email = $1
    WHERE u.username = 'brad'
    ORDER BY ses.starts_at LIMIT 1`,
  [SEOYEON_EMAIL, CLASS_TITLE],
);
if (target === undefined) {
  console.error(`멈춤: brad 대표의 「${CLASS_TITLE}」에서 김서연의 확정 예약이나 다가오는 회차가 없다 — dev-demo-owner-orders.ts 를 먼저 돌린다`);
  await finish(1);
}

const [already] = await q<{ n: number }>(
  "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'member.contact_revealed' AND target_id = $1 AND actor_staff_account_id = $2",
  [target!.member_id, target!.staff_id],
);
if ((already?.n ?? 0) > 0) {
  console.log(`건너뜀: brad 대표는 김서연의 연락처 열람 기록이 이미 ${already!.n}건 있다`);
  await finish(0);
}

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (health?.ok !== true) throw new Error(`개발 서버(${BASE})가 떠 있지 않다 — KDANCE_DEV_ROUTES=true npm run dev -- --port 3000`);

// 대표 앱처럼 Bearer 로 진짜 경로를 부른다(토큰은 찍지 않는다)
const token = (await ctx.internalAdapter.createSession(target!.user_id)).token;
const response = await fetch(`${BASE}/api/academies/${target!.academy_id}/members/${target!.member_id}/contact-reveal`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ reason: REASON, sessionId: target!.session_id }),
});
const text = await response.text();
if (response.status !== 200) {
  console.error(`POST 연락처 전체 열람 → ${response.status} ${text.slice(0, 200)}`);
  await finish(1);
}
const body = JSON.parse(text) as { phone: string; revealedAt: string };
console.log(`연락처 열람: brad 대표 → 김서연(${maskPhone(body.phone)}) · 사유 「${REASON}」 · ${body.revealedAt} → ${response.status}`);
await finish(0);
