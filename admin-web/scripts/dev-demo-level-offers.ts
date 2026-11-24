// 개발 DB 전용 — S6-3.4(강사 레벨 조절과 평가 레벨 숨김)의 시연 데이터. 강사가 「살사 LA 입문」 수강생의 레벨을 정하게 한다.
//
// 무엇을 넣나(행을 SQL 로 넣지 않는다 — 강사 앱이 부르는 진짜 경로 POST /api/instructor/level-evaluations 의 처리기를 그대로 부른다):
//   오세린 강사(그 수업 담당)가 보드 I23 「선택한 n명 레벨 올리기 → 최종 적용」을 두 번 누른 것과 같다.
//     ① 최하은 · 이수아 → 살사 2(초급). 둘 다 지금 Lv.0 이라 승급 안내 + 알림 「오세린 강사님이 살사 레벨을 2(초급)로 올려 줬어요」
//     ② 박지호 → 살사 1(입문). 지금 Lv.1 이라 평가 레벨만 저장되고 회원에게는 아무것도 가지 않는다(내린·같은 레벨은 평가에만 남는다)
//   그 결과 회원 화면 GET /api/me/levels 에 최하은·이수아는 pendingOffers 한 줄, 박지호는 없다. 회원 레벨은 셋 다 그대로다.
//   ③ (S6-3.9) 최하은이 안내를 받는다 → 살사 Lv.2 · 카드 1장(연출 대기). 이수아 안내는 열린 채로 둔다 — 아래 「S6-3.9」 블록
//   강사 멤버십은 가짜 포트(deps.ts 의 instructorMembership)를 그대로 쓴다 — 오세린은 멤버십이다.
//   잠긴 화면(I37) 시연용으로 윤하늘 강사를 「멤버십 아님」으로 두려면 admin-web/.env 에
//   FAKE_INSTRUCTOR_NON_MEMBER_IDS=<윤하늘 계정 id> 를 넣는다(이 스크립트가 끝에 그 줄을 보여 준다).
//
// 두 번 돌려도 같은 결과: 경로가 멱등이다(같은 레벨을 다시 보내면 아무것도 바꾸지 않고 같은 응답).
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-level-offers.ts
//   먼저 dev-demo-instructor-absences.ts(「살사 LA 입문」·수강생 5명)와 dev-demo-level-evaluation.ts(완주 판정)가 있어야 한다.
//   개발 서버는 필요 없다(경로 처리기를 이 프로세스에서 부른다). 알림 발송기는 넘기지 않아 알림함 행만 생긴다(pending).
import "dotenv/config";
import "temporal-polyfill/full/global";

import { createDeps } from "../lib/server/deps";
import { createInstructorLevelEvaluationsRoute } from "../lib/server/services/instructor-level-evaluations";
import { createMeLevelOfferRoutes } from "../lib/server/services/me-level-offers";
import { readMeLevels } from "../lib/server/services/me-levels";
import { createStaffAuth } from "../lib/server/staff-auth";
import { createDb } from "../prisma/db";

const CLASS_TITLE = "살사 LA 입문";
const INSTRUCTOR_NAME = "오세린";
const NON_MEMBER_DEMO_INSTRUCTOR = "윤하늘";
const STEPS = [
  { emails: ["demo-absent-haeun@example.com", "demo-absent-sua@example.com"], level: 2 },
  { emails: ["demo-absent-jiho@example.com"], level: 1 },
] as const;

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

// 그 수업의 판매 단위와 담당 강사 — 읽기만 한다
const [target] = await q<{ offering_id: string; auth_user_id: string }>(
  `SELECT o.id::text AS offering_id, st.auth_user_id
     FROM classes c JOIN class_offerings o ON o.class_id = c.id JOIN staff_accounts st ON st.id = c.instructor_account_id
    WHERE c.title = $1 AND st.display_name = $2 ORDER BY o.created_at LIMIT 1`,
  [CLASS_TITLE, INSTRUCTOR_NAME],
);
if (target === undefined) {
  console.error(`「${CLASS_TITLE}」(${INSTRUCTOR_NAME}) 수업이 없다 — dev-demo-instructor-absences.ts 를 먼저 돌린다`);
  await finish(1);
}
const t = target!;

// 강사 앱이 들고 있는 것과 같은 세션 토큰을 하나 만든다(Bearer) — 경로는 이 세션으로 「누가 부르는가」를 확인한다
const session = await ctx.internalAdapter.createSession(t.auth_user_id);
const deps = createDeps();
const route = createInstructorLevelEvaluationsRoute({
  db,
  getSession: (headers) => auth.api.getSession({ headers }),
  clock: deps.clock,
  instructorMembership: deps.instructorMembership,
});

