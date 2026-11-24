// 개발 DB 전용 — 앱 AI 플래너의 강사 수업 말로 찾기(보드 M10F·M10G)와 강사 프로필(M15) 입구를 실제 서버 데이터로 보이게 하는 시연 데이터(SX-5.7).
//
// 무엇을 넣나(brad 대표의 학원 「브래드 댄스 스튜디오」에):
//   ① 강사 「이준호」(살사/바차타) — 게시 수업 2개. 보드 M10F 의 두 카드와 같은 이름·요일·시간·가격
//      - 바차타 센슈얼 입문 · A홀 · 금 20:00–21:00 · 120,000원 · 입문 · 남 6/여 6 모두 찬 「마감」
//        (보드는 화요일이지만 개발 DB 의 A홀 화요일 저녁이 다른 시연 수업으로 차 있어 금요일로 옮겼다 — 홀 겹침 409)
//      - 바차타 커플반 · B홀 · 목 21:00–22:00 · 140,000원 · 초급 · 남 2 · 여 3 남음
//   ② 같은 이름 강사 「김하나」 두 명(보드 M10G) — 댄스스포츠 한 명(수업 없음) · 살사/바차타 한 명(게시 수업 1개)
//      - 살사 온원 중급 · B홀 · 토 14:00–15:00 · 130,000원
//
//   ③ (SX-5.8 — 여러 학원·주말/평일 수업) 이준호가 다른 두 학원에도 소속돼 수업을 올린다. 학원 이름은 가상이다
//      - 「살사포인트 홍대」(서울 마포구) · 살사 주말 입문 토 11:00–12:30 110,000원 입문 · 바차타 주말 초급 일 16:00–17:30 125,000원 초급(마감)
//      - 「라틴무브 성수」(서울 성동구) · 살사 온투 초중급 일 13:00–14:30 135,000원 · 평일 저녁 살사 초급 수 19:30–21:00 115,000원
//      → 「이준호 강사 주말 수업」 3개(학원 2곳), 「평일 저녁」 3개(목·금 브래드 + 수 성수), 「그중 토요일만」 1개
//      학원 대표 계정은 로그인용이 아니라 수업 승인 경로를 부르기 위한 시연 계정이다(demo-planner-owner-<키>@example.com)
//
// 넣는 방법
//   - 강사 계정·소속은 관리자 콘솔 시연(dev-demo-console-data.ts)과 같은 표·같은 방식으로 SQL 로 넣는다(가입 경로에는 본인확인이 걸려 있다).
//   - **수업은 진짜 등록 경로**(POST /api/classes → submit → 대표 approve)를 그대로 불러 만든다(dev-demo-member-catalog.ts 와 같은 방식).
//   - 신청 인원은 주문 경로를 거치지 않고 자리 묶음의 확정 수(confirmed_count)만 시연 값으로 올린다(member-catalog 와 같은 이유).
//   - 학원 이름은 보드의 「라틴하우스 강남」이 아니라 brad 학원 이름이다 — 개발 DB 에 「라틴하우스 강남」이 테스트 찌꺼기로 여러 곳 있어
//     이름으로 하나로 정해지지 않기 때문이다(SX-5.5 일반 검색은 하나로 정해진 학원만 고른다).
//   - 강사 사진은 넣지 않는다(강사 프로필 사진은 AI 로 만들지 않는다, spec FR-061b).
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-planner-search.ts
//   두 번 돌려도 같은 결과 — 강사는 표식(auth_user_id = demo-planner-<키>)으로, 수업은 (강사, 수업명)으로 이미 있는지 보고 있으면 건너뛴다.
//   중간에 멈췄다가 다시 돌려도 빠진 것만 채운다. 먼저 scripts/dev-demo-owner.ts(brad)가 있어야 한다.
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { createDb } from "../prisma/db";
import { createClassApprovalRoutes } from "../lib/server/services/class-approval";
import { classRegistrationSchema, createClassRegistrationRoutes } from "../lib/server/services/class-registration";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = "http://localhost:3000";
const MARK = "demo-planner-";

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);

const finish = async (message: string) => {
  console.log(message);
  await db.close();
  await pool.end();
};

