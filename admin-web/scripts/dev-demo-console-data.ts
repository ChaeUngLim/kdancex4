// 개발 DB 전용 — 시연 대표 brad 의 학원(라틴하우스 강남)에 관리자 웹 콘솔에서 보일 가상 데이터를 넣는다(2026-11-23 사용자 요청).
//   강사 6명(승인 대기 2 · 프리랜서 소속 3 · 학원 소속 직원 1)과 강사 공지 3건(발행 2 · 임시 저장 1).
//   E2E 도우미 seedAffiliation 과 같은 표·같은 값을 쓴다. 이름·전화는 모두 가상이다.
//   두 번 돌려도 같은 결과가 되도록, 이미 넣은 표식(auth_user_id 앞머리 demo-brad-)이 있으면 건너뛴다.
//   실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-console-data.ts
import "dotenv/config";

import pg from "pg";

const url = process.env["DATABASE_URL"] ?? "";
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");
const pool = new pg.Pool({ connectionString: url, max: 1 });

const { rows: owners } = await pool.query<{ staff_id: string; academy_id: string }>(
  `SELECT s.id AS staff_id, o.academy_id FROM auth."user" u
     JOIN staff_accounts s ON s.auth_user_id = u.id JOIN academy_owners o ON o.staff_account_id = s.id
   WHERE u.username = 'brad'`,
);
const owner = owners[0];
if (owner === undefined) throw new Error("brad 대표가 없다 — scripts/dev-demo-owner.ts 를 먼저 돌린다");

const { rowCount: done } = await pool.query("SELECT 1 FROM staff_accounts WHERE auth_user_id LIKE 'demo-brad-%'");
if ((done ?? 0) > 0) {
  console.log("이미 넣었다 — 건너뜀");
  await pool.end();
  process.exit(0);
}

type Seed = {
  name: string; phone: string; status: "pending" | "active"; message?: string; employee?: boolean;
  permissions?: string[]; daysAgo: number; color?: number;
};
// 가상 강사 — 장르는 학원(살사/바차타 중심)에 맞췄다
const SEEDS: Seed[] = [
  { name: "최유나", phone: "010-****-2231", status: "pending", message: "바차타 센슈얼 3년 차예요. 평일 저녁 수업 가능해요.", daysAgo: 1 },
  { name: "정민호", phone: "010-****-8810", status: "pending", message: "살사 온원 입문반 맡고 싶습니다.", daysAgo: 3 },
  { name: "이준호", phone: "010-****-5678", status: "active", permissions: ["class_submit", "roster_manage"], daysAgo: 40, color: 0 },
  { name: "박지훈", phone: "010-****-4402", status: "active", permissions: ["class_submit"], daysAgo: 25, color: 3 },
  { name: "한서윤", phone: "010-****-7719", status: "active", daysAgo: 12, color: 6 },
  { name: "김도현", phone: "010-****-3305", status: "active", employee: true, permissions: ["class_manage", "roster_manage", "class_submit"], daysAgo: 60, color: 9 },
];

let n = 0;
for (const seed of SEEDS) {
  n += 1;
  const at = new Date(Date.now() - seed.daysAgo * 86_400_000).toISOString();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO staff_accounts (id, auth_user_id, display_name, phone_masked, status, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'active', now()) RETURNING id`,
    [`demo-brad-${n}`, seed.name, seed.phone],
  );
  const instructorId = rows[0]!.id;
  await pool.query("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'instructor')", [instructorId]);
  const active = seed.status === "active";
  const { rows: aff } = await pool.query<{ id: string }>(
    `INSERT INTO instructor_affiliations
       (id, academy_id, instructor_account_id, status, source, applicant_message, is_academy_employee,
        requested_at, decided_at, calendar_color_index, updated_at)
     VALUES (uuidv7(), $1, $2, $3, 'application', $4, $5, $6::timestamptz, $7::timestamptz, $8, now()) RETURNING id`,
    [owner.academy_id, instructorId, seed.status, seed.message ?? null, seed.employee ?? false, at, active ? at : null, seed.color ?? null],
  );
  const affiliationId = aff[0]!.id;
  // 프리랜서 소속은 승인 때처럼 몫 비율 첫 행(60%)을 둔다. 학원 소속 직원은 몫 비율이 없다
  if (active && !seed.employee) {
    await pool.query(
      `INSERT INTO instructor_share_rates (id, affiliation_id, rate_bp, effective_from, created_by_account_id)
       VALUES (uuidv7(), $1, 6000, $2::timestamptz, $3)`,
      [affiliationId, at, owner.staff_id],
    );
  }
  for (const permission of seed.permissions ?? []) {
    await pool.query(
      "INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)",
      [affiliationId, permission, owner.staff_id],
    );
  }
}

// 강사 공지(관리자 웹 「직원 공지」) — 발행 2건 · 임시 저장 1건
const NOTICES = [
  { category: "academy_schedule", title: "12월 연말 파티 주간 시간표 안내", body: "12/22~12/28 은 파티 주간이라 저녁 정규 수업을 30분 앞당겨요. 각자 시간표를 확인해 주세요.", published: true, daysAgo: 2 },
  { category: "class_changed", title: "B홀 바닥 공사로 목요일 수업 A홀 이동", body: "11/27(목) 하루 B홀 바닥 보수가 있어요. 목요일 수업은 모두 A홀에서 진행해요.", published: true, daysAgo: 5 },
  { category: "other", title: "강사 회의 일정 조율(임시)", body: "12월 첫 주 강사 회의 가능한 시간을 적어 주세요.", published: false, daysAgo: 0 },
];
for (const notice of NOTICES) {
  const at = new Date(Date.now() - notice.daysAgo * 86_400_000).toISOString();
  await pool.query(
    `INSERT INTO academy_staff_notices (id, academy_id, author_account_id, category, title, body, status, published_at, recipient_count, created_at, updated_at)
     VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9::timestamptz, $9::timestamptz)`,
    [owner.academy_id, owner.staff_id, notice.category, notice.title, notice.body,
     notice.published ? "published" : "draft", notice.published ? at : null, notice.published ? 4 : null, at],
  );
}
console.log(`넣었다: 강사 ${SEEDS.length}명 · 공지 ${NOTICES.length}건 (학원 ${owner.academy_id})`);
await pool.end();
