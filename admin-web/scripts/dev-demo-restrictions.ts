// 개발 DB 전용 — 이용 제한 절차(S7-2.6(이용 제한 절차), FR-254)가 빈 표가 아니라 실제 서버 데이터로 보이게 하는 시연 데이터.
// 뒤에 올 운영자 P11 화면과 대표·강사 앱의 「이용 제한 안내」 알림이 이 절차를 읽는다.
//
// 무엇을 넣나(보통 절차와 긴급 절차를 하나씩):
//   ① 수업 「바차타(초급)」을 연 학원 · 앱 밖 결제 유도(off_platform_payment) · 수업 게시 제한 예정 → 사유 통지(notice_sent, 소명 기한 7일)
//      사유 글은 계약 15 §2-8 의 예시 글 「앱 밖 결제를 유도한 신고가 확인됐어요」
//   ② 강사 「오세린」 · 약관 위반(terms_violation) · 일부 기능 제한 · 긴급 → 조치 먼저(measure_applied)
//   진짜 처리기(createRestrictionRoutes)를 진짜 운영자 세션으로 부른다. 절차·알림·감사 행을 SQL 로 넣지 않는다.
//   운영자는 dev-demo-reports.ts 와 같은 「데모 운영자」(demoadmin, demo-admin@example.com) — 없으면 먼저 그 스크립트를 돌린다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-restrictions.ts
//   두 번 돌려도 같은 결과 — 절차마다 고정 열쇠(Idempotency-Key)를 써서 두 번째는 200 재생이다(알림·감사가 늘지 않는다).
//   먼저 dev-demo-member-my-class.ts(바차타(초급) 예약)·강사 소속 시연(오세린)·dev-demo-reports.ts(데모 운영자)가 있어야 한다.
import "dotenv/config";

import { systemClock } from "../lib/domain/time";
import { createRestrictionRoutes } from "../lib/server/services/restrictions";
import { createStaffAuth } from "../lib/server/staff-auth";
import { createDb } from "../prisma/db";

const BASE = "http://localhost:3000";
const ADMIN_USERNAME = "demoadmin";
const CLASS_TITLE = "바차타(초급)";
const INSTRUCTOR_NAME = "오세린";

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);
const routes = createRestrictionRoutes({ db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: systemClock });

try {
  // ---- 대상 둘과 운영자(읽기만) --------------------------------------------------------------------------------------
  const [academy] = await q<{ academy_id: string }>(
    "SELECT academy_id::text AS academy_id FROM classes WHERE title = $1 ORDER BY created_at LIMIT 1",
    [CLASS_TITLE],
  );
  if (academy === undefined) throw new Error(`수업 ${CLASS_TITLE} 이 없다 — dev-demo-member-my-class.ts 를 먼저 돌린다`);
  const [instructor] = await q<{ staff_id: string }>(
    `SELECT s.id::text AS staff_id FROM staff_accounts s
       JOIN role_grants g ON g.staff_account_id = s.id AND g.role = 'instructor' AND g.status = 'active'
      WHERE s.display_name = $1 AND s.status = 'active' ORDER BY s.created_at LIMIT 1`,
    [INSTRUCTOR_NAME],
  );
  if (instructor === undefined) throw new Error(`강사 ${INSTRUCTOR_NAME} 이 없다 — 강사 소속 시연을 먼저 돌린다`);
  const [admin] = await q<{ user_id: string }>(`SELECT id AS user_id FROM auth."user" WHERE username = $1`, [ADMIN_USERNAME]);
  if (admin === undefined) throw new Error("데모 운영자가 없다 — dev-demo-reports.ts 를 먼저 돌린다");
  const authorization = `Bearer ${(await ctx.internalAdapter.createSession(admin.user_id)).token}`;

  // ---- 절차 둘 — 진짜 경로 POST /api/admin/restrictions ---------------------------------------------------------------
  const plans = [
    {
      label: "① 바차타(초급) 학원 · 앱 밖 결제 유도 · 수업 게시 제한 예정",
      key: "demo-restriction-academy-offplatform",
      body: {
        subjectKind: "academy",
        subjectId: academy.academy_id,
        reasonCode: "off_platform_payment",
        reasonText: "앱 밖 결제를 유도한 신고가 확인됐어요",
        plannedMeasure: "listing_limit",
      },
    },
    {
      label: "② 강사 오세린 · 약관 위반 · 일부 기능 제한(긴급)",
      key: "demo-restriction-instructor-terms",
      body: {
        subjectKind: "instructor",
        subjectId: instructor.staff_id,
        reasonCode: "terms_violation",
        reasonText: "수업 중 회원에게 개인 계좌로 레슨비를 보내 달라고 요구했어요",
        plannedMeasure: "feature_limit",
        urgent: true,
      },
    },
  ];
  for (const plan of plans) {
    const response = await routes.open(
      new Request(`${BASE}/api/admin/restrictions`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json", "Idempotency-Key": plan.key },
        body: JSON.stringify(plan.body),
      }),
      undefined,
    );
    const text = await response.text();
    if (response.status !== 200 && response.status !== 201) throw new Error(`${plan.label} → ${response.status} ${text}`);
    console.log(`${response.status === 201 ? "새로 만듦(201)" : "200(이미 있음)"}: ${plan.label} · ${text}`);
  }

  // ---- 결과 요약 — 절차·알림·감사 행 수 -------------------------------------------------------------------------------
  const summary = await q(
    `SELECT c.subject_kind, c.reason_code, c.reason_text, c.planned_measure, c.measure, c.state,
            (SELECT count(*)::int FROM notifications n WHERE n.kind = 'restriction_notice' AND n.payload->>'caseId' = c.id::text) AS notices,
            (SELECT count(*)::int FROM audit_logs a WHERE a.target_id = c.id AND a.action = 'restriction.opened') AS audits
       FROM restriction_cases c WHERE c.idempotency_key LIKE 'demo-restriction-%' ORDER BY c.created_at`,
  );
  console.log("시연 이용 제한 절차:", JSON.stringify(summary));
} finally {
  await db.close();
  await pool.end();
}
