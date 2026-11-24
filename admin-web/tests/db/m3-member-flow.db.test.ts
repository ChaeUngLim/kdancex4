// M3-END.1(끝까지 한 바퀴) — M3(회원 결제) 완료 기준(플랜 06 §M3 행)의 첫 줄을 한 파일에서 처음부터 끝까지 이어 돌린다.
//   완료 기준: M1·M2 데이터로 가입 → 검색 → 결제 → 가짜 입금 → 확정 → 캘린더 8회차 → 강사 명단 1명
//
// 이 파일이 Task 별 테스트와 다른 점 — 「앞 단계가 만든 값을 다음 단계가 그대로 받아 쓰는가」, 단계 사이의 이음매만 본다.
//   - 시드(seed.ts·dev-demo-*)를 쓰지 않는다. 수업은 M2 경로(강사 가입 → 소속 신청 → 대표 승인·위임 → 강사 등록 → 대표 승인)로 만든다.
//   - 회원도 손으로 넣지 않는다. 가짜 본인확인 토큰으로 진짜 가입 경로(S3-1.2) → 취향·기준 장르(S3-1.5) 경로를 탄다.
//   - 주문·입금·확정은 진짜 주문 경로(S3-3.4) → 가짜 PG dev 입금 경로(S3-3.14, 서명한 웹훅이 §6 처리기를 그대로 거친다).
//   - 캘린더(S3-4.2)와 강사 명단(S3-5.2)은 확정이 넣은 행을 그대로 읽는다 — 그 행을 손으로 넣지 않는다.
//
// 손으로 준비하는 것(이미 M1 완료 기준 m1-owner-flow 가 경로로 확인한 대표 쪽 바닥 — M2 완료 기준 m2-gate 와 같은 범위):
//   대표 계정·학원·홀 1개, 학원의 정규 과정 환불 공지 판본 1판, 강사·회원 가입에 필요한 약관 판본, 수수료 요율 시드(마이그레이션 SQL).
//   회원 로그인 계정(Better Auth user + 세션)도 직접 만든다 — 소셜 로그인 3사 연동은 아직 없다(S8-2). 가입 경로는 「로그인만 한 계정」에서 시작한다.
//
// 이름: verify 의 tests/db/m3-end-1.db.test.ts 는 Task 번호 이름이라 기능 이름(m3-member-flow)으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getMigrations } from "better-auth/db/migration";
import { toNextJsHandler } from "better-auth/next-js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_DEADLINE_CONFIG } from "@/lib/domain/payment-deadline";
import { fixedClock, systemClock } from "@/lib/domain/time";
import { DEV_ROUTES_ENV, withDevRoute } from "@/lib/server/dev-routes";
import { FakeIdentityVerification } from "@/lib/server/fakes/fake-identity";
import { createFakePaymentGatewayStore, FakePaymentGateway } from "@/lib/server/fakes/fake-payment-gateway";
import { HmacWebhookVerifier, signWebhook } from "@/lib/server/fakes/hmac-webhook-verifier";
import { createRateLimiter, RATE_LIMIT_RULES } from "@/lib/server/rate-limit";
import { orderResponseSchema } from "@/lib/server/schemas/orders";
import { approvedAffiliationSchema, createApproveAffiliationRoute } from "@/lib/server/services/academy-affiliation-decisions";
import { createUpdateAffiliationPermissionsRoute } from "@/lib/server/services/academy-affiliation-permissions";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createDevFakePgHandlers, createDevWebhookLedger } from "@/lib/server/services/dev-fake-pg";
import { createHomeOfferingsRoute, homeOfferingsResponseSchema } from "@/lib/server/services/home-offerings";
import { appliedAffiliationSchema, createApplyAffiliationRoute } from "@/lib/server/services/instructor-affiliations";
import { createInstructorSignupRoutes, instructorSignupResponseSchema } from "@/lib/server/services/instructor-signup";
import { calendarResponseSchema, createMeCalendarRoute } from "@/lib/server/services/me-calendar";
import { createMemberProfileRoutes } from "@/lib/server/services/member-profile";
import { createMemberSignupRoutes, memberSchema } from "@/lib/server/services/member-signup";
import { createOfferingDetailRoute, offeringDetailSchema } from "@/lib/server/services/offering-detail";
import { createOrderRoute } from "@/lib/server/services/order-create";
import { processPaymentWebhook } from "@/lib/server/services/payment-webhook";
import { createSessionRosterRoute, sessionRosterSchema } from "@/lib/server/services/session-roster";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 서명 비밀값은 실행마다 새로 만든다 — 소스에 비밀값처럼 보이는 글자를 남기지 않는다(repo-secret-scan)
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const WEBHOOK_SECRET = `whsec-test-${randomUUID()}`;
const BASE = "http://localhost:3000";
const PASSWORD = "Latin!2026x";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6380";
// 시나리오의 「지금」 — 정규 과정(화·목 12/01~12/24, 8회차)보다 열흘 앞(KST 11/21 정오)
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");
// 가짜 입금은 주문 3분 뒤
const DEPOSIT_AT = NOW.add({ minutes: 3 });
const PRICE = 300000;
// 화·목 12/01~12/24 의 KST 날짜(8회차)
const DECEMBER_DATES = ["2026-12-01", "2026-12-03", "2026-12-08", "2026-12-10", "2026-12-15", "2026-12-17", "2026-12-22", "2026-12-24"];

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};

