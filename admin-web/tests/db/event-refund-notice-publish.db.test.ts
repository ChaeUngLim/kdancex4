// S1-3.5(이벤트형 취소 수수료 저장 API) — `POST …/refund-notices/event/versions` 를 진짜 세션 + PostgreSQL 로 확인한다(계약 09 §1).
//   로드맵 verify 의 파일 이름은 tests/db/s1-3-5.db.test.ts 였는데, 기능 이름(event-refund-notice-publish)으로 바꿨다.
//   verify 핵심: 계약 09 수용 시나리오 3(「6일 전 ~ 3일 전」 25% → 422 CANCEL_FEE_ABOVE_MAX, 15% → 201)
//   · 상한 경계(20 통과, 21 거부)를 API 로도 확인한다(단위 경계는 tests/unit/event-cancel-fee-max.test.ts).
//   그 밖: 처리 기간 3영업일 상한 422 · 판본 번호는 정규와 따로 센다 · 낡은 baseVersion 409 · 감사 1행 ·
//   위임 강사 403 · 2단계 전 401 · 모양 틀림 422.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createRefundNoticePublishRoute, publishRefundNoticeResponseSchema } from "@/lib/server/services/refund-notice-publish";
import { readCurrentRefundNotices } from "@/lib/server/services/refund-notice-read";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "event-refund-notice-publish-test-secret-0123";
const BASE = "http://localhost:3000";

/** 이벤트형 content — 「6일 전 ~ 3일 전」 구간 값과 처리 기간만 바꿔 가며 쓴다 */
const eventContent = (d6d3: number, processingBusinessDays = 3) => ({
  feeTiers: [
    { window: "d10_plus", percent: 10 },
    { window: "d9_d7", percent: 10 },
    { window: "d6_d3", percent: d6d3 },
    { window: "d2_to_deadline", percent: 30 },
  ],
  nonRefundableCases: "환불 마감일이 지난 뒤의 취소",
  processingBusinessDays,
  ownerContact: "01012345678",
});