// ---- brad 대표 · 학원 · 홀 -------------------------------------------------------------------------
const [owner] = await q<{ user_id: string; staff_id: string; academy_id: string }>(
  `SELECT u.id AS user_id, s.id AS staff_id, o.academy_id FROM auth."user" u
     JOIN staff_accounts s ON s.auth_user_id = u.id JOIN academy_owners o ON o.staff_account_id = s.id
   WHERE u.username = 'brad'`,
);
if (owner === undefined) throw new Error("brad 대표가 없다 — scripts/dev-demo-owner.ts 를 먼저 돌린다");
const rooms = await q<{ id: string; name: string }>(
  "SELECT r.id, r.name FROM rooms r JOIN academy_branches b ON b.id = r.branch_id WHERE b.academy_id = $1 AND r.status = 'active' ORDER BY r.name",
  [owner.academy_id],
);

// ---- 강사 3명(가상 이름·가려진 전화) ---------------------------------------------------------------
type InstructorSeed = { key: string; name: string; phone: string; genre: "salsa_bachata" | "dance_sport"; color: number };
const INSTRUCTORS: InstructorSeed[] = [
  { key: "junho", name: "이준호", phone: "010-****-5678", genre: "salsa_bachata", color: 1 },
  { key: "hana-ds", name: "김하나", phone: "010-****-1102", genre: "dance_sport", color: 4 },
  { key: "hana-sb", name: "김하나", phone: "010-****-2203", genre: "salsa_bachata", color: 7 },
];
const staffIds: Record<string, string> = {};
for (const seed of INSTRUCTORS) {
  // 이미 넣은 강사면 그 id 를 그대로 쓴다
  const [existing] = await q<{ id: string }>("SELECT id FROM staff_accounts WHERE auth_user_id = $1", [`${MARK}${seed.key}`]);
  if (existing !== undefined) {
    staffIds[seed.key] = existing.id;
    console.log(`강사(이미 있음): ${seed.name} ${existing.id}`);
    continue;
  }
  const [row] = await q<{ id: string }>(
    `INSERT INTO staff_accounts (id, auth_user_id, display_name, phone_masked, status, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'active', now()) RETURNING id`,
    [`${MARK}${seed.key}`, seed.name, seed.phone],
  );
  const id = row!.id;
  staffIds[seed.key] = id;
  await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'instructor')", [id]);
  await q(
    "INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, $2, now(), now())",
    [id, seed.genre],
  );
  const [aff] = await q<{ id: string }>(
    `INSERT INTO instructor_affiliations
       (id, academy_id, instructor_account_id, status, source, is_academy_employee, requested_at, decided_at, calendar_color_index, updated_at)
     VALUES (uuidv7(), $1, $2, 'active', 'application', false, now(), now(), $3, now()) RETURNING id`,
    [owner.academy_id, id, seed.color],
  );
  // 프리랜서 소속은 승인 때처럼 몫 비율 첫 행(60%)을 둔다(콘솔 시연과 같다)
  await q(
    `INSERT INTO instructor_share_rates (id, affiliation_id, rate_bp, effective_from, created_by_account_id)
     VALUES (uuidv7(), $1, 6000, now(), $2)`,
    [aff!.id, owner.staff_id],
  );
  console.log(`강사: ${seed.name}(${seed.genre}) ${id}`);
}


