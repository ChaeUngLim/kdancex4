// 개발 DB 전용 — 신고(S7-2.5(신고 접수·처리))가 빈 목록이 아니라 실제 서버 데이터로 보이게 하는 시연 데이터.
// 뒤에 올 앱 신고 화면(C11A)과 관리자 웹 신고 처리 화면(S7-2.10b)이 이 신고를 읽는다.
//
// 무엇을 넣나(진행 단계 셋을 하나씩 보이게):
//   ① 회원 「서아」(demo-myclass@example.com) → 수업 「바차타(초급)」 · 앱 밖 결제·거래 유도(FR-255, 계약 §2-7 예시 글) → 운영자가 확인 시작(in_review)
//   ② 같은 회원 → 같은 수업 · 수업 정보가 실제와 달라요 → 운영자가 「처리했어요」(upheld)로 처리(resolved)
//   ③ 강사 「오세린」 → 회원 「서아」 · 기타(수업 중 촬영 요청 반복) → 접수 그대로(received)
//   진짜 처리기(createReportRoutes)를 진짜 세션으로 부른다. 신고 행·알림 행을 SQL 로 넣지 않는다.
//   운영자는 dev-demo-holidays.ts 와 같은 「데모 운영자」(demoadmin, demo-admin@example.com) — 없으면 만든다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-reports.ts
//   두 번 돌려도 같은 결과 — 신고마다 고정 열쇠(Idempotency-Key)를 쓰므로 두 번째는 200 재생이고,
//   start-review·resolve 도 이미 그 상태면 200 으로 그대로다(알림이 늘지 않는다).
//   먼저 dev-demo-member-my-class.ts(윤서아 예약)·강사 소속 시연(오세린)이 있어야 한다.
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { systemClock } from "../lib/domain/time";
import { createReportRoutes } from "../lib/server/services/reports";
import { createStaffAuth } from "../lib/server/staff-auth";
import { createDb } from "../prisma/db";

const BASE = "http://localhost:3000";
const ADMIN_USERNAME = "demoadmin";
const MEMBER_EMAIL = "demo-myclass@example.com";
const CLASS_TITLE = "바차타(초급)";
const INSTRUCTOR_NAME = "오세린";

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);
const routes = createReportRoutes({ db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: systemClock });

/** 시연 운영자 — 있으면 그대로 쓴다(dev-demo-holidays.ts 와 같은 계정) */
async function ensureDemoAdmin(): Promise<string> {
  const [found] = await q<{ user_id: string }>(`SELECT id AS user_id FROM auth."user" WHERE username = $1`, [ADMIN_USERNAME]);
  if (found !== undefined) return found.user_id;
  const user = await ctx.internalAdapter.createUser(
    { email: "demo-admin@example.com", name: "데모 운영자", emailVerified: true, username: ADMIN_USERNAME, displayUsername: ADMIN_USERNAME },
    { method: "admin" },
  );
  // 콘솔 경로는 2단계를 마친 세션만 받는다 — 시연 계정은 인증 앱을 켠 것으로 둔다
  await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
  const staffId = randomUUID();
  await pool.query("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '데모 운영자', 'active', now())", [
    staffId,
    user.id,
  ]);
  await pool.query("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'admin')", [staffId]);
  return user.id;
}

const bearer = async (userId: string) => `Bearer ${(await ctx.internalAdapter.createSession(userId)).token}`;

