// M1-END.3(대표 흐름 DB 시나리오) — M1(대표가 관리자 웹에서 입점하고 학원·강사·공지를 갖춰 수업 받을 준비를 끝낸다)의
// 완료 기준을 한 파일에서 처음부터 끝까지 이어서 돌린다. 각 단계의 세부 경우(오류 코드·동시성 등)는 그 Task 의 테스트가 이미 본다.
// 이 파일은 「앞 단계가 만든 값을 다음 단계가 그대로 받아 쓰는가」— 단계 사이의 이음매만 본다.
//   근거: 플랜 06_master-plan.md M1 행 「DB 시나리오」 · 계약 07(입점·승인·정산 계좌) · 08(초대·소속·위임) · 09(공지·게시 차단)
//
// 순서(앞 단계의 결과를 뒤 단계가 쓴다 — vitest 는 한 파일 안의 test 를 적힌 순서대로 하나씩 돈다):
//   ① 입점 신청: 초안 저장 → 약관 5종 동의로 제출(계약 07 §2)
//   ② 운영자 승인: 심사 시작 → 승인 → 학원·대표 연결·정산 계좌가 생긴다(계약 07 §3). 승인 전에는 학원이 없어 게시 불가
//   ③ 정산 계좌 변경(2단계 재확인): 인증 앱 코드 없이 401 → 맞는 코드로 200, 활성 계좌 1개(계약 07 §4 · 시나리오 6)
//   ④ 초대 링크 1회: 강사가 받으면 pending, 같은 링크를 다른 강사가 다시 쓰면 409(계약 08 §1·§2) → 대표가 몫 비율로 승인
//   ⑤ 위임: 대표가 roster_manage 만 켠다 → 위임 강사는 「예약·명단」 메뉴만, 수업·초대(대표 고유)는 403(계약 08 §4)
//   ⑥ 공지 판본 2종: 정규 과정 공지 + 이벤트형 취소 수수료를 각각 1판씩 저장(계약 09 §1)
//   ⑦ 공지 없는 게시 거부: 판본이 없는 종류(개인 레슨)는 409 NOTICE_MISSING, 판본이 생긴 두 종류는 게시 통과(FR-246)
//
// 신청자 계정은 Better Auth 내부 어댑터로 바로 만든다(가입·인증 앱 등록 화면은 S0·S1-1 테스트가 따로 본다).
import { randomBytes, randomUUID } from "node:crypto";

import { createOTP } from "@better-auth/utils/otp";
import { symmetricEncrypt } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { RefundNoticeKind } from "@/lib/domain/constants";
import { fixedClock } from "@/lib/domain/time";
import { createFieldCipher } from "@/lib/server/field-encryption";
import { createGuards } from "@/lib/server/guards";
import { HttpError, withRoute } from "@/lib/server/http";
import { RATE_LIMIT_RULES, createRateLimiter } from "@/lib/server/rate-limit";
import { createApproveAffiliationRoute } from "@/lib/server/services/academy-affiliation-decisions";
import { createUpdateAffiliationPermissionsRoute } from "@/lib/server/services/academy-affiliation-permissions";
import { createCreateInviteRoute, createdInviteSchema } from "@/lib/server/services/academy-invites";
import { createPayoutAccountChangeRoute } from "@/lib/server/services/academy-payout-account";
import { approveResponseSchema, createApproveRoute, createStartReviewRoute } from "@/lib/server/services/admin-merchant-review";
import { canPublish, createClassPublishGateDeps } from "@/lib/server/services/class-publish-gate";
import { acceptedAffiliationSchema, createAcceptInviteRoute } from "@/lib/server/services/instructor-invite-accept";
import { createPutDraftRoute } from "@/lib/server/services/merchant-application-draft";
import { createSubmitApplicationRoute } from "@/lib/server/services/merchant-application-submit";
import { assertRefundNoticeForPublish } from "@/lib/server/services/refund-notice-gate";
import { createRefundNoticePublishRoute, publishRefundNoticeResponseSchema } from "@/lib/server/services/refund-notice-publish";
import { createStaffMeRoute, staffMeResponseSchema } from "@/lib/server/services/staff-me";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { createStaffTotpChecker } from "@/lib/server/staff-totp";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 만들어 비밀값 검사(gitleaks)가 진짜 키로 오인하지 않게 한다
const SECRET = "m1-owner-flow-test-".repeat(3);
const BASE = "http://localhost:3000";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6380";
const FIRST_ACCOUNT = "110000000521"; // 신청서에 적은 계좌
const NEW_ACCOUNT = "110000000999"; // ③에서 바꿀 계좌

