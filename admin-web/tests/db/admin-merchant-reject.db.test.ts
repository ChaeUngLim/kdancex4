// S1-1.15(심사 반려 API) — `POST /api/admin/merchant-applications/{id}/reject`(계약 07 §3 · 열린 점 ⑪)를
// 진짜 Better Auth 세션 + 진짜 PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-1-15.db.test.ts 였는데, 기능 이름(admin-merchant-reject)으로 바꿨다.
//   verify(통합): 반려 뒤 신청자가 초안을 저장하면 「새 신청」(다른 applicationId)이 열린다. 옛 신청은 rejected 그대로.
//   나머지: 사유 코드·글이 신청자에게 돌아간다(내 신청 조회 · 알림 payload) · 권한(대표·신청자 403, 세션 없음·2단계 전 401) ·
//   본문 422(사유 코드 4종 밖·글 비움·501자·다른 칸) · 404(초안·없는 id·모양 틀린 id) · 409(심사 시작 전·철회·승인됨·다른 사유) ·
//   같은 사유로 다시 보내면 200 같은 본문(알림·감사 1개 그대로) · 반려와 승인이 동시에 오면 하나만 이긴다.
import { randomBytes, randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createFieldCipher, type FieldCipher } from "@/lib/server/field-encryption";
import { adminApplicationSchema } from "@/lib/server/services/admin-merchant-applications";
import { createApproveRoute, createRejectRoute, REJECT_REASON_TEXT_MAX } from "@/lib/server/services/admin-merchant-review";
import {
  applicationResponseSchema,
  createGetMyApplicationRoute,
  createPutDraftRoute,
  PAYOUT_ACCOUNT_CONTEXT,
} from "@/lib/server/services/merchant-application-draft";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 비밀값 글자가 저장소에 남지 않게 실행마다 새로 만든다(repo-secret-scan 규칙)
const SECRET = randomBytes(32).toString("hex");
const BASE = "http://localhost:3000";
const accountOf = (n: number) => `1100000008${String(n).padStart(2, "0")}`;
const REASON = { reasonCode: "info_mismatch", reasonText: "사업자등록증 상호와 신청 상호가 달라요" } as const;

