// S1-3.3(공지 조회 API) — 환불·취소 공지 조회 경로 셋을 진짜 세션 + PostgreSQL 로 확인한다(계약 09 §1).
//   로드맵 verify 의 파일 이름은 tests/db/s1-3-3.db.test.ts 였는데, 기능 이름(refund-notice-read)으로 바꿨다.
//   핵심(verify): 계약 09 수용 시나리오 2 — 주문 A 가 판본 1 로 결제된 뒤 판본 2·3 이 생겨도,
//   주문이 가리키는 옛 판본 1 을 그때 내용 그대로 연다(O-16(판본 보존) · FR-284(주문 시점 값 고정)).
//   나머지: 현재 판본·템플릿(등록 형태별, 확인 전이면 엄격 기준) · 판본 목록 최신순 · 위임 강사 조회 ○ ·
//   위임 없는 강사·다른 학원 대표 403 · 2단계 전·로그인 안 함 401 · 없는 학원·판본·종류 404 · 조회가 판본을 바꾸지 않음.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createRefundNoticeReadRoutes,
  refundNoticesCurrentSchema,
  refundNoticeVersionListSchema,
  refundNoticeVersionSchema,
} from "@/lib/server/services/refund-notice-read";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { insertReservationAndPayment } from "../fixtures/contract-parents";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "refund-notice-read-test-secret-0123456789-01";
const BASE = "http://localhost:3000";

// 판본 1(주문 A 가 결제한 판본) — 2/3 시점을 템플릿보다 더 돌려주는 80% 로 적었다
const V1_CONTENT = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [
    { point: "before_start", percent: 100 },
    { point: "before_one_third", percent: 80 },
    { point: "before_half", percent: 50 },
    { point: "after_half", percent: 0 },
  ],
  nonRefundableCases: "이미 들은 회차",
  processingBusinessDays: 5,
  ownerContact: "0200000000",
};
// 판본 3(최신) — 템플릿 그대로
const V3_CONTENT = { ...V1_CONTENT, tiers: V1_CONTENT.tiers.map((t) => (t.point === "before_one_third" ? { ...t, percent: 67 } : t)) };

