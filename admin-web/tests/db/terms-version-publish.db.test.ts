// S1-1.23(입점 약관 판본 발행 API) — `POST /api/admin/terms-versions`(계약 07 §5, FR-259)를 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-1-23.db.test.ts 였는데, 기능 이름(terms-version-publish)으로 바꿨다.
//   핵심(verify): 이전 판본이 있으면 시행일이 「지금 + 29일 23시간」은 422 NOTICE_PERIOD_TOO_SHORT, 「지금 + 30일」은 201.
//   나머지: active 학원마다 대표 알림 1건 + 통지 1행(제한·대표 없는 학원은 빠짐) · 감사 1행 · 거부되면 아무것도 안 남음
//   · 불리 여부 칸은 받지 않음(422) · 같은 판본 번호 409 · 첫 판본은 30일 규칙 없음 · 운영자 아님 403 · 2단계 전 401.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createPublishTermsVersionRoute, publishTermsVersionResponseSchema } from "@/lib/server/services/terms-version-publish";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "terms-publish-test-secret-0123456789-0123456";
const BASE = "http://localhost:3000";
// 서버 시계를 이 순간에 멈춘다 — 「30일 뒤」 경계를 초 단위로 정확히 재려고.
// Instant 는 시간대가 없어 days 를 더할 수 없다 — 하루는 hours: 24 로 적는다
const NOW = Temporal.Instant.from("2026-12-01T00:00:00Z");
const after = (duration: Temporal.DurationLike) => NOW.add(duration).toString();

