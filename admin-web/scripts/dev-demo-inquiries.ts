// 개발 DB 전용 — 문의(S7-2.2(문의 생성과 조회 권한))가 빈 목록이 아니라 실제 서버 데이터로 보이게 하는 시연 데이터.
// 뒤에 올 앱 문의 화면(M22·I16, S7-2.8)·대표 문의함(O22·W21, S7-2.10)·운영자 문의함이 이 문의를 읽는다.
//
// 무엇을 넣나(받는 곳 규칙 — 계약 15 §2-1 의 네 갈래를 하나씩):
//   ① 회원 「서아」(윤서아, demo-myclass@example.com) → 브래드 댄스 스튜디오 · 수업 문의 · 결제완료 예약 「바차타(초급)」을 골라서
//   ② 같은 회원 → 운영자(앱 이용) · 계정 문의
//   ③ 브래드 댄스 스튜디오 소속 강사 「오세린」 → 소속 학원 · 결석 문의(D10 — 「결석」 칩)
//   ④ 대표 「브래드」(brad@example.com) → 운영자 · 결제 장애 문의
//   진짜 경로 POST /api/inquiries 를 떠 있는 개발 서버(:3000)로 부른다. 문의 행을 SQL 로 넣지 않는다.
// S7-2.3(답변과 응답 기한 재알림)이 더한 것:
//   ⑤ 대표 브래드가 ① 에 답한다 — 진짜 경로 POST /api/academies/{id}/inquiries/{id}/replies(대표 앱 Bearer). ① 은 「답변 완료」, 서아에게 inquiry_answered
//      ③(강사 결석)은 일부러 답하지 않고 남긴다 — 대표 문의함에 답변 대기가 보이고, 기한(다음 영업일 끝)이 지나면 재알림 대상이 된다
//   ⑥ 재알림 작업 POST /api/internal/jobs/inquiries/remind-overdue 를 지금 시각으로 한 번 부른다(X-Internal-Token).
//      기한 전이면 0 이고, 기한이 지난 뒤 다시 돌리면 ③·② 등 답 없는 문의마다 대표·운영자에게 1건씩 간다
// S7-2.10(대표 앱 문의함 화면 O22)이 더한 것: ⑦⑧ 브래드 댄스 스튜디오에 답변 대기 회원 문의 둘(환불 요청 · 일정 변경) — 아래 절
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-inquiries.ts
//   두 번 돌려도 같은 결과 — 문의마다 고정 열쇠(Idempotency-Key)를 쓰므로 두 번째는 200 재생이고 행이 늘지 않는다.
//   먼저 dev-demo-owner.ts(브래드·학원)·dev-demo-member-my-class.ts(윤서아 예약)·강사 소속 시연이 있어야 한다.
import "dotenv/config";

import { createDb } from "../prisma/db";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = process.env["DEMO_API_BASE"] ?? "http://localhost:3000";
const MEMBER_EMAIL = "demo-myclass@example.com";
const OWNER_EMAIL = "brad@example.com";
const ACADEMY_NAME = "브래드 댄스 스튜디오";
const CLASS_TITLE = "바차타(초급)";
const INSTRUCTOR_NAME = "오세린";

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

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (health?.ok !== true) throw new Error(`개발 서버(${BASE})가 떠 있지 않다 — npm run dev -- --port 3000`);

// ---- 묻는 사람 셋(읽기만) -----------------------------------------------------------------------------------------
const [member] = await q<{ user_id: string; reservation_id: string; academy_id: string }>(
  `SELECT u.id AS user_id, r.id::text AS reservation_id, c.academy_id::text AS academy_id
     FROM auth."user" u
     JOIN members m ON m.auth_user_id = u.id
     JOIN reservations r ON r.member_id = m.id AND r.status = 'confirmed'
     JOIN class_offerings off ON off.id = r.offering_id
     JOIN classes c ON c.id = off.class_id AND c.title = $2
    WHERE u.email = $1
    ORDER BY r.created_at DESC LIMIT 1`,
  [MEMBER_EMAIL, CLASS_TITLE],
);
if (member === undefined) throw new Error(`${MEMBER_EMAIL} 의 ${CLASS_TITLE} 예약이 없다 — dev-demo-member-my-class.ts 를 먼저 돌린다`);