/** 정규 과정 공지 content — 계약 09 §1 의 단계별 환불 비율(템플릿 하한 이상) */
const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [
    { point: "before_start", percent: 100 },
    { point: "before_one_third", percent: 67 },
    { point: "before_half", percent: 67 },
    { point: "after_half", percent: 0 },
  ],
  nonRefundableCases: "이미 들은 회차와 기간이 끝난 수강권",
  processingBusinessDays: 5,
  ownerContact: "0200000000",
};
/** 이벤트형 content — 구간별 취소 수수료(상한 이하) */
const eventContent = {
  feeTiers: [
    { window: "d10_plus", percent: 10 },
    { window: "d9_d7", percent: 10 },
    { window: "d6_d3", percent: 15 },
    { window: "d2_to_deadline", percent: 30 },
  ],
  nonRefundableCases: "환불 마감일이 지난 뒤의 취소",
  processingBusinessDays: 3,
  ownerContact: "01012345678",
};

describe.skipIf(!dbAvailable())("M1 대표 흐름 — 입점 → 승인 → 계좌(재확인) → 초대 1회 → 위임 → 공지 판본 → 공지 없는 게시 거부", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const cipher = createFieldCipher(randomBytes(32).toString("base64"));
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const count = async (sql: string, params: unknown[] = []) => Number((await q(sql, params)).rows[0].n);

  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const totpSecrets: Record<string, string> = {};
  const versions: Record<string, string> = {};

  // 단계 사이에 넘겨받는 값 — 앞 단계가 채우고 뒤 단계가 쓴다
  let applicationId = "";
  let academyId = "";
  let affiliationId = "";

  const getSession = (headers: Headers) => auth.api.getSession({ headers });
  const deps = () => ({ db: handle.db, getSession, fieldCipher: cipher, clock: fixedClock(Temporal.Now.instant()) });

  /** 직원 계정 + 로그인 세션 + (twoFactor 면) 인증 앱 비밀값. 비밀값은 플러그인이 하는 그대로 서버 비밀값으로 암호화해 둔다 */
  async function makeStaff(key: string, roles: string[]): Promise<void> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `flow_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    totpSecrets[key] = randomBytes(20).toString("hex");
    await ctx.adapter.create({
      model: "twoFactor",
      data: {
        secret: await symmetricEncrypt({ key: SECRET, data: totpSecrets[key] }),
        backupCodes: await symmetricEncrypt({ key: SECRET, data: "[]" }),
        userId: user.id,
        verified: true,
      },
    });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      key,
    ]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
  }

  /** 지금 시행 중인 약관 판본 한 줄(입점 동의 5종 중 하나) */
  async function termsVersion(key: string, kind: string): Promise<void> {
    versions[key] = randomUUID();
    await q(
      `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at)
       VALUES ($1, $2, '1.0', '본문', now() - interval '60 days', now() - interval '30 days')`,
      [versions[key], kind],
    );
  }

  /** 신청자가 올린 증빙 파일 한 장(업로드 경로는 file-upload 테스트가 본다) */
  async function evidenceFile(owner: string): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO uploaded_files (id, uploader_account_id, purpose, visibility, storage_key, mime_type, size_bytes, sha256, display_name)
       VALUES ($1, $2, 'merchant_evidence', 'private', $3, 'application/pdf', 10, 'x', '증빙.pdf')`,
      [id, staffIds[owner], `k-${id}.pdf`],
    );
    return id;
  }

  /** 라우트 처리기를 실제 앱처럼 부른다. Bearer 세션·멱등키·경로 매개변수를 붙이고 JSON 본문을 돌려준다 */
  async function call(
    route: (request: Request, ctx: never) => Promise<Response>,
    opts: { method: string; path: string; who?: string; body?: unknown; key?: string; params?: Record<string, string> },
  ) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.who !== undefined) headers["authorization"] = `Bearer ${tokens[opts.who]}`;
    if (opts.key !== undefined) headers["Idempotency-Key"] = opts.key;
    const res = await route(
      new Request(`${BASE}${opts.path}`, {
        method: opts.method,
        headers,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      }),
      (opts.params === undefined ? undefined : { params: Promise.resolve(opts.params) }) as never,
    );
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json, code: json["code"] as string | undefined };
  }

  /**
   * 수업 게시 경로 흉내 — 실제 게시 경로는 M2 가 만든다. M2 가 부를 두 판정을 같은 순서로 부른다:
   *   학원이 승인돼 active 인가(canPublish, FR-250) → 그 종류의 공지 판본이 있는가(assertRefundNoticeForPublish, FR-246)
   */
  async function publishClass(kind: RefundNoticeKind) {
    const route = withRoute<{ academyId: string }>(async (_request, ctx) => {
      if (!(await canPublish(createClassPublishGateDeps(handle.db), ctx.academyId))) {
        return Response.json({ code: "ACADEMY_NOT_APPROVED" }, { status: 409 });
      }
      await assertRefundNoticeForPublish(handle.db, ctx.academyId, kind);
      return Response.json({ published: true }, { status: 201 });
    });
    const res = await route(new Request(`${BASE}/api/classes`, { method: "POST" }), { academyId });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  /** 위임 강사의 「다음 요청」— 명단·수업 경로(S3·M2)는 아직 없어서 그 경로들이 맨 앞에서 부를 가드를 직접 부른다 */
  async function guardStatus(who: string, permission: "roster_manage" | "class_manage" | "owner"): Promise<number> {
    try {
      await createGuards({ db: handle.db, getSession }).requireStaff(permission, {
        academyId,
        surface: "web",
        headers: new Headers({ authorization: `Bearer ${tokens[who]}` }),
      });
      return 200;
    } catch (error) {
      if (error instanceof HttpError) return error.status;
      throw error;
    }
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    // 입점 동의 5종의 현재 판본(약관·수수료·카드 수수료·콘텐츠 이용 허락·1+1 안내)
    await termsVersion("terms", "merchant_terms");
    await termsVersion("fee", "platform_fee_notice");
    await termsVersion("card", "card_fee_notice");
    await termsVersion("content", "content_license");
    await termsVersion("onePlusOne", "one_plus_one_notice");

    await makeStaff("owner", []); // 신청자 — 승인 전에는 역할이 없다(staff_self)
    await makeStaff("admin", ["admin"]); // 운영자
    await makeStaff("iu", ["instructor"]); // 초대 링크를 받는 강사
    await makeStaff("late", ["instructor"]); // 같은 링크를 뒤늦게 누르는 강사
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 입점 신청 — 초안 저장 후 약관 5종 동의로 제출하면 submitted", async () => {
    const reg = await evidenceFile("owner");
    const sports = await evidenceFile("owner");
    const draft = await call(createPutDraftRoute(deps()), {
      method: "PUT",
      path: "/api/merchant-applications/me/draft",
      who: "owner",
      body: {
        academyName: "라틴하우스 강남",
        branchName: "강남점",
        businessName: "라틴하우스",
        representativeName: "김대표",
        businessRegistrationNumber: "1234567890",
        mailOrderReportNumber: null,
        businessAddress: "서울 강남구 테헤란로 000, 3층",
        region: { sido: "서울", gu: "강남구" },
        phone: "0200000000",
        registrationType: "sports_facility",
        industryCode: "921902",
        documents: [
          { docKind: "business_registration", fileId: reg },
          { docKind: "sports_facility_report", fileId: sports },
        ],
        payoutAccount: { bankCode: "088", accountNumber: FIRST_ACCOUNT, holderName: "라틴하우스" },
      },
    });
    expect(draft.status).toBe(200);

    const submitted = await call(createSubmitApplicationRoute(deps()), {
      method: "POST",
      path: "/api/merchant-applications/me/submit",
      who: "owner",
      key: `flow-submit-${randomUUID()}`,
      body: { consents: ["terms", "fee", "card", "content", "onePlusOne"].map((k) => ({ termsVersionId: versions[k], agreed: true })) },
    });
    expect(submitted.status).toBe(200);
    const app = (await q("SELECT id, status FROM merchant_applications WHERE applicant_account_id = $1", [staffIds["owner"]])).rows;
    expect(app).toHaveLength(1);
    expect(app[0].status).toBe("submitted");
    applicationId = app[0].id as string;
    expect(await count("SELECT count(*) AS n FROM merchant_consents WHERE application_id = $1", [applicationId])).toBe(5);
    // 승인 전에는 학원 행이 없다 — 학원 단위의 어떤 일도 아직 할 수 없다(FR-250)
    expect(await count("SELECT count(*) AS n FROM academies")).toBe(0);
  });

  test("② 운영자 승인 — 심사 시작 → 승인, 학원·대표 연결·정산 계좌·대표 역할이 생기고 학원은 active(공지 없으면 아직 게시 불가)", async () => {
    const params = { id: applicationId };
    const started = await call(createStartReviewRoute(deps()), {
      method: "POST",
      path: `/api/admin/merchant-applications/${applicationId}/start-review`,
      who: "admin",
      params,
    });
    expect(started.status).toBe(200);
    const approved = await call(createApproveRoute(deps()), {
      method: "POST",
      path: `/api/admin/merchant-applications/${applicationId}/approve`,
      who: "admin",
      key: `flow-approve-${randomUUID()}`,
      params,
    });
    expect(approved.status).toBe(200);
    academyId = approveResponseSchema.parse(approved.json).academyId;

    expect(await count("SELECT count(*) AS n FROM academy_owners WHERE academy_id = $1 AND staff_account_id = $2 AND status = 'active'", [academyId, staffIds["owner"]])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM academy_payout_accounts WHERE academy_id = $1 AND status = 'active'", [academyId])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM role_grants WHERE staff_account_id = $1 AND role = 'owner' AND status = 'active'", [staffIds["owner"]])).toBe(1);
    // 승인된 학원은 게시 자격(active)이 있지만, 공지 판본이 하나도 없으니 게시는 409 NOTICE_MISSING(FR-246)
    expect(await canPublish(createClassPublishGateDeps(handle.db), academyId)).toBe(true);
    const blocked = await publishClass("regular");
    expect(blocked).toMatchObject({ status: 409, json: { code: "NOTICE_MISSING" } });
  });

  test("③ 정산 계좌 변경 — 인증 앱 코드 없이 401 SECOND_FACTOR_REQUIRED, 맞는 코드면 200 · 활성 계좌 1개 · 옛 계좌 replaced", async () => {
    const route = createPayoutAccountChangeRoute({
      db: handle.db,
      getSession,
      fieldCipher: cipher,
      totp: createStaffTotpChecker(auth),
      // 실행마다 다른 키 앞말 — 다른 테스트·앱 실행의 실패 횟수와 섞이지 않게
      limiter: createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: `kdance:test:m1-flow:${randomUUID()}` }),
      totpFailureRule: RATE_LIMIT_RULES.authFailure, // 앱 기본값(15분 5회) 그대로
    });
    const body = { bankCode: "004", accountNumber: "110-000-000999", holderName: "라틴하우스" };
    const change = (extra: Record<string, unknown>) =>
      call(route, {
        method: "PUT",
        path: `/api/academies/${academyId}/payout-account`,
        who: "owner",
        key: randomUUID(),
        body: { ...body, ...extra },
        params: { academyId },
      });

    // 2단계 세션이어도 돈이 걸린 변경은 코드를 다시 받는다(재확인)
    expect(await change({})).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    const ok = await change({ totpCode: await createOTP(totpSecrets["owner"] ?? "").totp() });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ bankCode: "004", holderVerified: false });

    const rows = (
      await q("SELECT status, account_last4 FROM academy_payout_accounts WHERE academy_id = $1 ORDER BY created_at, id", [academyId])
    ).rows;
    expect(rows).toEqual([
      { status: "replaced", account_last4: FIRST_ACCOUNT.slice(-4) },
      { status: "active", account_last4: NEW_ACCOUNT.slice(-4) },
    ]);
  });

  test("④ 초대 링크 1회 — 강사가 받으면 pending, 같은 링크를 다른 강사가 쓰면 409 INVITE_ALREADY_USED, 대표가 몫 비율로 승인하면 active", async () => {
    const created = await call(createCreateInviteRoute({ ...deps(), inviteBaseUrl: "https://k-dancex4.test" }), {
      method: "POST",
      path: `/api/academies/${academyId}/invites`,
      who: "owner",
      body: {},
      params: { academyId },
    });
    expect(created.status).toBe(201);
    const token = createdInviteSchema.parse(created.json).inviteUrl.split("/invite/")[1] ?? "";

    const accept = (who: string) =>
      call(createAcceptInviteRoute(deps()), { method: "POST", path: `/api/instructor/invites/${token}/accept`, who, params: { token } });
    const first = await accept("iu");
    expect(first.status).toBe(201);
    const accepted = acceptedAffiliationSchema.parse(first.json);
    expect(accepted).toMatchObject({ academyId, status: "pending", source: "invite" });
    affiliationId = accepted.affiliationId;

    // 한 번 쓴 링크는 다시 못 쓴다 — 뒤늦은 강사에게는 소속 행이 생기지 않는다
    expect(await accept("late")).toMatchObject({ status: 409, code: "INVITE_ALREADY_USED" });
    expect(await count("SELECT count(*) AS n FROM instructor_affiliations WHERE instructor_account_id = $1", [staffIds["late"]])).toBe(0);

    const approved = await call(createApproveAffiliationRoute(deps()), {
      method: "POST",
      path: `/api/academies/${academyId}/affiliations/${affiliationId}/approve`,
      who: "owner",
      body: { isAcademyEmployee: false, shareRateBp: 6000 },
      params: { academyId, id: affiliationId },
    });
    expect(approved).toMatchObject({ status: 200, json: { status: "active", shareRateBp: 6000 } });
  });

  test("⑤ 위임 — 대표가 roster_manage 만 켜면 위임 강사는 「예약·명단」 메뉴만, 명단 200 · 수업·대표 고유 권한 403", async () => {
    const put = await call(createUpdateAffiliationPermissionsRoute(deps()), {
      method: "PUT",
      path: `/api/academies/${academyId}/affiliations/${affiliationId}/permissions`,
      who: "owner",
      body: { permissions: ["roster_manage"] },
      params: { academyId, id: affiliationId },
    });
    expect(put.status).toBe(200);

    // 화면이 그릴 메뉴는 서버가 계산한다 — 위임 강사는 켜진 위임의 메뉴만 받는다
    const me = await call(createStaffMeRoute({ db: handle.db, getSession }), { method: "GET", path: "/api/staff/me", who: "iu" });
    expect(me.status).toBe(200);
    const body = staffMeResponseSchema.parse(me.json);
    expect(body.consoleAccess).toBe(true);
    expect(body.academies).toEqual([
      { academyId, name: "라틴하우스 강남", as: "delegate", permissions: ["roster_manage"], menus: ["roster"] },
    ]);

    // 실제로 막는 일은 각 경로의 가드가 한다 — 메뉴에 없는 권한은 403
    expect(await guardStatus("iu", "roster_manage")).toBe(200);
    expect(await guardStatus("iu", "class_manage")).toBe(403);
    expect(await guardStatus("iu", "owner")).toBe(403);
    const invite = await call(createCreateInviteRoute({ ...deps(), inviteBaseUrl: "https://k-dancex4.test" }), {
      method: "POST",
      path: `/api/academies/${academyId}/invites`,
      who: "iu",
      body: {},
      params: { academyId },
    });
    expect(invite.status).toBe(403);
  });

  test("⑥ 공지 판본 2종 — 정규 과정 공지와 이벤트형 취소 수수료를 각각 1판 저장", async () => {
    const route = createRefundNoticePublishRoute({ db: handle.db, getSession });
    for (const [kind, content] of [
      ["regular", regularContent],
      ["event", eventContent],
    ] as const) {
      const saved = await call(route, {
        method: "POST",
        path: `/api/academies/${academyId}/refund-notices/${kind}/versions`,
        who: "owner",
        body: { baseVersion: null, content },
        params: { academyId, kind },
      });
      expect(saved.status, JSON.stringify(saved.json)).toBe(201);
      expect(publishRefundNoticeResponseSchema.parse(saved.json)).toMatchObject({ kind, version: 1 });
    }
    const kinds = (
      await q("SELECT notice_kind, version FROM refund_notice_versions WHERE academy_id = $1 ORDER BY notice_kind", [academyId])
    ).rows;
    expect(kinds).toEqual([
      { notice_kind: "event", version: 1 },
      { notice_kind: "regular", version: 1 },
    ]);
  });

  test("⑦ 공지 없는 게시 거부 — 판본이 없는 종류(개인 레슨)는 409 NOTICE_MISSING, 판본이 생긴 정규·이벤트형은 게시 통과", async () => {
    const missing = await publishClass("private_lesson");
    expect(missing).toMatchObject({ status: 409, json: { code: "NOTICE_MISSING" } });
    // ②에서 막혔던 정규 게시가 ⑥의 판본 저장 뒤에는 통과한다 — 같은 학원, 같은 판정
    expect((await publishClass("regular")).status).toBe(201);
    expect((await publishClass("event")).status).toBe(201);
  });
});
