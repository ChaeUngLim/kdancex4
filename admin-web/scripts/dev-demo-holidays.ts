// 개발 DB 전용 — 운영자 콘솔 P9 「공휴일 관리」(S7-4.8a(공휴일 운영자 입력 API(P9)))가 빈 표가 아니라 실제처럼 보이게 하는 시연 데이터.
//
// 무엇을 넣나(행을 SQL 로 직접 넣지 않고 진짜 경로를 부른다):
//   ① 시연 운영자 「데모 운영자」(demo-admin@example.com, 아이디 demoadmin) — 계정·직원·admin 역할만 만든다(로그인 신원 준비)
//   ② 2027년 자동 수집 줄 — 진짜 수집 서비스 syncHolidays 를 가짜 특일 정보(FakeSpecialDayProvider)와 함께 부른다.
//      바깥 API 는 부르지 않는다. 날짜는 시연용 예시다(실제 지정 공휴일과 다를 수 있다)
//   ③ 운영자 입력 줄 1개 — 진짜 처리기 POST /api/admin/console/holidays 로 「2027-05-06 임시 휴일(예시)」(계약 13 §10-1 예시와 같음)
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-holidays.ts
//   두 번 돌려도 같은 결과 — 운영자가 이미 있으면 그대로 쓰고, 2027년 수집 성공 기록이 있으면 수집을 건너뛰고,
//   같은 날짜 운영자 줄은 409(HOLIDAY_DATE_EXISTS)로 건너뛴다.
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { systemClock } from "../lib/domain/time";
import { FakeSpecialDayProvider, fakeHoliday } from "../lib/server/fakes/fake-special-days";
import { createAdminHolidaysRoutes } from "../lib/server/services/admin-holidays";
import { syncHolidays } from "../lib/server/services/holiday-sync";
import { createStaffAuth } from "../lib/server/staff-auth";
import { createDb } from "../prisma/db";

const ADMIN_USERNAME = "demoadmin";
const DEMO_YEAR = 2027;
// 시연용 2027년 공휴일(자동 수집 줄로 들어간다)
const DEMO_API_HOLIDAYS = [
  fakeHoliday("2027-01-01", "1월1일"),
  fakeHoliday("2027-02-06", "설날"),
  fakeHoliday("2027-02-07", "설날"),
  fakeHoliday("2027-02-08", "설날"),
  fakeHoliday("2027-02-09", "설날 대체", "substitute_holiday"),
  fakeHoliday("2027-03-01", "삼일절"),
  fakeHoliday("2027-05-05", "어린이날"),
  fakeHoliday("2027-05-13", "부처님오신날"),
  fakeHoliday("2027-06-06", "현충일"),
  fakeHoliday("2027-08-15", "광복절"),
  fakeHoliday("2027-08-16", "광복절 대체", "substitute_holiday"),
  fakeHoliday("2027-09-14", "추석"),
  fakeHoliday("2027-09-15", "추석"),
  fakeHoliday("2027-09-16", "추석"),
  fakeHoliday("2027-10-03", "개천절"),
  fakeHoliday("2027-10-04", "개천절 대체", "substitute_holiday"),
  fakeHoliday("2027-10-09", "한글날"),
  fakeHoliday("2027-10-11", "한글날 대체", "substitute_holiday"),
  fakeHoliday("2027-12-25", "기독탄신일"),
];
const DEMO_OPERATOR_HOLIDAY = { date: "2027-05-06", name: "임시 휴일(예시)", kind: "temporary_holiday" } as const;

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;

// ① 시연 운영자 — 있으면 그대로 쓴다
async function ensureDemoAdmin(): Promise<string> {
  const { rows } = await pool.query<{ user_id: string }>(`SELECT id AS user_id FROM auth."user" WHERE username = $1`, [ADMIN_USERNAME]);
  if (rows[0] !== undefined) return rows[0].user_id;
  const user = await ctx.internalAdapter.createUser(
    { email: "demo-admin@example.com", name: "데모 운영자", emailVerified: true, username: ADMIN_USERNAME, displayUsername: ADMIN_USERNAME },
    { method: "admin" },
  );
  // 콘솔 경로는 2단계를 마친 세션만 받는다 — 시연 계정은 인증 앱을 켠 것으로 둔다(세션 훅이 2단계 세션으로 적는다)
  await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
  const staffId = randomUUID();
  await pool.query("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '데모 운영자', 'active', now())", [
    staffId,
    user.id,
  ]);
  await pool.query("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'admin')", [staffId]);
  return user.id;
}

try {
  const adminUserId = await ensureDemoAdmin();

  // ② 자동 수집 줄 — 이미 2027년을 성공으로 받았으면 건너뛴다(수집 기록 줄이 늘지 않게)
  const { rowCount: synced } = await pool.query("SELECT 1 FROM holiday_sync_runs WHERE year = $1 AND status = 'success'", [DEMO_YEAR]);
  if ((synced ?? 0) === 0) {
    const specialDays = new FakeSpecialDayProvider().respond(DEMO_YEAR, { holidays: DEMO_API_HOLIDAYS });
    const result = await syncHolidays({ db, specialDays, clock: systemClock }, { years: [DEMO_YEAR] });
    console.log("자동 수집:", JSON.stringify(result.runs));
  } else {
    console.log(`자동 수집: ${DEMO_YEAR}년 성공 기록이 있어 건너뜀`);
  }

  // ③ 운영자 입력 줄 — 진짜 세션으로 진짜 처리기를 부른다
  const token = (await ctx.internalAdapter.createSession(adminUserId)).token;
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const routes = createAdminHolidaysRoutes({ db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: systemClock });
  const created = await routes.create(
    new Request("http://localhost:3000/api/admin/console/holidays", { method: "POST", headers, body: JSON.stringify(DEMO_OPERATOR_HOLIDAY) }),
    undefined,
  );
  const createdBody = (await created.json()) as Record<string, unknown>;
  if (created.status === 201) console.log("운영자 줄 더함:", JSON.stringify(createdBody));
  else if (createdBody["code"] === "HOLIDAY_DATE_EXISTS") console.log("운영자 줄: 같은 날짜가 이미 있어 건너뜀");
  else throw new Error(`운영자 줄 더하기 실패 ${created.status} ${JSON.stringify(createdBody)}`);

  // 결과 확인 — 화면이 읽을 목록 그대로
  const listed = await routes.list(new Request(`http://localhost:3000/api/admin/console/holidays?year=${DEMO_YEAR}`, { headers }), undefined);
  const listBody = (await listed.json()) as { items: { date: string; name: string; source: string; editable: boolean }[]; lastSync: unknown };
  console.log(`목록 ${listed.status}: ${listBody.items.length}줄, lastSync=${JSON.stringify(listBody.lastSync)}`);
  for (const item of listBody.items) console.log(`  ${item.date} ${item.name} (${item.source}${item.editable ? ", 고칠 수 있음" : ""})`);
} finally {
  await db.close();
  await pool.end();
}