const [owner] = await q<{ user_id: string }>(
  `SELECT u.id AS user_id FROM auth."user" u JOIN staff_accounts s ON s.auth_user_id = u.id WHERE u.email = $1`,
  [OWNER_EMAIL],
);
if (owner === undefined) throw new Error(`${OWNER_EMAIL} 대표가 없다 — dev-demo-owner.ts 를 먼저 돌린다`);

const [instructor] = await q<{ user_id: string }>(
  `SELECT s.auth_user_id AS user_id FROM staff_accounts s
     JOIN instructor_affiliations f ON f.instructor_account_id = s.id AND f.status = 'active'
     JOIN academies a ON a.id = f.academy_id AND a.name = $2
    WHERE s.display_name = $1 AND s.status = 'active'
    ORDER BY s.created_at LIMIT 1`,
  [INSTRUCTOR_NAME, ACADEMY_NAME],
);
if (instructor === undefined) throw new Error(`${ACADEMY_NAME} 소속 강사 ${INSTRUCTOR_NAME} 이 없다 — 강사 소속 시연을 먼저 돌린다`);

// ---- 진짜 경로로 문의 넷 ------------------------------------------------------------------------------------------
const tokenFor = async (userId: string) => (await ctx.internalAdapter.createSession(userId)).token;

const plans: { label: string; userId: string; key: string; body: Record<string, unknown> }[] = [
  {
    label: "서아 → 브래드 댄스 스튜디오 · 수업 문의",
    userId: member.user_id,
    key: "demo-inquiry-seoa-class",
    body: { kind: "academy", academyId: member.academy_id, category: "class", reservationId: member.reservation_id, body: "다음 주 수업에 신발은 무엇을 신나요? 아직 댄스화가 없어서요." },
  },
  {
    label: "서아 → 운영자 · 계정",
    userId: member.user_id,
    key: "demo-inquiry-seoa-account",
    body: { kind: "system", category: "account", body: "휴대폰 번호를 바꿨는데 로그인할 때 예전 번호로 인증 문자가 와요." },
  },
  {
    label: "오세린(강사) → 브래드 댄스 스튜디오 · 결석",
    userId: instructor.user_id,
    key: "demo-inquiry-serin-absence",
    body: { kind: "academy", academyId: member.academy_id, category: "absence", body: "지난 화요일 바차타 초급 3회차에 결석한 회원 두 분 처리 문의드려요." },
  },
  {
    label: "브래드(대표) → 운영자 · 결제 장애",
    userId: owner.user_id,
    key: "demo-inquiry-brad-outage",
    body: { kind: "system", category: "payment_outage", body: "오늘 오후부터 회원 결제가 계속 실패한다고 연락이 와요. 확인 부탁드려요." },
  },
];

const inquiryIds: Record<string, string> = {};
for (const plan of plans) {
  const response = await fetch(`${BASE}/api/inquiries`, {
    method: "POST",
    headers: { authorization: `Bearer ${await tokenFor(plan.userId)}`, "content-type": "application/json", "Idempotency-Key": plan.key },
    body: JSON.stringify(plan.body),
  });
  const text = await response.text();
  if (response.status !== 201 && response.status !== 200) {
    console.error(`POST /api/inquiries(${plan.label}) → ${response.status} ${text}`);
    await finish(1);
  }
  const outcome = JSON.parse(text) as { inquiryId: string; status: string; firstResponseDueAt: string };
  const verb = response.status === 201 ? "새로 만듦" : "건너뜀(이미 있음)";
  console.log(`${verb}: ${plan.label} · ${outcome.status} · 첫 답 기한 ${outcome.firstResponseDueAt} · ${outcome.inquiryId}`);
  inquiryIds[plan.key] = outcome.inquiryId;
}

// ---- ⑤ 대표 답변(S7-2.3) — 고정 열쇠라 두 번째 실행은 200 재생이다 ---------------------------------------------------
const seoaClassId = inquiryIds["demo-inquiry-seoa-class"]!;
const reply = await fetch(`${BASE}/api/academies/${member.academy_id}/inquiries/${seoaClassId}/replies`, {
  method: "POST",
  headers: { authorization: `Bearer ${await tokenFor(owner.user_id)}`, "content-type": "application/json", "Idempotency-Key": "demo-reply-brad-seoa-class" },
  body: JSON.stringify({ body: "첫 달은 바닥이 미끄럽지 않은 실내 운동화면 충분해요. 익숙해지면 스웨이드 밑창 댄스화를 추천드려요." }),
});
const replyText = await reply.text();
if (reply.status !== 201 && reply.status !== 200) {
  console.error(`대표 답변 → ${reply.status} ${replyText}`);
  await finish(1);
}
console.log(`${reply.status === 201 ? "새로 답함" : "건너뜀(이미 답함)"}: 브래드 → 서아 수업 문의 · ${replyText}`);

