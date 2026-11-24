// S1-1.12(입점 신청 철회 API) — `POST /api/merchant-applications/me/withdraw`(계약 07 §2)를
// 진짜 Better Auth 세션 + 진짜 PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-1-12.db.test.ts 였는데, 기능 이름(merchant-application-withdraw)으로 바꿨다.
//   verify(목표): draft·submitted 만 withdrawn 이 된다 — 심사 중(in_review) 철회는 409 로 거부되고 상태가 그대로다
//   나머지: 이미 철회 → 200 같은 본문(감사 1행 그대로) · 거절된 신청 409 · 신청 없음 404 · 철회 뒤 새 초안은 새 행
//   · 동시에 두 번 → 감사 1행 · 본문 형식 422 · 세션 없음 401 · 2단계 전 401 · 응답에 계좌 원문 0건
import { randomBytes, randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createFieldCipher } from "@/lib/server/field-encryption";
import {
  applicationResponseSchema,
  createGetMyApplicationRoute,
  createPutDraftRoute,
} from "@/lib/server/services/merchant-application-draft";
import { createWithdrawApplicationRoute } from "@/lib/server/services/merchant-application-withdraw";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 비밀값 글자가 저장소에 남지 않게 실행마다 새로 만든다(repo-secret-scan 규칙)
const SECRET = randomBytes(32).toString("hex");
const BASE = "http://localhost:3000";
const ACCOUNT = "110000000521";