/** 진짜 처리기 응답을 읽고, 실패면 바로 멈춘다 */
async function expectOk(label: string, response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (response.status !== 200 && response.status !== 201) throw new Error(`${label} → ${response.status} ${text}`);
  console.log(`${response.status === 201 ? "새로 만듦(201)" : "200"}: ${label} · ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

try {
  // ---- 사람 셋(읽기만) ----------------------------------------------------------------------------------------------
  const [member] = await q<{ user_id: string; member_id: string; class_id: string }>(
    `SELECT u.id AS user_id, m.id::text AS member_id, c.id::text AS class_id
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
  const [instructor] = await q<{ user_id: string }>(
    `SELECT s.auth_user_id AS user_id FROM staff_accounts s
       JOIN role_grants g ON g.staff_account_id = s.id AND g.role = 'instructor' AND g.status = 'active'
      WHERE s.display_name = $1 AND s.status = 'active' ORDER BY s.created_at LIMIT 1`,
    [INSTRUCTOR_NAME],
  );
  if (instructor === undefined) throw new Error(`강사 ${INSTRUCTOR_NAME} 이 없다 — 강사 소속 시연을 먼저 돌린다`);
  const adminUserId = await ensureDemoAdmin();

  // ---- 신고 셋 — 진짜 경로 POST /api/reports ---------------------------------------------------------------------------
  const plans = [
    {
      label: "① 서아 → 바차타(초급) · 앱 밖 결제·거래 유도",
      userId: member.user_id,
      key: "demo-report-seoa-offplatform",
      body: {
        targetKind: "class",
        targetId: member.class_id,
        reasonCode: "off_platform_payment",
        detail: "첫 수업 뒤에 다음 달부터는 앱 말고 계좌로 직접 보내면 10% 깎아 준다고 했어요.",
      },
    },
    {
      label: "② 서아 → 바차타(초급) · 수업 정보가 실제와 달라요",
      userId: member.user_id,
      key: "demo-report-seoa-mismatch",
      body: { targetKind: "class", targetId: member.class_id, reasonCode: "info_mismatch", detail: "초급반이라고 했는데 첫날부터 회전 콤비네이션만 했어요." },
    },
    {
      label: "③ 오세린(강사) → 회원 서아 · 기타",
      userId: instructor.user_id,
      key: "demo-report-serin-member",
      body: { targetKind: "member", targetId: member.member_id, reasonCode: "other", detail: "수업 중에 다른 회원을 촬영해 달라는 요청을 여러 번 했어요." },
    },
  ];
  const reportIds: string[] = [];
  for (const plan of plans) {
    const response = await routes.create(
      new Request(`${BASE}/api/reports`, {
        method: "POST",
        headers: { authorization: await bearer(plan.userId), "content-type": "application/json", "Idempotency-Key": plan.key },
        body: JSON.stringify(plan.body),
      }),
      {},
    );
    reportIds.push(String((await expectOk(plan.label, response))["reportId"]));
  }

  // ---- 운영자 처리 — ① 확인 시작, ② 확인 시작 → 처리. ③ 은 접수 그대로 둔다 ----------------------------------------------
  const adminHeaders = { authorization: await bearer(adminUserId), "content-type": "application/json" };
  for (const reportId of reportIds.slice(0, 2)) {
    // ② 가 이미 처리 끝이면 start-review 는 409 — 처리 끝 상태를 먼저 보고 건너뛴다
    const [row] = await q<{ status: string }>("SELECT status FROM reports WHERE id = $1", [reportId]);
    if (row?.status === "resolved") {
      console.log(`건너뜀(이미 처리 끝): start-review ${reportId}`);
      continue;
    }
    await expectOk(
      `start-review ${reportId}`,
      await routes.startReview(new Request(`${BASE}/api/admin/reports/${reportId}/start-review`, { method: "POST", headers: adminHeaders }), {
        params: Promise.resolve({ reportId }),
      }),
    );
  }
  const resolvedId = reportIds[1]!;
  await expectOk(
    `resolve ${resolvedId}(upheld)`,
    await routes.resolve(
      new Request(`${BASE}/api/admin/reports/${resolvedId}/resolve`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ outcome: "upheld", note: "학원에 수업 소개 문구를 실제 진도에 맞게 고치도록 안내", openRestriction: null }),
      }),
      { params: Promise.resolve({ reportId: resolvedId }) },
    ),
  );

  // ---- 결과 요약 -------------------------------------------------------------------------------------------------------
  const summary = await q<{ reason_code: string; status: string; outcome: string | null; notifications: number }>(
    `SELECT r.reason_code, r.status, r.outcome,
            (SELECT count(*)::int FROM notifications n WHERE n.payload->>'reportId' = r.id::text) AS notifications
       FROM reports r WHERE r.idempotency_key LIKE 'demo-report-%' ORDER BY r.received_at`,
  );
  console.log("시연 신고:", JSON.stringify(summary));
} finally {
  await db.close();
  await pool.end();
}
