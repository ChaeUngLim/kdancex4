// S1-1.18(학원 설정 조회 API) — `GET /api/academies/{academyId}/settings` 를 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-1-18.db.test.ts 였는데, 기능 이름(academy-settings)으로 바꿨다.
//   핵심(verify): 계약 07 수용 시나리오 4 — 승인 전 신청자는 어떤 학원 id 로 불러도 403(대표 연결이 없다).
//   나머지: 승인된 학원의 학원·지점·등록 형태·계좌(가린 값)·입점 조건 요약·시행 전 약관 변경 · 계좌 원문 0건
//   · 재심사 전에는 이전 형태 + 엄격 기준 · 다른 학원 대표·운영자 403 · 2단계 전·로그인 안 함 401.
import { randomBytes, randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createFieldCipher } from "@/lib/server/field-encryption";
import { academySettingsResponseSchema, createAcademySettingsRoute } from "@/lib/server/services/academy-settings";
import { ACADEMY_PAYOUT_ACCOUNT_CONTEXT } from "@/lib/server/services/admin-merchant-review";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "academy-settings-test-secret-0123456789-0123";
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T00:00:00Z");
const ACCOUNT_NUMBER = "110000000521"; // 시험용 번호 — 응답에는 110-***-***521 만 보여야 한다

