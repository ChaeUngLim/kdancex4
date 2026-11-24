// 개발 DB 전용 — 앱 캘린더(보드 M11)·내 예약·결제 내역(M16)·알림함(M21)을 가짜 응답이 아니라 실제 서버 데이터로 보이게 하는
// 시연 데이터(S3-4.7b(앱 캘린더·알림함·내역 시연 데이터)).
//
// 무엇을 넣나:
//   ① 시연 회원 2명
//      - demo-activity@example.com / demo-activity-1234 — 「이도윤」(남). 아래 주문·결석·알림을 가진 회원
//      - demo-empty@example.com    / demo-empty-1234    — 「한지우」(여). 아무것도 없는 회원(빈 화면 M16E·M21E 촬영용)
//   ② 이도윤의 주문 4건 — brad 대표 학원(브래드 댄스 스튜디오)의 게시 수업에, 진짜 주문 경로(POST /api/orders)로 만든다
//      - 바차타 센슈얼 입문(90,000원 · 카드)          → 가짜 PG 입금 dev 경로 → 웹훅 확정 = 결제완료. 12월 화요일 회차가 캘린더에 들어간다
//      - 살사 온원 기초(110,000원 · 가상계좌)         → 입금하지 않음 = 입금 대기
//      - 바차타 레이디스타일 기초(120,000원 · 가상계좌) → 내부 만료 작업(시험용 시계) = 만료
//      - 연말 살사 파티(30,000원 · 가상계좌)          → 회원 셀프 취소 경로 = 입금 전 취소
//      「부분 환불」은 넣지 않는다 — 주문을 partially_refunded 로 바꾸는 서버 경로가 아직 없다(환불 슬라이스 M4 의 일).
//      2026-11-23 사용자 결정으로 그 장면은 S4-1.7b 로 미뤘다. 행을 SQL 로 직접 고치지 않는다
//   ③ 결석 예정 1건 — 결제완료 수업의 12/8(화) 회차를 회원 결석 토글 경로(PUT /api/me/sessions/{id}/absence)로
//   ④ 알림 — 모두 진짜 경로가 만든다: 결제 확인(웹훅) · 입금 기한 임박(내부 작업, 시험용 시계) · 수업 공지(대표가 보냄)
//
// 시각을 옮기는 단 한 곳 — 알림 묶음(오늘·어제·이번 주):
//   서버 시계는 실제 시계라 진짜 경로로 만든 알림은 모두 「지금」에 생긴다. 알림함의 묶음을 보이려고 두 알림의
//   만든 시각(created_at)만 어제·사흘 전으로 옮긴다. 행을 새로 넣거나 내용을 바꾸지 않는다(dev-demo-member-catalog.ts 의
//   확정 수 올리기와 같은 「시연용 값 하나만 조정」이다).
//
// 왜 HTTP 로 부르나: 가짜 PG 원장은 개발 서버 프로세스의 메모리에 있다. 주문(계좌 발급)과 입금을 같은 원장에서 해야
//   웹훅 처리기가 금액을 대조할 수 있어, 이 스크립트는 떠 있는 개발 서버(:3000, KDANCE_DEV_ROUTES=true)를 부른다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-member-activity.ts
//   두 번 돌려도 같은 결과 — 이도윤이 이미 주문 4건을 가지고 있으면 아무것도 하지 않는다.
//   먼저 scripts/dev-demo-owner.ts(brad) · dev-demo-console-data.ts · dev-demo-member-catalog.ts · dev-demo-event-party.ts 가 있어야 한다.
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { createDb } from "../prisma/db";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = process.env["DEMO_API_BASE"] ?? "http://localhost:3000";
const ACTIVE = { email: "demo-activity@example.com", password: "demo-activity-1234", username: "demo_activity", name: "이도윤", nickname: "도윤", gender: "male", birth: "1995-03-14", phone: "01000000011" } as const;
const EMPTY = { email: "demo-empty@example.com", password: "demo-empty-1234", username: "demo_empty", name: "한지우", nickname: "지우", gender: "female", birth: "1997-08-02", phone: "01000000012" } as const;
const EXPECTED_ORDERS = 4;

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");
const internalToken = process.env["INTERNAL_API_TOKEN"];
if (!internalToken) throw new Error("INTERNAL_API_TOKEN 이 없다 — admin-web/.env 를 확인한다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);

async function finish(code = 0): Promise<never> {
  await db.close();
  await pool.end();
  process.exit(code);
}

// ---- 두 번째 실행: 이미 다 있으면 건너뛴다. 반쯤 남은 상태면 멈춘다(덮어쓰지 않는다) ----------------------------
// 집계(count)는 회원이 없어도 한 줄을 돌려주므로 GROUP BY 로 「회원이 있을 때만 한 줄」이 되게 한다
const [already] = await q<{ orders: number }>(
  `SELECT count(o.id)::int AS orders FROM auth."user" u JOIN members m ON m.auth_user_id = u.id
     LEFT JOIN orders o ON o.member_id = m.id WHERE u.email = $1 GROUP BY m.id`,
  [ACTIVE.email],
);
if (already !== undefined) {
  if (already.orders >= EXPECTED_ORDERS) {
    console.log(`건너뜀: ${ACTIVE.email} 에 주문 ${already.orders}건이 이미 있다`);
    await finish(0);
  }
  console.error(`멈춤: ${ACTIVE.email} 은 있는데 주문이 ${already.orders}건뿐이다(앞 실행이 중간에 끊김). 그 회원을 지우고 다시 돌린다`);
  await finish(1);
}

// ---- 개발 서버 확인 — dev 경로가 꺼져 있으면 결제 확정을 할 수 없다 -----------------------------------------------
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

// ---- 수업 찾기 — 앞 시연 스크립트가 만든 게시 수업 ---------------------------------------------------------------
const offerings = await q<{ title: string; class_id: string; offering_id: string }>(
  `SELECT c.title, c.id::text AS class_id, o.id::text AS offering_id FROM classes c JOIN class_offerings o ON o.class_id = c.id
    WHERE c.status = 'published' AND c.title = ANY($1::text[])`,
  [["바차타 센슈얼 입문", "살사 온원 기초", "바차타 레이디스타일 기초", "연말 살사 파티"]],
);
const offeringOf = (title: string) => {
  const found = offerings.find((o) => o.title === title);
  if (found === undefined) throw new Error(`게시 수업 「${title}」이 없다 — dev-demo-member-catalog.ts · dev-demo-event-party.ts 를 먼저 돌린다`);
  return found;
};
const bachata = offeringOf("바차타 센슈얼 입문");
const salsa = offeringOf("살사 온원 기초");
const lady = offeringOf("바차타 레이디스타일 기초");
const party = offeringOf("연말 살사 파티");

const [owner] = await q<{ user_id: string }>(`SELECT id AS user_id FROM auth."user" WHERE username = 'brad'`);
if (owner === undefined) throw new Error("brad 대표가 없다 — scripts/dev-demo-owner.ts 를 먼저 돌린다");

// ---- 시연 회원 만들기 — dev-demo-member-catalog.ts 와 같은 방식(가입을 마친 회원 행) -------------------------------
async function createMember(m: typeof ACTIVE | typeof EMPTY): Promise<{ memberId: string; token: string }> {
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
  // 스크립트가 경로를 부를 때 쓰는 앱 면(Bearer) 세션
  const token = (await ctx.internalAdapter.createSession(user.id)).token;
  return { memberId, token };
}

const empty = await q("SELECT 1 FROM auth.\"user\" WHERE email = $1", [EMPTY.email]);
if (empty.length === 0) {
  await createMember(EMPTY);
  console.log(`회원(빈 화면용): ${EMPTY.email}`);
}
const member = await createMember(ACTIVE);
console.log(`회원: ${ACTIVE.email}`);

type OrderBody = { orderId: string; payment: { amount: number; dueAt: string } };
/** 진짜 주문 경로로 주문 하나를 만든다(새 Idempotency-Key) */
async function startOrder(offeringId: string, seatKind: "male" | "female" | "any", method: "card" | "virtual_account"): Promise<OrderBody> {
  const created = await call("POST", "/api/orders", {
    token: member.token,
    headers: { "Idempotency-Key": randomUUID() },
    body: { offeringId, seatKind, method, noticesAcknowledged: true },
    expect: [201],
  });
  return created.body as unknown as OrderBody;
}
/** 주문의 PG 쪽 결제 번호 — dev 경로 주소에 들어간다(읽기만) */
async function gatewayIdOf(orderId: string): Promise<string> {
  const [row] = await q<{ id: string }>("SELECT gateway_payment_id AS id FROM payments WHERE order_id = $1", [orderId]);
  if (row === undefined) throw new Error(`결제 행이 없다: ${orderId}`);
  return row.id;
}
const internalHeaders = { "X-Internal-Token": internalToken };

// ① 만료 — 레이디스타일 기초를 가상계좌로 신청하고 입금하지 않은 채, 내부 만료 작업을 「기한 1분 뒤」 시계로 돌린다.
//    이 시점에 개발 DB 의 다른 결제 대기는 없어야 한다(있으면 같이 만료된다) — 먼저 센다
const [otherPending] = await q<{ n: number }>("SELECT count(*)::int AS n FROM orders WHERE status = 'pending'");
if ((otherPending?.n ?? 0) > 0) throw new Error(`다른 결제 대기 주문이 ${otherPending!.n}건 있어 만료 작업을 돌리면 함께 닫힌다 — 먼저 정리한다`);
const ladyOrder = await startOrder(lady.offering_id, "any", "virtual_account");
const expireAt = new Date(new Date(ladyOrder.payment.dueAt).getTime() + 60_000).toISOString();
const expired = await call("POST", "/api/internal/orders/expire", { headers: internalHeaders, body: { asOf: expireAt }, expect: [200] });
console.log(`만료: 바차타 레이디스타일 기초 · ${JSON.stringify(expired.body)}`);

// ② 입금 전 취소 — 연말 살사 파티를 가상계좌로 신청하고 회원 셀프 취소 경로로 닫는다
const partyOrder = await startOrder(party.offering_id, "any", "virtual_account");
await call("POST", `/api/orders/${partyOrder.orderId}/cancel`, { token: member.token, expect: [200] });
console.log("입금 전 취소: 연말 살사 파티");

// ③ 결제완료 — 바차타 센슈얼 입문(남 자리)을 카드로 신청하고 가짜 PG 입금 dev 경로를 부른다(웹훅 확정까지 서버가 한다)
const bachataOrder = await startOrder(bachata.offering_id, "male", "card");
await call("POST", `/api/dev/fake-pg/payments/${encodeURIComponent(await gatewayIdOf(bachataOrder.orderId))}/deposit`, {
  body: { amount: bachataOrder.payment.amount },
  expect: [200],
});
console.log("결제완료: 바차타 센슈얼 입문");

// ④ 입금 대기 — 살사 온원 기초를 가상계좌로 신청만 한다. 입금 기한 임박 알림 작업을 「기한 30분 전」 시계로 돌려 알림을 만든다
const salsaOrder = await startOrder(salsa.offering_id, "male", "virtual_account");
const remindAt = new Date(new Date(salsaOrder.payment.dueAt).getTime() - 30 * 60_000).toISOString();
const reminded = await call("POST", "/api/internal/jobs/payment-deadline-reminders", { headers: internalHeaders, body: { asOf: remindAt }, expect: [200] });
console.log(`입금 대기: 살사 온원 기초 · 기한 임박 알림 ${JSON.stringify(reminded.body)}`);

// ⑤ 수업 공지 — brad 대표가 바차타 센슈얼 입문 확정 수강생에게 준비물 공지를 보낸다(앱 면 Bearer — 2단계 인증 없이 같은 권한 검사)
const ownerToken = (await ctx.internalAdapter.createSession(owner.user_id)).token;
await call("POST", `/api/classes/${bachata.class_id}/announcements`, {
  token: ownerToken,
  headers: { "Idempotency-Key": randomUUID() },
  body: { kind: "supplies", title: "첫 수업 준비물 안내", body: "굽 낮은 댄스화와 물을 챙겨 오세요. 시작 10분 전에 홀 문을 열어요.", pushToo: false },
  expect: [201],
});
console.log("수업 공지: 바차타 센슈얼 입문 · 첫 수업 준비물 안내");

// ⑥ 결석 예정 — 결제완료 수업의 12/8(화) 회차를 회원이 직접 결석으로 알린다
const calendar = await call("GET", "/api/me/calendar?from=2026-12-01&to=2026-12-31", { token: member.token, expect: [200] });
const entries = (calendar.body["items"] ?? []) as { sessionId: string; title: string; startsAt: string }[];
const dec8 = entries.find((e) => e.title === "바차타 센슈얼 입문" && e.startsAt.startsWith("2026-12-08"));
if (dec8 === undefined) throw new Error(`캘린더에 12/8 바차타 회차가 없다: ${JSON.stringify(entries.map((e) => e.startsAt))}`);
await call("PUT", `/api/me/sessions/${dec8.sessionId}/absence`, { token: member.token, body: {}, expect: [200, 201] });
console.log(`결석 예정: 바차타 센슈얼 입문 12/8 · 캘린더 회차 ${entries.length}개`);

// ⑦ 알림 묶음 — 결제 확인은 「어제 19:30(KST)」, 수업 공지는 「사흘 전 14:00(KST)」로 만든 시각만 옮긴다(맨 위 설명)
const kstDayAt = (daysAgo: number, hh: number, mm: number) => {
  const kstNow = new Date(Date.now() + 9 * 3_600_000);
  return new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate() - daysAgo, hh - 9, mm)).toISOString();
};
await q("UPDATE notifications SET created_at = $2::timestamptz WHERE recipient_member_id = $1 AND kind = 'payment_confirmed_member'", [member.memberId, kstDayAt(1, 19, 30)]);
await q("UPDATE notifications SET created_at = $2::timestamptz WHERE recipient_member_id = $1 AND kind = 'class_announcement'", [member.memberId, kstDayAt(3, 14, 0)]);

const summary = await q<{ status: string; title: string }>(
  `SELECT o.status, c.title FROM orders o JOIN class_offerings co ON co.id = o.offering_id JOIN classes c ON c.id = co.class_id
    WHERE o.member_id = $1 ORDER BY o.created_at`,
  [member.memberId],
);
const notes = await q<{ kind: string; created_at: string }>(
  "SELECT kind, to_char(created_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') AS created_at FROM notifications WHERE recipient_member_id = $1 ORDER BY created_at DESC",
  [member.memberId],
);
console.log(`주문: ${summary.map((s) => `${s.title}=${s.status}`).join(" · ")}`);
console.log(`알림: ${notes.map((n) => `${n.kind}@${n.created_at}`).join(" · ")}`);
await finish(0);
