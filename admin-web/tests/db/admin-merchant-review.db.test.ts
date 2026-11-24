// S1-1.14(심사 시작·승인 API) — `POST /api/admin/merchant-applications/{id}/start-review` · `…/{id}/approve`
// (계약 07 §3 · 수용 시나리오 3·4)를 진짜 Better Auth 세션 + 진짜 PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-1-14.db.test.ts 였는데, 기능 이름(admin-merchant-review)으로 바꿨다.
//   verify:
//     · 같은 Idempotency-Key 로 두 번 승인 → 학원·대표 연결·정산 계좌가 1개씩, 두 응답의 academyId 가 같다(수용 ③)
//     · 동시 승인 2건(다른 키) → 1건 200, 1건 409 APPLICATION_STATE_CONFLICT, 학원은 1개
//   나머지: 승인 전에는 학원이 없다(수용 ④) · 심사 시작 submitted → in_review(두 번째는 같은 본문 200) · 상태 충돌 409 ·
//   권한(대표·신청자 403, 세션 없음·2단계 전 401) · 키 없음 400 · 본문 422 · 없는 id 404 · 계좌 재암호화 · 카드 결제·면제일 ·
//   대표 역할(이미 있으면 그대로) · 알림 1건 · 감사 기록에 계좌 전체 번호 0건.
import { randomBytes, randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createFieldCipher, type FieldCipher } from "@/lib/server/field-encryption";
import { adminApplicationSchema } from "@/lib/server/services/admin-merchant-applications";
import {
  ACADEMY_PAYOUT_ACCOUNT_CONTEXT,
  approveResponseSchema,
  createApproveRoute,
  createStartReviewRoute,
} from "@/lib/server/services/admin-merchant-review";
import { PAYOUT_ACCOUNT_CONTEXT } from "@/lib/server/services/merchant-application-draft";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 비밀값 글자가 저장소에 남지 않게 실행마다 새로 만든다(repo-secret-scan 규칙)
const SECRET = randomBytes(32).toString("hex");
const BASE = "http://localhost:3000";
const accountOf = (n: number) => `1100000007${String(n).padStart(2, "0")}`;

