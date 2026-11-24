// M2-END.3(M2 완료 기준 시나리오) — M2(강사) 완료 기준(플랜 06 §M2 행)을 한 파일에서 처음부터 끝까지 한 번에 확인한다.
//   완료 기준: 가입 → 소속 승인 → 정규 8회차(남 6·여 6) 등록 → 공지 읽기 전용 자동 입력 → 승인 → 공개 목록에 나옴
//            · 같은 강사·같은 시각 거부(SC-009(강사 중복 배정 0건)) · 같은 강의실·같은 시각 거부(SC-008(강의실 중복 0건))
//            · 환불 마감일 없는 이벤트형 거부
//
// 이 파일이 Task 별 테스트와 다른 점:
//   - 강사를 DB 에 손으로 넣지 않는다. 진짜 가입 경로(S2-1.2(강사 가입 API), 가짜 본인확인) → 진짜 로그인(sign-in/username)
//     → 로그인 응답의 set-auth-token 을 앱처럼 `Authorization: Bearer` 로 쓴다. 그래서 수업 경로는 앱 면 위임(class_submit)을 본다.
//   - 소속도 손으로 넣지 않는다. 강사 신청(S2-1.3) → 대표 승인(S1-2, 몫 비율) → 대표가 앱 수업 등록 위임(class_submit)을 켠다(S1-2 위임 경로).
//   - 단계마다 앞 단계가 만든 값(강사 id → 소속 id → 수업 id)을 다음 단계가 그대로 받아 쓴다. 테스트 순서가 곧 시나리오 순서다.
//
// 손으로 준비하는 것(이미 M1 완료 기준 m1-owner-flow 가 경로로 확인한 대표 쪽 바닥):
//   대표 계정·학원·홀 2개, 학원의 환불 공지 판본(정규·이벤트형 각 1판), 강사 가입에 필요한 약관 판본.
// 「공개 목록」은 회원 홈 목록(계약 02 §1)의 조건 — 수업 published + 판매 단위 open + 첫 회차가 지금 이후 — 을 SQL 로 센다.
//   그 경로(GET /api/home/offerings)는 M3 몫이라 아직 없다(S2-2.7 테스트와 같은 방식).
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { toNextJsHandler } from "better-auth/next-js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock, systemClock } from "@/lib/domain/time";
import { FakeIdentityVerification } from "@/lib/server/fakes/fake-identity";
import { createRateLimiter, RATE_LIMIT_RULES } from "@/lib/server/rate-limit";
import { approvedAffiliationSchema, createApproveAffiliationRoute } from "@/lib/server/services/academy-affiliation-decisions";
import { createUpdateAffiliationPermissionsRoute, updatedDelegationsSchema } from "@/lib/server/services/academy-affiliation-permissions";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { appliedAffiliationSchema, createApplyAffiliationRoute } from "@/lib/server/services/instructor-affiliations";
import { createInstructorSignupRoutes, instructorSignupResponseSchema } from "@/lib/server/services/instructor-signup";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 서명 비밀값은 실행마다 새로 만든다 — 소스에 비밀값처럼 보이는 글자를 남기지 않는다(repo-secret-scan)
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const PASSWORD = "Latin!2026x";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6380";
// 수업·소속 경로의 시계. 정규 과정(12/01~12/24)과 원데이(12/06)가 모두 이 시각 뒤다
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");
const EVENT_DAY = "2026-12-06";

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};
const eventContent = { feeTiers: [{ window: "d7", percent: 10 }], nonRefundableCases: "당일 취소", processingBusinessDays: 3, ownerContact: "02-000-0000" };