describe.skipIf(!dbAvailable())("POST /api/admin/terms-versions(계약 07 §5)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let POST: ReturnType<typeof createPublishTermsVersionRoute>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};

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

  /** 학원 1개. owner 를 주면 그 직원이 active 대표다 */
  async function makeAcademy(key: string, status: string, owner?: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', $3, now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], key, status],
    );
    if (owner !== undefined) {
      await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
    }
  }

  async function publish(who: string | undefined, body: Record<string, unknown>) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    const res = await POST(new Request(`${BASE}/api/admin/terms-versions`, { method: "POST", headers, body: JSON.stringify(body) }), undefined);
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 201) return { status: 201, body: publishTermsVersionResponseSchema.parse(json), code: undefined };
    return { status: res.status, body: undefined, code: json["code"] };
  }

  const count = async (table: string) => Number((await q(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  const merchantTerms = (version: string, effectiveAt: string) => ({ kind: "merchant_terms", version, body: `입점 약관 ${version} 전문`, effectiveAt });

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    POST = createPublishTermsVersionRoute({
      db: handle.db,
      getSession: (headers) => auth.api.getSession({ headers }),
      clock: fixedClock(NOW),
    });

    await makeStaff("admin", { roles: ["admin"] });
    await makeStaff("adminNo2fa", { roles: ["admin"], twoFactor: false });
    await makeStaff("ownerA");
    await makeStaff("ownerB");
    await makeStaff("ownerR");
    // 통지 대상: active 학원 A·B. 게시 제한(restricted) 학원 R 과 대표 없는 학원 N 은 대상이 아니다
    await makeAcademy("A", "active", "ownerA");
    await makeAcademy("B", "active", "ownerB");
    await makeAcademy("R", "restricted", "ownerR");
    await makeAcademy("N", "active");

    // 이미 시행 중인 입점 약관 1.0 — 다음 판본부터 30일 규칙이 걸린다
    await q(
      `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at)
       VALUES (uuidv7(), 'merchant_terms', '1.0', '옛 전문', now() - interval '90 days', now() - interval '60 days')`,
    );
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("이전 판본이 있으면 시행일 29일 23시간 뒤는 422 NOTICE_PERIOD_TOO_SHORT — 판본·통지·알림·감사 0건", async () => {
    const res = await publish("admin", merchantTerms("2.0", after({ hours: 30 * 24 - 1 })));
    expect(res).toEqual({ status: 422, body: undefined, code: "NOTICE_PERIOD_TOO_SHORT" });
    expect(await count("terms_versions")).toBe(1);
    expect(await count("terms_change_notices")).toBe(0);
    expect(await count("notifications")).toBe(0);
    expect(await count("audit_logs")).toBe(0);
  });

  test("30일에서 1초라도 모자라면 거부(경계는 시각으로 정확히 30 × 24시간)", async () => {
    const res = await publish("admin", merchantTerms("2.0", after({ seconds: 30 * 24 * 3600 - 1 })));
    expect(res.code).toBe("NOTICE_PERIOD_TOO_SHORT");
  });

  test("시행일 정확히 30일 뒤는 201 — active 학원 A·B 대표에게 알림 1건씩 + 통지 1행씩 + 감사 1행", async () => {
    const effectiveAt = after({ hours: 30 * 24 });
    const res = await publish("admin", merchantTerms("2.0", effectiveAt));
    expect(res.status).toBe(201);
    const body = res.body!;
    expect(body).toEqual({
      termsVersionId: expect.any(String),
      kind: "merchant_terms",
      version: "2.0",
      publishedAt: NOW.toString(),
      effectiveAt,
      noticeCount: 2,
    });

    const version = (await q("SELECT body, published_at, effective_at FROM terms_versions WHERE id = $1", [body.termsVersionId])).rows[0];
    expect(version.body).toBe("입점 약관 2.0 전문");
    expect(new Date(version.published_at).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(new Date(version.effective_at).toISOString()).toBe("2026-12-31T00:00:00.000Z");

    // 통지 행은 학원 A·B 두 곳, 각 행의 알림은 그 학원 대표(직원)에게 간 operations 칩 terms_change_notice
    const notices = (
      await q(
        `SELECT n.academy_id, n.notified_at, n.read_at, x.recipient_staff_account_id, x.recipient_member_id, x.academy_id AS notif_academy,
                x.category, x.kind, x.delivery_status, x.payload
         FROM terms_change_notices n JOIN notifications x ON x.id = n.notification_id
         WHERE n.terms_version_id = $1 ORDER BY x.recipient_staff_account_id = $2 DESC`,
        [body.termsVersionId, staffIds["ownerA"]],
      )
    ).rows;
    expect(notices.map((n) => [n.academy_id, n.recipient_staff_account_id])).toEqual([
      [academyIds["A"], staffIds["ownerA"]],
      [academyIds["B"], staffIds["ownerB"]],
    ]);
    for (const n of notices) {
      expect(n).toMatchObject({ recipient_member_id: null, category: "operations", kind: "terms_change_notice", delivery_status: "pending", read_at: null });
      expect(n.notif_academy).toBe(n.academy_id);
      expect(new Date(n.notified_at).toISOString()).toBe("2026-12-01T00:00:00.000Z");
      expect(n.payload).toEqual({ termsVersionId: body.termsVersionId, kind: "merchant_terms", version: "2.0", effectiveAt });
    }
    expect(await count("notifications")).toBe(2);

    const audits = (await q("SELECT actor_kind, actor_staff_account_id, actor_role, action, target_table, target_id, after FROM audit_logs")).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_kind: "staff",
      actor_staff_account_id: staffIds["admin"],
      actor_role: "admin",
      action: "terms_version.published",
      target_table: "terms_versions",
      target_id: body.termsVersionId,
    });
    expect(audits[0].after).toMatchObject({ version: "2.0", noticeCount: 2 });
  });

  test("같은 kind·version 을 다시 내면 409 TERMS_VERSION_EXISTS — 옛 본문을 덮어쓰지 않는다", async () => {
    const res = await publish("admin", { ...merchantTerms("2.0", after({ hours: 40 * 24 })), body: "바꿔치기" });
    expect(res.code).toBe("TERMS_VERSION_EXISTS");
    expect(res.status).toBe(409);
    expect((await q("SELECT body FROM terms_versions WHERE version = '2.0'")).rows[0].body).toBe("입점 약관 2.0 전문");
    expect(await count("terms_change_notices")).toBe(2);
  });

  test("불리한 변경을 따로 두지 않는다 — isUnfavorable 같은 칸을 보내면 422 VALIDATION_FAILED", async () => {
    const res = await publish("admin", { ...merchantTerms("3.0", after({ hours: 7 * 24 })), isUnfavorable: false });
    expect(res).toEqual({ status: 422, body: undefined, code: "VALIDATION_FAILED" });
  });

  test("첫 판본(이전 판본 없는 kind)은 30일 규칙이 없다 — 하루 뒤 시행도 201, 학원에 통지", async () => {
    const res = await publish("admin", { kind: "content_license", version: "1.0", body: "콘텐츠 이용 허락 전문", effectiveAt: after({ hours: 1 * 24 }) });
    expect(res.status).toBe(201);
    expect(res.body?.noticeCount).toBe(2);
  });

  test("시행일이 지금보다 앞서면 422 VALIDATION_FAILED · 시간대 없는 시각도 422", async () => {
    const past = await publish("admin", { kind: "privacy_policy", version: "1.0", body: "전문", effectiveAt: after({ hours: -1 }) });
    expect(past.code).toBe("VALIDATION_FAILED");
    const noOffset = await publish("admin", { kind: "privacy_policy", version: "1.0", body: "전문", effectiveAt: "2027-01-01T00:00:00" });
    expect(noOffset.code).toBe("VALIDATION_FAILED");
  });

  test("운영자가 아니면 403 FORBIDDEN · 2단계 전 운영자 401 SECOND_FACTOR_REQUIRED · 세션 없으면 401", async () => {
    const body = merchantTerms("9.0", after({ hours: 60 * 24 }));
    expect((await publish("ownerA", body)).code).toBe("FORBIDDEN");
    expect((await publish("adminNo2fa", body)).code).toBe("SECOND_FACTOR_REQUIRED");
    expect((await publish(undefined, body)).code).toBe("UNAUTHENTICATED");
    expect((await q("SELECT count(*)::int AS n FROM terms_versions WHERE version = '9.0'")).rows[0].n).toBe(0);
  });
});
