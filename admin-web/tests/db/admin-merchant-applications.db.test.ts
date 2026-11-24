// S1-1.13(운영자 심사 목록·상세 API) — `GET /api/admin/merchant-applications` · `GET /api/admin/merchant-applications/{id}`
// (계약 07 §3)를 진짜 Better Auth 세션 + 진짜 PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-1-13.db.test.ts 였는데, 기능 이름(admin-merchant-applications)으로 바꿨다.
//   verify:
//     · 대표가 부르면 403(목록·상세 모두) — 운영자만 본다
//     · 응답에 계좌 전체 번호 0건 — 가린 값(accountMasked)만
//   나머지: 운영자는 제출된 신청만 본다(초안·제출 안 한 철회는 없다) · 제출 순서 · 상태 거르기 · 커서로 다음 쪽(겹침·빠짐 없음)
//   · 틀린 커서·draft 거르기 422 · 상세에 증빙 파일 id · 초안·없는 id·모양 틀린 id 404 · 세션 없음·2단계 전 401.
import { randomBytes, randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createFieldCipher, type FieldCipher } from "@/lib/server/field-encryption";
import {
  adminApplicationListSchema,
  adminApplicationSchema,
  createGetMerchantApplicationRoute,
  createListMerchantApplicationsRoute,
  encodeCursor,
} from "@/lib/server/services/admin-merchant-applications";
import { PAYOUT_ACCOUNT_CONTEXT } from "@/lib/server/services/merchant-application-draft";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 비밀값 글자가 저장소에 남지 않게 실행마다 새로 만든다(repo-secret-scan 규칙)
const SECRET = randomBytes(32).toString("hex");
const BASE = "http://localhost:3000";
// 신청마다 다른 계좌번호(끝 3자리만 다르게) — 응답에 「전체 번호」가 하나라도 있으면 찾는다
const accountOf = (n: number) => `1100000005${String(n).padStart(2, "0")}`;