// ---- ⑥ 재알림 작업(S7-2.3) — 지금 시각 기준. 같은 문의에는 한 번만 간다 ----------------------------------------------
const job = await fetch(`${BASE}/api/internal/jobs/inquiries/remind-overdue`, {
  method: "POST",
  headers: { "X-Internal-Token": process.env["INTERNAL_API_TOKEN"] ?? "", "content-type": "application/json" },
  body: "{}",
});
const jobText = await job.text();
if (job.status !== 200) {
  console.error(`재알림 작업 → ${job.status} ${jobText}`);
  await finish(1);
}
console.log(`재알림 작업: ${jobText}`);

// ---- ⑦⑧ 대표 문의함(O22, S7-2.10)이 비어 보이지 않게 — 답변 대기 회원 문의 둘 ------------------------------------------
//   ⑦ 회원 「도윤」(demo-activity@example.com) → 환불 요청 · 결제완료 예약 「바차타 센슈얼 입문」(보드 O22 첫 카드 문장)
//   ⑧ 회원 「김서연」(demo-order-seoyeon@example.com) → 일정 변경 · 예약 「살사 온원 기초」
//   둘 다 진짜 경로 POST /api/inquiries(회원 Bearer, 고정 열쇠)로 만들고, 답하지 않고 남긴다 — 문의함에 「답변 대기」가 보인다.
//   「사람 요청」(AI 뒤 사람 이관, route=ai_handoff)은 AI 서버(MX 트랙)가 만들 수 있는 값이라 지금은 만들 경로가 없어 넣지 않는다.
const ownerPlans = [
  { email: "demo-activity@example.com", title: "바차타 센슈얼 입문", key: "demo-inquiry-doyun-refund", category: "refund",
    body: "개인 사정으로 2회차부터 못 나가요. 환불 가능할까요? 남은 회차만큼이라도 돌려받고 싶어요." },
  { email: "demo-order-seoyeon@example.com", title: "살사 온원 기초", key: "demo-inquiry-seoyeon-schedule", category: "schedule",
    body: "다음 주 목요일 수업이 회사 일정과 겹쳐요. 같은 주 토요일 반으로 한 번만 옮길 수 있을까요?" },
];
for (const plan of ownerPlans) {
  const [row] = await q<{ user_id: string; reservation_id: string; academy_id: string }>(
    `SELECT u.id AS user_id, r.id::text AS reservation_id, c.academy_id::text AS academy_id
       FROM auth."user" u
       JOIN members m ON m.auth_user_id = u.id
       JOIN reservations r ON r.member_id = m.id AND r.status = 'confirmed'
       JOIN class_offerings off ON off.id = r.offering_id
       JOIN classes c ON c.id = off.class_id AND c.title = $2
       JOIN academies a ON a.id = c.academy_id AND a.name = $3
      WHERE u.email = $1
      ORDER BY r.created_at DESC LIMIT 1`,
    [plan.email, plan.title, ACADEMY_NAME],
  );
  if (row === undefined) {
    console.log(`건너뜀(예약 없음): ${plan.email} 의 ${plan.title} — 해당 시연 스크립트를 먼저 돌린다`);
    continue;
  }
  const response = await fetch(`${BASE}/api/inquiries`, {
    method: "POST",
    headers: { authorization: `Bearer ${await tokenFor(row.user_id)}`, "content-type": "application/json", "Idempotency-Key": plan.key },
    body: JSON.stringify({ kind: "academy", academyId: row.academy_id, category: plan.category, reservationId: row.reservation_id, body: plan.body }),
  });
  const text = await response.text();
  if (response.status !== 201 && response.status !== 200) {
    console.error(`POST /api/inquiries(${plan.email}) → ${response.status} ${text}`);
    await finish(1);
  }
  const outcome = JSON.parse(text) as { inquiryId: string; status: string };
  console.log(`${response.status === 201 ? "새로 만듦" : "건너뜀(이미 있음)"}: ${plan.email} → ${ACADEMY_NAME} · ${plan.category} · ${outcome.status} · ${outcome.inquiryId}`);
}
await finish(0);
