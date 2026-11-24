// S1-1.10(입점 신청 초안 저장·조회 API) — `GET /api/merchant-applications/me` · `PUT /api/merchant-applications/me/draft`
// (계약 07 §2)를 진짜 Better Auth 세션 + 진짜 PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-1-10.db.test.ts 였는데, 기능 이름(merchant-application-draft)으로 바꿨다.
//   verify 세 가지:
//     ① 초안 덮어쓰기 — 두 번째 저장이 칸·증빙을 통째로 바꾸고 신청 행은 하나 그대로다
//     ② 제출 뒤 수정은 409 APPLICATION_NOT_EDITABLE — 저장된 값이 바뀌지 않는다
//     ③ 인증 앱 미등록 대표의 신청은 401 SECOND_FACTOR_REQUIRED(D24, S1-1.8 에서 옮김) — 행이 생기지 않는다
//   나머지: 계좌번호 원문이 응답·DB 어디에도 없음(FR-299) · 없으면 404 · 거절 뒤 새 초안 · 남의 파일·사진 용도 422
//   · 형식 오류 422 · 동시 저장 2건 → 열린 신청 1개 · 세션 없음 401.
import { randomBytes, randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createFieldCipher, type FieldCipher } from "@/lib/server/field-encryption";
import {
  PAYOUT_ACCOUNT_CONTEXT,
  applicationResponseSchema,
  createGetMyApplicationRoute,
  createPutDraftRoute,
} from "@/lib/server/services/merchant-application-draft";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 비밀값 글자가 저장소에 남지 않게 실행마다 새로 만든다(repo-secret-scan 규칙)
const SECRET = randomBytes(32).toString("hex");
const BASE = "http://localhost:3000";
const ACCOUNT = "110000000521";

