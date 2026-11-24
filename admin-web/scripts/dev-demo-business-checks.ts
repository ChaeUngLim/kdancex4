// 개발 DB 전용 — P11 사업자 점검(S1-1.29(소명 기한 지남 → 운영자 게시 중단), FR-250·FR-254)이 빈 표가 아니라
// 실제 서버 데이터로 보이게 하는 시연 데이터. 뒤에 올 운영자 P11 화면(S7-4.9g)이 이 건들을 읽는다.
//
// 무엇을 넣나(보드 P11·계약 13 §10-3 의 예시와 같은 이름):
//   ① 「모던스텝 합정」(대표 정수아, 123-45-*****) · 폐업 · 이틀 전 감지 → 소명 기한 D-5, 대표 소명 1건(계약 예시 글)
//   ② 「스윙라인 성수」(대표 이하준, 214-87-*****) · 휴업 · 8일 전 감지 · 소명 없음 → 「기한 지남」(운영자가 게시 중단을 누를 차례)
//   ③ 「비트스튜디오 건대」(대표 강민서, 308-12-*****) · 조회 실패 → 건 없음 · 조치 없음
//   점검은 진짜 작업 경로(runBusinessStatusCheck)를 가짜 국세청 응답(개발 deps 와 같은 FakeBusinessStatusProvider)으로 부른다.
//   제한·절차·알림·감사 행을 SQL 로 넣지 않는다. 시각만 「며칠 전」 시계로 돌린다.
//   예외 둘: 학원·대표 행은 dev-demo-owner.ts 와 같이 직접 넣는다(입점 승인 흐름은 이 Task 몫이 아니다).
//   소명 글 1건도 직접 넣는다 — 소명을 내는 경로(15-ops §2-8 POST /api/restrictions/{caseId}/explanations)가 아직 없어서다.
//   그 경로가 생기면 이 줄을 그 경로 호출로 바꾼다.
//
// S7-4.8c(사업자 점검 소명 처리 API(P11)) 확장: 넣은 뒤 진짜 GET 처리기(목록·상세)를 시연 운영자 「데모 운영자」(demoadmin,
//   dev-demo-holidays.ts 와 같은 계정 — 없으면 같은 방식으로 만든다) 세션으로 불러 P11 응답 모양 그대로 찍는다. 조회 기록도 진짜로 남는다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-business-checks.ts
//   두 번 돌려도 같은 결과 — 학원이 이미 있으면 만들지 않고, 그 학원에 점검 기록이 있으면 점검을 다시 돌리지 않는다.
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { fixedClock, systemClock } from "../lib/domain/time";
import { FakeBusinessStatusProvider, type FakeBusinessStatusChoice } from "../lib/server/fakes/fake-business-status";
import { createAdminBusinessCheckRoutes } from "../lib/server/services/admin-business-checks";
import { runBusinessStatusCheck } from "../lib/server/services/business-status-check";
import { createStaffAuth } from "../lib/server/staff-auth";
import { createDb } from "../prisma/db";

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);

const EXPLANATION = "폐업 신고는 장소를 옮기는 중이라 한 것이고, 신규 사업자 등록증을 첨부해요.";

const PLANS: readonly {
  name: string;
  sido: string;
  gu: string;
  owner: string;
  username: string;
  businessNo: string;
  daysAgo: number;
  choice: FakeBusinessStatusChoice;
  explain: boolean;
}[] = [
  { name: "모던스텝 합정", sido: "서울", gu: "마포구", owner: "정수아", username: "demobizmodern", businessNo: "1234598765", daysAgo: 2, choice: { status: "closed", closedOn: "2026-11-10" }, explain: true },
  { name: "스윙라인 성수", sido: "서울", gu: "성동구", owner: "이하준", username: "demobizswing", businessNo: "2148754321", daysAgo: 8, choice: { status: "suspended" }, explain: false },
  { name: "비트스튜디오 건대", sido: "서울", gu: "광진구", owner: "강민서", username: "demobizbeat", businessNo: "3081245678", daysAgo: 1, choice: { status: "error" }, explain: false },
];

/** 학원 + 대표(로그인 계정 포함). 같은 이름의 학원이 있으면 그 id 를 돌려준다 */
async function ensureAcademy(plan: (typeof PLANS)[number]): Promise<{ academyId: string; ownerId: string; created: boolean }> {
  const [found] = await q<{ academy_id: string; owner_id: string }>(
    `SELECT a.id::text AS academy_id, o.staff_account_id::text AS owner_id FROM academies a
       JOIN academy_owners o ON o.academy_id = a.id WHERE a.name = $1 AND a.business_registration_number = $2 LIMIT 1`,
    [plan.name, plan.businessNo],
  );
  if (found !== undefined) return { academyId: found.academy_id, ownerId: found.owner_id, created: false };

  const user = await ctx.internalAdapter.createUser(
    { email: `${plan.username}@example.com`, name: plan.owner, emailVerified: true, username: plan.username, displayUsername: plan.username },
    { method: "admin" },
  );
  const ownerId = randomUUID();
  const academyId = randomUUID();
  await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [ownerId, user.id, plan.owner]);
  await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'owner')", [ownerId]);
  await q(
    `INSERT INTO academies (id, name, region_sido, region_gu, status, business_status, business_status_checked_at, updated_at,
                            registration_type, business_name, representative_name, business_registration_number, business_address,
                            phone, approved_at)
     VALUES ($1, $2::text, $3, $4, 'active', 'active', now() - interval '20 days', now(),
             'sports_facility', $2::text, $5, $6, $7, '020000000', now() - interval '60 days')`,
    [academyId, plan.name, plan.sido, plan.gu, plan.owner, plan.businessNo, `${plan.sido} ${plan.gu} 시연로 1, 2층`],
  );
  await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, ownerId]);
  return { academyId, ownerId, created: true };
}

