// S1-1.11(입점 신청 제출 API) — `POST /api/merchant-applications/me/submit`(계약 07 §2)를
// 진짜 Better Auth 세션 + 진짜 PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-1-11.db.test.ts 였는데, 기능 이름(merchant-application-submit)으로 바꿨다.
//   verify:
//     · 시나리오 1 — 콘텐츠 이용 허락만 agreed=false → 422 REQUIRED_CONSENT_MISSING, 신청은 draft, 동의 행 0
//     · 시나리오 2 — 미등록 신청에 사업자등록증이 없으면 422 EVIDENCE_MISSING, 붙이면 형태별 증빙 없이 제출(엄격 기준 표시)
//     · 목표 — 같은 Idempotency-Key 로 두 번(차례로·동시에) 보내도 제출 1건(동의 5행·감사 1행), 두 응답이 같다
//   나머지: 키 없음 400 · 세션 없음 401 · 2단계 전 401 · 신청 없음 404 · 다른 키로 다시 409 · 칸 빠짐 422 fields
//   · 형태별 증빙 빠짐 422 · 옛 판본 409 TERMS_VERSION_OUTDATED · 응답·감사에 계좌 원문·키 원문 0건.
import { randomBytes, randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createFieldCipher } from "@/lib/server/field-encryption";
import { applicationResponseSchema, createPutDraftRoute } from "@/lib/server/services/merchant-application-draft";
import { createSubmitApplicationRoute } from "@/lib/server/services/merchant-application-submit";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 비밀값 글자가 저장소에 남지 않게 실행마다 새로 만든다(repo-secret-scan 규칙)
const SECRET = randomBytes(32).toString("hex");
const BASE = "http://localhost:3000";
const ACCOUNT = "110000000521";