describe.skipIf(!dbAvailable())("이벤트형 취소 수수료 저장(계약 09 §1 POST kind=event)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let post: ReturnType<typeof createRefundNoticePublishRoute>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyId = randomUUID();
  const academyNo2fa = randomUUID(); // 2단계 인증 전 대표의 학원(학원당 대표는 한 명이라 따로 둔다)

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

  /** 저장 요청 하나. 201 이면 응답을 계약 스키마로 parse(strict) */
  async function save(who: string | undefined, kind: string, body: unknown, academy = academyId) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    const res = await post(
      new Request(`${BASE}/api/academies/${academy}/refund-notices/${kind}/versions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ academyId: academy, kind }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    return res.status === 201
      ? { status: 201, body: publishRefundNoticeResponseSchema.parse(json), json }
      : { status: res.status, body: undefined, json };
  }
  const versionsOf = async (kind: string) =>
    (await q("SELECT version FROM refund_notice_versions WHERE academy_id = $1 AND notice_kind = $2 ORDER BY version", [academyId, kind]))
      .rows.map((r) => (r as { version: number }).version);

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    post = createRefundNoticePublishRoute({ db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }) });

    await makeStaff("owner");
    await makeStaff("ownerNo2fa", { twoFactor: false });
    await makeStaff("delegate", { roles: ["instructor"] });

    for (const [id, owner] of [[academyId, "owner"], [academyNo2fa, "ownerNo2fa"]] as const) {
      await q(
        `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, registration_verified_at, ${ACADEMY_SELLER_COLUMNS})
         VALUES ($1, '이벤트형 공지 시험 학원', '서울', '마포구', now(), now(), ${ACADEMY_SELLER_VALUES})`,
        [id],
      );
      await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [id, staffIds[owner]]);
    }
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now()) RETURNING id`,
      [academyId, staffIds["delegate"]],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_manage', $2)", [
      (rows[0] as { id: string }).id,
      staffIds["owner"],
    ]);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("수용 시나리오 3(verify) — 「6일 전 ~ 3일 전」 25% 는 422 CANCEL_FEE_ABOVE_MAX·판본 없음, 15% 는 201 판본 1", async () => {
    const high = await save("owner", "event", { baseVersion: null, content: eventContent(25) });
    expect(high.status).toBe(422);
    expect(high.json["code"]).toBe("CANCEL_FEE_ABOVE_MAX");
    expect(high.json["fields"]).toEqual([{ path: "content.feeTiers.2.percent", message: "20% 이하여야 해요" }]);
    expect(await versionsOf("event")).toEqual([]);

    const low = await save("owner", "event", { baseVersion: null, content: eventContent(15) });
    expect(low.status).toBe(201);
    expect(low.body!.kind).toBe("event");
    expect(low.body!.version).toBe(1);
    // 화면용 본문은 서버가 FR-099a 항목 순서대로 만든다(2번만 구간별 취소 수수료)
    expect(low.body!.body.split("\n").map((l) => l.trim().split(" ")[0])).toEqual(["1.", "2.", "-", "-", "-", "-", "3.", "4.", "5.", "6."]);
    expect(low.body!.body).toContain("6일 전 ~ 3일 전: 낸 참가비의 15% 취소 수수료");

    // 저장된 행: 종류 event · content 그대로 · 템플릿 없음(이벤트형은 모든 학원이 같은 상한) + 감사 1행
    const row = (
      await q("SELECT id, content, body, template_code, template_version, created_by_account_id FROM refund_notice_versions WHERE academy_id = $1 AND notice_kind = 'event'", [academyId])
    ).rows[0] as Record<string, unknown>;
    expect(row["content"]).toEqual(eventContent(15));
    expect(row["body"]).toBe(low.body!.body);
    expect([row["template_code"], row["template_version"], row["created_by_account_id"]]).toEqual([null, null, staffIds["owner"]]);
    const audits = (
      await q("SELECT actor_role, before, after FROM audit_logs WHERE action = 'refund_notice.published' AND target_id = $1", [row["id"]])
    ).rows as Record<string, unknown>[];
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_role: "owner", before: null });
    expect(audits[0]!["after"]).toMatchObject({ kind: "event", version: 1, content: eventContent(15) });
  });

  test("상한 경계(verify) — 「6일 전 ~ 3일 전」 21% 는 422, 상한 그대로 20% 는 201 판본 2", async () => {
    const over = await save("owner", "event", { baseVersion: 1, content: eventContent(21) });
    expect([over.status, over.json["code"]]).toEqual([422, "CANCEL_FEE_ABOVE_MAX"]);
    expect(await versionsOf("event")).toEqual([1]);

    const atMax = await save("owner", "event", { baseVersion: 1, content: eventContent(20) });
    expect(atMax.status).toBe(201);
    expect(atMax.body!.version).toBe(2);
    // 조회 API 의 현재 이벤트형 판본과 상한이 저장 결과와 맞는다
    const current = await readCurrentRefundNotices(handle.db, academyId);
    expect(current!.event.version).toBe(2);
    expect(current!.event.maxFeePercents).toEqual({ d10_plus: 10, d9_d7: 10, d6_d3: 20, d2_to_deadline: 30 });
  });

  test("여러 구간이 넘으면 칸마다 알려 준다 — 10일 전 11%·2일 전 31%", async () => {
    const content = { ...eventContent(20), feeTiers: [
      { window: "d10_plus", percent: 11 },
      { window: "d9_d7", percent: 10 },
      { window: "d6_d3", percent: 20 },
      { window: "d2_to_deadline", percent: 31 },
    ] };
    const res = await save("owner", "event", { baseVersion: 2, content });
    expect(res.json["fields"]).toEqual([
      { path: "content.feeTiers.0.percent", message: "10% 이하여야 해요" },
      { path: "content.feeTiers.3.percent", message: "30% 이하여야 해요" },
    ]);
    expect(await versionsOf("event")).toEqual([1, 2]);
  });

  test("처리 기간 — 4영업일은 422 PROCESSING_DAYS_TOO_LONG(3영업일은 앞 시나리오들에서 저장됐다)", async () => {
    const long = await save("owner", "event", { baseVersion: 2, content: eventContent(15, 4) });
    expect([long.status, long.json["code"]]).toEqual([422, "PROCESSING_DAYS_TOO_LONG"]);
    expect(long.json["fields"]).toEqual([{ path: "content.processingBusinessDays", message: "3영업일 이하여야 해요" }]);
    expect(await versionsOf("event")).toEqual([1, 2]);
  });

  test("판본 번호는 종류별로 센다 — 이벤트형 판본 2 가 있어도 정규 첫 판본은 baseVersion null 로 1, 낡은 이벤트형 baseVersion 은 409", async () => {
    const regular = await save("owner", "regular", {
      baseVersion: null,
      content: {
        cancellableUntil: "수강 시작 전까지 언제든",
        tiers: [
          { point: "before_start", percent: 100 },
          { point: "before_one_third", percent: 67 },
          { point: "before_half", percent: 50 },
          { point: "after_half", percent: 0 },
        ],
        nonRefundableCases: "이미 들은 회차",
        processingBusinessDays: 5,
        ownerContact: "0200000000",
      },
    });
    expect([regular.status, regular.body?.version]).toEqual([201, 1]);
    expect(await versionsOf("regular")).toEqual([1]);

    const stale = await save("owner", "event", { baseVersion: 1, content: eventContent(15) });
    expect([stale.status, stale.json["code"]]).toEqual([409, "NOTICE_VERSION_CONFLICT"]);
    expect(await versionsOf("event")).toEqual([1, 2]);
  });

  test("권한 — 위임 강사 403, 2단계 전 401, 로그인 안 함 401", async () => {
    const body = { baseVersion: 2, content: eventContent(15) };
    expect((await save("delegate", "event", body)).status).toBe(403);
    expect((await save("ownerNo2fa", "event", body, academyNo2fa)).json["code"]).toBe("SECOND_FACTOR_REQUIRED");
    expect((await save(undefined, "event", body)).status).toBe(401);
    expect(await versionsOf("event")).toEqual([1, 2]);
  });

  test("모양 — 구간 빠짐·중복·101%·정규 칸(cancellableUntil)·처리 기간 0 은 422 VALIDATION_FAILED", async () => {
    const base = eventContent(15);
    const cases = [
      { ...base, feeTiers: base.feeTiers.slice(0, 3) },
      { ...base, feeTiers: [...base.feeTiers.slice(0, 3), { window: "d10_plus", percent: 5 }] },
      { ...base, feeTiers: base.feeTiers.map((t) => (t.window === "d10_plus" ? { ...t, percent: 101 } : t)) },
      { ...base, cancellableUntil: "언제든" },
      { ...base, processingBusinessDays: 0 },
    ];
    for (const content of cases) {
      const res = await save("owner", "event", { baseVersion: 2, content });
      expect([res.status, res.json["code"]]).toEqual([422, "VALIDATION_FAILED"]);
    }
    expect(await versionsOf("event")).toEqual([1, 2]);
  });
});