describe.skipIf(!dbAvailable())("학원 설정 조회(계약 07 §4)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let GET: ReturnType<typeof createAcademySettingsRoute>;
  const cipher = createFieldCipher(randomBytes(32).toString("base64"));
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const versionIds: Record<string, string> = {};

  async function makeStaff(key: string, opts: { twoFactor?: boolean; roles?: string[] } = {}) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: key, displayUsername: key },
      { method: "admin" },
    );
    if (opts.twoFactor ?? true) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      key,
    ]);
    for (const role of opts.roles ?? []) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
  }

  /** 입점 승인을 마친 학원(등록 형태 확인됨, 면제 종료일·카드 결제 있음) + 대표 연결 + 승인된 신청 1건 */
  async function makeAcademy(key: string, owner: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, registration_verified_at, industry_code,
                              card_payment_enabled, platform_fee_exempt_until, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', 'active', now(), now(), '854', true, '2027-11-20', ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `${key} 학원`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
    await q("INSERT INTO merchant_applications (id, applicant_account_id, status, academy_id, updated_at) VALUES ($1, $2, 'approved', $3, now())", [
      randomUUID(),
      staffIds[owner],
      academyIds[key],
    ]);
  }

  async function makeVersion(key: string, kind: string, version: string, effectiveAt: string) {
    versionIds[key] = randomUUID();
    await q("INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at) VALUES ($1, $2, $3, $4, $5, $6)", [
      versionIds[key],
      kind,
      version,
      `${kind} ${version} 전문`,
      "2026-10-01T00:00:00Z",
      effectiveAt,
    ]);
  }

  async function makeNotice(version: string, academy: string, owner: string) {
    const notificationId = randomUUID();
    await q(
      `INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
       VALUES ($1, $2, $3, 'operations', 'terms_change_notice', $4, '{}'::jsonb)`,
      [notificationId, staffIds[owner], academyIds[academy], `terms_version:${versionIds[version]}:academy:${academyIds[academy]}`],
    );
    const noticeId = randomUUID();
    await q("INSERT INTO terms_change_notices (id, terms_version_id, academy_id, notified_at, notification_id) VALUES ($1, $2, $3, $4, $5)", [
      noticeId,
      versionIds[version],
      academyIds[academy],
      "2026-11-01T00:00:00Z",
      notificationId,
    ]);
    return noticeId;
  }

  async function getSettings(who: string | undefined, academy: string) {
    const academyId = academyIds[academy] ?? academy;
    const headers: Record<string, string> = who === undefined ? {} : { authorization: `Bearer ${tokens[who]}` };
    const res = await GET(new Request(`${BASE}/api/academies/${academyId}/settings`, { headers }), {
      params: Promise.resolve({ academyId }),
    });
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: academySettingsResponseSchema.parse(json), code: undefined, text, res };
    return { status: res.status, body: undefined, code: json["code"], text, res };
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    GET = createAcademySettingsRoute({
      db: handle.db,
      getSession: (headers: Headers) => auth.api.getSession({ headers }),
      fieldCipher: cipher,
      clock: fixedClock(NOW),
    });

    await makeStaff("ownerA");
    await makeStaff("ownerB");
    await makeStaff("ownerNo2fa", { twoFactor: false });
    await makeStaff("admin", { roles: ["admin"] });
    await makeStaff("applicant"); // 입점 신청만 낸 사람 — 아직 승인 전
    await makeAcademy("A", "ownerA");
    await makeAcademy("B", "ownerB");
    await makeAcademy("C", "ownerNo2fa");
    await q("INSERT INTO merchant_applications (id, applicant_account_id, status, updated_at) VALUES ($1, $2, 'submitted', now())", [
      randomUUID(),
      staffIds["applicant"],
    ]);

    // 학원 A: 지점 둘(두 번째는 나중에 만든 곳) · 활성 계좌 1 + 바뀐 옛 계좌 1 · 동의 2항목(하나는 재동의) · 약관 변경 통지 2건(하나는 시행 지남)
    await q(
      `INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, phone, opening_hours, created_at, updated_at)
       VALUES (uuidv7(), $1, '본점', '서울 마포구 테스트로 1', '서울', '마포구', '02-000-0000', '평일 14:00~23:00', '2026-11-01T00:00:00Z', now()),
              (uuidv7(), $1, '2호점', '서울 강남구 테스트로 2', '서울', '강남구', NULL, NULL, '2026-11-02T00:00:00Z', now())`,
      [academyIds["A"]],
    );
    const enc = (n: string) => Buffer.from(cipher.encrypt(n, ACADEMY_PAYOUT_ACCOUNT_CONTEXT));
    await q(
      `INSERT INTO academy_payout_accounts (id, academy_id, bank_code, account_enc, account_last4, holder_name, status, created_by_account_id, replaced_at)
       VALUES (uuidv7(), $1, '004', $2, '9999', '옛 예금주', 'replaced', $4, now()),
              (uuidv7(), $1, '088', $3, '0521', '라틴하우스', 'active', $4, NULL)`,
      [academyIds["A"], enc("220000009999"), enc(ACCOUNT_NUMBER), staffIds["ownerA"]],
    );
    await makeVersion("fee1", "platform_fee_notice", "1.0", "2026-10-01T00:00:00Z");
    await makeVersion("fee2", "platform_fee_notice", "1.1", "2026-10-15T00:00:00Z");
    await makeVersion("content1", "content_license", "1.0", "2026-10-01T00:00:00Z");
    await makeVersion("terms2", "merchant_terms", "2.0", "2026-12-31T00:00:00Z"); // 시행 전
    await makeVersion("past", "content_license", "1.1", "2026-11-10T00:00:00Z"); // 이미 시행
    const app = (await q("SELECT id FROM merchant_applications WHERE academy_id = $1", [academyIds["A"]])).rows[0].id as string;
    for (const [version, item, agreedAt] of [
      ["fee1", "platform_fee_notice", "2026-10-02T00:00:00Z"],
      ["fee2", "platform_fee_notice", "2026-10-16T00:00:00Z"],
      ["content1", "content_license", "2026-10-02T00:00:00Z"],
    ] as const) {
      await q(
        `INSERT INTO merchant_consents (id, application_id, academy_id, staff_account_id, terms_version_id, item, agreed_at, source)
         VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, 'application')`,
        [app, academyIds["A"], staffIds["ownerA"], versionIds[version], item, agreedAt],
      );
    }
    await makeNotice("terms2", "A", "ownerA");
    await makeNotice("past", "A", "ownerA");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("수용 시나리오 4 — 승인 전 신청자는 있는 학원 id 어느 것으로 불러도 403(대표 연결이 없다)", async () => {
    for (const academy of ["A", "B", "C"]) {
      const res = await getSettings("applicant", academy);
      expect([res.status, res.code]).toEqual([403, "FORBIDDEN"]);
      // 학원 정보가 한 글자도 새지 않는다
      expect(res.text).not.toContain("학원");
      expect(res.text).not.toContain("라틴하우스");
    }
    // 없는 학원 id 는 공통 가드 순서(계약 README §6-2 ⑤ 학원 존재 → ⑥ 대표)대로 404 — 학원이 없으니 알려 줄 정보도 없다
    const missing = await getSettings("applicant", randomUUID());
    expect([missing.status, missing.code]).toEqual([404, "NOT_FOUND"]);
  });

  test("승인된 학원 — 학원·지점·등록 형태·계좌(가린 값)·입점 조건 요약·시행 전 약관 변경", async () => {
    const res = await getSettings("ownerA", "A");
    expect(res.status).toBe(200);
    expect(res.res.headers.get("cache-control")).toBe("private, no-store");
    const body = res.body!;
    expect(body).toMatchObject({
      academyId: academyIds["A"],
      name: "A 학원",
      status: "active",
      seller: {
        businessName: "테스트 상호",
        representativeName: "테스트 대표",
        businessRegistrationNumber: "1234567890",
        mailOrderReportNumber: null,
        businessAddress: "서울 마포구 테스트로 1",
        phone: "02-000-0000",
      },
      registration: {
        registrationType: "academy",
        registrationVerified: true,
        strictRefundStandard: false,
        pendingChange: null,
        industryCode: "854",
      },
      // 바뀐(replaced) 옛 계좌가 아니라 지금 쓰는 계좌 하나
      payoutAccount: { bankCode: "088", accountMasked: "110-***-***521", holderName: "라틴하우스", holderVerified: false },
      onboardingTerms: { platformFeeExemptUntil: "2027-11-20", cardPaymentEnabled: true },
    });
    expect(body.registration.verifiedAt).not.toBeNull();
    // 지점은 만든 순서대로, 비운 칸은 null
    expect(body.branches.map((b) => b.name)).toEqual(["본점", "2호점"]);
    expect(body.branches[0]).toMatchObject({ region: { sido: "서울", gu: "마포구" }, openingHours: "평일 14:00~23:00", facilities: null });
    expect(body.branches[1]).toMatchObject({ phone: null, openingHours: null });
    // 동의는 항목마다 최신 하나(재동의한 수수료는 1.1)
    expect(body.onboardingTerms.agreedItems.map((i) => [i.item, i.version])).toEqual([
      ["content_license", "1.0"],
      ["platform_fee_notice", "1.1"],
    ]);
    // 시행 전인 변경만(이미 시행된 content_license 1.1 은 빠진다)
    expect(body.pendingTermsChanges.map((n) => [n.item, n.version, n.readAt])).toEqual([["merchant_terms", "2.0", null]]);
    // 계좌 원문은 응답 어디에도 없다(옛 계좌 번호도)
    expect(res.text).not.toContain(ACCOUNT_NUMBER);
    expect(res.text).not.toContain("220000009999");
  });

  test("등록 형태 변경 신청이 걸려 있으면 — 이전 형태 그대로, 확인 전(엄격 기준), 신청 내용이 따로 보인다", async () => {
    await q(
      `UPDATE academies SET pending_registration_type = 'unregistered', registration_change_requested_at = now(),
                            registration_verified_at = NULL WHERE id = $1`,
      [academyIds["B"]],
    );
    const res = await getSettings("ownerB", "B");
    expect(res.status).toBe(200);
    expect(res.body!.registration).toMatchObject({
      registrationType: "academy",
      registrationVerified: false,
      strictRefundStandard: true,
      verifiedAt: null,
      pendingChange: { registrationType: "unregistered", evidenceFileId: null },
    });
    // 지점·계좌가 아직 없는 학원은 빈 목록과 null
    expect(res.body!.branches).toEqual([]);
    expect(res.body!.payoutAccount).toBeNull();
    expect(res.body!.onboardingTerms.agreedItems).toEqual([]);
  });

  test("권한 — 다른 학원 대표·운영자 403, 2단계 전 401, 로그인 안 함 401", async () => {
    expect((await getSettings("ownerB", "A")).status).toBe(403);
    expect((await getSettings("admin", "A")).status).toBe(403);
    const no2fa = await getSettings("ownerNo2fa", "C");
    expect([no2fa.status, no2fa.code]).toEqual([401, "SECOND_FACTOR_REQUIRED"]);
    expect((await getSettings(undefined, "A")).status).toBe(401);
  });
});
