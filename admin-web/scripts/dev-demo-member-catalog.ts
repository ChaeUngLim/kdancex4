// 개발 DB 전용 — 앱 홈(보드 M7)·수업 상세(M8)·남녀 구분 없는 수업 상세(C13A)를 실제 서버 데이터로 보이게 하는 시연 데이터(S3-2.5).
//
// 무엇을 넣나:
//   ① 시연 회원 1명 — 이메일 demo-member@example.com / 비밀번호 demo-member-1234, 남자, 기준 장르 살사/바차타, 관심 지역 서울 강남구, 가능 18~23시
//   ② brad 대표의 학원(브래드 댄스 스튜디오)에 게시 수업 3개 — 진짜 등록 경로(POST /api/classes → submit → 대표 approve)를
//      그대로 불러 만든다. 수업 행을 SQL 로 직접 넣지 않는 이유: 판매 단위·자리 묶음·공지 판본 고정을 경로가 한 번에 만들기 때문이다
//      - 바차타 센슈얼 입문(남 6 · 여 6) — 보드 M8 처럼 여 자리가 마감된 상태
//      - 바차타 레이디스타일 기초(구분 없음 12) — 보드 C13A 의 단일 정원
//      - 살사 온원 기초(남 8 · 여 8)
//   ③ 신청 인원 — 주문·결제 경로(S3-3)가 아직 없어 자리 묶음의 확정 수(confirmed_count)만 시연 값으로 올린다.
//      화면이 읽는 「신청 인원 = 확정 수」 규칙(S3-2.3)은 그대로다. 진짜 주문이 생기면 이 단계는 필요 없다
//
// 왜 Bearer 로 부르나: 대표 brad 는 2단계 인증을 켠 계정이라 관리자 웹(쿠키) 면으로는 인증 코드가 필요하다.
//   앱 면(Bearer)은 같은 대표 권한 검사를 하되 2단계 인증을 요구하지 않는다(guards.ts ③) — 시연 스크립트는 앱 면으로 부른다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-member-catalog.ts
//   두 번 돌려도 같은 결과 — 시연 회원이 이미 있으면 아무것도 하지 않는다. 먼저 scripts/dev-demo-owner.ts(brad)가 있어야 한다.
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { createDb } from "../prisma/db";
import { createClassApprovalRoutes } from "../lib/server/services/class-approval";
import { classRegistrationSchema, createClassRegistrationRoutes } from "../lib/server/services/class-registration";
import { createStaffAuth } from "../lib/server/staff-auth";

const MEMBER_EMAIL = "demo-member@example.com";
const MEMBER_PASSWORD = "demo-member-1234";
const BASE = "http://localhost:3000";

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);

const done = await q("SELECT 1 FROM auth.\"user\" WHERE email = $1", [MEMBER_EMAIL]);
if (done.length > 0) {
  console.log(`이미 있다: ${MEMBER_EMAIL}`);
  await db.close();
  await pool.end();
  process.exit(0);
}

// ---- brad 대표 · 학원 · 홀 · 강사 2명 --------------------------------------------------------------
const [owner] = await q<{ user_id: string; academy_id: string }>(
  `SELECT u.id AS user_id, o.academy_id FROM auth."user" u
     JOIN staff_accounts s ON s.auth_user_id = u.id JOIN academy_owners o ON o.staff_account_id = s.id
   WHERE u.username = 'brad'`,
);
if (owner === undefined) throw new Error("brad 대표가 없다 — scripts/dev-demo-owner.ts 를 먼저 돌린다");
const rooms = await q<{ id: string }>(
  "SELECT r.id FROM rooms r JOIN academy_branches b ON b.id = r.branch_id WHERE b.academy_id = $1 AND r.status = 'active' ORDER BY r.name",
  [owner.academy_id],
);
// 활동 장르가 살사/바차타인 소속 강사 — 수업 장르는 담당 강사의 활동 장르에서 온다
const instructors = await q<{ id: string; name: string }>(
  `SELECT DISTINCT ON (s.display_name) s.id, s.display_name AS name
     FROM instructor_affiliations a JOIN staff_accounts s ON s.id = a.instructor_account_id
     JOIN instructor_profiles p ON p.staff_account_id = s.id
    WHERE a.academy_id = $1 AND a.status = 'active' AND p.activity_genre = 'salsa_bachata'
      AND NOT EXISTS (SELECT 1 FROM classes c WHERE c.instructor_account_id = s.id) -- 다른 시연이 남긴 수업과 일정이 겹치지 않게
    ORDER BY s.display_name, s.id LIMIT 2`,
  [owner.academy_id],
);
if (rooms.length === 0 || instructors.length < 2) throw new Error("brad 학원에 홀 또는 살사/바차타 강사가 부족하다");