describe.skipIf(!dbAvailable())("운영자 심사 목록·상세(계약 07 §3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let cipher: FieldCipher;
  let LIST: ReturnType<typeof createListMerchantApplicationsRoute>;
  let DETAIL: ReturnType<typeof createGetMerchantApplicationRoute>;
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const appIds: Record<string, string> = {};
  const fileIds: Record<string, string> = {};
  const accounts: string[] = [];
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

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

  /**
   * 신청 한 건을 DB 에 바로 넣는다(초안·제출 경로는 각자 테스트가 있다 — 여기서는 「운영자가 무엇을 보나」만 본다).
   * submittedMinutesAgo 가 null 이면 제출한 적 없는 신청이다. 계좌번호는 앱과 같은 방식으로 암호화해 넣는다
   */
  async function makeApplication(key: string, input: { status: string; submittedMinutesAgo: number | null; n: number }) {
    await makeStaff(`app${key}`);
    const account = accountOf(input.n);
    accounts.push(account);
    const enc = Buffer.from(cipher.encrypt(account, PAYOUT_ACCOUNT_CONTEXT));
    appIds[key] = randomUUID();
    await q(
      `INSERT INTO merchant_applications
         (id, applicant_account_id, status, academy_name, branch_name, business_name, representative_name,
          business_registration_number, business_address, region_sido, region_gu, phone, registration_type,
          payout_bank_code, payout_account_enc, payout_account_last4, payout_holder_name,
          reject_reason_code, submitted_at, updated_at)
       VALUES ($1, $2, $3, $4, '강남점', '라틴하우스', '김대표', '1234567890', '서울 강남구 테헤란로 000', '서울', '강남구',
               '0200000000', 'sports_facility', '088', $5, $6, '라틴하우스',
               $7, CASE WHEN $8::int IS NULL THEN NULL ELSE now() - make_interval(mins => $8::int) END, now())`,
      [
        appIds[key],
        staffIds[`app${key}`],
        input.status,
        `학원 ${key}`,
        enc,
        account.slice(-4),
        input.status === "rejected" ? "info_mismatch" : null,
        input.submittedMinutesAgo,
      ],
    );
    // 증빙 2종(사업자등록증 + 체육시설 신고증)
    for (const docKind of ["business_registration", "sports_facility_report"]) {
      const fileId = randomUUID();
      await q(
        `INSERT INTO uploaded_files (id, uploader_account_id, purpose, visibility, storage_key, mime_type, size_bytes, sha256, display_name, attached_at)
         VALUES ($1, $2, 'merchant_evidence', 'private', $3, 'application/pdf', 10, 'x', '증빙.pdf', now())`,
        [fileId, staffIds[`app${key}`], `k-${fileId}.pdf`],
      );
      await q("INSERT INTO merchant_application_documents (application_id, doc_kind, file_id) VALUES ($1, $2, $3)", [appIds[key], docKind, fileId]);
      fileIds[`${key}:${docKind}`] = fileId;
    }
  }

  async function list(who: string | undefined, search = "") {
    const headers: Record<string, string> = {};
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    const res = await LIST(new Request(`${BASE}/api/admin/merchant-applications${search}`, { headers }), undefined);
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: adminApplicationListSchema.parse(json), text, code: undefined };
    return { status: res.status, body: undefined, text, code: json["code"] as string | undefined };
  }

  async function detail(who: string | undefined, id: string) {
    const headers: Record<string, string> = {};
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    const res = await DETAIL(new Request(`${BASE}/api/admin/merchant-applications/${id}`, { headers }), {
      params: Promise.resolve({ id }),
    });
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: adminApplicationSchema.parse(json), text, code: undefined };
    return { status: res.status, body: undefined, text, code: json["code"] as string | undefined };
  }

  /** 응답 글자에 계좌 전체 번호가 몇 번 나오나 — 0 이어야 한다 */
  const fullAccountHits = (text: string) => accounts.filter((account) => text.includes(account)).length;

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    cipher = createFieldCipher(randomBytes(32).toString("base64"));
    const deps = { db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }), fieldCipher: cipher };
    LIST = createListMerchantApplicationsRoute(deps);
    DETAIL = createGetMerchantApplicationRoute(deps);

    await makeStaff("admin", { roles: ["admin"] });
    await makeStaff("adminNo2fa", { roles: ["admin"], twoFactor: false });
    // 대표 — owner 역할 + 학원 A 의 active 대표. 운영자 경로에서는 그래도 403 이어야 한다
    await makeStaff("owner", { roles: ["owner"] });
    const academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '학원 A', '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffIds["owner"]]);

    // 제출 시각이 이른 순서: S1(50분 전) → R(40) → W(30) → V(20) → S2(10). D·WD 는 제출한 적 없다
    await makeApplication("S1", { status: "submitted", submittedMinutesAgo: 50, n: 1 });
    await makeApplication("R", { status: "rejected", submittedMinutesAgo: 40, n: 2 });
    await makeApplication("W", { status: "withdrawn", submittedMinutesAgo: 30, n: 3 }); // 제출한 뒤 철회
    await makeApplication("V", { status: "in_review", submittedMinutesAgo: 20, n: 4 });
    await makeApplication("S2", { status: "submitted", submittedMinutesAgo: 10, n: 5 });
    await makeApplication("D", { status: "draft", submittedMinutesAgo: null, n: 6 }); // 아직 쓰는 초안
    await makeApplication("WD", { status: "withdrawn", submittedMinutesAgo: null, n: 7 }); // 제출 안 하고 철회
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  // ---- verify: 대표 403 -------------------------------------------------------------------

  test("대표가 목록을 부르면 403 FORBIDDEN — 신청 내용이 응답에 없다", async () => {
    const res = await list("owner");
    expect(res).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(res.text).not.toContain("학원 S1");
  });

  test("대표가 상세를 부르면 403 FORBIDDEN — 있는 신청 id 여도(있는지조차 알려 주지 않는다)", async () => {
    expect(await detail("owner", appIds["S1"]!)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await detail("owner", randomUUID())).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  test("신청자 본인(직원, 운영자 아님)도 403 — 자기 신청은 /api/merchant-applications/me 로 본다", async () => {
    expect(await detail("appS1", appIds["S1"]!)).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  test("세션 없음 401 UNAUTHENTICATED · 운영자라도 2단계 전 세션은 401 SECOND_FACTOR_REQUIRED", async () => {
    expect(await list(undefined)).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(await detail(undefined, appIds["S1"]!)).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(await list("adminNo2fa")).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    expect(await detail("adminNo2fa", appIds["S1"]!)).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
  });

  // ---- 목록 ---------------------------------------------------------------------------------

  test("운영자 목록 — 제출된 신청만, 제출 시각 이른 순(초안·제출 안 한 철회는 없다), 다음 쪽 없음", async () => {
    const res = await list("admin");
    expect(res.status).toBe(200);
    expect(res.body!.items.map((i) => i.applicationId)).toEqual(["S1", "R", "W", "V", "S2"].map((k) => appIds[k]));
    expect(res.body!.nextCursor).toBeNull();
    // 신청자와 상태가 함께 온다
    expect(res.body!.items[0]).toMatchObject({
      status: "submitted",
      academyName: "학원 S1",
      applicant: { staffAccountId: staffIds["appS1"], displayName: "appS1" },
    });
    expect(res.body!.items[1]).toMatchObject({ status: "rejected", rejectReasonCode: "info_mismatch" });
  });

  test("verify: 목록 응답에 계좌 전체 번호 0건 — 가린 값만(110-***-***501)", async () => {
    const res = await list("admin");
    expect(fullAccountHits(res.text)).toBe(0);
    // 끝 4자리 묶음도 원문 그대로 이어 붙어 나오지 않는다(가린 모양만)
    expect(res.body!.items[0]!.payoutAccount).toEqual({ bankCode: "088", accountMasked: "110-***-***501", holderName: "라틴하우스" });
    expect(res.text).not.toContain("payout_account_enc");
    expect(res.text).not.toContain("accountNumber");
  });

  test("상태 거르기 — status=submitted 는 제출 상태 2건, status=in_review 는 1건", async () => {
    const submitted = await list("admin", "?status=submitted");
    expect(submitted.body!.items.map((i) => i.applicationId)).toEqual([appIds["S1"], appIds["S2"]]);
    const inReview = await list("admin", "?status=in_review");
    expect(inReview.body!.items.map((i) => i.applicationId)).toEqual([appIds["V"]]);
    // 제출 안 하고 철회한 WD 는 withdrawn 으로 걸러도 없다
    const withdrawn = await list("admin", "?status=withdrawn");
    expect(withdrawn.body!.items.map((i) => i.applicationId)).toEqual([appIds["W"]]);
  });

  test("커서로 다음 쪽 — limit=2 로 세 쪽, 겹침·빠짐 없이 5건, 마지막 쪽 nextCursor null", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    const pageSizes: number[] = [];
    do {
      const search: string = `?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const res = await list("admin", search);
      expect(res.status).toBe(200);
      pageSizes.push(res.body!.items.length);
      seen.push(...res.body!.items.map((i) => i.applicationId));
      cursor = res.body!.nextCursor;
    } while (cursor !== null);
    expect(pageSizes).toEqual([2, 2, 1]);
    expect(seen).toEqual(["S1", "R", "W", "V", "S2"].map((k) => appIds[k]));
  });

  test("틀린 값 422 VALIDATION_FAILED — 손댄 커서 · draft 거르기 · 모르는 쿼리 · limit 0·101", async () => {
    for (const search of [
      "?cursor=not-a-cursor",
      `?cursor=${Buffer.from("2026-01-01|nope").toString("base64url")}`,
      "?status=draft",
      "?status=whatever",
      "?sort=desc",
      "?limit=0",
      "?limit=101",
    ]) {
      expect({ search, ...(await list("admin", search)) }).toMatchObject({ search, status: 422, code: "VALIDATION_FAILED" });
    }
  });

  test("커서 직접 만들기 — 마지막 행(S2) 뒤를 가리키면 빈 쪽", async () => {
    const [row] = (
      await q(
        `SELECT to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t FROM merchant_applications WHERE id = $1`,
        [appIds["S2"]],
      )
    ).rows as { t: string }[];
    const res = await list("admin", `?cursor=${encodeCursor({ submittedAt: row!.t, id: appIds["S2"]! })}`);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  // ---- 상세 ---------------------------------------------------------------------------------

  test("운영자 상세 — 판매자 정보 + 증빙 파일 id 2개 + 신청자, 계좌 전체 번호 0건", async () => {
    const res = await detail("admin", appIds["V"]!);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      applicationId: appIds["V"],
      status: "in_review",
      businessName: "라틴하우스",
      businessRegistrationNumber: "1234567890",
      registrationType: "sports_facility",
      payoutAccount: { bankCode: "088", accountMasked: "110-***-***504", holderName: "라틴하우스" },
      applicant: { staffAccountId: staffIds["appV"], displayName: "appV" },
    });
    expect(res.body!.documents).toEqual([
      { docKind: "business_registration", fileId: fileIds["V:business_registration"] },
      { docKind: "sports_facility_report", fileId: fileIds["V:sports_facility_report"] },
    ]);
    expect(fullAccountHits(res.text)).toBe(0);
  });

  test("상세 404 NOT_FOUND — 아직 쓰는 초안 · 제출 안 한 철회 · 없는 id · 모양 틀린 id", async () => {
    for (const id of [appIds["D"]!, appIds["WD"]!, randomUUID(), "not-a-uuid"]) {
      expect({ id, ...(await detail("admin", id)) }).toMatchObject({ id, status: 404, code: "NOT_FOUND" });
    }
  });

  test("verify: 모든 성공 응답을 합쳐도 계좌 전체 번호 0건", async () => {
    const texts = [(await list("admin")).text];
    for (const key of ["S1", "R", "W", "V", "S2"]) texts.push((await detail("admin", appIds[key]!)).text);
    expect(fullAccountHits(texts.join("\n"))).toBe(0);
    // 시험에 쓴 계좌 7개가 실제로 DB 에는 암호문으로 있다(빈 검사가 아니다)
    expect(accounts).toHaveLength(7);
  });
});