describe.skipIf(!dbAvailable())("운영자 심사 시작·승인(계약 07 §3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let cipher: FieldCipher;
  let START: ReturnType<typeof createStartReviewRoute>;
  let APPROVE: ReturnType<typeof createApproveRoute>;
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const appIds: Record<string, string> = {};
  const accounts: string[] = [];
  let cardFeeVersionId: string;
  let termsVersionId: string;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const count = async (sql: string, params: unknown[] = []) => Number((await q(sql, params)).rows[0].n);

  async function makeStaff(key: string, opts: { twoFactor?: boolean; roles?: string[] } = {}): Promise<void> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: key.toLowerCase(), displayUsername: key },
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

  /** 신청 한 건을 DB 에 바로 넣는다(초안·제출 경로는 각자 테스트가 있다). 동의 행은 제출 때처럼 신청에 붙여 둔다 */
  async function makeApplication(
    key: string,
    input: { status: string; submitted: boolean; n: number; cardFee?: boolean; applicantRoles?: string[] },
  ) {
    await makeStaff(`app${key}`, { roles: input.applicantRoles ?? [] });
    const account = accountOf(input.n);
    accounts.push(account);
    const enc = Buffer.from(cipher.encrypt(account, PAYOUT_ACCOUNT_CONTEXT));
    appIds[key] = randomUUID();
    await q(
      `INSERT INTO merchant_applications
         (id, applicant_account_id, status, academy_name, branch_name, business_name, representative_name,
          business_registration_number, business_address, region_sido, region_gu, phone, registration_type,
          payout_bank_code, payout_account_enc, payout_account_last4, payout_holder_name, submitted_at,
          review_started_at, updated_at)
       VALUES ($1, $2, $3, $4, '강남점', '라틴하우스', '김대표', '1234567890', '서울 강남구 테헤란로 000', '서울', '강남구',
               '0200000000', 'sports_facility', '088', $5, $6, '라틴하우스',
               CASE WHEN $7::boolean THEN now() - interval '1 hour' END,
               CASE WHEN $3 = 'in_review' THEN now() END, now())`,
      [appIds[key], staffIds[`app${key}`], input.status, `학원 ${key}`, enc, account.slice(-4), input.submitted],
    );
    const versions = input.cardFee ? [termsVersionId, cardFeeVersionId] : [termsVersionId];
    for (const versionId of versions) {
      await q(
        `INSERT INTO merchant_consents (id, application_id, staff_account_id, terms_version_id, item, agreed_at, source)
         SELECT uuidv7(), $1, $2, v.id, v.kind, now(), 'application' FROM terms_versions v WHERE v.id = $3`,
        [appIds[key], staffIds[`app${key}`], versionId],
      );
    }
  }

  function headersFor(who: string | undefined, key?: string): Headers {
    const headers = new Headers({ "content-type": "application/json" });
    if (who !== undefined) headers.set("authorization", `Bearer ${tokens[who]}`);
    if (key !== undefined) headers.set("Idempotency-Key", key);
    return headers;
  }

  async function call(
    route: typeof START,
    action: string,
    who: string | undefined,
    id: string,
    opts: { key?: string; body?: string } = {},
  ) {
    const res = await route(
      new Request(`${BASE}/api/admin/merchant-applications/${id}/${action}`, {
        method: "POST",
        headers: headersFor(who, opts.key),
        ...(opts.body === undefined ? {} : { body: opts.body }),
      }),
      { params: Promise.resolve({ id }) },
    );
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    return { status: res.status, json, text, code: json["code"] as string | undefined };
  }
  const start = (who: string | undefined, id: string, opts: { body?: string } = {}) => call(START, "start-review", who, id, opts);
  const approve = (who: string | undefined, id: string, opts: { key?: string; body?: string } = {}) =>
    call(APPROVE, "approve", who, id, opts);

  const academyRows = (applicantKey: string) =>
    count(
      `SELECT count(*) AS n FROM academies ac JOIN academy_owners o ON o.academy_id = ac.id WHERE o.staff_account_id = $1`,
      [staffIds[applicantKey]],
    );

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    cipher = createFieldCipher(randomBytes(32).toString("base64"));
    const deps = { db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }), fieldCipher: cipher };
    START = createStartReviewRoute(deps);
    APPROVE = createApproveRoute(deps);

    termsVersionId = randomUUID();
    cardFeeVersionId = randomUUID();
    await q(
      `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at)
       VALUES ($1, 'merchant_terms', '1.0', '본문', now() - interval '60 days', now() - interval '30 days'),
              ($2, 'card_fee_notice', '1.0', '본문', now() - interval '60 days', now() - interval '30 days')`,
      [termsVersionId, cardFeeVersionId],
    );

    await makeStaff("admin", { roles: ["admin"] });
    await makeStaff("admin2", { roles: ["admin"] });
    await makeStaff("adminNo2fa", { roles: ["admin"], twoFactor: false });
    await makeStaff("owner", { roles: ["owner"] });

    await makeApplication("S", { status: "submitted", submitted: true, n: 1 }); // 심사 시작 → 승인(같은 키 두 번)
    await makeApplication("C", { status: "in_review", submitted: true, n: 2, cardFee: true }); // 동시 승인(다른 키)
    await makeApplication("K", { status: "in_review", submitted: true, n: 3, applicantRoles: ["owner"] }); // 동시 승인(같은 키)
    await makeApplication("P", { status: "submitted", submitted: true, n: 4 }); // 심사 시작 없이 승인 → 409
    await makeApplication("D", { status: "draft", submitted: false, n: 5 }); // 초안 — 운영자에게는 없는 신청
    await makeApplication("W", { status: "withdrawn", submitted: true, n: 6 }); // 제출 뒤 철회
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  // ---- 권한 -----------------------------------------------------------------------------

  test("대표·신청자 본인은 403, 세션 없음·2단계 전 401 — 신청은 그대로", async () => {
    for (const who of ["owner", "appS"]) {
      expect(await start(who, appIds["S"]!)).toMatchObject({ status: 403, code: "FORBIDDEN" });
      expect(await approve(who, appIds["S"]!, { key: "approve-key-x1" })).toMatchObject({ status: 403, code: "FORBIDDEN" });
    }
    expect(await start(undefined, appIds["S"]!)).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(await approve("adminNo2fa", appIds["S"]!, { key: "approve-key-x1" })).toMatchObject({
      status: 401,
      code: "SECOND_FACTOR_REQUIRED",
    });
    expect((await q("SELECT status FROM merchant_applications WHERE id = $1", [appIds["S"]])).rows[0].status).toBe("submitted");
  });

  // ---- 수용 ④: 승인 전에는 학원이 없다 ------------------------------------------------------

  test("승인 전 신청자에게는 학원·대표 연결·계좌·대표 역할이 하나도 없다", async () => {
    expect(await academyRows("appS")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM academy_owners WHERE staff_account_id = $1", [staffIds["appS"]])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM role_grants WHERE staff_account_id = $1", [staffIds["appS"]])).toBe(0);
  });

  // ---- 심사 시작 ----------------------------------------------------------------------------

  test("심사 시작: submitted → in_review, 두 번째는 아무것도 바꾸지 않고 같은 본문 200, 감사 1행", async () => {
    const first = await start("admin", appIds["S"]!);
    expect(first.status).toBe(200);
    const body = adminApplicationSchema.parse(first.json);
    expect(body).toMatchObject({ applicationId: appIds["S"], status: "in_review", academyId: null });

    const second = await start("admin2", appIds["S"]!, { body: "{}" });
    expect(second.status).toBe(200);
    expect(second.json).toEqual(first.json);

    const row = (await q("SELECT reviewed_by_account_id, review_started_at FROM merchant_applications WHERE id = $1", [appIds["S"]]))
      .rows[0];
    expect(row.reviewed_by_account_id).toBe(staffIds["admin"]);
    expect(row.review_started_at).not.toBeNull();
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_logs WHERE action = 'merchant_application.review_started' AND target_id = $1",
        [appIds["S"]],
      ),
    ).toBe(1);
  });

  test("심사 시작: 초안·없는 id·모양 틀린 id 404 · 철회한 신청 409 · 본문에 다른 칸 422", async () => {
    expect(await start("admin", appIds["D"]!)).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await start("admin", randomUUID())).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await start("admin", "not-a-uuid")).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await start("admin", appIds["W"]!)).toMatchObject({ status: 409, code: "APPLICATION_STATE_CONFLICT" });
    expect(await start("admin", appIds["P"]!, { body: '{"force":true}' })).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect((await q("SELECT status FROM merchant_applications WHERE id = $1", [appIds["P"]])).rows[0].status).toBe("submitted");
  });

  // ---- 승인: 입력 검사 ----------------------------------------------------------------------

  test("승인: 키 없음 400 · 심사 시작 전(submitted) 409 · 초안·없는 id 404 · 본문 422 — 학원은 생기지 않는다", async () => {
    expect(await approve("admin", appIds["P"]!)).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await approve("admin", appIds["P"]!, { key: "approve-key-p1" })).toMatchObject({
      status: 409,
      code: "APPLICATION_STATE_CONFLICT",
    });
    expect(await approve("admin", appIds["D"]!, { key: "approve-key-d1" })).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await approve("admin", randomUUID(), { key: "approve-key-n1" })).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await approve("admin", appIds["P"]!, { key: "approve-key-p2", body: '{"x":1}' })).toMatchObject({
      status: 422,
      code: "VALIDATION_FAILED",
    });
    expect(await academyRows("appP")).toBe(0);
  });

  // ---- 수용 ③: 같은 키 두 번 ----------------------------------------------------------------

  test("수용 ③: 같은 키로 승인 두 번 → 둘 다 200, academyId 같음, 학원·지점·계좌·대표 연결·역할·알림 1개씩", async () => {
    const key = "approve-key-s-0001";
    const first = await approve("admin", appIds["S"]!, { key });
    const second = await approve("admin", appIds["S"]!, { key });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = approveResponseSchema.parse(first.json);
    const b = approveResponseSchema.parse(second.json);
    expect(b.academyId).toBe(a.academyId);
    expect(a).toEqual({ applicationId: appIds["S"], status: "approved", academyId: a.academyId });

    const academyId = a.academyId;
    expect(await academyRows("appS")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM academy_branches WHERE academy_id = $1", [academyId])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM academy_payout_accounts WHERE academy_id = $1", [academyId])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM academy_owners WHERE academy_id = $1 AND status = 'active'", [academyId])).toBe(1);
    expect(
      await count("SELECT count(*) AS n FROM role_grants WHERE staff_account_id = $1 AND role = 'owner' AND status = 'active'", [
        staffIds["appS"],
      ]),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM notifications WHERE kind = 'merchant_application_approved' AND recipient_staff_account_id = $1",
        [staffIds["appS"]],
      ),
    ).toBe(1);
    expect(
      await count("SELECT count(*) AS n FROM audit_logs WHERE action = 'merchant_application.approved' AND target_id = $1", [appIds["S"]]),
    ).toBe(1);

    // 신청서 — approved · academy_id · 결정 시각 · 승인한 운영자
    const app = (await q("SELECT status, academy_id, decided_at, reviewed_by_account_id FROM merchant_applications WHERE id = $1", [appIds["S"]]))
      .rows[0];
    expect(app).toMatchObject({ status: "approved", academy_id: academyId, reviewed_by_account_id: staffIds["admin"] });
    expect(app.decided_at).not.toBeNull();

    // 같은 신청에 다른 키 → 이미 승인됨 409(학원을 또 만들지 않는다)
    expect(await approve("admin", appIds["S"]!, { key: "approve-key-s-0002" })).toMatchObject({
      status: 409,
      code: "APPLICATION_STATE_CONFLICT",
    });
    expect(await academyRows("appS")).toBe(1);
    // 승인 뒤 심사 시작도 409
    expect(await start("admin", appIds["S"]!)).toMatchObject({ status: 409, code: "APPLICATION_STATE_CONFLICT" });
  });

  test("승인이 만든 학원 값: 판매자 정보 사본 · 카드 결제 꺼짐(카드 수수료 동의 없음) · 면제일 = 승인일(KST)+1년 · 지점 · 동의 기록 연결", async () => {
    const [academy] = (
      await q(
        `SELECT ac.*, ac.platform_fee_exempt_until::text AS exempt,
                ((now() AT TIME ZONE 'Asia/Seoul')::date + interval '1 year')::date::text AS expected_exempt
         FROM academies ac JOIN merchant_applications a ON a.academy_id = ac.id WHERE a.id = $1`,
        [appIds["S"]],
      )
    ).rows;
    expect(academy).toMatchObject({
      name: "학원 S",
      status: "active",
      registration_type: "sports_facility",
      business_name: "라틴하우스",
      representative_name: "김대표",
      business_registration_number: "1234567890",
      mail_order_report_number: null,
      business_address: "서울 강남구 테헤란로 000",
      phone: "0200000000",
      region_sido: "서울",
      region_gu: "강남구",
      card_payment_enabled: false,
    });
    expect(academy.registration_verified_at).not.toBeNull();
    expect(academy.exempt).toBe(academy.expected_exempt);

    const [branch] = (await q("SELECT name, address, region_gu FROM academy_branches WHERE academy_id = $1", [academy.id])).rows;
    expect(branch).toEqual({ name: "강남점", address: "서울 강남구 테헤란로 000", region_gu: "강남구" });
    expect(await count("SELECT count(*) AS n FROM merchant_consents WHERE application_id = $1 AND academy_id IS NULL", [appIds["S"]])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM merchant_consents WHERE academy_id = $1", [academy.id])).toBe(1);
  });

  test("정산 계좌: 학원 계좌 칸 이름으로 다시 암호화(신청서 칸 이름으로는 안 풀림) · 끝 4자리 · 예금주 확인 전", async () => {
    const [row] = (
      await q(
        `SELECT p.account_enc, p.account_last4, p.bank_code, p.holder_name, p.holder_verified_at, p.holder_verify_method,
                p.created_by_account_id, p.status
         FROM academy_payout_accounts p JOIN merchant_applications a ON a.academy_id = p.academy_id WHERE a.id = $1`,
        [appIds["S"]],
      )
    ).rows;
    const enc = new Uint8Array(row.account_enc as Buffer);
    expect(cipher.decrypt(enc, ACADEMY_PAYOUT_ACCOUNT_CONTEXT)).toBe(accountOf(1));
    expect(() => cipher.decrypt(enc, PAYOUT_ACCOUNT_CONTEXT)).toThrow();
    expect(row).toMatchObject({
      account_last4: accountOf(1).slice(-4),
      bank_code: "088",
      holder_name: "라틴하우스",
      holder_verified_at: null,
      holder_verify_method: null,
      created_by_account_id: staffIds["appS"],
      status: "active",
    });
  });

  test("알림 1건(신청자 직원 알림함, approval) · 감사 기록·응답에 계좌 전체 번호 0건", async () => {
    const [n] = (
      await q(
        "SELECT category, academy_id, payload::text AS payload FROM notifications WHERE kind = 'merchant_application_approved' AND recipient_staff_account_id = $1",
        [staffIds["appS"]],
      )
    ).rows;
    expect(n.category).toBe("approval");
    expect(n.academy_id).not.toBeNull();
    const audits = (await q("SELECT after::text AS after FROM audit_logs WHERE target_id = $1", [appIds["S"]])).rows
      .map((r) => r.after as string)
      .join("\n");
    expect(accounts.filter((account) => audits.includes(account))).toEqual([]);
    expect(audits).toContain(`"last4":"${accountOf(1).slice(-4)}"`);
  });

  // ---- verify: 동시 승인 ---------------------------------------------------------------------

  test("verify: 동시 승인 2건(다른 키) → 1건 200 · 1건 409, 학원·계좌·대표 연결 1개씩", async () => {
    const results = await Promise.all([
      approve("admin", appIds["C"]!, { key: "approve-key-c-0001" }),
      approve("admin2", appIds["C"]!, { key: "approve-key-c-0002" }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.code).toBe("APPLICATION_STATE_CONFLICT");
    const academyId = approveResponseSchema.parse(results.find((r) => r.status === 200)?.json).academyId;
    expect(await academyRows("appC")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM academy_payout_accounts WHERE academy_id = $1", [academyId])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM academy_branches WHERE academy_id = $1", [academyId])).toBe(1);
    // 카드 수수료에 동의한 신청 → 카드 결제 켜짐(FR-125b)
    expect((await q("SELECT card_payment_enabled FROM academies WHERE id = $1", [academyId])).rows[0].card_payment_enabled).toBe(true);
  });

  test("동시 승인 2건(같은 키) → 둘 다 200, 같은 academyId · 이미 있던 대표 역할은 그대로(새 행 없음)", async () => {
    const key = "approve-key-k-0001";
    const results = await Promise.all([approve("admin", appIds["K"]!, { key }), approve("admin", appIds["K"]!, { key })]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const [a, b] = results.map((r) => approveResponseSchema.parse(r.json));
    expect(b!.academyId).toBe(a!.academyId);
    expect(await academyRows("appK")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM role_grants WHERE staff_account_id = $1 AND role = 'owner'", [staffIds["appK"]])).toBe(1);
    expect(
      await count("SELECT count(*) AS n FROM audit_logs WHERE action = 'role_grant.changed' AND after ->> 'staffAccountId' = $1", [
        staffIds["appK"],
      ]),
    ).toBe(0);
  });
});