describe.skipIf(!dbAvailable())("입점 신청 초안 저장·조회(계약 07 §2)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let cipher: FieldCipher;
  let GET: ReturnType<typeof createGetMyApplicationRoute>;
  let PUT: ReturnType<typeof createPutDraftRoute>;
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
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

  async function makeFile(owner: string, purpose = "merchant_evidence"): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO uploaded_files (id, uploader_account_id, purpose, visibility, storage_key, mime_type, size_bytes, sha256, display_name)
       VALUES ($1, $2, $3, $4, $5, 'application/pdf', 10, 'x', '증빙.pdf')`,
      [id, staffIds[owner], purpose, purpose === "merchant_evidence" ? "private" : "public", `k-${id}.pdf`],
    );
    return id;
  }

  const headersOf = (who: string | undefined): Record<string, string> =>
    who === undefined ? {} : { authorization: `Bearer ${tokens[who]}` };

  async function call(method: "GET" | "PUT", who: string | undefined, body?: unknown) {
    const path = method === "GET" ? "/api/merchant-applications/me" : "/api/merchant-applications/me/draft";
    const request = new Request(`${BASE}${path}`, {
      method,
      headers: { ...headersOf(who), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await (method === "GET" ? GET : PUT)(request, undefined);
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: applicationResponseSchema.parse(json), text, code: undefined };
    return { status: res.status, body: undefined, text, code: json["code"] as string | undefined, raw: json };
  }

  const appRows = async (who: string) =>
    (await q("SELECT * FROM merchant_applications WHERE applicant_account_id = $1 ORDER BY created_at", [staffIds[who]]))
      .rows as Record<string, unknown>[];
  const docRows = async (applicationId: unknown) =>
    (await q("SELECT doc_kind, file_id FROM merchant_application_documents WHERE application_id = $1 ORDER BY doc_kind", [applicationId]))
      .rows as Record<string, unknown>[];

  const fullDraft = (docs: { docKind: string; fileId: string }[]) => ({
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
    documents: docs,
    payoutAccount: { bankCode: "088", accountNumber: ACCOUNT, holderName: "라틴하우스" },
  });

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    cipher = createFieldCipher(randomBytes(32).toString("base64"));
    const deps = { db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), fieldCipher: cipher };
    GET = createGetMyApplicationRoute(deps);
    PUT = createPutDraftRoute(deps);

    await makeStaff("owner", true); // 인증 앱까지 마친 대표(역할 없음 — staff_self)
    await makeStaff("owner_no_2fa", false); // 가입만 하고 인증 앱 등록 전
    await makeStaff("other", true); // 다른 신청자
  });

  beforeEach(async () => {
    await q("DELETE FROM merchant_application_documents");
    await q("DELETE FROM merchant_applications");
    await q("DELETE FROM uploaded_files");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("verify ③ 인증 앱 미등록 대표는 저장·조회 모두 401 SECOND_FACTOR_REQUIRED — 행이 생기지 않는다", async () => {
    const put = await call("PUT", "owner_no_2fa", fullDraft([]));
    expect(put).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    const get = await call("GET", "owner_no_2fa");
    expect(get).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    expect(await appRows("owner_no_2fa")).toHaveLength(0);
  });

  test("세션이 없으면 401 UNAUTHENTICATED", async () => {
    expect(await call("PUT", undefined, {})).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(await call("GET", undefined)).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  test("신청이 없으면 GET 404 NOT_FOUND", async () => {
    expect(await call("GET", "owner")).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("첫 저장은 초안을 만든다 — 계좌번호는 가린 값만 응답에, DB 에는 암호문과 끝 4자리만", async () => {
    const reg = await makeFile("owner");
    const sports = await makeFile("owner");
    const docs = [
      { docKind: "business_registration", fileId: reg },
      { docKind: "sports_facility_report", fileId: sports },
    ];
    const res = await call("PUT", "owner", fullDraft(docs));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "draft",
      academyName: "라틴하우스 강남",
      region: { sido: "서울", gu: "강남구" },
      mailOrderReportNumber: null,
      documents: docs,
      payoutAccount: { bankCode: "088", accountMasked: "110-***-***521", holderName: "라틴하우스" },
      submittedAt: null,
      academyId: null,
    });
    // 응답 글자 어디에도 원문 번호가 없다(FR-299)
    expect(res.text).not.toContain(ACCOUNT);

    const [row, ...rest] = await appRows("owner");
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({ status: "draft", payout_account_last4: "0521", business_registration_number: "1234567890" });
    const enc = row?.["payout_account_enc"] as Buffer;
    expect(Buffer.isBuffer(enc)).toBe(true);
    expect(enc.toString("latin1")).not.toContain(ACCOUNT);
    // 같은 키로만, 같은 칸 이름으로만 풀린다
    expect(cipher.decrypt(enc, PAYOUT_ACCOUNT_CONTEXT)).toBe(ACCOUNT);
    expect(() => cipher.decrypt(enc, "staff_accounts.phone_enc")).toThrow();
    expect(() => createFieldCipher(randomBytes(32).toString("base64")).decrypt(enc, PAYOUT_ACCOUNT_CONTEXT)).toThrow();

    // 파일 attached_at 은 제출 때 채운다 — 초안 저장으로는 그대로 NULL
    const attached = await q("SELECT count(*)::int AS n FROM uploaded_files WHERE attached_at IS NOT NULL");
    expect(attached.rows[0].n).toBe(0);

    const get = await call("GET", "owner");
    expect(get.body).toEqual(res.body);
  });

  test("verify ① 두 번째 저장은 초안 전체를 덮어쓴다 — 빠진 칸은 비고, 증빙·계좌도 바뀌고, 행은 하나", async () => {
    const reg = await makeFile("owner");
    const sports = await makeFile("owner");
    const first = await call("PUT", "owner", fullDraft([
      { docKind: "business_registration", fileId: reg },
      { docKind: "sports_facility_report", fileId: sports },
    ]));
    expect(first.status).toBe(200);

    const academyDoc = await makeFile("owner");
    const second = await call("PUT", "owner", {
      academyName: "살사클럽 홍대",
      registrationType: "academy",
      businessRegistrationNumber: "987-65-43210", // 하이픈은 걷어 낸다
      documents: [{ docKind: "academy_registration", fileId: academyDoc }],
      payoutAccount: { bankCode: "004", accountNumber: "9876-5432-1098", holderName: "살사클럽" },
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      applicationId: first.body?.applicationId,
      status: "draft",
      academyName: "살사클럽 홍대",
      branchName: null, // 이번 본문에 없던 칸은 비었다(전체 교체)
      businessName: null,
      region: { sido: null, gu: null },
      registrationType: "academy",
      businessRegistrationNumber: "9876543210",
      documents: [{ docKind: "academy_registration", fileId: academyDoc }],
      payoutAccount: { bankCode: "004", accountMasked: "987-***-***098", holderName: "살사클럽" },
    });

    const rows = await appRows("owner");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ payout_account_last4: "1098", branch_name: null });
    expect(await docRows(rows[0]?.["id"])).toEqual([{ doc_kind: "academy_registration", file_id: academyDoc }]);

    // 계좌를 빼고 저장하면 계좌 칸도 모두 비운다
    const third = await call("PUT", "owner", { academyName: "살사클럽 홍대" });
    expect(third.body?.payoutAccount).toEqual({ bankCode: null, accountMasked: null, holderName: null });
    expect(third.body?.documents).toEqual([]);
    const [after] = await appRows("owner");
    expect(after).toMatchObject({ payout_account_enc: null, payout_account_last4: null });
  });

  test.each(["submitted", "in_review"])(
    "verify ② %s 신청을 고치려 하면 409 APPLICATION_NOT_EDITABLE — 값이 그대로다",
    async (status) => {
      const first = await call("PUT", "owner", fullDraft([]));
      expect(first.status).toBe(200);
      await q("UPDATE merchant_applications SET status = $1, submitted_at = now() WHERE id = $2", [status, first.body?.applicationId]);

      const res = await call("PUT", "owner", { academyName: "바꾼 이름" });
      expect(res).toMatchObject({ status: 409, code: "APPLICATION_NOT_EDITABLE" });
      const rows = await appRows("owner");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status, academy_name: "라틴하우스 강남" });

      // 조회는 된다 — 제출한 신청을 그대로 돌려준다
      const get = await call("GET", "owner");
      expect(get.body).toMatchObject({ status, academyName: "라틴하우스 강남" });
    },
  );

  test("승인된 신청자는 새 초안을 만들 수 없다(409), 거절된 신청자는 새 초안을 만든다", async () => {
    const first = await call("PUT", "owner", fullDraft([]));
    await q("UPDATE merchant_applications SET status = 'rejected', reject_reason_code = 'info_mismatch', decided_at = now() WHERE id = $1", [
      first.body?.applicationId,
    ]);
    // 거절 뒤 GET 은 마지막 신청(거절)을 돌려준다
    expect((await call("GET", "owner")).body).toMatchObject({ status: "rejected", rejectReasonCode: "info_mismatch" });

    const again = await call("PUT", "owner", { academyName: "다시 신청" });
    expect(again.status).toBe(200);
    expect(again.body?.applicationId).not.toBe(first.body?.applicationId);
    expect(await appRows("owner")).toHaveLength(2);
    // 열린 신청이 있으면 GET 은 그것을 돌려준다
    expect((await call("GET", "owner")).body).toMatchObject({ status: "draft", academyName: "다시 신청" });

    // 승인된 신청에는 학원이 있어야 한다(ck_merchant_app_approved) — 학원 행을 하나 만들어 승인 상태를 흉내 낸다
    await q("UPDATE merchant_applications SET status = 'withdrawn' WHERE id = $1", [again.body?.applicationId]);
    const academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, registration_type, business_name, representative_name,
                              business_registration_number, business_address, phone, approved_at, updated_at)
       VALUES ($1, '승인 학원', '서울', '강남구', 'academy', '상호', '대표', '1234567890', '주소', '0200000000', now(), now())`,
      [academyId],
    );
    await q("UPDATE merchant_applications SET status = 'approved', reject_reason_code = NULL, academy_id = $2, decided_at = now() WHERE id = $1", [
      first.body?.applicationId,
      academyId,
    ]);
    const blocked = await call("PUT", "owner", { academyName: "두 번째 학원" });
    expect(blocked).toMatchObject({ status: 409, code: "APPLICATION_NOT_EDITABLE" });
    expect(await appRows("owner")).toHaveLength(2);
  });

  test("남의 파일·사진 용도 파일·없는 파일은 증빙으로 붙일 수 없다(422) — 초안도 생기지 않는다", async () => {
    const others = await makeFile("other");
    const photo = await makeFile("owner", "academy_photo");
    for (const fileId of [others, photo, randomUUID()]) {
      const res = await call("PUT", "owner", fullDraft([{ docKind: "business_registration", fileId }]));
      expect(res).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
      expect(res.raw?.["fields"]).toEqual([{ path: "documents.0.fileId", message: expect.any(String) }]);
    }
    expect(await appRows("owner")).toHaveLength(0);
  });

  test("형식이 틀린 칸은 422 VALIDATION_FAILED — 칸 이름을 알려 주고 원문 계좌번호를 되돌려 싣지 않는다", async () => {
    const cases: [unknown, string][] = [
      [{ businessRegistrationNumber: "123456789" }, "businessRegistrationNumber"],
      [{ payoutAccount: { accountNumber: "abc0000000521" } }, "payoutAccount.accountNumber"],
      [{ registrationType: "school" }, "registrationType"],
      [{ unknownField: 1 }, ""],
      [
        { documents: [{ docKind: "business_registration", fileId: randomUUID() }, { docKind: "business_registration", fileId: randomUUID() }] },
        "documents",
      ],
    ];
    for (const [body, path] of cases) {
      const res = await call("PUT", "owner", body);
      expect(res).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
      expect((res.raw?.["fields"] as { path: string }[]).map((f) => f.path)).toContain(path);
      expect(res.text).not.toContain("0000000521");
    }
    // JSON 이 아니면 400
    const bad = await PUT(
      new Request(`${BASE}/api/merchant-applications/me/draft`, { method: "PUT", headers: headersOf("owner"), body: "{" }),
      undefined,
    );
    expect(bad.status).toBe(400);
    expect(await appRows("owner")).toHaveLength(0);
  });

  test("동시에 두 번 저장해도 열린 신청은 하나다(uq_merchant_app_open)", async () => {
    const results = await Promise.all([
      call("PUT", "owner", { academyName: "A" }),
      call("PUT", "owner", { academyName: "B" }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const rows = await appRows("owner");
    expect(rows).toHaveLength(1);
    expect(results[0]?.body?.applicationId).toBe(results[1]?.body?.applicationId);
  });

  test("신청은 사람마다 따로다 — 다른 신청자의 초안은 보이지 않는다", async () => {
    await call("PUT", "owner", fullDraft([]));
    expect(await call("GET", "other")).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});