describe.skipIf(!dbAvailable())("입점 신청 제출(계약 07 §2)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let PUT: ReturnType<typeof createPutDraftRoute>;
  let SUBMIT: ReturnType<typeof createSubmitApplicationRoute>;
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const versions: Record<string, string> = {};
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  async function makeStaff(key: string, twoFactor: boolean): Promise<void> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: key, displayUsername: key },
      { method: "admin" },
    );
    if (twoFactor) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      key,
    ]);
    staffIds[key] = id;
  }

  /** 판본 한 줄. effectiveDays 는 지금 기준 시행일(음수 = 이미 시행) */
  async function version(key: string, kind: string, ver: string, effectiveDays: number): Promise<void> {
    versions[key] = randomUUID();
    await q(
      `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at)
       VALUES ($1, $2, $3, '본문', now() - interval '60 days', now() + make_interval(days => $4))`,
      [versions[key], kind, ver, effectiveDays],
    );
  }

  async function makeFile(owner: string): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO uploaded_files (id, uploader_account_id, purpose, visibility, storage_key, mime_type, size_bytes, sha256, display_name)
       VALUES ($1, $2, 'merchant_evidence', 'private', $3, 'application/pdf', 10, 'x', '증빙.pdf')`,
      [id, staffIds[owner], `k-${id}.pdf`],
    );
    return id;
  }

  const fullDraft = (registrationType: string, docs: { docKind: string; fileId: string }[]) => ({
    academyName: "라틴하우스 강남",
    branchName: "강남점",
    businessName: "라틴하우스",
    representativeName: "김대표",
    businessRegistrationNumber: "1234567890",
    mailOrderReportNumber: null,
    businessAddress: "서울 강남구 테헤란로 000, 3층",
    region: { sido: "서울", gu: "강남구" },
    phone: "0200000000",
    registrationType,
    industryCode: "921902",
    documents: docs,
    payoutAccount: { bankCode: "088", accountNumber: ACCOUNT, holderName: "라틴하우스" },
  });

  async function saveDraft(who: string, body: unknown): Promise<void> {
    const res = await PUT(
      new Request(`${BASE}/api/merchant-applications/me/draft`, {
        method: "PUT",
        headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      undefined,
    );
    expect(res.status).toBe(200);
  }

  /** 지금 시행 중인 판본 5개에 모두 동의하는 본문. override 로 한 항목만 바꾼다 */
  const consentsBody = (override: Record<string, boolean> = {}) => ({
    consents: ["terms", "fee", "card", "content", "onePlusOne"].map((k) => ({
      termsVersionId: versions[k],
      agreed: override[k] ?? true,
    })),
  });

  async function submit(who: string | undefined, key: string | null, body: unknown = consentsBody()) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    if (key !== null) headers["Idempotency-Key"] = key;
    const res = await SUBMIT(
      new Request(`${BASE}/api/merchant-applications/me/submit`, { method: "POST", headers, body: JSON.stringify(body) }),
      undefined,
    );
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: applicationResponseSchema.parse(json), text, code: undefined, raw: json };
    return { status: res.status, body: undefined, text, code: json["code"] as string | undefined, raw: json };
  }

  const newKey = () => `submit-${randomUUID()}`;
  const appRows = async (who: string) =>
    (await q("SELECT id, status, submitted_at FROM merchant_applications WHERE applicant_account_id = $1", [staffIds[who]]))
      .rows as { id: string; status: string; submitted_at: Date | null }[];
  const consentRows = async (who: string) =>
    (
      await q(
        `SELECT c.item, c.terms_version_id, c.source, c.agreed_at FROM merchant_consents c
         JOIN merchant_applications a ON a.id = c.application_id WHERE a.applicant_account_id = $1 ORDER BY c.item`,
        [staffIds[who]],
      )
    ).rows as { item: string; terms_version_id: string; source: string; agreed_at: Date }[];
  const auditRows = async (who: string) =>
    (
      await q(
        `SELECT l.after, l.after::text AS after_text FROM audit_logs l
         WHERE l.action = 'merchant_application.submitted'
           AND l.target_id IN (SELECT id FROM merchant_applications WHERE applicant_account_id = $1)`,
        [staffIds[who]],
      )
    ).rows as { after: Record<string, unknown>; after_text: string }[];

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    const deps = {
      db: handle.db,
      getSession: (h: Headers) => auth.api.getSession({ headers: h }),
      fieldCipher: createFieldCipher(randomBytes(32).toString("base64")),
    };
    PUT = createPutDraftRoute(deps);
    SUBMIT = createSubmitApplicationRoute(deps);

    // 입점 약관은 옛 판본 1.0 과 현재 판본 1.1 이 있다 — 옛 판본에 동의한 제출은 OUTDATED
    await version("termsOld", "merchant_terms", "1.0", -50);
    await version("terms", "merchant_terms", "1.1", -10);
    await version("fee", "platform_fee_notice", "1.0", -50);
    await version("card", "card_fee_notice", "1.0", -50);
    await version("content", "content_license", "1.0", -50);
    await version("onePlusOne", "one_plus_one_notice", "1.0", -50);

    await makeStaff("owner", true); // 인증 앱까지 마친 신청자(역할 없음 — staff_self)
    await makeStaff("owner_no_2fa", false); // 인증 앱 등록 전
  });

  beforeEach(async () => {
    // 감사 행은 추가 전용이라 지우지 않는다 — 테스트마다 새 키를 쓰고, 재생은 「지금 있는 내 신청」의 감사 행만 본다
    await q("DELETE FROM merchant_consents");
    await q("DELETE FROM merchant_application_documents");
    await q("DELETE FROM merchant_applications");
    await q("DELETE FROM uploaded_files");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  /** 체육시설 신청 초안(사업자등록증 + 체육시설 신고증) */
  async function sportsDraft(): Promise<string[]> {
    const reg = await makeFile("owner");
    const sports = await makeFile("owner");
    await saveDraft("owner", fullDraft("sports_facility", [
      { docKind: "business_registration", fileId: reg },
      { docKind: "sports_facility_report", fileId: sports },
    ]));
    return [reg, sports];
  }

  test("시나리오 1: 콘텐츠 이용 허락만 agreed=false → 422 REQUIRED_CONSENT_MISSING, 신청은 draft, 동의 행 0", async () => {
    await sportsDraft();
    const res = await submit("owner", newKey(), consentsBody({ content: false }));
    expect(res).toMatchObject({ status: 422, code: "REQUIRED_CONSENT_MISSING" });
    expect(String(res.raw["detail"])).toContain("콘텐츠 이용 허락");
    expect((await appRows("owner"))[0]).toMatchObject({ status: "draft", submitted_at: null });
    expect(await consentRows("owner")).toHaveLength(0);
    expect(await auditRows("owner")).toHaveLength(0);
  });

  test("필수 항목 하나를 목록에서 빼도 422 REQUIRED_CONSENT_MISSING", async () => {
    await sportsDraft();
    const body = { consents: consentsBody().consents.filter((c) => c.termsVersionId !== versions["card"]) };
    expect(await submit("owner", newKey(), body)).toMatchObject({ status: 422, code: "REQUIRED_CONSENT_MISSING" });
    expect(await consentRows("owner")).toHaveLength(0);
  });

  test("시나리오 2: 미등록 신청에 사업자등록증이 없으면 422 EVIDENCE_MISSING, 붙이면 형태별 증빙 없이 제출된다(엄격 기준 표시)", async () => {
    await saveDraft("owner", fullDraft("unregistered", []));
    const key = newKey();
    const first = await submit("owner", key);
    expect(first).toMatchObject({ status: 422, code: "EVIDENCE_MISSING" });
    expect(String(first.raw["detail"])).toContain("사업자등록증");
    expect((await appRows("owner"))[0]?.status).toBe("draft");
    expect(await consentRows("owner")).toHaveLength(0);

    // 사업자등록증만 붙여 다시 저장 → 같은 키로 다시 제출해도 된다(실패한 요청은 기록되지 않는다)
    const reg = await makeFile("owner");
    await saveDraft("owner", fullDraft("unregistered", [{ docKind: "business_registration", fileId: reg }]));
    const second = await submit("owner", key);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: "submitted", registrationType: "unregistered" });
    expect(second.body?.submittedAt).not.toBeNull();

    const [audit, ...more] = await auditRows("owner");
    expect(more).toHaveLength(0);
    // FR-087: 등록 형태 증빙이 없는 학원 → 엄격 기준 표시
    expect(audit?.after).toMatchObject({ status: "submitted", registrationType: "unregistered", strictRefundStandard: true });
  });

  test("목표: 같은 키로 두 번 보내도 제출 1건 — 동의 5행·감사 1행·파일 붙음, 두 응답이 같다", async () => {
    const files = await sportsDraft();
    const key = newKey();
    const first = await submit("owner", key);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      status: "submitted",
      payoutAccount: { bankCode: "088", accountMasked: "110-***-***521", holderName: "라틴하우스" },
    });
    const second = await submit("owner", key);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    const apps = await appRows("owner");
    expect(apps).toHaveLength(1);
    expect(apps[0]?.status).toBe("submitted");

    const consents = await consentRows("owner");
    expect(consents.map((c) => c.item)).toEqual([
      "card_fee_notice",
      "content_license",
      "merchant_terms",
      "one_plus_one_notice",
      "platform_fee_notice",
    ]);
    expect(consents.every((c) => c.source === "application")).toBe(true);
    // 입점 약관은 현재 판본(1.1)에 동의한 것으로 기록된다
    expect(consents.find((c) => c.item === "merchant_terms")?.terms_version_id).toBe(versions["terms"]);

    const audits = await auditRows("owner");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.after).toMatchObject({ strictRefundStandard: false, registrationType: "sports_facility" });

    // 붙인 증빙 파일은 이제 주인이 있다(24시간 정리 대상에서 빠짐)
    const attached = await q("SELECT id FROM uploaded_files WHERE attached_at IS NOT NULL ORDER BY id");
    expect(attached.rows.map((r: { id: string }) => r.id).sort()).toEqual([...files].sort());

    // 계좌번호 원문·키 원문은 응답·감사 어디에도 없다(FR-299)
    expect(first.text).not.toContain(ACCOUNT);
    expect(audits[0]?.after_text).not.toContain(ACCOUNT);
    expect(audits[0]?.after_text).not.toContain(key);
  });

  test("같은 키로 동시에 두 번 보내도 제출 1건 — 두 응답 모두 200 이고 같다", async () => {
    await sportsDraft();
    const key = newKey();
    const [a, b] = await Promise.all([submit("owner", key), submit("owner", key)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(await consentRows("owner")).toHaveLength(5);
    expect(await auditRows("owner")).toHaveLength(1);
  });

  test("이미 제출한 신청을 다른 키로 보내면 409 APPLICATION_NOT_EDITABLE — 동의가 늘지 않는다", async () => {
    await sportsDraft();
    expect((await submit("owner", newKey())).status).toBe(200);
    expect(await submit("owner", newKey())).toMatchObject({ status: 409, code: "APPLICATION_NOT_EDITABLE" });
    expect(await consentRows("owner")).toHaveLength(5);
    expect(await auditRows("owner")).toHaveLength(1);
  });

  test("체육시설 신청에 신고증이 없으면 422 EVIDENCE_MISSING", async () => {
    const reg = await makeFile("owner");
    await saveDraft("owner", fullDraft("sports_facility", [{ docKind: "business_registration", fileId: reg }]));
    const res = await submit("owner", newKey());
    expect(res).toMatchObject({ status: 422, code: "EVIDENCE_MISSING" });
    expect(String(res.raw["detail"])).toContain("체육시설 신고증");
  });

  test("칸이 비면 422 VALIDATION_FAILED + 빠진 칸 목록", async () => {
    const reg = await makeFile("owner");
    await saveDraft("owner", {
      ...fullDraft("unregistered", [{ docKind: "business_registration", fileId: reg }]),
      businessName: null,
      phone: null,
      payoutAccount: null,
    });
    const res = await submit("owner", newKey());
    expect(res).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    const paths = (res.raw["fields"] as { path: string }[]).map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(["businessName", "phone", "payoutAccount.bankCode", "payoutAccount.accountNumber", "payoutAccount.holderName"]),
    );
    // 통신판매업 신고번호는 비어 있어도 된다(신고 대상인 학원만, FR-240)
    expect(paths).not.toContain("mailOrderReportNumber");
    expect((await appRows("owner"))[0]?.status).toBe("draft");
  });

  test("옛 판본에 동의하면 409 TERMS_VERSION_OUTDATED", async () => {
    await sportsDraft();
    const body = {
      consents: consentsBody().consents.map((c) =>
        c.termsVersionId === versions["terms"] ? { termsVersionId: versions["termsOld"], agreed: true } : c,
      ),
    };
    expect(await submit("owner", newKey(), body)).toMatchObject({ status: 409, code: "TERMS_VERSION_OUTDATED" });
    expect(await consentRows("owner")).toHaveLength(0);
  });

  test("신청이 없으면 404 NOT_FOUND", async () => {
    expect(await submit("owner", newKey())).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("Idempotency-Key 가 없거나 짧으면 400 BAD_REQUEST — 제출되지 않는다", async () => {
    await sportsDraft();
    expect(await submit("owner", null)).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await submit("owner", "short")).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect((await appRows("owner"))[0]?.status).toBe("draft");
  });

  test("본문 형식이 틀리면 422 VALIDATION_FAILED", async () => {
    await sportsDraft();
    expect(await submit("owner", newKey(), { consents: [{ termsVersionId: "x", agreed: true }] })).toMatchObject({
      status: 422,
      code: "VALIDATION_FAILED",
    });
  });

  test("세션 없음 401 UNAUTHENTICATED · 인증 앱 미등록 401 SECOND_FACTOR_REQUIRED", async () => {
    expect(await submit(undefined, newKey())).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(await submit("owner_no_2fa", newKey())).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
  });
});