describe.skipIf(!dbAvailable())("환불·취소 공지 조회(계약 09 §1)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let routes: ReturnType<typeof createRefundNoticeReadRoutes>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  let academyA = ""; // 주문이 걸린 학원(대표 ownerA)
  let academyB = ""; // 다른 학원(대표 ownerB, 등록 형태 확인 전 → 엄격 기준)
  let academyS = ""; // 신고 체육시설(확인됨) — 템플릿 값 미정
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

  async function affiliate(academyId: string, staff: string, permissions: string[]) {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now()) RETURNING id`,
      [academyId, staffIds[staff]],
    );
    for (const p of permissions) {
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        (rows[0] as { id: string }).id,
        p,
        staffIds["ownerA"],
      ]);
    }
  }

  async function addVersion(academyId: string, kind: string, version: number, content: object, createdAt: string) {
    const id = randomUUID();
    await q(
      `INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, template_code, template_version,
                                           created_by_account_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'hakwon_act', '2026-11-13', $7, $8)`,
      [id, academyId, kind, version, `${kind} ${version}판 본문`, JSON.stringify(content), staffIds["ownerA"], createdAt],
    );
    return id;
  }

  // 요청 하나 — 응답이 200 이면 넘긴 스키마로 parse(strict: 계약 밖 키가 섞이면 실패)
  async function call<T>(
    handler: (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>,
    who: string | undefined,
    params: Record<string, string>,
    schema: { parse: (v: unknown) => T },
  ) {
    const headers: Record<string, string> = who === undefined ? {} : { authorization: `Bearer ${tokens[who]}` };
    const res = await handler(new Request(`${BASE}/api/academies/${params["academyId"]}/refund-notices`, { headers }), {
      params: Promise.resolve(params),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return res.status === 200
      ? { status: 200, body: schema.parse(json), code: undefined, res }
      : { status: res.status, body: undefined, code: json["code"], res };
  }
  const getCurrent = (who: string | undefined, academyId: string) =>
    call(routes.getCurrent as never, who, { academyId }, refundNoticesCurrentSchema);
  const listVersions = (who: string | undefined, academyId: string, kind: string) =>
    call(routes.listVersions as never, who, { academyId, kind }, refundNoticeVersionListSchema);
  const getVersion = (who: string | undefined, academyId: string, kind: string, version: string) =>
    call(routes.getVersion as never, who, { academyId, kind, version }, refundNoticeVersionSchema);

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    routes = createRefundNoticeReadRoutes({ db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }) });

    await makeStaff("ownerA");
    await makeStaff("ownerB");
    await makeStaff("ownerNo2fa", { twoFactor: false });
    await makeStaff("delegate", { roles: ["instructor"] }); // 학원 A 소속 + 명단 관리 위임
    await makeStaff("plainInstructor", { roles: ["instructor"] }); // 학원 A 소속, 위임 없음
    await makeStaff("admin", { roles: ["admin"] });

    // 학원 A: 주문 사슬 픽스처(학원·수업·기간·회원·판본 1·주문 A 결제). 판본 1 에 그때 내용을 채우고 판본 2·3 을 쌓는다
    await insertReservationAndPayment(handle.pool);
    const order = (
      await q("SELECT o.refund_notice_version_id AS notice_id, v.academy_id FROM orders o JOIN refund_notice_versions v ON v.id = o.refund_notice_version_id")
    ).rows[0] as { notice_id: string; academy_id: string };
    orderNoticeId = order.notice_id;
    academyA = order.academy_id;
    // 등록 형태 확인됨(학원) — 정규 템플릿은 학원법
    await q("UPDATE academies SET registration_verified_at = now() WHERE id = $1", [academyA]);
    await q(
      `UPDATE refund_notice_versions SET content = $2::jsonb, body = '정규 1판 본문', template_code = 'hakwon_act',
              template_version = '2026-11-13', created_at = '2026-11-01T00:00:00Z' WHERE id = $1`,
      [orderNoticeId, JSON.stringify(V1_CONTENT)],
    );
    await own(academyA, "ownerA");
    await addVersion(academyA, "regular", 2, { ...V1_CONTENT, ownerContact: "0211111111" }, "2026-11-05T00:00:00Z");
    await addVersion(academyA, "regular", 3, V3_CONTENT, "2026-11-10T00:00:00Z");
    await addVersion(academyA, "event", 1, { feeTiers: [{ window: "d10_plus", percent: 0 }] }, "2026-11-11T00:00:00Z");
    await affiliate(academyA, "delegate", ["roster_manage"]);
    await affiliate(academyA, "plainInstructor", []);

    // 학원 B: 판본 없음 · 등록 형태 확인 전(엄격 기준) · 학원 S: 신고 체육시설 확인됨 · 학원 C: 2단계 안 켠 대표
    academyB = randomUUID();
    academyS = randomUUID();
    const academyC = randomUUID();
    for (const [id, verified] of [[academyB, false], [academyS, true], [academyC, true]] as const) {
      await q(
        `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, registration_verified_at, ${ACADEMY_SELLER_COLUMNS})
         VALUES ($1, '공지 조회 시험 학원', '서울', '마포구', now(), ${verified ? "now()" : "NULL"}, ${ACADEMY_SELLER_VALUES})`,
        [id],
      );
    }
    await q("UPDATE academies SET registration_type = 'sports_facility' WHERE id = $1", [academyS]);
    await own(academyB, "ownerB");
    await own(academyS, "ownerB");
    await own(academyC, "ownerNo2fa");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("수용 시나리오 2(verify) — 주문 A 가 가리키는 옛 판본 1 이 판본 3 이 생긴 뒤에도 그때 내용 그대로 열린다", async () => {
    // 주문이 가리키는 판본의 번호를 DB 에서 읽는다(주문은 판본 id 를 들고 있다)
    const { rows } = await q("SELECT notice_kind, version FROM refund_notice_versions WHERE id = $1", [orderNoticeId]);
    const { notice_kind: kind, version } = rows[0] as { notice_kind: string; version: number };
    expect([kind, version]).toEqual(["regular", 1]);

    const old = await getVersion("ownerA", academyA, kind, String(version));
    expect(old.status).toBe(200);
    expect(old.res.headers.get("cache-control")).toBe("private, no-store");
    expect(old.body).toEqual({
      kind: "regular",
      version: 1,
      createdAt: "2026-11-01T00:00:00Z",
      content: V1_CONTENT,
      body: "정규 1판 본문",
      templateCode: "hakwon_act",
      templateVersion: "2026-11-13",
    });

    // 같은 학원의 현재 판본은 3 이고 내용이 다르다 — 새 주문은 3 을, 주문 A 는 여전히 1 을 본다
    const current = await getCurrent("ownerA", academyA);
    expect(current.body!.regular.version).toBe(3);
    expect(current.body!.regular.content).toEqual(V3_CONTENT);
    const v3 = await getVersion("ownerA", academyA, "regular", "3");
    expect(v3.body!.content).toEqual(V3_CONTENT);
  });

  test("현재 판본 — 종류별 최신 판본 · 학원법 템플릿 100·67·50·0 · 이벤트형 상한 10·10·20·30 · 개인 레슨 없음", async () => {
    const res = await getCurrent("ownerA", academyA);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      registrationType: "academy",
      registrationVerified: true,
      regular: {
        version: 3,
        createdAt: "2026-11-10T00:00:00Z",
        content: V3_CONTENT,
        template: {
          code: "hakwon_act",
          templateVersion: "2026-11-13",
          minimums: [
            { point: "before_start", percent: 100 },
            { point: "before_one_third", percent: 67 },
            { point: "before_half", percent: 50 },
            { point: "after_half", percent: 0 },
          ],
        },
      },
      event: {
        version: 1,
        createdAt: "2026-11-11T00:00:00Z",
        content: { feeTiers: [{ window: "d10_plus", percent: 0 }] },
        maxFeePercents: { d10_plus: 10, d9_d7: 10, d6_d3: 20, d2_to_deadline: 30 },
      },
      privateLesson: null,
    });
  });

  test("판본이 없는 학원 — 판본 칸은 null, 확인 전이라 엄격한 학원법 템플릿(FR-087), 목록은 비어 있다", async () => {
    const res = await getCurrent("ownerB", academyB);
    expect(res.status).toBe(200);
    expect(res.body!.registrationVerified).toBe(false);
    expect(res.body!.regular).toMatchObject({ version: null, createdAt: null, content: null });
    expect(res.body!.regular.template?.code).toBe("hakwon_act");
    expect(res.body!.event).toMatchObject({ version: null, createdAt: null, content: null });
    const list = await listVersions("ownerB", academyB, "regular");
    expect(list.body).toEqual({ kind: "regular", items: [] });
  });

  test("신고 체육시설(확인됨) — 템플릿 값이 spec 에 없어 template null(Q11 ① 미정)", async () => {
    const res = await getCurrent("ownerB", academyS);
    expect(res.body!.registrationType).toBe("sports_facility");
    expect(res.body!.regular.template).toBeNull();
  });

  test("판본 목록 — 종류별로 최신순, 다른 종류는 섞이지 않는다", async () => {
    const regular = await listVersions("ownerA", academyA, "regular");
    expect(regular.body!.items.map((i) => i.version)).toEqual([3, 2, 1]);
    expect(regular.body!.items[2]).toEqual({
      version: 1,
      createdAt: "2026-11-01T00:00:00Z",
      templateCode: "hakwon_act",
      templateVersion: "2026-11-13",
    });
    const event = await listVersions("ownerA", academyA, "event");
    expect(event.body!.items.map((i) => i.version)).toEqual([1]);
    const lesson = await listVersions("ownerA", academyA, "private_lesson");
    expect(lesson.body!.items).toEqual([]);
  });

  test("위임 강사는 조회만 된다 — 세 경로 모두 200", async () => {
    expect((await getCurrent("delegate", academyA)).status).toBe(200);
    expect((await listVersions("delegate", academyA, "regular")).status).toBe(200);
    expect((await getVersion("delegate", academyA, "regular", "1")).body!.content).toEqual(V1_CONTENT);
  });

  test("권한 — 위임 없는 소속 강사·다른 학원 대표·운영자 403, 2단계 전·로그인 안 함 401", async () => {
    for (const who of ["plainInstructor", "ownerB", "admin"]) {
      const res = await getCurrent(who, academyA);
      expect([who, res.status, res.code]).toEqual([who, 403, "FORBIDDEN"]);
      const one = await getVersion(who, academyA, "regular", "1");
      expect([who, one.status]).toEqual([who, 403]);
    }
    // 위임 강사도 다른 학원 공지는 못 본다
    expect((await getCurrent("delegate", academyB)).status).toBe(403);
    const no2fa = await getCurrent("ownerNo2fa", academyA);
    expect([no2fa.status, no2fa.code]).toEqual([401, "SECOND_FACTOR_REQUIRED"]);
    const anon = await getCurrent(undefined, academyA);
    expect([anon.status, anon.code]).toEqual([401, "UNAUTHENTICATED"]);
  });

  test("없는 것은 404 — 학원·판본 번호·종류 이름·모양이 틀린 값", async () => {
    expect((await getCurrent("ownerA", randomUUID())).status).toBe(404);
    expect((await getCurrent("ownerA", "not-a-uuid")).status).toBe(404);
    for (const [kind, version] of [
      ["regular", "4"],
      ["regular", "0"],
      ["regular", "abc"],
      ["regular", "99999999999"],
      ["event", "2"],
      ["membership", "1"],
    ]) {
      const res = await getVersion("ownerA", academyA, kind!, version!);
      expect([kind, version, res.status, res.code]).toEqual([kind, version, 404, "NOT_FOUND"]);
    }
    expect((await listVersions("ownerA", academyA, "membership")).status).toBe(404);
  });

  test("조회는 판본을 바꾸지 않는다 — 판본 수·옛 판본 내용 그대로", async () => {
    const before = await q("SELECT id, version, content::text FROM refund_notice_versions WHERE academy_id = $1 ORDER BY notice_kind, version", [academyA]);
    await getCurrent("ownerA", academyA);
    await getVersion("ownerA", academyA, "regular", "1");
    const after = await q("SELECT id, version, content::text FROM refund_notice_versions WHERE academy_id = $1 ORDER BY notice_kind, version", [academyA]);
    expect(after.rows).toEqual(before.rows);
  });
});
