// S1-3.4(정규 과정 공지 저장 API) — `POST …/refund-notices/{kind}/versions` 를 진짜 세션 + PostgreSQL 로 확인한다(계약 09 §1).
//   로드맵 verify 의 파일 이름은 tests/db/s1-3-4.db.test.ts 였는데, 기능 이름(refund-notice-publish)으로 바꿨다.
//   verify 핵심: 계약 09 수용 시나리오 1(템플릿 하한 422 → 올리면 201) · 2(옛 주문은 옛 판본, 새 주문은 새 판본)
//   · 4(같은 baseVersion 동시 저장 → 한쪽 201, 한쪽 409).
//   그 밖: 첫 판본(baseVersion null) · 낡은 baseVersion 409 · 감사 1행 · 위임 강사·다른 대표 403 · 2단계 전 401 ·
//   모양 틀림 422 · 아직 안 되는 종류(개인 레슨) 422 · 없는 종류 404 · 신고 체육시설은 템플릿 없이 저장.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createRefundNoticePublishRoute, publishRefundNoticeResponseSchema } from "@/lib/server/services/refund-notice-publish";
import { readCurrentRefundNotices } from "@/lib/server/services/refund-notice-read";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { insertReservationAndPayment } from "../fixtures/contract-parents";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "refund-notice-publish-test-secret-0123456789";
const BASE = "http://localhost:3000";

type Tier = { point: string; percent: number };
const tiers = (beforeHalf: number): Tier[] => [
  { point: "before_start", percent: 100 },
  { point: "before_one_third", percent: 67 },
  { point: "before_half", percent: beforeHalf },
  { point: "after_half", percent: 0 },
];
const content = (beforeHalf: number) => ({
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: tiers(beforeHalf),
  nonRefundableCases: "이미 들은 회차와 기간이 끝난 수강권",
  processingBusinessDays: 5,
  ownerContact: "0200000000",
});