const ownerToken = (await ctx.internalAdapter.createSession(owner.user_id)).token;
const ownerHeaders = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };
const getSession = (h: Headers) => auth.api.getSession({ headers: h });
const registration = createClassRegistrationRoutes({ db, getSession });
const approval = createClassApprovalRoutes({ db, getSession });

type ClassSeed = {
  title: string;
  subGenre: string;
  classKind: "regular" | "lady_style";
  weekdays: string[];
  start: string;
  end: string;
  price: number;
  capacity: { mode: "gender_split" | "single"; male: number | null; female: number | null; any: number | null };
  /** 시연용 확정 수 — 자리 종류별 */
  confirmed: Partial<Record<"male" | "female" | "any", number>>;
  instructor: number;
  room: number;
};

const SEEDS: ClassSeed[] = [
  {
    title: "바차타 센슈얼 입문", subGenre: "bachata", classKind: "regular",
    weekdays: ["tue"], start: "20:00", end: "21:00", price: 90000,
    capacity: { mode: "gender_split", male: 6, female: 6, any: null }, confirmed: { male: 5, female: 6 }, instructor: 0, room: rooms.length - 1,
  },
  {
    title: "바차타 레이디스타일 기초", subGenre: "bachata", classKind: "lady_style",
    weekdays: ["thu"], start: "20:00", end: "21:00", price: 120000,
    capacity: { mode: "single", male: null, female: null, any: 12 }, confirmed: { any: 9 }, instructor: 1, room: 0,
  },
  {
    title: "살사 온원 기초", subGenre: "salsa", classKind: "regular",
    weekdays: ["wed"], start: "19:30", end: "20:30", price: 110000,
    capacity: { mode: "gender_split", male: 8, female: 8, any: null }, confirmed: { male: 2, female: 3 }, instructor: 0, room: rooms.length - 1,
  },
];

/** 진짜 등록 경로로 한 수업을 만들어 게시까지 한다. 실패하면 서버 응답을 그대로 보여 주고 멈춘다 */
async function publishClass(seed: ClassSeed): Promise<string> {
  const created = await registration.create(
    new Request(`${BASE}/api/classes`, {
      method: "POST",
      headers: { ...ownerHeaders, "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        academyId: owner!.academy_id,
        classKind: seed.classKind,
        title: seed.title,
        subGenre: seed.subGenre,
        discipline: null,
        targetLevel: "entry",
        targetAges: ["all"],
        roomId: rooms[seed.room]!.id,
        priceAmount: seed.price,
        schedule: { kind: "recurring", weekdays: seed.weekdays, startTime: seed.start, endTime: seed.end, periodFrom: "2026-12-01", periodTo: "2026-12-31" },
        capacity: seed.capacity,
        refundDeadlineOn: null,
        introText: null,
        instructorAccountId: instructors[seed.instructor]!.id,
      }),
    }),
    undefined,
  );
  if (created.status !== 201) throw new Error(`등록 실패 ${seed.title}: ${created.status} ${await created.text()}`);
  const { classId } = classRegistrationSchema.parse(await created.json());
  const params = { params: Promise.resolve({ classId }) };
  const submitted = await registration.submit(
    new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: ownerHeaders, body: "{}" }),
    params,
  );
  // 대표가 직접 올린 수업은 제출과 동시에 게시될 수 있다 — 그때는 승인을 건너뛴다
  if (submitted.status !== 200) throw new Error(`제출 실패 ${seed.title}: ${submitted.status} ${await submitted.text()}`);
  const [state] = await q<{ status: string }>("SELECT status FROM classes WHERE id = $1", [classId]);
  if (state?.status !== "published") {
    const academyId = owner!.academy_id;
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

for (const seed of SEEDS) {
  const offeringId = await publishClass(seed);
  console.log(`게시: ${seed.title} · 판매 단위 ${offeringId}`);
}

// ---- 시연 회원 ---------------------------------------------------------------------------------------
const user = await ctx.internalAdapter.createUser(
  { email: MEMBER_EMAIL, name: "시연 회원", emailVerified: true, username: "demo_member", displayUsername: "demo_member" },
  { method: "admin" },
);
await ctx.internalAdapter.linkAccount({
  userId: user.id,
  providerId: "credential",
  accountId: user.id,
  password: await ctx.password.hash(MEMBER_PASSWORD),
});
const memberId = randomUUID();
await q(
  `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at,
                        base_genre, available_from, available_to, updated_at)
   VALUES ($1, $2, '김시연', 'male', '1994-05-10', '01000000000', $3, '시연', now(), 'salsa_bachata', '18:00'::time, '23:00'::time, now())`,
  [memberId, user.id, `demo-ci-${randomUUID()}`],
);
await q("INSERT INTO member_interest_genres (member_id, genre) VALUES ($1, 'salsa_bachata')", [memberId]);
await q("INSERT INTO member_regions (member_id, region_sido, region_gu) VALUES ($1, '서울', '강남구')", [memberId]);
console.log(`회원: ${MEMBER_EMAIL}`);

await db.close();
await pool.end();