for (const step of STEPS) {
  const rows = await q<{ id: string }>(
    `SELECT m.id::text AS id FROM members m JOIN auth."user" u ON u.id = m.auth_user_id WHERE u.email = ANY($1::text[]) ORDER BY u.email`,
    [step.emails],
  );
  if (rows.length !== step.emails.length) {
    console.error(`수강생을 찾지 못했다: ${step.emails.join(", ")}`);
    await finish(1);
  }
  const res = await route(
    new Request("http://localhost:3000/api/instructor/level-evaluations", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ offeringId: t.offering_id, detailGenre: "salsa", memberIds: rows.map((r) => r.id), level: step.level }),
    }),
    undefined,
  );
  const body = await res.text();
  if (res.status !== 200) {
    console.error(`레벨 정하기 실패 ${res.status}: ${body}`);
    await finish(1);
  }
  console.log(`최종 적용 살사 ${step.level} → ${step.emails.join(", ")}: ${body}`);
}

// S6-3.9(강사 승급 제안 받기·거절 API) — 최하은이 받은 안내에 「이 레벨로 승급하기」를 누른 것과 같다.
//   회원 앱이 부르는 진짜 경로 POST /api/me/level-offers/{offerId}/accept 의 처리기를 최하은 세션으로 부른다 → 살사 Lv.2 + 카드 1장.
//   이수아의 안내는 열어 둔다 — 앱 연출(M25B 「이 카드를 발급받겠습니까?」, S6-3.10)을 시연할 몫이다.
//   두 번 돌려도 같은 결과: 이미 답한 안내는 열린 안내 목록에 없으니 건너뛴다(경로를 다시 부르면 409 라 부르지 않는다).
const ACCEPT_EMAIL = "demo-absent-haeun@example.com";
const [accepter] = await q<{ member_id: string; auth_user_id: string }>(
  `SELECT m.id::text AS member_id, m.auth_user_id FROM members m JOIN auth."user" u ON u.id = m.auth_user_id WHERE u.email = $1`,
  [ACCEPT_EMAIL],
);
if (accepter !== undefined) {
  const open = (await readMeLevels(db, accepter.member_id)).pendingOffers.find((o) => o.detailGenre === "salsa");
  if (open === undefined) {
    console.log(`승급 받기: ${ACCEPT_EMAIL} 는 열린 살사 안내가 없다 — 건너뛴다(이미 받았거나 아직 안내 전)`);
  } else {
    const memberSession = await ctx.internalAdapter.createSession(accepter.auth_user_id);
    const offers = createMeLevelOfferRoutes({ db, getSession: (headers) => auth.api.getSession({ headers }), clock: deps.clock });
    const res = await offers.accept(
      new Request(`http://localhost:3000/api/me/level-offers/${open.offerId}/accept`, {
        method: "POST",
        headers: { authorization: `Bearer ${memberSession.token}` },
      }),
      { params: Promise.resolve({ offerId: open.offerId }) },
    );
    const body = await res.text();
    if (res.status !== 200) {
      console.error(`승급 받기 실패 ${res.status}: ${body}`);
      await finish(1);
    }
    console.log(`승급 받기 ${ACCEPT_EMAIL} 「${open.message}」 → ${body}`);
  }
}

// 결과 요약 — 회원 화면 응답(GET /api/me/levels 와 같은 함수)에서 레벨과 승급 안내만
const enrollees = await q<{ id: string; email: string }>(
  `SELECT m.id::text AS id, u.email FROM members m JOIN auth."user" u ON u.id = m.auth_user_id
    WHERE u.email LIKE 'demo-absent-%@example.com' ORDER BY u.email`,
);
for (const e of enrollees) {
  const view = await readMeLevels(db, e.id);
  const salsa = view.items.find((i) => i.detailGenre === "salsa");
  const offers = view.pendingOffers.map((o) => `「${o.message}」`).join(" ") || "안내 없음";
  const reveal = view.pendingReveal.map((r) => `카드 Lv.${r.level}(${r.reason})`).join(" ") || "새 카드 없음";
  console.log(`  ${e.email}: 살사 Lv.${salsa?.level ?? 0} · ${offers} · ${reveal}`);
}
const [nonMember] = await q<{ id: string }>(`SELECT s.id::text AS id FROM staff_accounts s
    WHERE s.display_name = $1 AND EXISTS (SELECT 1 FROM instructor_affiliations ia WHERE ia.instructor_account_id = s.id AND ia.status = 'active')
    ORDER BY s.created_at LIMIT 1`, [NON_MEMBER_DEMO_INSTRUCTOR]);
if (nonMember !== undefined) console.log(`잠긴 화면 시연: admin-web/.env 에 FAKE_INSTRUCTOR_NON_MEMBER_IDS=${nonMember.id}`);
await finish(0);
