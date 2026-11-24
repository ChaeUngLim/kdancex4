// 개발 DB 전용 — S6-3.10(앱 등급 알림·카드 받기·카드 공개 연출)의 시연 데이터. 앱을 열면 홈 위에 등급 연출이 뜨게 한다.
//
// 무엇을 넣나(행을 SQL 로 넣지 않는다 — 앞 Task 시연 스크립트와 강사 앱이 부르는 진짜 경로를 그대로 쓴다):
//   ① 본인 레벨업 1건 — dev-demo-level-cards.ts(S6-3.8) → 레벨 계산 작업(runLevelEvaluation)으로 박지호·정우진이
//      「살사 LA 입문」을 끝까지 마쳐 Salsa Lv.1 (입문) 카드를 받는다. 연출 전이라 pendingReveal 에 남는다 → M25 → M25C(묻지 않음)
//   ② 강사 제안 1건(받기 시연) — dev-demo-level-offers.ts(S6-3.4·S6-3.9) → 오세린 강사가 이수아에게 살사 2(초급)를 안내 → M25 → M25B → 예
//   ③ 강사 제안(거절 시연) — 이 파일. 오세린 강사가 최서준에게 살사 2(초급), 정우진에게 살사 3(초급)을 안내한다
//      (POST /api/instructor/level-evaluations 처리기를 강사 세션으로 부른다) → M25 → M25B → 아니오 → 「지금 레벨 0 그대로예요」
//   최하은은 S6-3.9 에서 이미 안내를 받아 살사 Lv.2 카드(연출 전)가 있다 → 강사 승급이지만 이미 고른 것이라 M25 → M25C.
//
// 두 번 돌려도 같은 결과: 앞 스크립트들이 「이미 있으면 건너뜀」이고, 레벨 정하기 경로는 같은 값이면 아무것도 바꾸지 않는다.
//   단 앱에서 연출을 끝까지 보면(확인 · 예 · 아니오) 진짜 기록이 남아 그 회원의 연출은 다시 뜨지 않는다 — 시연 데이터가 「쓰인」 것이다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-level-up.ts
//   먼저 dev-demo-instructor-absences.ts(「살사 LA 입문」·수강생 5명)가 있어야 한다. 개발 서버는 필요 없다.
// 앱에서 보기(비밀번호는 dev-demo-instructor-absences.ts 의 PASSWORD): 박지호 = 본인 레벨업 · 이수아 = 카드 받기(예) ·
//   최서준 = 거절(아니오) · 정우진 = 본인 레벨업 카드 다음에 강사 안내 거절(차례 두 개)
import "dotenv/config";
import "temporal-polyfill/full/global";

import { spawnSync } from "node:child_process";

import { createDeps } from "../lib/server/deps";
import { createInstructorLevelEvaluationsRoute } from "../lib/server/services/instructor-level-evaluations";
import { readMeLevels } from "../lib/server/services/me-levels";
import { createStaffAuth } from "../lib/server/staff-auth";
import { createDb } from "../prisma/db";

const CLASS_TITLE = "살사 LA 입문";
const INSTRUCTOR_NAME = "오세린";
// 거절 시연 대상 둘 — 최서준(지금 0 → 2 안내), 정우진(완주 카드 Lv.1 연출 뒤에 1 → 3 안내가 이어지는 「차례 두 개」 시연).
//   첫 촬영(2026-11-25)에서 최서준 안내는 이미 「아니오」로 쓰였다. 정우진은 다시 찍을 때의 몫이다
const DECLINE_TARGETS = [
  { email: "demo-absent-seojun@example.com", level: 2 },
  { email: "demo-absent-woojin@example.com", level: 3 },
] as const;

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

// ①② 앞 Task 시연 스크립트를 차례로 부른다(각자 멱등)
for (const script of ["scripts/dev-demo-level-cards.ts", "scripts/dev-demo-level-offers.ts"]) {
  const run = spawnSync("./node_modules/.bin/jiti", [script], { stdio: "inherit" });
  if (run.status !== 0) throw new Error(`${script} 실패(exit ${run.status})`);
}

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);

async function finish(code = 0): Promise<never> {
  await db.close();
  await pool.end();
  process.exit(code);
}

// ③ 거절 시연용 안내 — 그 회원에게 살사 안내가 한 번도 없을 때만 보낸다(이미 거절했거나 받았으면 건너뛴다)
const [target] = await q<{ offering_id: string; auth_user_id: string }>(
  `SELECT o.id::text AS offering_id, st.auth_user_id
     FROM classes c JOIN class_offerings o ON o.class_id = c.id JOIN staff_accounts st ON st.id = c.instructor_account_id
    WHERE c.title = $1 AND st.display_name = $2 ORDER BY o.created_at LIMIT 1`,
  [CLASS_TITLE, INSTRUCTOR_NAME],
);
if (target === undefined) {
  console.error(`「${CLASS_TITLE}」 수업이 없다 — dev-demo-instructor-absences.ts 를 먼저 돌린다`);
  await finish(1);
}
const session = await ctx.internalAdapter.createSession(target!.auth_user_id);
const deps = createDeps();
const route = createInstructorLevelEvaluationsRoute({
  db,
  getSession: (headers) => auth.api.getSession({ headers }),
  clock: deps.clock,
  instructorMembership: deps.instructorMembership,
});
for (const decline of DECLINE_TARGETS) {
  const [member] = await q<{ id: string; answered: boolean }>(
    `SELECT m.id::text AS id,
            EXISTS (SELECT 1 FROM level_offers lo WHERE lo.member_id = m.id AND lo.detail_genre = 'salsa') AS answered
       FROM members m JOIN auth."user" u ON u.id = m.auth_user_id WHERE u.email = $1`,
    [decline.email],
  );
  if (member === undefined) {
    console.error(`${decline.email} 이 없다 — dev-demo-instructor-absences.ts 를 먼저 돌린다`);
    await finish(1);
  }
  if (member!.answered) {
    console.log(`거절 시연: ${decline.email} 는 살사 안내가 이미 있다 — 건너뛴다`);
    continue;
  }
  const res = await route(
    new Request("http://localhost:3000/api/instructor/level-evaluations", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ offeringId: target!.offering_id, detailGenre: "salsa", memberIds: [member!.id], level: decline.level }),
    }),
    undefined,
  );
  const body = await res.text();
  if (res.status !== 200) {
    console.error(`레벨 정하기 실패 ${res.status}: ${body}`);
    await finish(1);
  }
  console.log(`거절 시연 안내 살사 ${decline.level} → ${decline.email}: ${body}`);
}

// 요약 — 앱이 홈에서 읽는 것과 같은 함수(GET /api/me/levels)로 회원마다 「연출 차례」를 찍는다
const enrollees = await q<{ id: string; email: string }>(
  `SELECT m.id::text AS id, u.email FROM members m JOIN auth."user" u ON u.id = m.auth_user_id
    WHERE u.email LIKE 'demo-absent-%@example.com' ORDER BY u.email`,
);
for (const e of enrollees) {
  const view = await readMeLevels(db, e.id);
  const reveal = view.pendingReveal.map((r) => `카드 Lv.${r.fromLevel}→${r.level}(${r.reason}, ${r.characterKey})`);
  const offers = view.pendingOffers.map((o) => `안내 「${o.message}」`);
  console.log(`  연출 차례 ${e.email}: ${[...reveal, ...offers].join(" · ") || "없음"}`);
}
await finish(0);