describe.skipIf(!dbAvailable())("M2 완료 기준 — 강사 가입부터 게시까지 한 바퀴 + 거부 3종(M2-END.3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let authHandler: ReturnType<typeof toNextJsHandler>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const identity = new FakeIdentityVerification({
    secret: "fake-identity-secret-for-m2-gate-scenario-0123456789",
    ciPepper: "fake-identity-pepper-for-m2-gate-scenario-0123456789",
    clock: systemClock,
  });
  const limiter = createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: `kdance:test:m2-gate:${randomUUID()}` });

  // 시나리오가 이어 쓰는 값들 — 앞 단계가 채우고 뒤 단계가 읽는다
  let ownerId = "";
  let ownerToken = "";
  let academyId = "";
  const roomIds: Record<"A" | "B", string> = { A: "", B: "" };
  const noticeIds: Record<"regular" | "event", string> = { regular: "", event: "" };
  /** 강사 이름표 → { 직원 id, 앱 Bearer 토큰, 소속 id } */
  const instructors: Record<string, { id: string; token: string; affiliationId: string }> = {};
  let regularClassId = "";

  const deps = () => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: fixedClock(NOW) });
  const asOwner = () => ({ authorization: `Bearer ${ownerToken}`, "content-type": "application/json" });
  const asInstructor = (key: string) => ({ authorization: `Bearer ${instructors[key]?.token ?? ""}`, "content-type": "application/json" });

  // ---- 준비 도우미 ------------------------------------------------------------------------------

  /** 대표 — M1 에서 경로로 확인한 쪽이라 손으로 만든다. 관리자 경로를 부르므로 2단계를 켠 계정 + 세션 */
  async function makeOwner(): Promise<void> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: "owner@example.com", name: "owner", emailVerified: true, username: "owner_m2gate", displayUsername: "owner" },
      { method: "admin" },
    );
    await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    ownerToken = (await ctx.internalAdapter.createSession(user.id)).token;
    ownerId = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '대표', 'active', now())", [ownerId, user.id]);
    await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'owner')", [ownerId]);
  }

  /** 학원 1곳 + 지점 1곳 + 홀 2개(A·B) + 환불 공지 판본(정규·이벤트형 각 1판) */
  async function makeAcademy(): Promise<void> {
    academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '라틴하우스', '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, ownerId]);
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '서울 마포구 1', '서울', '마포구', now())",
      [branch, academyId],
    );
    for (const key of ["A", "B"] as const) {
      roomIds[key] = randomUUID();
      await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [roomIds[key], branch, `${key}홀`]);
    }
    for (const [kind, content] of [["regular", regularContent], ["event", eventContent]] as const) {
      noticeIds[kind] = randomUUID();
      await q(
        "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES ($1, $2, $3, 1, $4, $5, $6)",
        [noticeIds[kind], academyId, kind, `${kind} 공지 v1`, JSON.stringify(content), ownerId],
      );
    }
  }

  /** 강사 — 진짜 가입(I31C → I31) → 진짜 로그인. 로그인 응답의 set-auth-token 을 앱 Bearer 로 쓴다 */
  async function signUpAndLogin(key: string, displayName: string, gender: "male" | "female"): Promise<void> {
    const routes = createInstructorSignupRoutes({
      db: handle.db,
      identityVerification: identity,
      clock: systemClock,
      limiter,
      identityRule: { ...RATE_LIMIT_RULES.identityVerification, limit: 1000 },
    });
    const { verificationToken } = identity.issue({
      name: displayName,
      gender,
      birthDate: Temporal.PlainDate.from("1992-05-10"),
      phone: "01055507777",
      personKey: `m2-gate-${key}`,
    });
    const res = await routes.signup(
      new Request(`${BASE}/api/instructor/signup`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.88" },
        body: JSON.stringify({
          verificationToken,
          username: `${key}dance`,
          password: PASSWORD,
          displayName,
          activityGenre: "dance_sport",
          businessRegistrationNumber: null,
          consents: { merchantTerms: true, merchantPrivacyCollection: true, marketing: false },
        }),
      }),
      {},
    );
    expect(res.status).toBe(201);
    const account = instructorSignupResponseSchema.parse(await res.json());

    const login = await authHandler.POST(
      new Request(`${BASE}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ username: `${key}dance`, password: PASSWORD }),
      }),
    );
    expect(login.status).toBe(200);
    const token = login.headers.get("set-auth-token");
    expect(token).toBeTruthy();
    instructors[key] = { id: account.accountId, token: token ?? "", affiliationId: "" };
  }

  // ---- 경로 부르기 ------------------------------------------------------------------------------

  async function apply(key: string) {
    const res = await createApplyAffiliationRoute(deps())(
      new Request(`${BASE}/api/instructor/affiliations`, {
        method: "POST",
        headers: asInstructor(key),
        body: JSON.stringify({ academyId, message: "정규반을 맡고 싶어요" }),
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    return appliedAffiliationSchema.parse(await res.json());
  }

  async function ownerApprove(affiliationId: string) {
    const res = await createApproveAffiliationRoute(deps())(
      new Request(`${BASE}/api/academies/${academyId}/affiliations/${affiliationId}/approve`, {
        method: "POST",
        headers: asOwner(),
        body: JSON.stringify({ isAcademyEmployee: false, shareRateBp: 6000 }),
      }),
      { params: Promise.resolve({ academyId, id: affiliationId }) },
    );
    expect(res.status).toBe(200);
    return approvedAffiliationSchema.parse(await res.json());
  }

  /** 대표가 그 소속에 「앱 수업 등록」(class_submit) 위임을 켠다 — 없으면 강사 앱의 수업 등록은 403 */
  async function ownerGrantClassSubmit(affiliationId: string) {
    const res = await createUpdateAffiliationPermissionsRoute(deps())(
      new Request(`${BASE}/api/academies/${academyId}/affiliations/${affiliationId}/permissions`, {
        method: "PUT",
        headers: asOwner(),
        body: JSON.stringify({ permissions: ["class_submit"] }),
      }),
      { params: Promise.resolve({ academyId, id: affiliationId }) },
    );
    expect(res.status).toBe(200);
    return updatedDelegationsSchema.parse(await res.json());
  }

  const reg = () => createClassRegistrationRoutes(deps());
  const createClass = (key: string, body: unknown) =>
    reg().create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: { ...asInstructor(key), "Idempotency-Key": randomUUID() },
        body: JSON.stringify(body),
      }),
      undefined,
    );
  const submitClass = (key: string, classId: string) =>
    reg().submit(new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: asInstructor(key), body: "{}" }), {
      params: Promise.resolve({ classId }),
    });
  const approveClass = (classId: string) =>
    createClassApprovalRoutes(deps()).approve(
      new Request(`${BASE}/api/academies/${academyId}/classes/${classId}/approve`, { method: "POST", headers: asOwner(), body: "{}" }),
      { params: Promise.resolve({ academyId, classId }) },
    );

  /** 정규 과정 본문 — 화·목 12/01~12/24 = 8회차, 남 6·여 6 */
  const regularBody = (room: "A" | "B", startTime: string, endTime: string) => ({
    academyId,
    classKind: "regular",
    title: "쌈바(입문) · 12월",
    genre: "dance_sport",
    subGenre: "latin",
    discipline: "samba",
    targetLevel: "entry",
    targetAges: ["all"],
    roomId: roomIds[room],
    priceAmount: 300000,
    schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime, endTime, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
    capacity: { mode: "gender_split", male: 6, female: 6 },
    refundDeadlineOn: null,
    introText: null,
  });

  /** 강사가 몰래 붙여 보내는 공지 값 — 서버가 버려야 한다 */
  const forgedNotice = () => ({
    versionId: randomUUID(),
    kind: "regular",
    version: 99,
    content: { cancellableUntil: "강사가 바꾼 문구", tiers: [{ point: "any", percent: 0 }] },
    readOnly: false,
  });

  /** 회원 홈 목록(계약 02 §1)의 판매 조건 그대로 — 공개 수업 + 열린 판매 단위 + 첫 회차가 지금 이후 */
  const publicListCount = async (classId: string) =>
    Number(
      (
        await q(
          `SELECT count(*)::int AS n FROM class_offerings o JOIN classes c ON c.id = o.class_id
           WHERE c.id = $1 AND c.status = 'published' AND o.status = 'open' AND o.first_session_starts_at > $2::timestamptz`,
          [classId, NOW.toString()],
        )
      ).rows[0].n,
    );
  /** 학원 전체 회차 수 — 거부된 요청이 회차를 남기지 않았는지 본다 */
  const academySessionCount = async () =>
    Number(
      (
        await q(
          "SELECT count(*)::int AS n FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id JOIN classes c ON c.id = o.class_id WHERE c.academy_id = $1",
          [academyId],
        )
      ).rows[0].n,
    );

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    authHandler = toNextJsHandler(auth);
    await (await getMigrations(auth.options)).runMigrations();

    // 강사 가입에 필요한 필수 동의 둘의 시행 중 판본
    await q(
      `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at) VALUES
         (uuidv7(), 'merchant_terms', '1.0', '입점 이용약관 1.0', now() - interval '40 days', now() - interval '10 days'),
         (uuidv7(), 'merchant_privacy_collection', '1.0', '개인정보 수집·이용 1.0', now() - interval '40 days', now() - interval '10 days')`,
    );
    await makeOwner();
    await makeAcademy();
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 가입 — 강사 둘이 본인확인 → 아이디·비밀번호로 가입하고 앱 토큰으로 로그인한다", async () => {
    await signUpAndLogin("junho", "이준호", "male");
    await signUpAndLogin("seoyun", "박서윤", "female");

    const { rows } = await q(
      `SELECT s.id::text AS id, p.activity_genre, array_agg(g.role ORDER BY g.role) AS roles
       FROM staff_accounts s JOIN instructor_profiles p ON p.staff_account_id = s.id JOIN role_grants g ON g.staff_account_id = s.id
       WHERE s.id = ANY($1::uuid[]) GROUP BY s.id, p.activity_genre ORDER BY s.id`,
      [[instructors["junho"]?.id, instructors["seoyun"]?.id]],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.activity_genre === "dance_sport" && JSON.stringify(r.roles) === JSON.stringify(["instructor"]))).toBe(true);
  });

  test("② 소속 승인 — 신청(pending) → 대표 승인(몫 60%, active) → 앱 수업 등록 위임을 켠다", async () => {
    // 승인 전에는 수업을 못 올린다 — 소속이 없으니 403 AFFILIATION_REQUIRED
    const early = await createClass("junho", regularBody("A", "20:30", "21:30"));
    expect(early.status).toBe(403);
    expect((await early.json()).code).toBe("AFFILIATION_REQUIRED");

    for (const key of ["junho", "seoyun"]) {
      const applied = await apply(key);
      expect(applied).toMatchObject({ academyId, status: "pending" });
      const approved = await ownerApprove(applied.affiliationId);
      expect(approved).toMatchObject({ affiliationId: applied.affiliationId, status: "active", shareRateBp: 6000 });
      const delegated = await ownerGrantClassSubmit(applied.affiliationId);
      expect(delegated.permissions).toEqual(["class_submit"]);
      instructors[key] = { ...instructors[key]!, affiliationId: applied.affiliationId };
    }

    const { rows } = await q("SELECT status FROM instructor_affiliations WHERE academy_id = $1 ORDER BY id", [academyId]);
    expect(rows).toEqual([{ status: "active" }, { status: "active" }]);
  });

  test("③ 정규 8회차 등록 + 공지 자동 입력 — 강사가 보낸 공지는 버려지고 대표의 정규 판본이 읽기 전용으로 붙는다", async () => {
    const created = await createClass("junho", { ...regularBody("A", "20:30", "21:30"), refundNotice: forgedNotice() });
    expect(created.status).toBe(201);
    const draft = classRegistrationSchema.parse(await created.json());
    regularClassId = draft.classId;
    expect(draft.status).toBe("draft");
    expect(draft.schedule?.sessionCount).toBe(8);
    expect(draft.capacity).toEqual({ mode: "gender_split", male: 6, female: 6, any: null });
    // 공지 자동 입력(FR-099b) — 응답은 대표의 정규 판본, 읽기 전용
    expect(draft.refundNotice).toEqual({ versionId: noticeIds.regular, kind: "regular", version: 1, content: regularContent, readOnly: true });

    const submitted = await submitClass("junho", regularClassId);
    expect(submitted.status).toBe(200);
    expect(classRegistrationSchema.parse(await submitted.json()).status).toBe("pending_approval");

    // 승인 요청 때 판본 id 가 수업에 고정되고, 강사가 보낸 값은 DB 어디에도 없다
    const cls = (await q("SELECT refund_notice_version_id::text AS v, registration_payload::text AS payload FROM classes WHERE id = $1", [regularClassId]))
      .rows[0] as { v: string; payload: string };
    expect(cls.v).toBe(noticeIds.regular);
    expect(cls.payload).not.toContain("강사가 바꾼 문구");

    // 회차 8 · 자리 남 6·여 6 · 판매 단위는 아직 닫힘(승인 전이라 공개 목록 0)
    const { rows: offerings } = await q("SELECT id, status FROM class_offerings WHERE class_id = $1", [regularClassId]);
    expect(offerings).toHaveLength(1);
    expect(offerings[0].status).toBe("closed");
    const sessions = (await q("SELECT count(*)::int AS n FROM class_sessions WHERE offering_id = $1", [offerings[0].id])).rows[0].n;
    expect(sessions).toBe(8);
    const { rows: pools } = await q("SELECT seat_kind, capacity FROM seat_pools WHERE offering_id = $1 ORDER BY seat_kind", [offerings[0].id]);
    expect(pools).toEqual([{ seat_kind: "female", capacity: 6 }, { seat_kind: "male", capacity: 6 }]);
    expect(await publicListCount(regularClassId)).toBe(0);
  });

  test("④ 대표 승인 → 공개 목록에 1건", async () => {
    const res = await approveClass(regularClassId);
    expect(res.status).toBe(200);
    const pub = classRegistrationSchema.parse(await res.json());
    expect(pub.status).toBe("published");
    expect(pub.refundNotice?.versionId).toBe(noticeIds.regular);
    expect(await publicListCount(regularClassId)).toBe(1);
    // 강사에게 승인 알림 1건
    const notices = (await q("SELECT recipient_staff_account_id::text AS r FROM notifications WHERE kind = 'class_approved' AND payload->>'classId' = $1", [regularClassId]))
      .rows;
    expect(notices).toEqual([{ r: instructors["junho"]?.id }]);
  });

  test("⑤ 같은 강사·같은 시각 거부 — 다른 홀이라도 409 SCHEDULE_CONFLICT, 회차가 늘지 않는다(SC-009(강사 중복 배정 0건))", async () => {
    const before = await academySessionCount();
    const res = await createClass("junho", regularBody("B", "21:00", "22:00"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SCHEDULE_CONFLICT");
    expect(await academySessionCount()).toBe(before);
  });

  test("⑥ 같은 강의실·같은 시각 거부 — 다른 강사가 A홀 같은 시각이면 409 ROOM_CONFLICT, 회차가 늘지 않는다(SC-008(강의실 중복 0건))", async () => {
    const before = await academySessionCount();
    const res = await createClass("seoyun", regularBody("A", "20:30", "21:30"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ROOM_CONFLICT");
    expect(await academySessionCount()).toBe(before);
  });

  test("⑦ 환불 마감일 없는 이벤트형 거부 — 유료 원데이 승인 요청 422 REFUND_DEADLINE_REQUIRED, draft 그대로·회차 0", async () => {
    const created = await createClass("seoyun", {
      academyId,
      classKind: "one_day",
      title: "쌈바 원데이",
      subGenre: "latin",
      discipline: "samba",
      targetAges: ["all"],
      roomId: roomIds["B"],
      priceAmount: 30000,
      schedule: { kind: "single", date: EVENT_DAY, startTime: "14:00", endTime: "16:00" },
      capacity: { mode: "gender_split", male: 10, female: 10 },
      refundDeadlineOn: null,
    });
    expect(created.status).toBe(201);
    const draft = classRegistrationSchema.parse(await created.json());

    const before = await academySessionCount();
    const res = await submitClass("seoyun", draft.classId);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("REFUND_DEADLINE_REQUIRED");
    expect((await q("SELECT status FROM classes WHERE id = $1", [draft.classId])).rows[0].status).toBe("draft");
    expect(await academySessionCount()).toBe(before);
    expect(await publicListCount(draft.classId)).toBe(0);
  });
});