// ---- (SX-5.8) 다른 학원 두 곳 + 이준호 소속 ---------------------------------------------------------
type AcademySeed = { key: string; name: string; gu: string; owner: string; address: string; rooms: string[] };
const EXTRA_ACADEMIES: AcademySeed[] = [
  { key: "hongdae", name: "살사포인트 홍대", gu: "마포구", owner: "한서윤", address: "서울 마포구 와우산로 000, 2층", rooms: ["메인홀"] },
  { key: "seongsu", name: "라틴무브 성수", gu: "성동구", owner: "오지민", address: "서울 성동구 성수이로 000, 4층", rooms: ["1홀", "2홀"] },
];
type AcademyRef = { academyId: string; userId: string; rooms: { id: string; name: string }[] };
const academies: Record<string, AcademyRef> = {
  brad: { academyId: owner.academy_id, userId: owner.user_id, rooms },
};
{
  const authForSeed = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
  const seedCtx = await authForSeed.$context;
  for (const seed of EXTRA_ACADEMIES) {
    const email = `${MARK}owner-${seed.key}@example.com`;
    const [existing] = await q<{ user_id: string; academy_id: string }>(
      `SELECT u.id AS user_id, o.academy_id FROM auth."user" u JOIN staff_accounts s ON s.auth_user_id = u.id
         JOIN academy_owners o ON o.staff_account_id = s.id WHERE u.email = $1`,
      [email],
    );
    let academyId: string;
    let userId: string;
    if (existing !== undefined) {
      academyId = existing.academy_id;
      userId = existing.user_id;
      console.log(`학원(이미 있음): ${seed.name} ${academyId}`);
    } else {
      // 대표 계정 + 승인된 학원 + 지점 + 홀 — dev-demo-owner.ts 와 같은 표·같은 값
      // 앞 실행이 사용자만 만들고 멈췄으면 그 사용자를 그대로 쓴다
      const [madeUser] = await q<{ id: string }>('SELECT id FROM auth."user" WHERE email = $1', [email]);
      const user =
        madeUser ??
        (await seedCtx.internalAdapter.createUser(
          { email, name: seed.owner, emailVerified: true, username: `demoplanner${seed.key}`, displayUsername: `demoplanner${seed.key}` },
          { method: "admin" },
        ));
      userId = user.id;
      academyId = randomUUID();
      const branchId = randomUUID();
      const [madeStaff] = await q<{ id: string }>("SELECT id FROM staff_accounts WHERE auth_user_id = $1", [user.id]);
      const staffId = madeStaff?.id ?? randomUUID();
      if (madeStaff === undefined) {
        await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [staffId, user.id, seed.owner]);
      }
      await q(
        `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, approved_at, registration_verified_at,
                                registration_type, industry_code, card_payment_enabled, business_name, representative_name,
                                business_registration_number, business_address, phone)
         VALUES ($1, $2, '서울', $3, 'active', now(), now() - interval '40 days', now() - interval '40 days',
                 'sports_facility', '921902', true, $6, $4, '1234567890', $5, '020000000')`,
        [academyId, seed.name, seed.gu, seed.owner, seed.address, seed.name],
      );
      await q(
        `INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, phone, updated_at)
         VALUES ($1, $2, '본점', $3, '서울', $4, '020000000', now())`,
        [branchId, academyId, seed.address, seed.gu],
      );
      for (const room of seed.rooms) {
        await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES (uuidv7(), $1, $2, 'active', now())", [branchId, room]);
      }
      await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffId]);
      await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'owner')", [staffId]);
      console.log(`학원: ${seed.name} ${academyId}`);
    }
    const academyRooms = await q<{ id: string; name: string }>(
      "SELECT r.id, r.name FROM rooms r JOIN academy_branches b ON b.id = r.branch_id WHERE b.academy_id = $1 AND r.status = 'active' ORDER BY r.name",
      [academyId],
    );
    academies[seed.key] = { academyId, userId, rooms: academyRooms };
    // 수업 승인 요청에는 학원의 정규 과정 환불 공지가 있어야 한다 — brad 학원 공지 글을 같은 판본 모양으로 옮겨 둔다
    const [notice] = await q<{ id: string }>("SELECT id FROM refund_notice_versions WHERE academy_id = $1 AND notice_kind = 'regular'", [academyId]);
    if (notice === undefined) {
      const [ownerStaffForNotice] = await q<{ id: string }>("SELECT id FROM staff_accounts WHERE auth_user_id = $1", [userId]);
      await q(
        `INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id)
         SELECT uuidv7(), $1, notice_kind, 1, body, content, $3 FROM refund_notice_versions
          WHERE academy_id = $2 AND notice_kind = 'regular' ORDER BY version DESC LIMIT 1`,
        [academyId, owner.academy_id, ownerStaffForNotice!.id],
      );
      console.log(`환불 공지: ${seed.name}`);
    }
    // 이준호의 소속(프리랜서, 몫 60%) — 이미 있으면 건너뛴다
    const [aff] = await q<{ id: string }>(
      "SELECT id FROM instructor_affiliations WHERE academy_id = $1 AND instructor_account_id = $2",
      [academyId, staffIds["junho"]],
    );
    if (aff === undefined) {
      const [created] = await q<{ id: string }>(
        `INSERT INTO instructor_affiliations
           (id, academy_id, instructor_account_id, status, source, is_academy_employee, requested_at, decided_at, calendar_color_index, updated_at)
         VALUES (uuidv7(), $1, $2, 'active', 'application', false, now(), now(), 1, now()) RETURNING id`,
        [academyId, staffIds["junho"]],
      );
      const [ownerStaff] = await q<{ id: string }>("SELECT s.id FROM staff_accounts s WHERE s.auth_user_id = $1", [userId]);
      await q(
        `INSERT INTO instructor_share_rates (id, affiliation_id, rate_bp, effective_from, created_by_account_id)
         VALUES (uuidv7(), $1, 6000, now(), $2)`,
        [created!.id, ownerStaff!.id],
      );
      console.log(`소속: 이준호 → ${seed.name}`);
    }
  }
}