describe.skipIf(!dbAvailable())("입점 신청 철회(계약 07 §2)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let PUT: ReturnType<typeof createPutDraftRoute>;
  let GET: ReturnType<typeof createGetMyApplicationRoute>;
  let WITHDRAW: ReturnType<typeof createWithdrawApplicationRoute>;
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

  const draftBody = {
    academyName: "라틴하우스 강남",
    businessName: "라틴하우스",
    registrationType: "sports_facility",
    payoutAccount: { bankCode: "088", accountNumber: ACCOUNT, holderName: "라틴하우스" },
  };

  async function saveDraft(who: string): Promise<number> {
    const res = await PUT(
      new Request(`${BASE}/api/merchant-applications/me/draft`, {
        method: "PUT",
        headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" },
        body: JSON.stringify(draftBody),
      }),
      undefined,
    );
    return res.status;
  }

  /** 철회를 부른다. body 가 undefined 면 본문 없이 보낸다(화면이 보통 이렇게 부른다) */
  async function withdraw(who: string | undefined, body?: string) {
    const headers: Record<string, string> = {};
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await WITHDRAW(
      new Request(`${BASE}/api/merchant-applications/me/withdraw`, { method: "POST", headers, ...(body !== undefined ? { body } : {}) }),
      undefined,
    );
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: applicationResponseSchema.parse(json), text, code: undefined };
    return { status: res.status, body: undefined, text, code: json["code"] as string | undefined };
  }

  const appRows = async (who: string) =>
    (
      await q("SELECT id, status FROM merchant_applications WHERE applicant_account_id = $1 ORDER BY created_at, id", [
        staffIds[who],
      ])
    ).rows as { id: string; status: string }[];
  const auditRows = async (who: string) =>
    (
      await q(
        `SELECT l.before, l.after FROM audit_logs l
         WHERE l.action = 'merchant_application.withdrawn'
           AND l.target_id IN (SELECT id FROM merchant_applications WHERE applicant_account_id = $1)`,
        [staffIds[who]],
      )
    ).rows as { before: Record<string, unknown>; after: Record<string, unknown> }[];
  /** 운영자 쪽 경로(S1-1.13~)가 아직 없어서, 상태는 SQL 로 직접 옮긴다 */
  const setStatus = (who: string, status: string, extra = "") =>
    q(`UPDATE merchant_applications SET status = $2 ${extra} WHERE applicant_account_id = $1`, [staffIds[who], status]);

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
    GET = createGetMyApplicationRoute(deps);
    WITHDRAW = createWithdrawApplicationRoute(deps);
    await makeStaff("owner", true);
    await makeStaff("owner_no_2fa", false);
  });

  beforeEach(async () => {
    // 감사 행은 추가 전용이라 지우지 않는다 — 감사 확인은 「지금 있는 내 신청」의 행만 본다
    await q("DELETE FROM merchant_application_documents");
    await q("DELETE FROM merchant_applications");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("초안(draft)을 철회하면 200 withdrawn — 감사 1행(before draft)", async () => {
    expect(await saveDraft("owner")).toBe(200);
    const res = await withdraw("owner");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "withdrawn", academyName: "라틴하우스 강남" });
    expect((await appRows("owner"))[0]?.status).toBe("withdrawn");
    const audits = await auditRows("owner");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ before: { status: "draft" }, after: { status: "withdrawn" } });
  });

  test("제출한 신청(submitted)도 철회된다 — 감사 before submitted", async () => {
    await saveDraft("owner");
    await setStatus("owner", "submitted", ", submitted_at = now()");
    const res = await withdraw("owner", "{}");
    expect(res.status).toBe(200);
    expect(res.body?.status).toBe("withdrawn");
    expect(res.body?.submittedAt).not.toBeNull();
    expect((await auditRows("owner"))[0]).toMatchObject({ before: { status: "submitted" } });
  });

  test("목표: 심사 중(in_review) 철회는 409 APPLICATION_NOT_EDITABLE — 상태 그대로, 감사 0", async () => {
    await saveDraft("owner");
    await setStatus("owner", "in_review", ", submitted_at = now(), review_started_at = now()");
    const res = await withdraw("owner");
    expect(res).toMatchObject({ status: 409, code: "APPLICATION_NOT_EDITABLE" });
    expect(res.text).toContain("심사 중");
    expect((await appRows("owner"))[0]?.status).toBe("in_review");
    expect(await auditRows("owner")).toHaveLength(0);
  });

  test("거절된 신청은 409 APPLICATION_NOT_EDITABLE — 상태 그대로", async () => {
    await saveDraft("owner");
    await setStatus("owner", "rejected", ", reject_reason_code = 'info_mismatch', decided_at = now()");
    expect(await withdraw("owner")).toMatchObject({ status: 409, code: "APPLICATION_NOT_EDITABLE" });
    expect((await appRows("owner"))[0]?.status).toBe("rejected");
  });

  test("이미 철회했으면 200 같은 본문 — 감사 행은 1행 그대로", async () => {
    await saveDraft("owner");
    const first = await withdraw("owner");
    const second = await withdraw("owner");
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await auditRows("owner")).toHaveLength(1);
  });

  test("동시에 두 번 눌러도 철회 1건 — 둘 다 200, 감사 1행", async () => {
    await saveDraft("owner");
    const [a, b] = await Promise.all([withdraw("owner"), withdraw("owner")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body?.status).toBe("withdrawn");
    expect(b.body?.status).toBe("withdrawn");
    expect(await auditRows("owner")).toHaveLength(1);
  });

  test("철회 뒤 다시 저장하면 새 초안(새 행)이 생기고 조회는 새 초안을 보인다", async () => {
    await saveDraft("owner");
    await withdraw("owner");
    expect(await saveDraft("owner")).toBe(200);
    const rows = await appRows("owner");
    expect(rows.map((r) => r.status)).toEqual(["withdrawn", "draft"]);
    const res = await GET(
      new Request(`${BASE}/api/merchant-applications/me`, { headers: { authorization: `Bearer ${tokens["owner"]}` } }),
      undefined,
    );
    expect(applicationResponseSchema.parse(await res.json())).toMatchObject({ applicationId: rows[1]?.id, status: "draft" });
  });

  test("신청이 없으면 404 NOT_FOUND", async () => {
    expect(await withdraw("owner")).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("본문에 다른 칸이 있으면 422 VALIDATION_FAILED · JSON 이 아니면 400 — 철회되지 않는다", async () => {
    await saveDraft("owner");
    expect(await withdraw("owner", JSON.stringify({ reason: "그냥" }))).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect(await withdraw("owner", "not-json")).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect((await appRows("owner"))[0]?.status).toBe("draft");
  });

  test("세션 없음 401 UNAUTHENTICATED · 인증 앱 미등록 401 SECOND_FACTOR_REQUIRED", async () => {
    expect(await withdraw(undefined)).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(await withdraw("owner_no_2fa")).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
  });

  test("응답에 계좌번호 원문이 없다(가린 값만)", async () => {
    await saveDraft("owner");
    const res = await withdraw("owner");
    expect(res.text).not.toContain(ACCOUNT);
    expect(res.body?.payoutAccount?.accountMasked).toContain("***");
  });
});
