// S2-1.3(소속 신청·초대 수락·재신청) — 강사 앱 쪽에서 S1-2 의 신청·초대·거절 경로를 끝까지 이어 불러 본다.
//   verify(수용 ②): 거절 → 강사 알림 행(사유 포함) → 재신청 성공. 직접 신청과 초대 링크 두 길 모두.
//   - 강사는 손으로 만들지 않고 진짜 가입 경로(S2-1.2, 가짜 본인확인)로 만들고 진짜 로그인 경로(sign-in/username)로 들어온다.
//     그래야 「가입 때 고른 활동 장르 하나」가 대표 알림·대표 소속 목록까지 흘러가는지 같이 볼 수 있다.
//   - 대표의 거절도 DB 를 직접 고치지 않고 실제 거절 경로(계약 08 §3)를 부른다 — 알림 행은 그 경로가 쓴다.
//   - 초대 링크로 들어와도 바로 소속되지 않고 승인 대기다(결정 3 · S1-2.5 와 같은 경로).
//
// 이름: verify 의 tests/db/s2-1-3.db.test.ts 는 Task 번호 이름이라 기능 이름으로 바꿨다.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { toNextJsHandler } from "better-auth/next-js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { systemClock, type Clock } from "@/lib/domain/time";
import { FakeIdentityVerification } from "@/lib/server/fakes/fake-identity";
import { createRateLimiter, RATE_LIMIT_RULES } from "@/lib/server/rate-limit";
import { createRejectAffiliationRoute, rejectedAffiliationSchema } from "@/lib/server/services/academy-affiliation-decisions";
import { affiliationListSchema, createListAcademyAffiliationsRoute } from "@/lib/server/services/academy-affiliation-list";
import { createCreateInviteRoute, createdInviteSchema } from "@/lib/server/services/academy-invites";
import {
  affiliationCardListSchema,
  appliedAffiliationSchema,
  createApplyAffiliationRoute,
  createListMyAffiliationsRoute,
} from "@/lib/server/services/instructor-affiliations";
import { acceptedAffiliationSchema, createAcceptInviteRoute } from "@/lib/server/services/instructor-invite-accept";
import { createInstructorSignupRoutes, instructorSignupResponseSchema } from "@/lib/server/services/instructor-signup";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 서명 비밀값은 실행마다 새로 만든다 — 소스에 비밀값처럼 보이는 글자를 남기지 않는다(repo-secret-scan)
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const PASSWORD = "Latin!2026x";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6380";
const START = Temporal.Instant.from("2026-11-21T03:00:00Z");