describe.skipIf(!dbAvailable())("운영자 심사 반려(계약 07 §3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let cipher: FieldCipher;
  let REJECT: ReturnType<typeof createRejectRoute>;
  let APPROVE: ReturnType<typeof createApproveRoute>;
  let GET_ME: ReturnType<typeof createGetMyApplicationRoute>;
  let PUT_DRAFT: ReturnType<typeof createPutDraftRoute>;
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const appIds: Record<string, string> = {};
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const count = async (sql: string, params: unknown[] = []) => Number((await q(sql, params)).rows[0].n);
  const statusOf = async (key: string) =>
    (await q("SELECT status FROM merchant_applications WHERE id = $1", [appIds[key]])).rows[0].status as string;

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

  /** 신청 한 건을 DB 에 바로 넣는다(초안·제출·심사 시작 경로는 각자 테스트가 있다) */
  async function makeApplication(key: string, input: { status: string; submitted: boolean; n: number }) {
    await makeStaff(`app${key}`);
    const account = accountOf(input.n);
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
  }

  function headersFor(who: string | undefined, key?: string): Headers {
    const headers = new Headers({ "content-type": "application/json" });
    if (who !== undefined) headers.set("authorization", `Bearer ${tokens[who]}`);
    if (key !== undefined) headers.set("Idempotency-Key", key);
    return headers;
  }

  async function toResult(res: Response) {
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    return { status: res.status, json, text, code: json["code"] as string | undefined };
  }

  /** 반려 요청. body 를 글자로 주면 그대로, 객체면 JSON 으로 보낸다 */
  async function reject(who: string | undefined, id: string, body: string | object = REASON) {
    const res = await REJECT(
      new Request(`${BASE}/api/admin/merchant-applications/${id}/reject`, {
        method: "POST",
        headers: headersFor(who),
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
    return toResult(res);
  }

  async function approve(who: string, id: string, key: string) {
    const res = await APPROVE(
      new Request(`${BASE}/api/admin/merchant-applications/${id}/approve`, { method: "POST", headers: headersFor(who, key) }),
      { params: Promise.resolve({ id }) },
    );
    return toResult(res);
  }

  /** 신청자 본인의 「내 신청」 조회 — 반려 사유가 돌아오는 자리 */
  async function getMe(who: string) {
    return toResult(await GET_ME(new Request(`${BASE}/api/merchant-applications/me`, { headers: headersFor(who) }), undefined));
  }

  /** 신청자 본인의 초안 저장(1단계 일부만) — 반려 뒤 재신청 */
  async function putDraft(who: string, body: object) {
    const res = await PUT_DRAFT(
      new Request(`${BASE}/api/merchant-applications/me/draft`, { method: "PUT", headers: headersFor(who), body: JSON.stringify(body) }),
      undefined,
    );
    return toResult(res);
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    cipher = createFieldCipher(randomBytes(32).toString("base64"));
    const deps = { db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }), fieldCipher: cipher };
    REJECT = createRejectRoute(deps);
    APPROVE = createApproveRoute(deps);
    GET_ME = createGetMyApplicationRoute(deps);
    PUT_DRAFT = createPutDraftRoute(deps);

    await makeStaff("admin", { roles: ["admin"] });
    await makeStaff("admin2", { roles: ["admin"] });
    await makeStaff("adminNo2fa", { roles: ["admin"], twoFactor: false });
    await makeStaff("owner", { roles: ["owner"] });

    await makeApplication("R", { status: "in_review", submitted: true, n: 1 }); // 반려 → 재신청(verify)
    await makeApplication("P", { status: "submitted", submitted: true, n: 2 }); // 심사 시작 전 → 409
    await makeApplication("D", { status: "draft", submitted: false, n: 3 }); // 초안 — 운영자에게는 없는 신청
    await makeApplication("W", { status: "withdrawn", submitted: true, n: 4 }); // 제출 뒤 철회 → 409
    await makeApplication("X", { status: "in_review", submitted: true, n: 5 }); // 반려·승인 동시
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  // ---- 권한 -----------------------------------------------------------------------------

  test("대표·신청자 본인은 403, 세션 없음·2단계 전 401 — 신청은 심사 중 그대로", async () => {
    for (const who of ["owner", "appR"]) {
      expect(await reject(who, appIds["R"]!)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    }
    expect(await reject(undefined, appIds["R"]!)).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(await reject("adminNo2fa", appIds["R"]!)).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    expect(await statusOf("R")).toBe("in_review");
  });

  // ---- 입력 검사 ----------------------------------------------------------------------------

  test("본문: 사유 코드 없음·4종 밖·글 없음·빈 글·501자·다른 칸 422 · JSON 아님·빈 본문 400", async () => {
    const invalid: object[] = [
      { reasonText: REASON.reasonText },
      { reasonCode: "other", reasonText: REASON.reasonText },
      { reasonCode: "info_mismatch" },
      { reasonCode: "info_mismatch", reasonText: "   " },
      { reasonCode: "info_mismatch", reasonText: "가".repeat(REJECT_REASON_TEXT_MAX + 1) },
      { ...REASON, force: true },
    ];
    for (const body of invalid) {
      expect(await reject("admin", appIds["R"]!, body)).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    }
    expect(await reject("admin", appIds["R"]!, "not json")).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await reject("admin", appIds["R"]!, "")).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await statusOf("R")).toBe("in_review");
  });

  test("초안·없는 id·모양 틀린 id 404 · 심사 시작 전(submitted)·철회한 신청 409", async () => {
    expect(await reject("admin", appIds["D"]!)).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await reject("admin", randomUUID())).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await reject("admin", "not-a-uuid")).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await reject("admin", appIds["P"]!)).toMatchObject({ status: 409, code: "APPLICATION_STATE_CONFLICT" });
    expect(await reject("admin", appIds["W"]!)).toMatchObject({ status: 409, code: "APPLICATION_STATE_CONFLICT" });
    expect(await statusOf("P")).toBe("submitted");
    expect(await statusOf("W")).toBe("withdrawn");
    expect(await statusOf("D")).toBe("draft");
  });

  // ---- 반려 ---------------------------------------------------------------------------------

  test("반려: in_review → rejected, 응답에 사유 코드·글·결정 시각 · 알림 1건(사유 포함) · 감사 1행", async () => {
    const res = await reject("admin", appIds["R"]!, { reasonCode: REASON.reasonCode, reasonText: `  ${REASON.reasonText}  ` });
    expect(res.status).toBe(200);
    const body = adminApplicationSchema.parse(res.json);
    expect(body).toMatchObject({
      applicationId: appIds["R"],
      status: "rejected",
      rejectReasonCode: "info_mismatch",
      rejectReasonText: REASON.reasonText, // 앞뒤 공백은 지운다
      academyId: null,
    });
    expect(body.decidedAt).not.toBeNull();

    const row = (
      await q("SELECT status, reject_reason_code, reject_reason_text, decided_at, reviewed_by_account_id FROM merchant_applications WHERE id = $1", [
        appIds["R"],
      ])
    ).rows[0];
    expect(row).toMatchObject({
      status: "rejected",
      reject_reason_code: "info_mismatch",
      reject_reason_text: REASON.reasonText,
      reviewed_by_account_id: staffIds["admin"],
    });
    expect(row.decided_at).not.toBeNull();

    const notes = (
      await q(
        "SELECT category, academy_id, payload FROM notifications WHERE kind = 'merchant_application_rejected' AND recipient_staff_account_id = $1",
        [staffIds["appR"]],
      )
    ).rows;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      category: "approval",
      academy_id: null,
      payload: { applicationId: appIds["R"], reasonCode: "info_mismatch", reasonText: REASON.reasonText },
    });

    const audits = (
      await q("SELECT actor_staff_account_id, before, after FROM audit_logs WHERE action = 'merchant_application.rejected' AND target_id = $1", [
        appIds["R"],
      ])
    ).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_staff_account_id: staffIds["admin"],
      before: { status: "in_review" },
      after: { status: "rejected", reasonCode: "info_mismatch", reasonText: REASON.reasonText },
    });
    // 반려는 학원을 만들지 않는다
    expect(await count("SELECT count(*) AS n FROM academy_owners WHERE staff_account_id = $1", [staffIds["appR"]])).toBe(0);
  });

  test("같은 사유로 다시 보내면 200 같은 본문(알림·감사 그대로 1개) · 다른 사유는 409 · 반려 뒤 승인도 409", async () => {
    const first = await reject("admin", appIds["R"]!);
    const second = await reject("admin2", appIds["R"]!);
    expect(first.status).toBe(200);
    expect(second.json).toEqual(first.json);

    expect(await reject("admin", appIds["R"]!, { reasonCode: "trust_violation", reasonText: REASON.reasonText })).toMatchObject({
      status: 409,
      code: "APPLICATION_STATE_CONFLICT",
    });
    expect(await reject("admin", appIds["R"]!, { reasonCode: REASON.reasonCode, reasonText: "다른 설명" })).toMatchObject({
      status: 409,
      code: "APPLICATION_STATE_CONFLICT",
    });
    expect(await approve("admin", appIds["R"]!, "approve-after-reject-1")).toMatchObject({
      status: 409,
      code: "APPLICATION_STATE_CONFLICT",
    });

    const saved = (await q("SELECT reject_reason_code, reviewed_by_account_id FROM merchant_applications WHERE id = $1", [appIds["R"]])).rows[0];
    expect(saved).toMatchObject({ reject_reason_code: "info_mismatch", reviewed_by_account_id: staffIds["admin"] });
    expect(
      await count("SELECT count(*) AS n FROM notifications WHERE kind = 'merchant_application_rejected' AND recipient_staff_account_id = $1", [
        staffIds["appR"],
      ]),
    ).toBe(1);
    expect(
      await count("SELECT count(*) AS n FROM audit_logs WHERE action = 'merchant_application.rejected' AND target_id = $1", [appIds["R"]]),
    ).toBe(1);
  });

  // ---- 신청자 쪽: 사유가 돌아오고, 재신청은 새 신청 ---------------------------------------------------

  test("신청자의 내 신청 조회에 반려 사유 코드·글이 보인다(FR-250 「정해진 사유를 학원에 알린다」)", async () => {
    const me = await getMe("appR");
    expect(me.status).toBe(200);
    const body = applicationResponseSchema.parse(me.json);
    expect(body).toMatchObject({
      applicationId: appIds["R"],
      status: "rejected",
      rejectReasonCode: "info_mismatch",
      rejectReasonText: REASON.reasonText,
    });
  });

  test("verify 통합: 반려 뒤 초안을 저장하면 새 신청(다른 id, draft, 사유 비움)이 열리고 옛 신청은 rejected 그대로", async () => {
    const saved = await putDraft("appR", { academyName: "학원 R 재신청", branchName: "강남점" });
    expect(saved.status).toBe(200);
    const fresh = applicationResponseSchema.parse(saved.json);
    expect(fresh.applicationId).not.toBe(appIds["R"]);
    expect(fresh).toMatchObject({
      status: "draft",
      academyName: "학원 R 재신청",
      rejectReasonCode: null,
      rejectReasonText: null,
      submittedAt: null,
      decidedAt: null,
    });

    // 내 신청 조회는 이제 새 초안을 보인다
    const me = applicationResponseSchema.parse((await getMe("appR")).json);
    expect(me.applicationId).toBe(fresh.applicationId);

    // 행은 둘 — 옛 신청(rejected, 사유 그대로) + 새 초안. 열린 신청은 하나뿐(uq_merchant_app_open)
    const rows = (
      await q("SELECT id, status, reject_reason_code FROM merchant_applications WHERE applicant_account_id = $1 ORDER BY created_at", [
        staffIds["appR"],
      ])
    ).rows;
    expect(rows).toEqual([
      { id: appIds["R"], status: "rejected", reject_reason_code: "info_mismatch" },
      { id: fresh.applicationId, status: "draft", reject_reason_code: null },
    ]);
  });

  // ---- 동시성 -------------------------------------------------------------------------------

  test("같은 신청에 반려와 승인이 동시에 오면 하나만 200, 다른 하나는 409 — 최종 상태와 결과가 맞는다", async () => {
    const [r, a] = await Promise.all([
      reject("admin", appIds["X"]!, { reasonCode: "registration_missing", reasonText: "체육시설업 신고증이 없어요" }),
      approve("admin2", appIds["X"]!, "approve-race-x-0001"),
    ]);
    const statuses = [r.status, a.status].sort();
    expect(statuses).toEqual([200, 409]);
    const final = await statusOf("X");
    expect(final).toBe(r.status === 200 ? "rejected" : "approved");
    const loser = r.status === 200 ? a : r;
    expect(loser.code).toBe("APPLICATION_STATE_CONFLICT");
    // 반려가 이겼으면 학원이 없다 / 승인이 이겼으면 반려 알림이 없다
    const academies = await count("SELECT count(*) AS n FROM academy_owners WHERE staff_account_id = $1", [staffIds["appX"]]);
    const rejectNotes = await count(
      "SELECT count(*) AS n FROM notifications WHERE kind = 'merchant_application_rejected' AND recipient_staff_account_id = $1",
      [staffIds["appX"]],
    );
    expect({ academies, rejectNotes }).toEqual(final === "rejected" ? { academies: 0, rejectNotes: 1 } : { academies: 1, rejectNotes: 0 });
  });
});
