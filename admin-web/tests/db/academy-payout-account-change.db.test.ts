// S1-1.21(정산 계좌 변경 API) — `PUT /api/academies/{academyId}/payout-account` 를 진짜 세션 + PostgreSQL + Redis 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-1-21.db.test.ts 였는데, 기능 이름(academy-payout-account-change)으로 바꿨다.
//   핵심(verify, 계약 07 수용 시나리오 6): 2단계 세션이어도 totpCode 가 없으면 401 SECOND_FACTOR_REQUIRED.
//     맞는 코드로 다시 보내면 활성 계좌가 1개만 남고(옛 계좌는 replaced), 감사 기록에는 끝 4자리만 남는다.
//   나머지: 틀린 코드 422 TOTP_INVALID → 한도를 넘으면 429 · 같은 키 재요청은 같은 응답(계좌 1번만 바뀜)
//     · 대표 알림(가린 번호) · 새 계좌는 예금주 확인 대기 · 키 없음 400 · 본문 422 · 남의 학원 403 · 운영자 403 · 2단계 전 401.
import { randomBytes, randomUUID } from "node:crypto";

import { createOTP } from "@better-auth/utils/otp";
import { symmetricEncrypt } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { maskAccountNumber } from "@/lib/domain/payout-account";
import { createFieldCipher } from "@/lib/server/field-encryption";
import { createRateLimiter } from "@/lib/server/rate-limit";
import { ACADEMY_PAYOUT_ACCOUNT_CONTEXT } from "@/lib/server/services/admin-merchant-review";
import {
  createPayoutAccountChangeRoute,
  payoutAccountChangeResponseSchema,
} from "@/lib/server/services/academy-payout-account";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { createStaffTotpChecker } from "@/lib/server/staff-totp";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "academy-payout-account-test-secret-0123456789";
const BASE = "http://localhost:3000";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6380";
const OLD_ACCOUNT = "110000000521";
const NEW_ACCOUNT = "110000000999";
// 틀린 코드 한도 — 테스트가 빨리 닿도록 작게(앱 기본값은 15분 5회)
const TIGHT_RULE = { name: "auth-failure", limit: 3, windowSeconds: 60 };

