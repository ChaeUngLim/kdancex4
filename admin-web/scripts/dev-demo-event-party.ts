// 개발 DB 전용 — 앱 이벤트형 결제 화면(보드 M9E)을 실제 서버 데이터로 보이게 하는 시연 수업 1개(S3-3.16(앱 결제 화면)).
//
// 무엇을 넣나: brad 대표의 학원(브래드 댄스 스튜디오)에 게시된 파티 1개 — 「연말 살사 파티」 30,000원, 남녀 구분 없는 20자리,
//   환불 마감일 2026-12-15. 진짜 등록 경로(POST /api/classes → submit → 대표 approve)로 만든다 — 판매 단위·자리 묶음·
//   이벤트형 공지 판본 고정을 경로가 한 번에 만들기 때문이다(dev-demo-member-catalog.ts 와 같은 방식).
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-event-party.ts
//   두 번 돌려도 같은 결과 — 같은 이름의 수업이 이미 있으면 아무것도 하지 않는다. 먼저 scripts/dev-demo-owner.ts(brad)가 있어야 한다.
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { createDb } from "../prisma/db";
import { createClassApprovalRoutes } from "../lib/server/services/class-approval";
import { classRegistrationSchema, createClassRegistrationRoutes } from "../lib/server/services/class-registration";
import { createStaffAuth } from "../lib/server/staff-auth";

const TITLE = "연말 살사 파티";
const BASE = "http://localhost:3000";

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);

const existing = await q<{ id: string }>("SELECT o.id::text AS id FROM classes c JOIN class_offerings o ON o.class_id = c.id WHERE c.title = $1", [TITLE]);
if (existing.length > 0) {
  console.log(`이미 있다: ${TITLE} · 판매 단위 ${existing[0]!.id}`);
  await db.close();
  await pool.end();
  process.exit(0);
}

const [owner] = await q<{ user_id: string; academy_id: string }>(
  `SELECT u.id AS user_id, o.academy_id FROM auth."user" u
     JOIN staff_accounts s ON s.auth_user_id = u.id JOIN academy_owners o ON o.staff_account_id = s.id
   WHERE u.username = 'brad'`,
);
if (owner === undefined) throw new Error("brad 대표가 없다 — scripts/dev-demo-owner.ts 를 먼저 돌린다");
const [room] = await q<{ id: string }>(
  "SELECT r.id FROM rooms r JOIN academy_branches b ON b.id = r.branch_id WHERE b.academy_id = $1 AND r.status = 'active' ORDER BY r.name LIMIT 1",
  [owner.academy_id],
);
// 활동 장르가 살사/바차타인 소속 강사 한 명 — 파티 장르는 담당 강사의 활동 장르에서 온다
const [instructor] = await q<{ id: string }>(
  `SELECT s.id FROM instructor_affiliations a JOIN staff_accounts s ON s.id = a.instructor_account_id
     JOIN instructor_profiles p ON p.staff_account_id = s.id
    WHERE a.academy_id = $1 AND a.status = 'active' AND p.activity_genre = 'salsa_bachata'
    ORDER BY s.display_name, s.id LIMIT 1`,
  [owner.academy_id],
);
if (room === undefined || instructor === undefined) throw new Error("brad 학원에 홀 또는 살사/바차타 강사가 없다");

const ownerToken = (await ctx.internalAdapter.createSession(owner.user_id)).token;
const ownerHeaders = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };
const getSession = (h: Headers) => auth.api.getSession({ headers: h });
const registration = createClassRegistrationRoutes({ db, getSession });
const approval = createClassApprovalRoutes({ db, getSession });

const created = await registration.create(
  new Request(`${BASE}/api/classes`, {
    method: "POST",
    headers: { ...ownerHeaders, "Idempotency-Key": randomUUID() },
    body: JSON.stringify({
      academyId: owner.academy_id,
      classKind: "party",
      title: TITLE,
      subGenre: "salsa",
      discipline: null,
      targetLevel: "entry",
      targetAges: ["all"],
      roomId: room.id,
      priceAmount: 30000,
      // 토요일 밤 — 다른 시연 수업(화·수·목 저녁)과 홀·강사 일정이 겹치지 않게
      schedule: { kind: "single", date: "2026-12-19", startTime: "21:00", endTime: "23:00" },
      capacity: { mode: "single", male: null, female: null, any: 20 },
      refundDeadlineOn: "2026-12-15",
      introText: null,
      instructorAccountId: instructor.id,
    }),
  }),
  undefined,
);
if (created.status !== 201) throw new Error(`등록 실패: ${created.status} ${await created.text()}`);
const { classId } = classRegistrationSchema.parse(await created.json());
const submitted = await registration.submit(
  new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: ownerHeaders, body: "{}" }),
  { params: Promise.resolve({ classId }) },
);
if (submitted.status !== 200) throw new Error(`제출 실패: ${submitted.status} ${await submitted.text()}`);
const [state] = await q<{ status: string }>("SELECT status FROM classes WHERE id = $1", [classId]);
// 대표가 직접 올린 수업은 제출과 동시에 게시될 수 있다 — 그때는 승인을 건너뛴다
if (state?.status !== "published") {
  const academyId = owner.academy_id;
  const approved = await approval.approve(
    new Request(`${BASE}/api/academies/${academyId}/classes/${classId}/approve`, { method: "POST", headers: ownerHeaders, body: "{}" }),
    { params: Promise.resolve({ academyId, classId }) },
  );
  if (approved.status !== 200) throw new Error(`승인 실패: ${approved.status} ${await approved.text()}`);
}
const [offering] = await q<{ id: string }>("SELECT id::text AS id FROM class_offerings WHERE class_id = $1", [classId]);
console.log(`게시: ${TITLE} · 판매 단위 ${offering!.id}`);

await db.close();
await pool.end();