/** 시연 운영자(demoadmin) — 있으면 그대로 쓴다. 콘솔 경로는 2단계를 마친 세션만 받아 인증 앱을 켠 것으로 둔다 */
async function ensureDemoAdmin(): Promise<string> {
  const [found] = await q<{ user_id: string }>(`SELECT id AS user_id FROM auth."user" WHERE username = 'demoadmin'`);
  if (found !== undefined) return found.user_id;
  const user = await ctx.internalAdapter.createUser(
    { email: "demo-admin@example.com", name: "데모 운영자", emailVerified: true, username: "demoadmin", displayUsername: "demoadmin" },
    { method: "admin" },
  );
  await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
  const staffId = randomUUID();
  await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '데모 운영자', 'active', now())", [staffId, user.id]);
  await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'admin')", [staffId]);
  return user.id;
}

try {
  for (const plan of PLANS) {
    const { academyId, ownerId, created } = await ensureAcademy(plan);
    const [checked] = await q<{ n: number }>("SELECT count(*)::int AS n FROM business_status_checks WHERE academy_id = $1", [academyId]);
    if ((checked?.n ?? 0) > 0) {
      console.log(`이미 있음: ${plan.name}(점검 기록 ${checked?.n}건)`);
      continue;
    }
    // 진짜 점검 작업 — 감지 시각을 며칠 전으로 돌린 시계로 부른다(소명 기한 = 감지 + 7일)
    const detectedAt = systemClock().subtract({ hours: 24 * plan.daysAgo });
    const provider = new FakeBusinessStatusProvider().respond(plan.businessNo, plan.choice);
    await runBusinessStatusCheck({ db, businessStatus: provider, clock: fixedClock(detectedAt) }, { trigger: "daily", academyIds: [academyId] });
    console.log(`${created ? "새로 만듦" : "학원은 있었음"} + 점검: ${plan.name} · ${plan.choice.status} · ${plan.daysAgo}일 전 감지`);

    if (plan.explain) {
      const [bizCase] = await q<{ id: string }>(
        "SELECT id::text AS id FROM restriction_cases WHERE subject_academy_id = $1 AND source = 'business_status' LIMIT 1",
        [academyId],
      );
      if (bizCase === undefined) throw new Error(`${plan.name}: 점검이 절차를 열지 않았다`);
      // 소명 제출 경로가 아직 없어 직접 넣는다(머리 주석). 절차 단계도 그 경로가 할 일(notice_sent → explained)을 같이 한다
      await q("INSERT INTO restriction_explanations (id, case_id, submitted_by_staff_account_id, body) VALUES (uuidv7(), $1, $2, $3)", [
        bizCase.id,
        ownerId,
        EXPLANATION,
      ]);
      await q("UPDATE restriction_cases SET state = 'explained', updated_at = now() WHERE id = $1 AND state = 'notice_sent'", [bizCase.id]);
      console.log(`  소명 1건: ${plan.name}`);
    }
  }

  // ---- 결과 요약 — 진짜 GET 처리기(P11 목록·상세)로 읽는다(S7-4.8c) ----------------------------------------------------------
  const token = (await ctx.internalAdapter.createSession(await ensureDemoAdmin())).token;
  const headers = { authorization: `Bearer ${token}` };
  const routes = createAdminBusinessCheckRoutes({ db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: systemClock });
  const listRes = await routes.list(new Request("http://localhost:3000/api/admin/console/business-checks", { headers }), undefined);
  const list = (await listRes.json()) as { summary: unknown; items: { caseId: string | null; academyName: string; [k: string]: unknown }[] };
  if (listRes.status !== 200) throw new Error(`목록 실패 ${listRes.status} ${JSON.stringify(list)}`);
  const demo = list.items.filter((i) => PLANS.some((p) => p.name === i.academyName));
  console.log(`GET 목록 ${listRes.status} · 요약(개발 DB 전체):`, JSON.stringify(list.summary));
  for (const i of demo) {
    const { academyName, ownerName, businessNoMasked, status, state, actions, dueLabel, explanationCount, note } = i;
    console.log("  줄:", JSON.stringify({ academyName, ownerName, businessNoMasked, status, state, actions, dueLabel, explanationCount, note }));
  }
  const modern = demo.find((i) => i.academyName === "모던스텝 합정" && i.caseId !== null);
  if (modern?.caseId) {
    const caseId = modern.caseId;
    const res = await routes.detail(new Request(`http://localhost:3000/api/admin/console/business-checks/${caseId}`, { headers }), {
      params: Promise.resolve({ caseId }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    console.log(`GET 상세 ${res.status}(모던스텝 합정):`, JSON.stringify({ latestCheck: body["latestCheck"], explanations: body["explanations"], actions: body["actions"], dueLabel: body["dueLabel"] }));
  }
} finally {
  await db.close();
  await pool.end();
}