describe.skipIf(!dbAvailable())("정산 계좌 변경(계약 07 §4 · 수용 시나리오 6)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let PUT: ReturnType<typeof createPayoutAccountChangeRoute>;
  const cipher = createFieldCipher(randomBytes(32).toString("base64"));
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const authIds: Record<string, string> = {};
  const totpSecrets: Record<string, string> = {};
  const academyIds: Record<string, string> = {};

  /** 직원 계정 + 2단계 세션. 인증 앱 비밀값도 플러그인이 하는 그대로(서버 비밀값으로 암호화) 저장한다 */
  async function makeStaff(key: string, opts: { twoFactor?: boolean; roles?: string[] } = {}) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: key, displayUsername: key },
      { method: "admin" },
    );
    if (opts.twoFactor ?? true) {
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
    }
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    authIds[key] = user.id;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      key,
    ]);
    for (const role of opts.roles ?? []) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
  }

  /** 승인된 학원 + 대표 연결 + 지금 쓰는 계좌 1개(승인 때와 같은 칸 이름으로 암호화) */
  async function makeAcademy(key: string, owner: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, registration_verified_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', 'active', now(), now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `${key} 학원`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
    await q(
      `INSERT INTO academy_payout_accounts (id, academy_id, bank_code, account_enc, account_last4, holder_name, created_by_account_id)
       VALUES (uuidv7(), $1, '088', $2, $3, '라틴하우스', $4)`,
      [academyIds[key], Buffer.from(cipher.encrypt(OLD_ACCOUNT, ACADEMY_PAYOUT_ACCOUNT_CONTEXT)), OLD_ACCOUNT.slice(-4), staffIds[owner]],
    );
  }

  const currentCode = (who: string) => createOTP(totpSecrets[who] ?? "").totp();
  /** 지금 창(앞뒤 한 칸 포함)의 어느 코드와도 다른 6자리 */
  async function wrongCode(who: string): Promise<string> {
    const otp = createOTP(totpSecrets[who] ?? "");
    for (let n = 0; ; n++) {
      const candidate = String(n).padStart(6, "0");
      if (!(await otp.verify(candidate))) return candidate;
    }
  }

  async function put(who: string | undefined, academy: string, body: unknown, key: string | null = randomUUID()) {
    const academyId = academyIds[academy] ?? academy;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    if (key !== null) headers["idempotency-key"] = key;
    const res = await PUT(
      new Request(`${BASE}/api/academies/${academyId}/payout-account`, { method: "PUT", headers, body: JSON.stringify(body) }),
      { params: Promise.resolve({ academyId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: payoutAccountChangeResponseSchema.parse(json), json, res };
    return { status: res.status, body: undefined, json, res };
  }

  const newAccountBody = async (who: string, extra: Record<string, unknown> = {}) => ({
    bankCode: "004",
    accountNumber: "110-000-000999",
    holderName: "라틴하우스",
    totpCode: await currentCode(who),
    ...extra,
  });

  async function accounts(academy: string) {
    const { rows } = await q(
      `SELECT id, status, bank_code, account_last4, holder_verified_at, holder_verify_method, replaced_at, encode(account_enc, 'base64') AS enc
       FROM academy_payout_accounts WHERE academy_id = $1 ORDER BY created_at, id`,
      [academyIds[academy]],
    );
    return rows as Array<Record<string, unknown>>;
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    PUT = createPayoutAccountChangeRoute({
      db: handle.db,
      getSession: (headers: Headers) => auth.api.getSession({ headers }),
      fieldCipher: cipher,
      totp: createStaffTotpChecker(auth),
      // 실행마다 다른 키 앞말 — 다른 테스트·앱 실행의 횟수와 섞이지 않게
      limiter: createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: `kdance:test:payout:${randomUUID()}` }),
      totpFailureRule: TIGHT_RULE,
    });

    await makeStaff("ownerA");
    await makeStaff("ownerB");
    await makeStaff("ownerC");
    await makeStaff("ownerNo2fa", { twoFactor: false });
    await makeStaff("admin", { roles: ["admin"] });
    await makeAcademy("A", "ownerA");
    await makeAcademy("B", "ownerB");
    await makeAcademy("C", "ownerC");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("verify(시나리오 6): totpCode 없이 보내면 401 SECOND_FACTOR_REQUIRED, 계좌·감사·알림은 그대로", async () => {
    const before = await accounts("A");
    const { totpCode: _omit, ...noCode } = await newAccountBody("ownerA");
    const res = await put("ownerA", "A", noCode);
    expect(res.status).toBe(401);
    expect(res.json["code"]).toBe("SECOND_FACTOR_REQUIRED");
    // 빈 글자도 「없음」과 같다
    expect((await put("ownerA", "A", { ...noCode, totpCode: "  " })).json["code"]).toBe("SECOND_FACTOR_REQUIRED");
    expect(await accounts("A")).toEqual(before);
    const audits = await q("SELECT 1 FROM audit_logs WHERE action = 'payout_account.changed' AND academy_id = $1", [academyIds["A"]]);
    expect(audits.rowCount).toBe(0);
  });

  test("verify(시나리오 6): 맞는 코드면 활성 계좌 1개만 남고(옛 계좌 replaced), 감사에는 끝자리만 보이는 가린 값만 남는다", async () => {
    const res = await put("ownerA", "A", await newAccountBody("ownerA"));
    expect(res.status).toBe(200);
    expect(res.res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.body).toMatchObject({
      bankCode: "004",
      accountMasked: maskAccountNumber(NEW_ACCOUNT),
      holderName: "라틴하우스",
      holderVerified: false,
    });
    expect(Number.isNaN(Date.parse(res.body?.changedAt ?? ""))).toBe(false);

    const rows = await accounts("A");
    expect(rows.map((r) => r["status"])).toEqual(["replaced", "active"]);
    expect(rows.filter((r) => r["status"] === "active")).toHaveLength(1);
    expect(rows[0]?.["replaced_at"]).not.toBeNull();
    // 새 계좌는 예금주 확인 대기 — 운영자가 통장 사본으로 확인하기 전(S1-1.22)
    expect(rows[1]).toMatchObject({ bank_code: "004", account_last4: "0999", holder_verified_at: null, holder_verify_method: null });
    // 암호문은 승인 때와 같은 칸 이름으로 풀린다
    expect(cipher.decrypt(Buffer.from(String(rows[1]?.["enc"]), "base64"), ACADEMY_PAYOUT_ACCOUNT_CONTEXT)).toBe(NEW_ACCOUNT);

    const { rows: audits } = await q(
      "SELECT actor_role, target_id, before::text AS before, after::text AS after FROM audit_logs WHERE action = 'payout_account.changed' AND academy_id = $1",
      [academyIds["A"]],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_role).toBe("owner");
    expect(audits[0].target_id).toBe(rows[1]?.["id"]);
    const text = `${audits[0].before}${audits[0].after}`;
    // 원문 계좌번호는 전도 후도 없다. 가린 값(끝 3자리)만
    expect(text).not.toContain(OLD_ACCOUNT);
    expect(text).not.toContain(NEW_ACCOUNT);
    expect(text).not.toContain(await currentCode("ownerA"));
    expect(audits[0].before).toContain(maskAccountNumber(OLD_ACCOUNT));
    expect(audits[0].after).toContain(maskAccountNumber(NEW_ACCOUNT));
  });

  test("대표에게 알림 payout_account_changed 1건(category settlement, 가린 번호만)", async () => {
    const { rows } = await q(
      "SELECT recipient_staff_account_id, category, payload::text AS payload FROM notifications WHERE kind = 'payout_account_changed' AND academy_id = $1",
      [academyIds["A"]],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_staff_account_id).toBe(staffIds["ownerA"]);
    expect(rows[0].category).toBe("settlement");
    expect(rows[0].payload).toContain(maskAccountNumber(NEW_ACCOUNT));
    expect(rows[0].payload).not.toContain(NEW_ACCOUNT);
  });

  test("같은 Idempotency-Key 로 두 번 보내면 같은 응답이고 계좌는 한 번만 바뀐다", async () => {
    const key = randomUUID();
    const first = await put("ownerB", "B", await newAccountBody("ownerB"), key);
    const second = await put("ownerB", "B", await newAccountBody("ownerB", { bankCode: "020" }), key);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect((await accounts("B")).map((r) => r["status"])).toEqual(["replaced", "active"]);
    const audits = await q("SELECT 1 FROM audit_logs WHERE action = 'payout_account.changed' AND academy_id = $1", [academyIds["B"]]);
    expect(audits.rowCount).toBe(1);
  });

  test("틀린 코드는 422 TOTP_INVALID 이고 아무것도 바뀌지 않는다 → 한도(3회)를 넘으면 맞는 코드도 429", async () => {
    const before = await accounts("C");
    for (let i = 0; i < TIGHT_RULE.limit; i++) {
      const res = await put("ownerC", "C", await newAccountBody("ownerC", { totpCode: await wrongCode("ownerC") }));
      expect(res.status).toBe(422);
      expect(res.json["code"]).toBe("TOTP_INVALID");
    }
    const blocked = await put("ownerC", "C", await newAccountBody("ownerC"));
    expect(blocked.status).toBe(429);
    expect(blocked.json["code"]).toBe("RATE_LIMITED");
    expect(await accounts("C")).toEqual(before);
  });

  test("키 없음 400 · 본문 틀림 422(계좌번호·모르는 칸) · 남의 학원 403 · 운영자 403 · 2단계 전 401 · 로그인 안 함 401", async () => {
    expect((await put("ownerA", "A", await newAccountBody("ownerA"), null)).json["code"]).toBe("BAD_REQUEST");
    const shortNumber = await put("ownerA", "A", await newAccountBody("ownerA", { accountNumber: "123" }));
    expect(shortNumber.status).toBe(422);
    expect(JSON.stringify(shortNumber.json)).toContain("accountNumber");
    expect((await put("ownerA", "A", await newAccountBody("ownerA", { extra: 1 }))).status).toBe(422);
    expect((await put("ownerA", "B", await newAccountBody("ownerA"))).json["code"]).toBe("FORBIDDEN");
    expect((await put("admin", "A", await newAccountBody("admin"))).json["code"]).toBe("FORBIDDEN");
    expect((await put("ownerNo2fa", "A", { bankCode: "004" })).json["code"]).toBe("SECOND_FACTOR_REQUIRED");
    expect((await put(undefined, "A", await newAccountBody("ownerA"))).json["code"]).toBe("UNAUTHENTICATED");
  });

  test("DB: 한 학원에 active 계좌를 둘 둘 수 없다(uq_payout_accounts_active)", async () => {
    await expect(
      q(
        `INSERT INTO academy_payout_accounts (id, academy_id, bank_code, account_enc, account_last4, holder_name, created_by_account_id)
         VALUES (uuidv7(), $1, '088', '\\x00', '1234', '라틴하우스', $2)`,
        [academyIds["A"], staffIds["ownerA"]],
      ),
    ).rejects.toThrow(/uq_payout_accounts_active/);
  });
});
