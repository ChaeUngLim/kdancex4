// S1-4.3(학원 공지 초안·수정·올리기 API) — 계약 09 §3 의 쓰기 경로 셋을 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-4-3.db.test.ts 였는데, 기능 이름(academy-staff-notice-publish)으로 바꿨다.
//   핵심(verify): 초안만 고친다 · 올린 공지 PATCH 409 NOTICE_ALREADY_PUBLISHED · 올리기 두 번 → 알림 강사당 1건
//                 · 제목 101자 422 · 위임 강사 쓰기 403.
//   나머지: 받는 사람은 그 순간 active 소속만(해제·대기 제외, 수용 5) · 소속 강사 0명 409 NO_RECIPIENTS(초안 그대로)
//           · publish:true 한 요청으로 올리기 · 다른 학원 공지 404 · 다른 학원 대표 403 · 2단계 전 401 · 동시 올리기.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createCreateStaffNoticeRoute,
  createPublishStaffNoticeRoute,
  createUpdateStaffNoticeRoute,
  staffNoticeSchema,
} from "@/lib/server/services/academy-staff-notices";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "academy-staff-notice-test-secret-0123456789-01";
const BASE = "http://localhost:3000";
const DECIDED_AT = "2026-11-10T00:00:00Z";

describe.skipIf(!dbAvailable())("학원 공지 초안·수정·올리기(계약 09 §3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let CREATE: ReturnType<typeof createCreateStaffNoticeRoute>;
  let UPDATE: ReturnType<typeof createUpdateStaffNoticeRoute>;
  let PUBLISH: ReturnType<typeof createPublishStaffNoticeRoute>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};

  async function makeStaff(key: string, opts: { twoFactor?: boolean } = {}) {
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
    staffIds[key] = id;
  }

  async function makeAcademy(key: string, owner: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `${key}댄스학원`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
  }

  /** 소속 행 하나 — 상태별로(active·released·pending) */
  async function affiliate(academy: string, instructor: string, status: "active" | "released" | "pending"): Promise<string> {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations
         (id, academy_id, instructor_account_id, status, source, decided_at, released_at, release_initiated_by, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'application', $4::timestamptz, $5::timestamptz, $6, now()) RETURNING id`,
      [
        academyIds[academy],
        staffIds[instructor],
        status,
        status === "pending" ? null : DECIDED_AT,
        status === "released" ? DECIDED_AT : null,
        status === "released" ? "owner" : null,
      ],
    );
    return (rows[0] as { id: string }).id;
  }

  function headersFor(who: string | undefined): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    return headers;
  }

  async function create(who: string | undefined, academy: string, body: unknown) {
    const academyId = academyIds[academy] ?? academy;
    const res = await CREATE(
      new Request(`${BASE}/api/academies/${academyId}/staff-notices`, { method: "POST", headers: headersFor(who), body: JSON.stringify(body) }),
      { params: Promise.resolve({ academyId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json, body: res.status === 201 ? staffNoticeSchema.parse(json) : undefined };
  }

  async function update(who: string | undefined, academy: string, noticeId: string, body: unknown) {
    const academyId = academyIds[academy] ?? academy;
    const res = await UPDATE(
      new Request(`${BASE}/api/academies/${academyId}/staff-notices/${noticeId}`, {
        method: "PATCH",
        headers: headersFor(who),
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ academyId, noticeId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json, body: res.status === 200 ? staffNoticeSchema.parse(json) : undefined };
  }

  async function publish(who: string | undefined, academy: string, noticeId: string) {
    const academyId = academyIds[academy] ?? academy;
    const res = await PUBLISH(
      new Request(`${BASE}/api/academies/${academyId}/staff-notices/${noticeId}/publish`, { method: "POST", headers: headersFor(who) }),
      { params: Promise.resolve({ academyId, noticeId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json, body: res.status === 200 ? staffNoticeSchema.parse(json) : undefined };
  }

  const DRAFT = { category: "class_cancelled", title: "11/21 (토) 살사 온원 입문 휴강", body: "강사님 사정으로 이번 주 수업은 쉽니다." };

  const noticeCount = async () => Number((await q("SELECT count(*) FROM academy_staff_notices")).rows[0].count);
  /** 이 공지로 생긴 알림을 강사별로 센다 */
  async function notificationsPerInstructor(noticeId: string): Promise<Record<string, number>> {
    const { rows } = await q(
      `SELECT recipient_staff_account_id AS id, count(*)::int AS n FROM notifications
       WHERE kind = 'staff_notice_published' AND payload->>'noticeId' = $1 GROUP BY recipient_staff_account_id`,
      [noticeId],
    );
    return Object.fromEntries((rows as { id: string; n: number }[]).map((r) => [r.id, r.n]));
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    const deps = { db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }) };
    CREATE = createCreateStaffNoticeRoute(deps);
    UPDATE = createUpdateStaffNoticeRoute(deps);
    PUBLISH = createPublishStaffNoticeRoute(deps);

    for (const key of ["ownerA", "ownerB", "ownerC", "insA1", "insA2", "insA3", "insPending", "delegate"]) await makeStaff(key);
    await makeStaff("ownerNo2fa", { twoFactor: false });
    await makeAcademy("A", "ownerA");
    await makeAcademy("B", "ownerB"); // 소속 강사 0명
    await makeAcademy("C", "ownerC");
    await makeAcademy("D", "ownerNo2fa");
    // 학원 A: active 3명(insA1·insA2·delegate) + 해제 1명(insA3) + 대기 1명(insPending)
    await affiliate("A", "insA1", "active");
    await affiliate("A", "insA2", "active");
    await affiliate("A", "insA3", "released");
    await affiliate("A", "insPending", "pending");
    const delegateAff = await affiliate("A", "delegate", "active");
    for (const p of ["roster_manage", "class_manage"]) {
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        delegateAff,
        p,
        staffIds["ownerA"],
      ]);
    }
    await affiliate("C", "insA1", "active");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("대표가 초안을 만든다 → 201, draft · 올린 시각·받는 사람 수는 null", async () => {
    const res = await create("ownerA", "A", DRAFT);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ...DRAFT, academyId: academyIds["A"], status: "draft", publishedAt: null, recipientCount: null });
    const { rows } = await q("SELECT author_account_id FROM academy_staff_notices WHERE id = $1", [res.body?.noticeId]);
    expect(rows[0].author_account_id).toBe(staffIds["ownerA"]);
  });

  test("제목 101자 → 422 VALIDATION_FAILED(fields title), 100자는 201", async () => {
    const before = await noticeCount();
    const long = await create("ownerA", "A", { ...DRAFT, title: "가".repeat(101) });
    expect(long.status).toBe(422);
    expect(long.json).toMatchObject({ code: "VALIDATION_FAILED", fields: [{ path: "title" }] });
    expect(await noticeCount()).toBe(before);
    const max = await create("ownerA", "A", { ...DRAFT, title: "가".repeat(100) });
    expect(max.status).toBe(201);
  });

  test("잘못된 분류·빈 내용·모르는 칸(이미지) → 422", async () => {
    expect((await create("ownerA", "A", { ...DRAFT, category: "party" })).status).toBe(422);
    expect((await create("ownerA", "A", { ...DRAFT, body: "   " })).status).toBe(422);
    expect((await create("ownerA", "A", { ...DRAFT, posterFileId: randomUUID() })).status).toBe(422);
  });

  test("위임 강사(roster·class 둘 다)의 공지 쓰기 → 403 FORBIDDEN 셋 다, 공지는 생기지 않는다", async () => {
    const draft = await create("ownerA", "A", DRAFT);
    const before = await noticeCount();
    const c = await create("delegate", "A", DRAFT);
    expect(c.status).toBe(403);
    expect(c.json.code).toBe("FORBIDDEN");
    expect((await update("delegate", "A", draft.body!.noticeId, { title: "바꿈" })).status).toBe(403);
    expect((await publish("delegate", "A", draft.body!.noticeId)).status).toBe(403);
    expect(await noticeCount()).toBe(before);
  });

  test("다른 학원 대표 403 · 2단계 전 401 · 로그인 안 함 401", async () => {
    const draft = await create("ownerA", "A", DRAFT);
    expect((await create("ownerB", "A", DRAFT)).status).toBe(403);
    expect((await publish("ownerB", "A", draft.body!.noticeId)).status).toBe(403);
    const no2fa = await create("ownerNo2fa", "D", DRAFT);
    expect(no2fa.status).toBe(401);
    expect(no2fa.json.code).toBe("SECOND_FACTOR_REQUIRED");
    expect((await create(undefined, "A", DRAFT)).status).toBe(401);
  });

  test("초안은 고친다 → 200, 보낸 칸만 바뀐다 · 빈 본문 422", async () => {
    const draft = await create("ownerA", "A", DRAFT);
    const res = await update("ownerA", "A", draft.body!.noticeId, { title: "11/21 (토) 휴강 — 보강은 다음 주" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: "11/21 (토) 휴강 — 보강은 다음 주", body: DRAFT.body, category: DRAFT.category, status: "draft" });
    expect((await update("ownerA", "A", draft.body!.noticeId, {})).status).toBe(422);
    expect((await update("ownerA", "A", draft.body!.noticeId, { title: "가".repeat(101) })).status).toBe(422);
  });

  test("올리기 → 받는 사람은 지금 active 소속 3명(해제·대기 제외), 강사마다 알림 1건", async () => {
    const draft = await create("ownerA", "A", DRAFT);
    const noticeId = draft.body!.noticeId;
    const res = await publish("ownerA", "A", noticeId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "published", recipientCount: 3 });
    expect(res.body?.publishedAt).not.toBeNull();

    const { rows } = await q("SELECT instructor_account_id FROM academy_staff_notice_recipients WHERE notice_id = $1", [noticeId]);
    const recipients = (rows as { instructor_account_id: string }[]).map((r) => r.instructor_account_id).sort();
    expect(recipients).toEqual([staffIds["insA1"], staffIds["insA2"], staffIds["delegate"]].sort());

    const perInstructor = await notificationsPerInstructor(noticeId);
    expect(perInstructor).toEqual({ [staffIds["insA1"]]: 1, [staffIds["insA2"]]: 1, [staffIds["delegate"]]: 1 });
    const { rows: n } = await q(
      `SELECT academy_id, category, dedupe_key, payload->>'body' AS body FROM notifications
       WHERE kind = 'staff_notice_published' AND recipient_staff_account_id = $1 AND payload->>'noticeId' = $2`,
      [staffIds["insA1"], noticeId],
    );
    expect(n[0]).toMatchObject({
      academy_id: academyIds["A"],
      category: "operations",
      dedupe_key: `staff_notice:${noticeId}:${staffIds["insA1"]}`,
      body: DRAFT.title,
    });
  });

  test("올리기를 두 번 누른다 → 두 번째도 200 같은 본문, 알림은 강사당 1건 그대로", async () => {
    const draft = await create("ownerA", "A", DRAFT);
    const noticeId = draft.body!.noticeId;
    const first = await publish("ownerA", "A", noticeId);
    const second = await publish("ownerA", "A", noticeId);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const perInstructor = await notificationsPerInstructor(noticeId);
    expect(Object.values(perInstructor)).toEqual([1, 1, 1]);
  });

  test("동시에 올리기 두 번 → 둘 다 200, 받는 사람 3행·알림 강사당 1건", async () => {
    const draft = await create("ownerA", "A", DRAFT);
    const noticeId = draft.body!.noticeId;
    const [a, b] = await Promise.all([publish("ownerA", "A", noticeId), publish("ownerA", "A", noticeId)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body).toEqual(b.body);
    const { rows } = await q("SELECT count(*)::int AS n FROM academy_staff_notice_recipients WHERE notice_id = $1", [noticeId]);
    expect(rows[0].n).toBe(3);
    expect(Object.values(await notificationsPerInstructor(noticeId))).toEqual([1, 1, 1]);
  });

  test("올린 공지 고치기 → 409 NOTICE_ALREADY_PUBLISHED, 내용 그대로", async () => {
    const draft = await create("ownerA", "A", DRAFT);
    const noticeId = draft.body!.noticeId;
    await publish("ownerA", "A", noticeId);
    const res = await update("ownerA", "A", noticeId, { title: "몰래 바꿈" });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("NOTICE_ALREADY_PUBLISHED");
    const { rows } = await q("SELECT title FROM academy_staff_notices WHERE id = $1", [noticeId]);
    expect(rows[0].title).toBe(DRAFT.title);
  });

  test("소속 강사 0명 학원 → 올리기 409 NO_RECIPIENTS, 초안 그대로 · publish:true 면 초안도 안 남는다", async () => {
    const draft = await create("ownerB", "B", DRAFT);
    const res = await publish("ownerB", "B", draft.body!.noticeId);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("NO_RECIPIENTS");
    const { rows } = await q("SELECT status, published_at FROM academy_staff_notices WHERE id = $1", [draft.body!.noticeId]);
    expect(rows[0]).toMatchObject({ status: "draft", published_at: null });

    const before = await noticeCount();
    const direct = await create("ownerB", "B", { ...DRAFT, publish: true });
    expect(direct.status).toBe(409);
    expect(direct.json.code).toBe("NO_RECIPIENTS");
    expect(await noticeCount()).toBe(before);
  });

  test("publish:true 한 요청으로 바로 올린다(O28) → 201 published, 받는 사람 1명", async () => {
    const res = await create("ownerC", "C", { ...DRAFT, publish: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "published", recipientCount: 1 });
    expect(await notificationsPerInstructor(res.body!.noticeId)).toEqual({ [staffIds["insA1"]]: 1 });
  });

  test("다른 학원 공지·없는 공지·모양 틀린 id → 404", async () => {
    const draftC = await create("ownerC", "C", DRAFT);
    expect((await update("ownerA", "A", draftC.body!.noticeId, { title: "남의 것" })).status).toBe(404);
    expect((await publish("ownerA", "A", draftC.body!.noticeId)).status).toBe(404);
    expect((await publish("ownerA", "A", randomUUID())).status).toBe(404);
    expect((await publish("ownerA", "A", "not-a-uuid")).status).toBe(404);
  });
});
