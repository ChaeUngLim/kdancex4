// 개발 DB 전용 — S6-3.5(개강 후보)의 시연 데이터. 「살사 LA 입문」 수강생 일부가 「새 반 안내에 연락처 제공」에 동의하게 한다.
//
// 무엇을 넣나(행을 SQL 로 넣지 않는다 — 회원 앱이 부르는 진짜 경로 PUT /api/me/contact-consent 의 처리기를 회원 세션으로 부른다):
//   박지호 · 최하은 · 이수아 → 동의(consented: true). 김우진 · 정서준 → 동의하지 않음(행 없음 = 동의 안 함, 아무것도 부르지 않는다)
//   그다음 오세린 강사(그 학원 소속)가 보드 I15 에서 「살사 Lv.0~3 · 화·목 20:30~21:30 · 정원 남 8 · 여 8」로
//   `후보 찾기`를 누른 것과 같은 경로 GET /api/instructor/new-class-candidates 를 불러 결과를 보여 준다(이 경로는 아무것도 쓰지 않는다).
//   명단 경로(…/list)는 부를 때마다 감사 한 줄을 남기므로 여기서는 부르지 않는다 — 다시 돌려도 결과가 같게.
//
// 두 번 돌려도 같은 결과: 같은 값 PUT 은 아무것도 쓰지 않는다(감사도 없다).
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-new-class-candidates.ts
//   먼저 dev-demo-instructor-absences.ts(수업·수강생 5명) · dev-demo-level-evaluation.ts(완주 판정·레벨) ·
//   dev-demo-level-offers.ts(오세린의 평가 레벨)가 있어야 한다. 개발 서버는 필요 없다.
import "dotenv/config";
import "temporal-polyfill/full/global";

import { createDeps } from "../lib/server/deps";
import { createMeContactConsentRoutes } from "../lib/server/services/me-contact-consent";
import { createNewClassCandidatesRoute } from "../lib/server/services/new-class-candidates";
import { createStaffAuth } from "../lib/server/staff-auth";
import { createDb } from "../prisma/db";

const INSTRUCTOR_NAME = "오세린";
const CONSENTING = ["demo-absent-jiho@example.com", "demo-absent-haeun@example.com", "demo-absent-sua@example.com"] as const;
const QUERY = "?detailGenre=salsa&levelFrom=0&levelTo=3&weekdays=tue,thu&timeFrom=20:30&timeTo=21:30&capacityMale=8&capacityFemale=8";

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);
const getSession = (headers: Headers) => auth.api.getSession({ headers });
const deps = createDeps();

async function finish(code = 0): Promise<never> {
  await db.close();
  await pool.end();
  process.exit(code);
}

// ① 회원 세 명이 마이 화면에서 동의를 켠다 — 회원 세션 토큰을 만들어 진짜 경로 처리기를 부른다
const consentRoutes = createMeContactConsentRoutes({ db, getSession, clock: deps.clock });
const people = await q<{ email: string; auth_user_id: string }>(
  `SELECT u.email, m.auth_user_id FROM members m JOIN auth."user" u ON u.id = m.auth_user_id WHERE u.email = ANY($1::text[]) ORDER BY u.email`,
  [CONSENTING],
);
if (people.length !== CONSENTING.length) {
  console.error("수강생을 찾지 못했다 — dev-demo-instructor-absences.ts 를 먼저 돌린다");
  await finish(1);
}
for (const person of people) {
  const before = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM candidate_contact_consents c JOIN members m ON m.id = c.member_id WHERE m.auth_user_id = $1 AND c.consented`,
    [person.auth_user_id],
  );
  const session = await ctx.internalAdapter.createSession(person.auth_user_id);
  const res = await consentRoutes.put(
    new Request("http://localhost:3000/api/me/contact-consent", {
      method: "PUT",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ consented: true }),
    }),
    undefined,
  );
  if (res.status !== 200) {
    console.error(`동의 실패 ${res.status}: ${await res.text()}`);
    await finish(1);
  }
  console.log(`${person.email}: ${before[0]!.n > 0 ? "이미 동의 — 건너뜀" : "동의함"} ${await res.text()}`);
}

// ② 오세린 강사가 후보를 찾는다 — 읽기만 한다
const [instructor] = await q<{ auth_user_id: string }>(
  `SELECT s.auth_user_id FROM staff_accounts s
    WHERE s.display_name = $1 AND EXISTS (SELECT 1 FROM instructor_affiliations ia WHERE ia.instructor_account_id = s.id AND ia.status = 'active')
    ORDER BY s.created_at LIMIT 1`,
  [INSTRUCTOR_NAME],
);
if (instructor === undefined) {
  console.error(`${INSTRUCTOR_NAME} 강사가 없다 — dev-demo-instructor-absences.ts 를 먼저 돌린다`);
  await finish(1);
}
const staffSession = await ctx.internalAdapter.createSession(instructor!.auth_user_id);
const summary = await createNewClassCandidatesRoute({
  db,
  getSession,
  clock: deps.clock,
  instructorMembership: deps.instructorMembership,
  revealRootSecret: process.env["BETTER_AUTH_SECRET"] ?? "",
})(new Request(`http://localhost:3000/api/instructor/new-class-candidates${QUERY}`, { headers: { authorization: `Bearer ${staffSession.token}` } }), undefined);
console.log(`후보 찾기(${INSTRUCTOR_NAME}, 살사 Lv.0~3 · 20:30~21:30) ${summary.status}: ${await summary.text()}`);
await finish(summary.status === 200 ? 0 : 1);