// ---- 수업 — 진짜 등록 경로 ------------------------------------------------------------------------
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
// 학원마다 그 학원 대표의 세션으로 등록·승인한다
const ownerHeadersByAcademy: Record<string, Record<string, string>> = {};
for (const [key, ref] of Object.entries(academies)) {
  const token = (await ctx.internalAdapter.createSession(ref.userId)).token;
  ownerHeadersByAcademy[key] = { authorization: `Bearer ${token}`, "content-type": "application/json" };
}
const getSession = (h: Headers) => auth.api.getSession({ headers: h });
const registration = createClassRegistrationRoutes({ db, getSession });
const approval = createClassApprovalRoutes({ db, getSession });

type ClassSeed = {
  title: string;
  subGenre: string;
  level: "entry" | "beginner" | "novice_intermediate" | "intermediate";
  weekday: string;
  start: string;
  end: string;
  price: number;
  room: string;
  instructor: string;
  capacity: { male: number; female: number };
  confirmed: { male: number; female: number };
  /** 어느 학원 수업인가(없으면 brad 학원) */
  academy?: string;
};
const CLASSES: ClassSeed[] = [
  {
    title: "바차타 센슈얼 입문", subGenre: "bachata", level: "entry", weekday: "fri", start: "20:00", end: "21:00", price: 120000,
    room: "A홀", instructor: "junho", capacity: { male: 6, female: 6 }, confirmed: { male: 6, female: 6 },
  },
  {
    title: "바차타 커플반", subGenre: "bachata", level: "beginner", weekday: "thu", start: "21:00", end: "22:00", price: 140000,
    room: "B홀", instructor: "junho", capacity: { male: 6, female: 6 }, confirmed: { male: 4, female: 3 },
  },
  {
    title: "살사 온원 중급", subGenre: "salsa", level: "intermediate", weekday: "sat", start: "14:00", end: "15:00", price: 130000,
    room: "B홀", instructor: "hana-sb", capacity: { male: 8, female: 8 }, confirmed: { male: 3, female: 5 },
  },
  // SX-5.8 — 이준호의 다른 학원 수업(주말 3개 · 평일 저녁 1개 더)
  {
    title: "살사 주말 입문", subGenre: "salsa", level: "entry", weekday: "sat", start: "11:00", end: "12:30", price: 110000,
    room: "메인홀", instructor: "junho", capacity: { male: 8, female: 8 }, confirmed: { male: 2, female: 4 }, academy: "hongdae",
  },
  {
    title: "바차타 주말 초급", subGenre: "bachata", level: "beginner", weekday: "sun", start: "16:00", end: "17:30", price: 125000,
    room: "메인홀", instructor: "junho", capacity: { male: 6, female: 6 }, confirmed: { male: 6, female: 6 }, academy: "hongdae",
  },
  {
    title: "살사 온투 초중급", subGenre: "salsa", level: "novice_intermediate", weekday: "sun", start: "13:00", end: "14:30", price: 135000,
    room: "1홀", instructor: "junho", capacity: { male: 8, female: 8 }, confirmed: { male: 5, female: 4 }, academy: "seongsu",
  },
  {
    title: "평일 저녁 살사 초급", subGenre: "salsa", level: "beginner", weekday: "wed", start: "19:30", end: "21:00", price: 115000,
    room: "2홀", instructor: "junho", capacity: { male: 8, female: 8 }, confirmed: { male: 3, female: 3 }, academy: "seongsu",
  },
];