describe.skipIf(!dbAvailable())("정규 과정 공지 저장(계약 09 §1 POST)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let post: ReturnType<typeof createRefundNoticePublishRoute>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  let academyA = ""; // 주문 A 가 걸린 학원(대표 ownerA, 학원 확인됨)
  let academyB = ""; // 판본 없는 학원(대표 ownerB, 확인 전 → 엄격 기준)
  let academyS = ""; // 신고 체육시설(확인됨, 대표 ownerB) — 템플릿 값 미정
  let orderNoticeId = "";

  async function makeStaff(key: string, opts: { twoFactor?: boolean; roles?: string[] } = {}) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: key, displayUsername: key },
      { method: "admin" },
    );
    if (opts.twoFactor ?? true) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, user.id, key]);
    for (const role of opts.roles ?? []) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
  }
  const own = (academyId: string, staff: string) =>
    q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffIds[staff]]);

  /** 저장 요청 하나. 201 이면 응답을 계약 스키마로 parse(strict — 계약 밖 키가 섞이면 실패) */
  async function save(who: string | undefined, academyId: string, kind: string, body: unknown) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    const res = await post(
      new Request(`${BASE}/api/academies/${academyId}/refund-notices/${kind}/versions`, {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      { params: Promise.resolve({ academyId, kind }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    return res.status === 201
      ? { status: 201, body: publishRefundNoticeResponseSchema.parse(json), json }
      : { status: res.status, body: undefined, json };
  }
  const versionsOf = async (academyId: string) =>
    (await q("SELECT version FROM refund_notice_versions WHERE academy_id = $1 AND notice_kind = 'regular' ORDER BY version", [academyId]))
      .rows.map((r) => (r as { version: number }).version);

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    post = createRefundNoticePublishRoute({ db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }) });

    await makeStaff("ownerA");
    await makeStaff("ownerB");
    await makeStaff("ownerNo2fa", { twoFactor: false });
    await makeStaff("delegate", { roles: ["instructor"] });

    // 학원 A: 주문 사슬 픽스처(판본 1 + 주문 A 결제). 판본 2·3 을 쌓아 주문 A 를 판본 3 으로 옮긴다(시나리오 2 의 Given)
    await insertReservationAndPayment(handle.pool);
    const order = (
      await q("SELECT o.refund_notice_version_id AS notice_id, v.academy_id FROM orders o JOIN refund_notice_versions v ON v.id = o.refund_notice_version_id")
    ).rows[0] as { notice_id: string; academy_id: string };
    academyA = order.academy_id;
    await q("UPDATE academies SET registration_verified_at = now() WHERE id = $1", [academyA]);
    for (const v of [2, 3]) {
      const id = randomUUID();
      await q(
        `INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, template_code, template_version)
         VALUES ($1, $2, 'regular', $3, $4, $5::jsonb, 'hakwon_act', '2026-11-13')`,
        [id, academyA, v, `정규 ${v}판 본문`, JSON.stringify(content(50))],
      );
      if (v === 3) orderNoticeId = id;
    }
    await q("UPDATE orders SET refund_notice_version_id = $1", [orderNoticeId]);
    await own(academyA, "ownerA");
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now()) RETURNING id`,
      [academyA, staffIds["delegate"]],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_manage', $2)", [
      (rows[0] as { id: string }).id,
      staffIds["ownerA"],
    ]);

    academyB = randomUUID();
    academyS = randomUUID();
    for (const [id, verified] of [[academyB, false], [academyS, true]] as const) {
      await q(
        `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, registration_verified_at, ${ACADEMY_SELLER_COLUMNS})
         VALUES ($1, '공지 저장 시험 학원', '서울', '마포구', now(), ${verified ? "now()" : "NULL"}, ${ACADEMY_SELLER_VALUES})`,
        [id],
      );
    }
    await q("UPDATE academies SET registration_type = 'sports_facility' WHERE id = $1", [academyS]);
    await own(academyB, "ownerB");
    await own(academyS, "ownerB");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("수용 시나리오 1(verify) — 「1/2 지나기 전」 40% 는 422 REFUND_BELOW_TEMPLATE·판본 그대로, 67% 로 올리면 201", async () => {
    const low = await save("ownerA", academyA, "regular", { baseVersion: 3, content: content(40) });
    expect(low.status).toBe(422);
    expect(low.json["code"]).toBe("REFUND_BELOW_TEMPLATE");
    expect(low.json["fields"]).toEqual([{ path: "content.tiers.2.percent", message: "50% 이상이어야 해요" }]);
    expect(await versionsOf(academyA)).toEqual([1, 2, 3]);

    const ok = await save("ownerA", academyA, "regular", { baseVersion: 3, content: content(67) });
    expect(ok.status).toBe(201);
    expect(ok.body!.kind).toBe("regular");
    expect(ok.body!.version).toBe(4);
    // 화면용 본문은 서버가 FR-099a 항목 순서대로 만든다
    expect(ok.body!.body.split("\n").map((l) => l.trim().split(" ")[0])).toEqual(["1.", "2.", "-", "-", "-", "-", "3.", "4.", "5.", "6."]);
    expect(ok.body!.body).toContain("총 기간의 1/2 이 지나기 전: 낸 금액의 67% 환불");
    expect(await versionsOf(academyA)).toEqual([1, 2, 3, 4]);

    // 저장된 행: content·템플릿·올린 사람 + 감사 refund_notice.published(before = 옛 판본 3 의 content)
    const row = (
      await q("SELECT id, content, body, template_code, template_version, created_by_account_id FROM refund_notice_versions WHERE academy_id = $1 AND version = 4", [academyA])
    ).rows[0] as Record<string, unknown>;
    expect(row["content"]).toEqual(content(67));
    expect(row["body"]).toBe(ok.body!.body);
    expect([row["template_code"], row["template_version"], row["created_by_account_id"]]).toEqual(["hakwon_act", "2026-11-13", staffIds["ownerA"]]);
    const audits = (
      await q("SELECT actor_role, academy_id, target_table, before, after FROM audit_logs WHERE action = 'refund_notice.published' AND target_id = $1", [row["id"]])
    ).rows as Record<string, unknown>[];
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_role: "owner", academy_id: academyA, target_table: "refund_notice_versions", before: content(50) });
    expect(audits[0]!["after"]).toMatchObject({ kind: "regular", version: 4, content: content(67) });
  });

  test("수용 시나리오 2(verify) — 판본 4 저장 뒤에도 주문 A 는 판본 3 을, 새 주문이 고를 현재 판본은 4", async () => {
    const order = (
      await q("SELECT v.version, v.content FROM orders o JOIN refund_notice_versions v ON v.id = o.refund_notice_version_id")
    ).rows[0] as { version: number; content: unknown };
    expect(order.version).toBe(3);
    expect(order.content).toEqual(content(50));
    // 옛 판본 행은 고쳐지지 않았다
    const v3 = (await q("SELECT body FROM refund_notice_versions WHERE id = $1", [orderNoticeId])).rows[0] as { body: string };
    expect(v3.body).toBe("정규 3판 본문");
    const current = await readCurrentRefundNotices(handle.db, academyA);
    expect(current!.regular.version).toBe(4);
    expect(current!.regular.content).toEqual(content(67));
  });

  test("수용 시나리오 4(verify) — 같은 baseVersion 4 로 동시에 두 번 저장 → 하나는 201(판본 5), 하나는 409", async () => {
    const results = await Promise.all([
      save("ownerA", academyA, "regular", { baseVersion: 4, content: content(60) }),
      save("ownerA", academyA, "regular", { baseVersion: 4, content: content(70) }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(results.find((r) => r.status === 201)!.body!.version).toBe(5);
    expect(results.find((r) => r.status === 409)!.json["code"]).toBe("NOTICE_VERSION_CONFLICT");
    // 판본이 건너뛰거나 겹치지 않았고, 감사도 판본 수만큼만 생겼다
    expect(await versionsOf(academyA)).toEqual([1, 2, 3, 4, 5]);
    const audits = await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'refund_notice.published' AND academy_id = $1", [academyA]);
    expect((audits.rows[0] as { n: number }).n).toBe(2);
  });

  test("낡은 baseVersion(3)·첫 판본이 아닌데 null 은 409, 판본 없는 학원은 null 로 판본 1 을 만든다", async () => {
    const stale = await save("ownerA", academyA, "regular", { baseVersion: 3, content: content(67) });
    expect([stale.status, stale.json["code"]]).toEqual([409, "NOTICE_VERSION_CONFLICT"]);
    const nullBase = await save("ownerA", academyA, "regular", { baseVersion: null, content: content(67) });
    expect(nullBase.status).toBe(409);
    expect(await versionsOf(academyA)).toEqual([1, 2, 3, 4, 5]);

    // 학원 B 는 확인 전이라 엄격 기준(학원법) — 하한 검사를 받는다. 판본이 없을 때 baseVersion 1 은 409
    expect((await save("ownerB", academyB, "regular", { baseVersion: 1, content: content(67) })).status).toBe(409);
    expect((await save("ownerB", academyB, "regular", { baseVersion: null, content: content(40) })).json["code"]).toBe("REFUND_BELOW_TEMPLATE");
    const first = await save("ownerB", academyB, "regular", { baseVersion: null, content: content(50) });
    expect(first.status).toBe(201);
    expect(first.body!.version).toBe(1);
    const audit = (await q("SELECT before FROM audit_logs WHERE action = 'refund_notice.published' AND academy_id = $1", [academyB])).rows[0] as { before: unknown };
    expect(audit.before).toBeNull();
  });

  test("신고 체육시설(확인됨) — 템플릿 값이 없어(Q11 ①) 하한 검사 없이 저장되고 template_code 는 비어 있다", async () => {
    const res = await save("ownerB", academyS, "regular", { baseVersion: null, content: content(40) });
    expect(res.status).toBe(201);
    const row = (await q("SELECT template_code, template_version FROM refund_notice_versions WHERE academy_id = $1", [academyS])).rows[0];
    expect(row).toEqual({ template_code: null, template_version: null });
  });

  test("권한 — 위임 강사·다른 학원 대표 403, 2단계 전 401, 로그인 안 함 401, 없는 학원 404", async () => {
    const body = { baseVersion: 5, content: content(67) };
    expect((await save("delegate", academyA, "regular", body)).status).toBe(403);
    expect((await save("ownerB", academyA, "regular", body)).status).toBe(403);
    expect((await save("ownerNo2fa", academyA, "regular", body)).json["code"]).toBe("SECOND_FACTOR_REQUIRED");
    expect((await save(undefined, academyA, "regular", body)).status).toBe(401);
    expect((await save("ownerA", randomUUID(), "regular", body)).status).toBe(404);
    expect(await versionsOf(academyA)).toEqual([1, 2, 3, 4, 5]);
  });

  test("모양·종류 — 시점 중복·빠짐·101%·모르는 키 422, JSON 아님 400, private_lesson 422 NOT_READY, 없는 종류 404", async () => {
    const dup = { ...content(67), tiers: [...tiers(67).slice(0, 3), { point: "before_start", percent: 100 }] };
    const missing = { ...content(67), tiers: tiers(67).slice(0, 3) };
    const over = { ...content(67), tiers: tiers(101) };
    for (const c of [dup, missing, over, { ...content(67), extra: 1 }]) {
      const res = await save("ownerA", academyA, "regular", { baseVersion: 5, content: c });
      expect([res.status, res.json["code"]]).toEqual([422, "VALIDATION_FAILED"]);
    }
    expect((await save("ownerA", academyA, "regular", "{not json")).status).toBe(400);
    // event 는 S1-3.5(이벤트형 저장)가 붙어 이제 저장된다 — tests/db/event-refund-notice-publish.db.test.ts 가 본다
    const lesson = await save("ownerA", academyA, "private_lesson", { baseVersion: null, content: {} });
    expect([lesson.status, lesson.json["code"]]).toEqual([422, "NOTICE_KIND_NOT_READY"]);
    expect((await save("ownerA", academyA, "weekly", { baseVersion: null, content: {} })).status).toBe(404);
    expect(await versionsOf(academyA)).toEqual([1, 2, 3, 4, 5]);
  });
});