describe.skipIf(!dbAvailable())("강사 소속 신청·초대 수락·재신청 — 거절 알림 뒤 다시 신청(S2-1 수용 ②)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let authHandler: ReturnType<typeof toNextJsHandler>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 소속 경로들의 시계 — 단계마다 앞으로 돌려 「거절 뒤에 다시 신청」의 시간 순서를 분명히 한다
  let now = START;
  const clock: Clock = () => now;
  const tick = (minutes: number) => {
    now = now.add({ minutes });
  };
  const deps = () => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock });

  const identity = new FakeIdentityVerification({
    secret: "fake-identity-secret-for-affiliation-reapply-0123456789",
    ciPepper: "fake-identity-pepper-for-affiliation-reapply-0123456789",
    clock: systemClock,
  });
  const limiter = createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: `kdance:test:affiliation-reapply:${randomUUID()}` });

  const ownerToken: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  /** 강사 이름표 → { 직원 id, 로그인 쿠키 } */
  const instructors: Record<string, { id: string; cookie: string }> = {};

  // ---- 준비 도우미 ------------------------------------------------------------------------------

  /** 대표 — 관리자 웹 경로(2단계 필요)를 부르므로 2단계를 켠 계정 + 세션. 대표 쪽은 S1 에서 확인한 경로라 손으로 만든다 */
  async function makeOwner(key: string): Promise<string> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `owner_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    ownerToken[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, user.id, key]);
    await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'owner')", [id]);
    return id;
  }

  async function makeAcademy(key: string, ownerId: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `${key}댄스학원`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], ownerId]);
  }

  /** 강사 — 진짜 가입(I31C → I31) + 진짜 로그인. 활동 장르는 하나만 고른다 */
  async function signUpInstructor(key: string, genre: string, displayName: string) {
    const routes = createInstructorSignupRoutes({
      db: handle.db,
      identityVerification: identity,
      clock: systemClock,
      limiter,
      identityRule: { ...RATE_LIMIT_RULES.identityVerification, limit: 1000 },
    });
    const { verificationToken } = identity.issue({
      name: displayName,
      gender: "female",
      birthDate: Temporal.PlainDate.from("1994-03-02"),
      phone: "01055501234",
      personKey: `person-${key}`,
    });
    const res = await routes.signup(
      new Request(`${BASE}/api/instructor/signup`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.77" },
        body: JSON.stringify({
          verificationToken,
          username: `${key}dance`,
          password: PASSWORD,
          displayName,
          activityGenre: genre,
          businessRegistrationNumber: null,
          consents: { merchantTerms: true, merchantPrivacyCollection: true, marketing: false },
        }),
      }),
      {},
    );
    const signed = (await res.json()) as unknown;
    expect(res.status).toBe(201);
    const account = instructorSignupResponseSchema.parse(signed);

    const login = await authHandler.POST(
      new Request(`${BASE}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ username: `${key}dance`, password: PASSWORD }),
      }),
    );
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
    instructors[key] = { id: account.accountId, cookie };
  }

  // ---- 경로 부르기 ------------------------------------------------------------------------------

  const asInstructor = (key: string): Record<string, string> => ({ cookie: instructors[key]?.cookie ?? "", "content-type": "application/json" });
  const asOwner = (key: string): Record<string, string> => ({ authorization: `Bearer ${ownerToken[key]}`, "content-type": "application/json" });

  async function apply(instructor: string, academy: string, message: string | null) {
    const res = await createApplyAffiliationRoute(deps())(
      new Request(`${BASE}/api/instructor/affiliations`, {
        method: "POST",
        headers: asInstructor(instructor),
        body: JSON.stringify({ academyId: academyIds[academy], message }),
      }),
      undefined,
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async function myCards(instructor: string) {
    const res = await createListMyAffiliationsRoute(deps())(
      new Request(`${BASE}/api/instructor/affiliations`, { headers: asInstructor(instructor) }),
      undefined,
    );
    expect(res.status).toBe(200);
    return affiliationCardListSchema.parse(await res.json()).items;
  }

  async function ownerReject(owner: string, academy: string, affiliationId: string, body: unknown) {
    const academyId = academyIds[academy] ?? "";
    const res = await createRejectAffiliationRoute(deps())(
      new Request(`${BASE}/api/academies/${academyId}/affiliations/${affiliationId}/reject`, {
        method: "POST",
        headers: asOwner(owner),
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ academyId, id: affiliationId }) },
    );
    expect(res.status).toBe(200);
    return rejectedAffiliationSchema.parse(await res.json());
  }

  async function ownerPendingList(owner: string, academy: string) {
    const academyId = academyIds[academy] ?? "";
    const res = await createListAcademyAffiliationsRoute(deps())(
      new Request(`${BASE}/api/academies/${academyId}/affiliations?status=pending`, { headers: asOwner(owner) }),
      { params: Promise.resolve({ academyId }) },
    );
    expect(res.status).toBe(200);
    return affiliationListSchema.parse(await res.json()).items;
  }

  async function createInviteToken(owner: string, academy: string): Promise<string> {
    const academyId = academyIds[academy] ?? "";
    const res = await createCreateInviteRoute({ ...deps(), inviteBaseUrl: "https://k-dancex4.test" })(
      new Request(`${BASE}/api/academies/${academyId}/invites`, { method: "POST", headers: asOwner(owner), body: "{}" }),
      { params: Promise.resolve({ academyId }) },
    );
    expect(res.status).toBe(201);
    return createdInviteSchema.parse(await res.json()).inviteUrl.split("/invite/")[1] ?? "";
  }

  async function acceptInvite(instructor: string, token: string) {
    const res = await createAcceptInviteRoute(deps())(
      new Request(`${BASE}/api/instructor/invites/${token}/accept`, { method: "POST", headers: asInstructor(instructor) }),
      { params: Promise.resolve({ token }) },
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  // ---- DB 읽기 ----------------------------------------------------------------------------------

  const affiliationRows = async (instructor: string, academy: string) =>
    (
      await q(
        `SELECT id, status, source, reject_reason_code, reject_reason_text, decided_at
         FROM instructor_affiliations WHERE instructor_account_id = $1 AND academy_id = $2 ORDER BY requested_at, id`,
        [instructors[instructor]?.id, academyIds[academy]],
      )
    ).rows as { id: string; status: string; source: string; reject_reason_code: string | null; reject_reason_text: string | null }[];

  const notificationsFor = async (recipientId: string | undefined, kind: string) =>
    (
      await q(
        "SELECT recipient_staff_account_id, category, kind, dedupe_key, payload FROM notifications WHERE recipient_staff_account_id = $1 AND kind = $2 ORDER BY created_at, id",
        [recipientId, kind],
      )
    ).rows as { category: string; dedupe_key: string; payload: Record<string, unknown> }[];

  let ownerAId = "";
  let ownerBId = "";

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

    ownerAId = await makeOwner("ownerA");
    ownerBId = await makeOwner("ownerB");
    await makeAcademy("라틴하우스", ownerAId);
    await makeAcademy("스윙타운", ownerBId);
    await signUpInstructor("seoyun", "salsa_bachata", "박서윤");
    await signUpInstructor("haneul", "swing", "김하늘");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("직접 신청: 신청 → 대표 거절(사유) → 강사 알림 행 → 카드에 사유 → 다시 신청하면 새 pending(수용 ②)", async () => {
    // ① 가입한 강사가 앱에서 학원에 신청한다. 대표 알림·대표 목록에 가입 때 고른 활동 장르가 그대로 보인다
    const first = await apply("seoyun", "라틴하우스", "주말 저녁 수업을 맡고 싶어요");
    expect(first.status).toBe(201);
    const firstId = appliedAffiliationSchema.parse(first.json).affiliationId;
    const requested = await notificationsFor(ownerAId, "affiliation_requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]?.payload).toMatchObject({
      affiliationId: firstId,
      instructorName: "박서윤",
      genres: ["salsa_bachata"],
      message: "주말 저녁 수업을 맡고 싶어요",
    });
    expect((await ownerPendingList("ownerA", "라틴하우스"))[0]?.instructor).toMatchObject({
      accountId: instructors["seoyun"]?.id,
      activityGenre: "salsa_bachata",
    });

    // ② 대표가 사유를 골라 거절한다(실제 거절 경로)
    tick(30);
    const rejected = await ownerReject("ownerA", "라틴하우스", firstId, { reasonCode: "genre_mismatch", reasonText: null });
    expect(rejected).toMatchObject({ affiliationId: firstId, status: "rejected", reasonCode: "genre_mismatch" });

    // ③ 강사에게 거절 알림 행 1건 — 사유 코드와 사람이 읽는 사유 문장이 함께 남는다
    const rejectNotes = await notificationsFor(instructors["seoyun"]?.id, "affiliation_rejected");
    expect(rejectNotes).toHaveLength(1);
    expect(rejectNotes[0]).toMatchObject({ category: "operations", dedupe_key: `affiliation:${firstId}:rejected` });
    expect(rejectNotes[0]?.payload).toMatchObject({
      affiliationId: firstId,
      academyId: academyIds["라틴하우스"],
      reasonCode: "genre_mismatch",
      reasonText: null,
      body: "사유: 학원 장르와 맞지 않아요",
    });

    // ④ 강사 앱의 학원 카드(I27B)에도 거절과 사유가 보인다
    const afterReject = await myCards("seoyun");
    expect(afterReject).toHaveLength(1);
    expect(afterReject[0]).toMatchObject({ affiliationId: firstId, status: "rejected", rejectReasonCode: "genre_mismatch" });

    // ⑤ 다시 신청 → 201 새 pending 행. 옛 rejected 행과 거절 알림은 그대로 남는다
    tick(60);
    const again = await apply("seoyun", "라틴하우스", "바차타 초급반도 가능해요");
    expect(again.status).toBe(201);
    const againId = appliedAffiliationSchema.parse(again.json).affiliationId;
    expect(againId).not.toBe(firstId);

    const rows = await affiliationRows("seoyun", "라틴하우스");
    expect(rows.map((r) => [r.id, r.status, r.source, r.reject_reason_code])).toEqual([
      [firstId, "rejected", "application", "genre_mismatch"],
      [againId, "pending", "application", null],
    ]);
    expect(await notificationsFor(instructors["seoyun"]?.id, "affiliation_rejected")).toHaveLength(1);
    // 대표에게는 두 번째 신청 알림이 새로 간다(열쇠가 신청 id 마다 달라 막히지 않는다)
    const requestedAgain = await notificationsFor(ownerAId, "affiliation_requested");
    expect(requestedAgain.map((n) => n.dedupe_key)).toEqual([`affiliation:${firstId}:requested`, `affiliation:${againId}:requested`]);

    // 카드는 학원마다 최근 행 하나 — 이제 승인 대기
    const cards = await myCards("seoyun");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ affiliationId: againId, status: "pending", rejectReasonCode: null, decidedAt: null });
  });

  test("초대 링크: 받아도 승인 대기 → 대표 거절(기타·글) → 알림 행 → 새 링크로 다시 들어오면 새 pending", async () => {
    // ① 초대 링크로 들어와도 바로 소속되지 않는다 — source invite 인 pending 행
    tick(10);
    const token = await createInviteToken("ownerB", "스윙타운");
    const accepted = await acceptInvite("haneul", token);
    expect(accepted.status).toBe(201);
    const firstBody = acceptedAffiliationSchema.parse(accepted.json);
    expect(firstBody).toMatchObject({ status: "pending", source: "invite" });
    expect((await affiliationRows("haneul", "스윙타운")).some((r) => r.status === "active")).toBe(false);
    const requested = await notificationsFor(ownerBId, "affiliation_requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]?.payload).toMatchObject({ source: "invite", instructorName: "김하늘", genres: ["swing"], message: null });

    // ② 대표가 「기타」로 거절 — 글이 사유 문장이 된다
    tick(30);
    await ownerReject("ownerB", "스윙타운", firstBody.affiliationId, { reasonCode: "other", reasonText: "이번 학기 강사 모집이 끝났어요" });
    const notes = await notificationsFor(instructors["haneul"]?.id, "affiliation_rejected");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.payload).toMatchObject({
      affiliationId: firstBody.affiliationId,
      reasonCode: "other",
      reasonText: "이번 학기 강사 모집이 끝났어요",
      body: "사유: 이번 학기 강사 모집이 끝났어요",
    });
    expect((await myCards("haneul"))[0]).toMatchObject({
      status: "rejected",
      source: "invite",
      rejectReasonCode: "other",
      rejectReasonText: "이번 학기 강사 모집이 끝났어요",
    });

    // ③ 한 번 쓴 링크는 다시 못 쓴다 — 새 링크를 받아 다시 들어오면 새 pending(여전히 승인 대기)
    tick(60);
    expect((await acceptInvite("haneul", token)).status).toBe(409);
    const token2 = await createInviteToken("ownerB", "스윙타운");
    const again = await acceptInvite("haneul", token2);
    expect(again.status).toBe(201);
    const againBody = acceptedAffiliationSchema.parse(again.json);
    expect(againBody.affiliationId).not.toBe(firstBody.affiliationId);

    const rows = await affiliationRows("haneul", "스윙타운");
    expect(rows.map((r) => [r.id, r.status, r.source])).toEqual([
      [firstBody.affiliationId, "rejected", "invite"],
      [againBody.affiliationId, "pending", "invite"],
    ]);
    expect(await notificationsFor(instructors["haneul"]?.id, "affiliation_rejected")).toHaveLength(1);
    expect((await myCards("haneul"))[0]).toMatchObject({ affiliationId: againBody.affiliationId, status: "pending" });
  });

  test("재신청은 거절 뒤에만 — 대기 중에 또 신청하면 409 AFFILIATION_ALREADY_OPEN, 행·알림이 늘지 않는다", async () => {
    const before = (await affiliationRows("seoyun", "라틴하우스")).length;
    const notesBefore = (await notificationsFor(ownerAId, "affiliation_requested")).length;
    const dup = await apply("seoyun", "라틴하우스", null);
    expect(dup).toMatchObject({ status: 409, json: { code: "AFFILIATION_ALREADY_OPEN" } });
    expect((await affiliationRows("seoyun", "라틴하우스")).length).toBe(before);
    expect((await notificationsFor(ownerAId, "affiliation_requested")).length).toBe(notesBefore);
  });
});