/** UTC 순간 → KST 날짜 글자 */
const kstDate = (iso: string) => Temporal.Instant.from(iso).toZonedDateTimeISO("Asia/Seoul").toPlainDate().toString();

describe.skipIf(!dbAvailable())("M3 완료 기준 — 회원 가입부터 캘린더·강사 명단까지 한 바퀴(M3-END.1)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let authHandler: ReturnType<typeof toNextJsHandler>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const one = async <T>(text: string, params: unknown[] = []) => (await q(text, params)).rows[0] as T;

  const identity = new FakeIdentityVerification({
    secret: `fake-identity-secret-m3-flow-${randomUUID()}`,
    ciPepper: `fake-identity-pepper-m3-flow-${randomUUID()}`,
    clock: systemClock,
  });
  const limiter = createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: `kdance:test:m3-flow:${randomUUID()}` });
  const identityRule = { ...RATE_LIMIT_RULES.identityVerification, limit: 1000 };
  // 이 파일 전용 가짜 PG 원장 — 주문 생성·dev 입금·웹훅 재조회가 모두 같은 원장을 본다(다른 테스트와 섞이지 않게)
  const store = createFakePaymentGatewayStore();
  const pg = (at: Temporal.Instant) => new FakePaymentGateway({ store, clock: fixedClock(at) });

  // 시나리오가 이어 쓰는 값들 — 앞 단계가 채우고 뒤 단계가 읽는다
  let ownerId = "";
  let ownerToken = "";
  let academyId = "";
  let roomId = "";
  let noticeId = "";
  const instructor = { id: "", token: "", affiliationId: "" };
  let classId = "";
  let offeringId = "";
  const member = { token: "", id: "" };
  let orderId = "";
  let reservationId = "";
  let gatewayPaymentId = "";
  let amount = 0;

  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const deps = (at: Temporal.Instant = NOW) => ({ db: handle.db, getSession, clock: fixedClock(at), paymentGateway: pg(at) });
  const json = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  // ---- 준비 도우미 — 대표 쪽 바닥(M1 이 경로로 확인한 것) ------------------------------------------------

  /** 대표 — 관리자 경로를 부르므로 2단계를 켠 계정 + 세션 */
  async function makeOwner(): Promise<void> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: "owner-m3flow@example.com", name: "owner", emailVerified: true, username: "owner_m3flow", displayUsername: "owner" },
      { method: "admin" },
    );
    await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    ownerToken = (await ctx.internalAdapter.createSession(user.id)).token;
    ownerId = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '대표', 'active', now())", [ownerId, user.id]);
    await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'owner')", [ownerId]);
  }

  /** 학원 1곳(입점 승인 끝난 active) + 지점 + A홀 + 정규 과정 환불 공지 판본 1판 */
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
    roomId = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomId, branch]);
    noticeId = randomUUID();
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES ($1, $2, 'regular', 1, '정규 공지 v1', $3, $4)",
      [noticeId, academyId, JSON.stringify(regularContent), ownerId],
    );
  }

  // ---- 준비 도우미 — 강사·수업(M2 경로 그대로) --------------------------------------------------------

  /** 강사 — 진짜 가입 → 진짜 로그인(set-auth-token 을 앱 Bearer 로) → 소속 신청 → 대표 승인 → 앱 수업 등록 위임 */
  async function makeInstructor(): Promise<void> {
    const routes = createInstructorSignupRoutes({ db: handle.db, identityVerification: identity, clock: systemClock, limiter, identityRule });
    const { verificationToken } = identity.issue({
      name: "이준호",
      gender: "male",
      birthDate: Temporal.PlainDate.from("1992-05-10"),
      phone: "01055507777",
      personKey: "m3-flow-junho",
    });
    const signup = await routes.signup(
      new Request(`${BASE}/api/instructor/signup`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.31" },
        body: JSON.stringify({
          verificationToken,
          username: "junhodance",
          password: PASSWORD,
          displayName: "이준호",
          activityGenre: "dance_sport",
          businessRegistrationNumber: null,
          consents: { merchantTerms: true, merchantPrivacyCollection: true, marketing: false },
        }),
      }),
      {},
    );
    expect(signup.status).toBe(201);
    instructor.id = instructorSignupResponseSchema.parse(await signup.json()).accountId;

    const login = await authHandler.POST(
      new Request(`${BASE}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ username: "junhodance", password: PASSWORD }),
      }),
    );
    expect(login.status).toBe(200);
    instructor.token = login.headers.get("set-auth-token") ?? "";
    expect(instructor.token).not.toBe("");

    const applied = await createApplyAffiliationRoute(deps())(
      new Request(`${BASE}/api/instructor/affiliations`, {
        method: "POST",
        headers: json(instructor.token),
        body: JSON.stringify({ academyId, message: "정규반을 맡고 싶어요" }),
      }),
      undefined,
    );
    expect(applied.status).toBe(201);
    instructor.affiliationId = appliedAffiliationSchema.parse(await applied.json()).affiliationId;

    const params = { params: Promise.resolve({ academyId, id: instructor.affiliationId }) };
    const approved = await createApproveAffiliationRoute(deps())(
      new Request(`${BASE}/api/academies/${academyId}/affiliations/${instructor.affiliationId}/approve`, {
        method: "POST",
        headers: json(ownerToken),
        body: JSON.stringify({ isAcademyEmployee: false, shareRateBp: 6000 }),
      }),
      params,
    );
    expect(approved.status).toBe(200);
    expect(approvedAffiliationSchema.parse(await approved.json()).status).toBe("active");

    const delegated = await createUpdateAffiliationPermissionsRoute(deps())(
      new Request(`${BASE}/api/academies/${academyId}/affiliations/${instructor.affiliationId}/permissions`, {
        method: "PUT",
        headers: json(ownerToken),
        body: JSON.stringify({ permissions: ["class_submit"] }),
      }),
      { params: Promise.resolve({ academyId, id: instructor.affiliationId }) },
    );
    expect(delegated.status).toBe(200);
  }

  /** 정규 8회차(화·목 12/01~12/24 20:30~21:30, 남 6·여 6, 300,000원) — 강사가 올리고 대표가 승인해 공개 */
  async function makePublishedClass(): Promise<void> {
    const reg = createClassRegistrationRoutes(deps());
    const created = await reg.create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: { ...json(instructor.token), "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          academyId,
          classKind: "regular",
          title: "쌈바(입문) · 12월",
          genre: "dance_sport",
          subGenre: "latin",
          discipline: "samba",
          targetLevel: "entry",
          targetAges: ["all"],
          roomId,
          priceAmount: PRICE,
          schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime: "20:30", endTime: "21:30", periodFrom: "2026-12-01", periodTo: "2026-12-24" },
          capacity: { mode: "gender_split", male: 6, female: 6 },
          refundDeadlineOn: null,
          introText: null,
        }),
      }),
      undefined,
    );
    expect(created.status).toBe(201);
    classId = classRegistrationSchema.parse(await created.json()).classId;

    const submitted = await reg.submit(
      new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: json(instructor.token), body: "{}" }),
      { params: Promise.resolve({ classId }) },
    );
    expect(submitted.status).toBe(200);
    const approved = await createClassApprovalRoutes(deps()).approve(
      new Request(`${BASE}/api/academies/${academyId}/classes/${classId}/approve`, { method: "POST", headers: json(ownerToken), body: "{}" }),
      { params: Promise.resolve({ academyId, classId }) },
    );
    expect(approved.status).toBe(200);
    expect(classRegistrationSchema.parse(await approved.json()).status).toBe("published");
  }

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 12 });
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    authHandler = toNextJsHandler(auth);
    await (await getMigrations(auth.options)).runMigrations();
    // 다른 DB 테스트의 truncateAll 이 요율 시드를 비우므로 마이그레이션 시드 SQL 로 되살린다(me-calendar 와 같은 방식)
    const ops = JSON.parse(
      readFileSync(new URL("../../migrations/app/20261120T0143_platform_fee_rates/ops.json", import.meta.url), "utf8"),
    ) as { id: string; execute: { sql: string }[] }[];
    for (const step of ops.find((op) => op.id === "seed.platform_fee_rates")!.execute) await q(step.sql);
    // 강사 가입에 필요한 필수 동의 둘의 시행 중 판본
    await q(
      `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at) VALUES
         (uuidv7(), 'merchant_terms', '1.0', '입점 이용약관 1.0', now() - interval '40 days', now() - interval '10 days'),
         (uuidv7(), 'merchant_privacy_collection', '1.0', '개인정보 수집·이용 1.0', now() - interval '40 days', now() - interval '10 days')`,
    );

    await makeOwner();
    await makeAcademy();
    await makeInstructor();
    await makePublishedClass();
    offeringId = (await one<{ id: string }>("SELECT id::text AS id FROM class_offerings WHERE class_id = $1", [classId])).id;
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 가입 — 로그인만 한 계정이 가짜 본인확인으로 가입하고, 취향·기준 장르(댄스스포츠)를 저장한다", async () => {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: "m3flow-seoyeon@example.com", name: "seoyeon", emailVerified: true }, { method: "admin" });
    member.token = (await ctx.internalAdapter.createSession(user.id)).token;

    const { verificationToken } = identity.issue({
      name: "김서연",
      gender: "male",
      birthDate: Temporal.PlainDate.from("1995-03-02"),
      phone: "01012345678",
      personKey: "m3-flow-member",
    });
    const signup = await createMemberSignupRoutes({ db: handle.db, getSession, identityVerification: identity, clock: systemClock, limiter, identityRule }).signup(
      new Request(`${BASE}/api/members`, {
        method: "POST",
        headers: json(member.token),
        body: JSON.stringify({
          verificationToken,
          noticeAcknowledged: true,
          nickname: "서연",
          consents: { memberTerms: true, memberPrivacyCollection: true, academySharing: true, age19Plus: true, marketing: false, location: false },
        }),
      }),
      {},
    );
    expect(signup.status).toBe(201);
    const created = memberSchema.parse(await signup.json());
    expect(created).toMatchObject({ name: "김서연", nickname: "서연", gender: "male", baseGenre: null });
    member.id = (await one<{ id: string }>("SELECT id::text AS id FROM members WHERE auth_user_id = $1", [user.id])).id;

    const profileRoutes = createMemberProfileRoutes({ db: handle.db, getSession, clock: systemClock });
    const profile = await profileRoutes.putProfile(
      new Request(`${BASE}/api/me/profile`, {
        method: "PUT",
        headers: json(member.token),
        body: JSON.stringify({
          interestGenres: ["dance_sport"],
          regions: [{ sido: "서울", gu: "마포구" }],
          availableFrom: "19:00",
          availableTo: "22:00",
          experienceLevel: "beginner",
        }),
      }),
      {},
    );
    expect(profile.status).toBe(200);
    const base = await profileRoutes.putBaseGenre(
      new Request(`${BASE}/api/me/base-genre`, { method: "PUT", headers: json(member.token), body: JSON.stringify({ baseGenre: "dance_sport" }) }),
      {},
    );
    expect(base.status).toBe(200);
    expect(memberSchema.parse(await base.json()).onboarding).toEqual({ profileDone: true, baseGenreDone: true });
  });

  test("② 검색 — 홈 목록에 M2 경로로 게시된 정규 과정이 나오고, 상세는 8회차·남자 자리 기본·공지 판본을 보여 준다", async () => {
    const home = await createHomeOfferingsRoute(deps())(new Request(`${BASE}/api/home/offerings`, { headers: { authorization: `Bearer ${member.token}` } }), undefined);
    expect(home.status).toBe(200);
    const list = homeOfferingsResponseSchema.parse(await home.json());
    const found = list.items.filter((i) => i.offeringId === offeringId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      classId,
      title: "쌈바(입문) · 12월",
      classKind: "regular",
      academy: { id: academyId, name: "라틴하우스" },
      sessionCount: 8,
      priceAmount: PRICE,
      capacity: { total: 12, enrolled: 0 },
    });

    const detailRes = await createOfferingDetailRoute(deps())(
      new Request(`${BASE}/api/offerings/${offeringId}`, { headers: { authorization: `Bearer ${member.token}` } }),
      { params: Promise.resolve({ offeringId }) },
    );
    expect(detailRes.status).toBe(200);
    const detail = offeringDetailSchema.parse(await detailRes.json());
    expect(detail.sessions).toHaveLength(8);
    expect(detail.instructorName).toBe("이준호");
    expect(detail.instructorId).toBe(instructor.id);
    expect(detail.seatSelection.defaultSeatKind).toBe("male");
    expect(detail.refundNotice?.versionId).toBe(noticeId);
  });

  test("③ 결제 — 카드 주문을 만들면 결제 대기(pending) · 남자 자리 held 1 · 그 시점 공지 판본이 주문에 고정된다", async () => {
    const res = await createOrderRoute({ ...deps(), deadlineConfig: DEFAULT_DEADLINE_CONFIG })(
      new Request(`${BASE}/api/orders`, {
        method: "POST",
        headers: { ...json(member.token), "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ offeringId, seatKind: "male", method: "card", noticesAcknowledged: true }),
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    const created = orderResponseSchema.parse(await res.json());
    expect(created).toMatchObject({ status: "pending", seatKind: "male", refundNoticeVersionId: noticeId, payment: { method: "card", status: "ready" } });
    orderId = created.orderId;
    reservationId = created.reservationId;
    amount = created.payment.amount;
    expect(amount).toBe(PRICE);
    gatewayPaymentId = (await one<{ gid: string }>("SELECT gateway_payment_id AS gid FROM payments WHERE order_id = $1", [orderId])).gid;

    const seat = await one<{ held: number; confirmed: number }>(
      "SELECT held_count AS held, confirmed_count AS confirmed FROM seat_pools WHERE offering_id = $1 AND seat_kind = 'male'",
      [offeringId],
    );
    expect(seat).toEqual({ held: 1, confirmed: 0 });
  });

  test("④ 가짜 입금 → ⑤ 확정 — dev 입금 경로의 서명 웹훅이 확정 처리기를 거쳐 주문 paid · 예약 confirmed · 자리 confirmed 1", async () => {
    // dev 처리기 재료 — 진짜 웹훅 경로와 같은 검증기·처리기(서명·중복·금액 대조를 건너뛰지 않는다)
    const deposit = withDevRoute(
      createDevFakePgHandlers({
        gateway: () => pg(DEPOSIT_AT),
        sign: (input) => signWebhook({ ...input, secret: WEBHOOK_SECRET }),
        clock: fixedClock(DEPOSIT_AT),
        processWebhook: (input) =>
          processPaymentWebhook(
            { db: handle.db, clock: fixedClock(DEPOSIT_AT), paymentGateway: pg(DEPOSIT_AT), webhookVerifier: new HmacWebhookVerifier({ secret: WEBHOOK_SECRET }) },
            input,
          ),
        ledger: createDevWebhookLedger(),
      }).deposit,
      { [DEV_ROUTES_ENV]: "true" },
    );
    const res = await deposit(
      new Request(`${BASE}/api/dev/fake-pg/payments/${encodeURIComponent(gatewayPaymentId)}/deposit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount }),
      }),
      { params: Promise.resolve({ gatewayPaymentId }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: "confirmed", orderId, orderStatus: "paid" });

    const state = await one<{ order: string; payment: string; reservation: string; held: number; confirmed: number }>(
      `SELECT o.status AS order,
              (SELECT p.status FROM payments p WHERE p.order_id = o.id) AS payment,
              (SELECT r.status::text FROM reservations r WHERE r.order_id = o.id) AS reservation,
              (SELECT held_count FROM seat_pools WHERE offering_id = o.offering_id AND seat_kind = 'male') AS held,
              (SELECT confirmed_count FROM seat_pools WHERE offering_id = o.offering_id AND seat_kind = 'male') AS confirmed
         FROM orders o WHERE o.id = $1`,
      [orderId],
    );
    expect(state).toEqual({ order: "paid", payment: "paid", reservation: "confirmed", held: 0, confirmed: 1 });
  });

  test("⑥ 캘린더 8회차 — 확정이 넣은 캘린더 행 8건이 12월 KST 날짜·회차 순서·수업 제목·학원 이름 그대로 나온다", async () => {
    const res = await createMeCalendarRoute({ db: handle.db, getSession, clock: fixedClock(DEPOSIT_AT) })(
      new Request(`${BASE}/api/me/calendar?from=2026-12-01&to=2026-12-31`, { headers: { authorization: `Bearer ${member.token}` } }),
      undefined,
    );
    expect(res.status).toBe(200);
    const body = calendarResponseSchema.parse(await res.json());
    expect(body.items).toHaveLength(8);
    expect(body.items.map((i) => i.sessionSeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(body.items.map((i) => kstDate(i.startsAt))).toEqual(DECEMBER_DATES);
    for (const item of body.items) {
      expect(item).toMatchObject({ reservationId, offeringId, title: "쌈바(입문) · 12월", academyName: "라틴하우스", absence: null });
    }
  });

  test("⑦ 강사 명단 1명 — 담당 강사가 앱 토큰으로 첫 회차 명단을 열면 결제 끝난 회원 1명(가린 번호)만, 결제 대기 0", async () => {
    const first = await one<{ id: string }>("SELECT id::text AS id FROM class_sessions WHERE offering_id = $1 ORDER BY starts_at LIMIT 1", [offeringId]);
    const res = await createSessionRosterRoute({ ...deps(DEPOSIT_AT) })(
      new Request(`${BASE}/api/classes/${classId}/sessions/${first.id}/roster`, { headers: { authorization: `Bearer ${instructor.token}` } }),
      { params: Promise.resolve({ classId, sessionId: first.id }) } as never,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const roster = sessionRosterSchema.parse(JSON.parse(text));
    expect(roster).toMatchObject({ classId, sessionId: first.id, academyId, title: "쌈바(입문) · 12월", awaitingPayment: { male: 0, female: 0 } });
    expect(roster.members).toHaveLength(1);
    expect(roster.members[0]).toMatchObject({ memberId: member.id, nickname: "서연", gender: "male", phoneMasked: "010-****-5678", absence: null });
    // 강사 화면에는 본명·전체 번호가 나가지 않는다
    expect(text).not.toContain("김서연");
    expect(text).not.toContain("01012345678");
  });
});