/** 임시 저장(초안)만 만든다. 앞 실행이 초안까지만 만들고 멈췄으면 그 초안을 이어 쓴다(publishClass 의 draftClassId) */
async function createDraft(
  seed: ClassSeed,
  academyId: string,
  ownerHeaders: Record<string, string>,
  roomOf: (name: string) => string,
): Promise<string> {
  const created = await registration.create(
    new Request(`${BASE}/api/classes`, {
      method: "POST",
      headers: { ...ownerHeaders, "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        academyId,
        classKind: "regular",
        title: seed.title,
        subGenre: seed.subGenre,
        discipline: null,
        targetLevel: seed.level,
        targetAges: ["all"],
        roomId: roomOf(seed.room),
        priceAmount: seed.price,
        schedule: { kind: "recurring", weekdays: [seed.weekday], startTime: seed.start, endTime: seed.end, periodFrom: "2026-12-01", periodTo: "2026-12-31" },
        capacity: { mode: "gender_split", male: seed.capacity.male, female: seed.capacity.female, any: null },
        refundDeadlineOn: null,
        introText: null,
        instructorAccountId: staffIds[seed.instructor],
      }),
    }),
    undefined,
  );
  if (created.status !== 201) throw new Error(`등록 실패 ${seed.title}: ${created.status} ${await created.text()}`);
  const { classId } = classRegistrationSchema.parse(await created.json());
  return classId;
}

/** 한 수업을 등록 → 제출 → (필요하면) 대표 승인까지. 실패하면 서버 응답을 그대로 보여 주고 멈춘다 */
async function publishClass(seed: ClassSeed, draftClassId: string | null): Promise<string> {
  const academyKey = seed.academy ?? "brad";
  const academy = academies[academyKey]!;
  const ownerHeaders = ownerHeadersByAcademy[academyKey]!;
  const roomOf = (name: string) => {
    const room = academy.rooms.find((r) => r.name === name);
    if (room === undefined) throw new Error(`${academyKey} 학원에 ${name} 이 없다`);
    return room.id;
  };
  const classId = draftClassId ?? (await createDraft(seed, academy.academyId, ownerHeaders, roomOf));
  // 초안일 때만 승인 요청을 보낸다(앞 실행이 요청까지 보내고 멈췄으면 승인만 남았다)
  const [before] = await q<{ status: string }>("SELECT status FROM classes WHERE id = $1", [classId]);
  if (before?.status === "draft") {
    const submitted = await registration.submit(
      new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: ownerHeaders, body: "{}" }),
      { params: Promise.resolve({ classId }) },
    );
    if (submitted.status !== 200) throw new Error(`제출 실패 ${seed.title}: ${submitted.status} ${await submitted.text()}`);
  }
  const [state] = await q<{ status: string }>("SELECT status FROM classes WHERE id = $1", [classId]);
  if (state?.status !== "published") {
    const academyId = academy.academyId;
    const approved = await approval.approve(
      new Request(`${BASE}/api/academies/${academyId}/classes/${classId}/approve`, { method: "POST", headers: ownerHeaders, body: "{}" }),
      { params: Promise.resolve({ academyId, classId }) },
    );
    if (approved.status !== 200) throw new Error(`승인 실패 ${seed.title}: ${approved.status} ${await approved.text()}`);
  }
  const [offering] = await q<{ id: string }>("SELECT id::text AS id FROM class_offerings WHERE class_id = $1", [classId]);
  // 시연용 신청 인원(확정 수). 정원을 넘지 않게 LEAST 로 막는다
  for (const [seatKind, count] of Object.entries(seed.confirmed)) {
    await q("UPDATE seat_pools SET confirmed_count = LEAST($3::int, capacity), updated_at = now() WHERE offering_id = $1 AND seat_kind = $2", [
      offering!.id,
      seatKind,
      count,
    ]);
  }
  return offering!.id;
}

for (const seed of CLASSES) {
  const [existing] = await q<{ id: string; status: string }>(
    "SELECT id, status FROM classes WHERE instructor_account_id = $1 AND title = $2",
    [staffIds[seed.instructor], seed.title],
  );
  if (existing?.status === "published") {
    console.log(`수업(이미 있음): ${seed.title}`);
    continue;
  }
  const offeringId = await publishClass(seed, existing?.id ?? null);
  console.log(`게시: ${seed.title} · 판매 단위 ${offeringId}`);
}

await finish(`넣었다: 강사 ${INSTRUCTORS.length}명 · 수업 ${CLASSES.length}개 · 학원 ${Object.keys(academies).length}곳`);
