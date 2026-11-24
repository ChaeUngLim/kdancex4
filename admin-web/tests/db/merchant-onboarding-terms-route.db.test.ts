// S1-1.9(입점 필수 동의 판정과 약관 조회) — `GET /api/terms/merchant-onboarding` 을 진짜 세션 + PostgreSQL 로 확인한다.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §2 · 권한 staff_self(2단계 인증을 마친 active 직원, 역할 무관)
//   본다: 항목 5개 · 항목별 「지금 시행 중인」 판본(시행 전 새 판본은 고르지 않음) · 2단계 전 401 · 세션 없음 401 · 판본 누락 500
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { createMerchantOnboardingTermsRoute, merchantOnboardingTermsResponseSchema } from "@/lib/server/services/merchant-onboarding-terms";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "merchant-terms-test-secret-0123456789-012345";
const BASE = "http://localhost:3000";

describe.skipIf(!dbAvailable())("GET /api/terms/merchant-onboarding(계약 07 §2)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let GET: ReturnType<typeof createMerchantOnboardingTermsRoute>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  async function makeStaff(key: string, twoFactor: boolean) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: key, displayUsername: key },
      { method: "admin" },
    );
    if (twoFactor) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      randomUUID(),
      user.id,
      key,
    ]);
  }

  /** 판본 한 줄. effectiveDays 는 지금 기준 시행일(음수 = 이미 시행) */
  async function version(key: string, kind: string, ver: string, effectiveDays: number) {
    ids[key] = randomUUID();
    await q(
      `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at)
       VALUES ($1, $2, $3, '본문', now() - interval '60 days', now() + make_interval(days => $4))`,
      [ids[key], kind, ver, effectiveDays],
    );
  }

  async function call(who?: string) {
    const headers: Record<string, string> = who === undefined ? {} : { authorization: `Bearer ${tokens[who]}` };
    const res = await GET(new Request(`${BASE}/api/terms/merchant-onboarding`, { headers }), undefined);
    const body = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: merchantOnboardingTermsResponseSchema.parse(body) };
    return { status: res.status, code: body["code"] };
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    GET = createMerchantOnboardingTermsRoute({ db: handle.db, getSession: (headers) => auth.api.getSession({ headers }) });

    // 입점 약관은 1.0(시행 중) · 1.1(시행 중, 더 늦음) · 2.0(20일 뒤 시행 — 통지 기간)이 있다 → 1.1 이 현재 판본
    await version("terms10", "merchant_terms", "1.0", -50);
    await version("terms11", "merchant_terms", "1.1", -10);
    await version("terms20", "merchant_terms", "2.0", 20);
    await version("fee", "platform_fee_notice", "1.0", -50);
    await version("card", "card_fee_notice", "1.0", -50);
    await version("content", "content_license", "1.0", -50);
    await version("onePlusOne", "one_plus_one_notice", "1.0", -50);
    // 입점 항목이 아닌 판본 — 응답에 나오면 안 된다
    await version("privacy", "merchant_privacy_collection", "1.0", -50);

    await makeStaff("applicant", true); // 역할 없는 직원(입점 신청 전 대표)
    await makeStaff("noTotp", false);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("2단계를 마친 역할 없는 직원 — 항목 5개와 항목별 시행 중인 판본(시행 전 2.0 은 고르지 않는다)", async () => {
    expect(await call("applicant")).toEqual({
      status: 200,
      body: {
        items: [
          { item: "merchant_terms", termsVersionId: ids["terms11"], version: "1.1", required: true, label: "입점 약관" },
          { item: "platform_fee_notice", termsVersionId: ids["fee"], version: "1.0", required: true, label: "플랫폼 수수료" },
          {
            item: "card_fee_notice",
            termsVersionId: ids["card"],
            version: "1.0",
            required: true,
            label: "결제·카드 수수료 대표 부담",
            gates: "card_payment",
          },
          { item: "content_license", termsVersionId: ids["content"], version: "1.0", required: true, label: "콘텐츠 이용 허락" },
          { item: "one_plus_one_notice", termsVersionId: ids["onePlusOne"], version: "1.0", required: true, label: "1+1 할인권 안내 확인" },
        ],
      },
    });
  });

  test("2단계 인증 전이면 401 SECOND_FACTOR_REQUIRED · 세션 없으면 401 UNAUTHENTICATED", async () => {
    expect(await call("noTotp")).toEqual({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    expect(await call()).toEqual({ status: 401, code: "UNAUTHENTICATED" });
  });

  test("입점 항목 하나라도 시행 중인 판본이 없으면 빈 id 로 내려주지 않고 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await q("DELETE FROM terms_versions WHERE id = $1", [ids["content"]]);
    expect(await call("applicant")).toEqual({ status: 500, code: "INTERNAL" });
    vi.restoreAllMocks();
  });
});
