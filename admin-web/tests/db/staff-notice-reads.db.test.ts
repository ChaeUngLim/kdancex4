// S1-4.4(소속 강사 공지 조회·읽음 API) — 계약 09 §3 의 읽기 경로 셋을 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-4-4.db.test.ts 였는데, 기능 이름(staff-notice-reads)으로 바꿨다.
//   핵심(verify · 수용 시나리오 5): 소속 강사 3명 중 1명이 해제된 뒤 공지를 올리면 받는 사람 2명이고, 해제된 강사의 목록은 비어 있다.
//   나머지: 올린 뒤 해제되면 받아 둔 옛 공지도 사라진다(읽음도 404) · 올린 뒤 소속된 강사는 옛 공지를 못 본다
//           · 학원·분류 거르기 · 커서로 다음 쪽 · 읽음 멱등 · 남의 공지 읽음 404 · 대표 지난 공지(초안 제외, 읽은 수)
//           · 권한(대표 쪽 위임 강사 403 · 강사 쪽 대표 403 · 로그인 안 함 401).
//   공지는 S1-4.3 의 실제 쓰기 경로(만들기 + 올리기)로 올린다 — 받는 사람 고정이 진짜 흐름 그대로 들어간다.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createCreateStaffNoticeRoute } from "@/lib/server/services/academy-staff-notices";
import {
  academyNoticeListSchema,
  createListAcademyStaffNoticesRoute,
  createListInstructorStaffNoticesRoute,
  createReadInstructorStaffNoticeRoute,
  instructorNoticeListSchema,
  noticeReadResponseSchema,
} from "@/lib/server/services/staff-notice-reads";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "staff-notice-reads-test-secret-0123456789-0123";
const BASE = "http://localhost:3000";
const DECIDED_AT = "2026-11-10T00:00:00Z";

describe.skipIf(!dbAvailable())("소속 강사 공지 조회·읽음(계약 09 §3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let CREATE: ReturnType<typeof createCreateStaffNoticeRoute>;
  let OWNER_LIST: ReturnType<typeof createListAcademyStaffNoticesRoute>;
  let INS_LIST: ReturnType<typeof createListInstructorStaffNoticesRoute>;
  let READ: ReturnType<typeof createReadInstructorStaffNoticeRoute>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};

  async function makeStaff(key: string, roles: string[]) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: key.toLowerCase(), displayUsername: key },
      { method: "admin" },
    );
    await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      key,
    ]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
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

  /** active 소속 행 하나 */
  async function affiliate(academy: string, instructor: string): Promise<string> {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', $3::timestamptz, now()) RETURNING id`,
      [academyIds[academy], staffIds[instructor], DECIDED_AT],
    );
    return (rows[0] as { id: string }).id;
  }

  /** 소속 해제 — 해제 API(S1-2.12)가 남기는 끝 상태와 같은 칸만 바꾼다 */
  async function release(academy: string, instructor: string) {
    await q(
      `UPDATE instructor_affiliations SET status = 'released', released_at = now(), release_initiated_by = 'owner', updated_at = now()
       WHERE academy_id = $1 AND instructor_account_id = $2 AND status = 'active'`,
      [academyIds[academy], staffIds[instructor]],
    );
  }

  const headersFor = (who: string | undefined): Record<string, string> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    return headers;
  };

  /** 대표가 실제 쓰기 경로로 공지를 바로 올린다(publish: true). 공지 id 를 돌려준다 */
  async function publishNotice(owner: string, academy: string, title: string, category = "class_cancelled"): Promise<string> {
    const academyId = academyIds[academy];
    const res = await CREATE(
      new Request(`${BASE}/api/academies/${academyId}/staff-notices`, {
        method: "POST",
        headers: headersFor(owner),
        body: JSON.stringify({ category, title, body: `${title} 본문`, publish: true }),
      }),
      { params: Promise.resolve({ academyId }) },
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { noticeId: string }).noticeId;
  }

  async function draftNotice(owner: string, academy: string, title: string): Promise<string> {
    const academyId = academyIds[academy];
    const res = await CREATE(
      new Request(`${BASE}/api/academies/${academyId}/staff-notices`, {
        method: "POST",
        headers: headersFor(owner),
        body: JSON.stringify({ category: "other", title, body: "초안 본문" }),
      }),
      { params: Promise.resolve({ academyId }) },
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { noticeId: string }).noticeId;
  }

  async function insList(who: string | undefined, query = "") {
    const res = await INS_LIST(new Request(`${BASE}/api/instructor/staff-notices${query}`, { headers: headersFor(who) }), undefined);
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json, body: res.status === 200 ? instructorNoticeListSchema.parse(json) : undefined };
  }

  async function read(who: string | undefined, noticeId: string) {
    const res = await READ(
      new Request(`${BASE}/api/instructor/staff-notices/${noticeId}/read`, { method: "POST", headers: headersFor(who) }),
      { params: Promise.resolve({ noticeId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json, body: res.status === 200 ? noticeReadResponseSchema.parse(json) : undefined };
  }

  async function ownerList(who: string | undefined, academy: string, query = "") {
    const academyId = academyIds[academy] ?? academy;
    const res = await OWNER_LIST(
      new Request(`${BASE}/api/academies/${academyId}/staff-notices${query}`, { headers: headersFor(who) }),
      { params: Promise.resolve({ academyId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json, body: res.status === 200 ? academyNoticeListSchema.parse(json) : undefined };
  }

  const titles = (body: { items: { title: string }[] } | undefined) => body?.items.map((i) => i.title);

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    const deps = { db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }) };
    CREATE = createCreateStaffNoticeRoute(deps);
    OWNER_LIST = createListAcademyStaffNoticesRoute(deps);
    INS_LIST = createListInstructorStaffNoticesRoute(deps);
    READ = createReadInstructorStaffNoticeRoute(deps);

    for (const key of ["ownerA", "ownerB", "ownerC"]) await makeStaff(key, ["owner"]);
    for (const key of ["ins1", "ins2", "ins3", "insLate", "insLeaver", "delegate"]) await makeStaff(key, ["instructor"]);
    await makeAcademy("A", "ownerA");
    await makeAcademy("B", "ownerB");
    await makeAcademy("C", "ownerC");
    for (const ins of ["ins1", "ins2", "ins3", "insLeaver"]) await affiliate("A", ins);
    const delegateAff = await affiliate("A", "delegate");
    for (const p of ["roster_manage", "class_manage"]) {
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        delegateAff,
        p,
        staffIds["ownerA"],
      ]);
    }
    await affiliate("B", "ins1");
    await affiliate("C", "ins3");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("시나리오 5: 소속 강사 3명 중 1명이 해제된 뒤 올리면 받는 사람 2명, 해제된 강사의 학원 공지 목록은 비어 있다", async () => {
    // 학원 C: ins3 혼자 소속 → 학원 C 에 2명을 더 소속시켜 「3명 중 1명 해제」를 만든다
    await makeStaff("insC1", ["instructor"]);
    await makeStaff("insC2", ["instructor"]);
    await affiliate("C", "insC1");
    await affiliate("C", "insC2");
    await release("C", "insC2");

    const noticeId = await publishNotice("ownerC", "C", "C 학원 12월 일정");
    const { rows } = await q("SELECT instructor_account_id FROM academy_staff_notice_recipients WHERE notice_id = $1", [noticeId]);
    expect(new Set(rows.map((r: { instructor_account_id: string }) => r.instructor_account_id))).toEqual(
      new Set([staffIds["ins3"], staffIds["insC1"]]),
    );

    const owner = await ownerList("ownerC", "C");
    expect(owner.body?.items).toEqual([expect.objectContaining({ noticeId, recipientCount: 2, readCount: 0 })]);

    const released = await insList("insC2");
    expect(released.status).toBe(200);
    expect(released.body).toEqual({ items: [], nextCursor: null });

    const active = await insList("insC1");
    expect(active.body?.items).toEqual([
      {
        noticeId,
        academyId: academyIds["C"],
        academyName: "C댄스학원",
        category: "class_cancelled",
        title: "C 학원 12월 일정",
        body: "C 학원 12월 일정 본문",
        publishedAt: expect.any(String),
        readAt: null,
      },
    ]);
  });

  test("올린 뒤에 해제되면 받아 둔 옛 공지도 목록에서 사라지고, 읽음도 404", async () => {
    const noticeId = await publishNotice("ownerA", "A", "A 휴강 안내(해제 전)");
    const before = await insList("insLeaver", `?academyId=${academyIds["A"]}`);
    expect(titles(before.body)).toContain("A 휴강 안내(해제 전)");

    await release("A", "insLeaver");
    // 받는 사람 행은 그대로 남아 있다 — 거르기는 조회가 맡는다
    const { rowCount } = await q("SELECT 1 FROM academy_staff_notice_recipients WHERE notice_id = $1 AND instructor_account_id = $2", [
      noticeId,
      staffIds["insLeaver"],
    ]);
    expect(rowCount).toBe(1);
    expect((await insList("insLeaver")).body).toEqual({ items: [], nextCursor: null });
    expect((await read("insLeaver", noticeId)).json).toMatchObject({ code: "NOT_FOUND" });
    expect((await read("insLeaver", noticeId)).status).toBe(404);
  });

  test("공지를 올린 뒤에 소속된 강사는 그 옛 공지를 못 본다(받는 사람이 아니다), 읽음도 404", async () => {
    const noticeId = await publishNotice("ownerA", "A", "A 소속 전 공지");
    await affiliate("A", "insLate");
    const late = await insList("insLate");
    expect(titles(late.body)).not.toContain("A 소속 전 공지");
    expect((await read("insLate", noticeId)).status).toBe(404);
  });

  test("여러 학원 소속 강사: 최신순으로 두 학원 공지가 섞이고, academyId·category 로 거른다", async () => {
    await publishNotice("ownerB", "B", "B 일정 변경", "class_changed");
    const all = await insList("ins1");
    expect(all.status).toBe(200);
    const items = all.body?.items ?? [];
    expect(items.map((i) => i.academyId)).toEqual(expect.arrayContaining([academyIds["A"], academyIds["B"]]));
    // 최신순: 올린 시각이 앞의 것 ≥ 뒤의 것
    for (let i = 1; i < items.length; i += 1) expect(items[i - 1]!.publishedAt >= items[i]!.publishedAt).toBe(true);
    expect(items[0]?.title).toBe("B 일정 변경");

    const onlyB = await insList("ins1", `?academyId=${academyIds["B"]}`);
    expect(titles(onlyB.body)).toEqual(["B 일정 변경"]);
    const changed = await insList("ins1", "?category=class_changed");
    expect(titles(changed.body)).toEqual(["B 일정 변경"]);
    expect((await insList("ins1", "?category=party")).status).toBe(422);
    expect((await insList("ins1", "?academyId=nope")).status).toBe(422);
  });

  test("커서로 다음 쪽 — 겹치거나 빠지는 공지가 없다, 손으로 고친 커서는 422", async () => {
    for (const n of [1, 2, 3]) await publishNotice("ownerA", "A", `쪽 넘기기 ${n}`);
    const all = (await insList("ins2", "?limit=100")).body?.items.map((i) => i.noticeId) ?? [];
    expect(all.length).toBeGreaterThanOrEqual(4);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`;
      const page = await insList("ins2", query);
      expect(page.status).toBe(200);
      seen.push(...(page.body?.items.map((i) => i.noticeId) ?? []));
      cursor = page.body?.nextCursor ?? null;
    } while (cursor !== null);
    expect(seen).toEqual(all);

    const bad = await insList("ins2", "?cursor=bm90LWEtY3Vyc29y");
    expect(bad.status).toBe(422);
  });

  test("읽음: 처음 시각을 지키는 멱등 · 목록 readAt · 대표 쪽 읽은 수가 오른다", async () => {
    const noticeId = await publishNotice("ownerA", "A", "읽음 확인 공지");
    const first = await read("ins2", noticeId);
    expect(first.status).toBe(200);
    expect(first.body?.noticeId).toBe(noticeId);
    const second = await read("ins2", noticeId);
    expect(second.status).toBe(200);
    expect(second.body?.readAt).toBe(first.body?.readAt);

    const list = await insList("ins2", `?academyId=${academyIds["A"]}&limit=100`);
    expect(list.body?.items.find((i) => i.noticeId === noticeId)?.readAt).toBe(first.body?.readAt);
    const unread = await insList("ins1", `?academyId=${academyIds["A"]}&limit=100`);
    expect(unread.body?.items.find((i) => i.noticeId === noticeId)?.readAt).toBeNull();

    const owner = await ownerList("ownerA", "A", "?limit=100");
    expect(owner.body?.items.find((i) => i.noticeId === noticeId)).toMatchObject({ readCount: 1 });
  });

  test("받는 사람이 아닌 공지·없는 공지·id 모양이 틀린 공지 읽음 → 404", async () => {
    const bNotice = (await ownerList("ownerB", "B")).body?.items[0]?.noticeId ?? "";
    expect((await read("ins2", bNotice)).status).toBe(404); // ins2 는 학원 B 소속이 아니다
    expect((await read("ins2", randomUUID())).status).toBe(404);
    expect((await read("ins2", "not-a-uuid")).status).toBe(404);
  });

  test("대표 지난 공지: 올린 공지만 최신순(초안 제외), 받은 사람 수 · status=draft 는 422", async () => {
    await draftNotice("ownerA", "A", "아직 안 올린 초안");
    const res = await ownerList("ownerA", "A", "?status=published&limit=100");
    expect(res.status).toBe(200);
    const items = res.body?.items ?? [];
    expect(titles(res.body)).not.toContain("아직 안 올린 초안");
    expect(items[0]?.title).toBe("읽음 확인 공지");
    for (let i = 1; i < items.length; i += 1) expect(items[i - 1]!.publishedAt >= items[i]!.publishedAt).toBe(true);
    // 「읽음 확인 공지」를 올린 순간 학원 A 의 active 소속: ins1·ins2·ins3·delegate·insLate (insLeaver 는 해제)
    expect(items[0]?.recipientCount).toBe(5);
    expect((await ownerList("ownerA", "A", "?status=draft")).status).toBe(422);

    // 커서로 다음 쪽(대표 쪽도 같은 커서 규칙)
    const first = await ownerList("ownerA", "A", "?limit=1");
    expect(first.body?.items).toHaveLength(1);
    const next = await ownerList("ownerA", "A", `?limit=1&cursor=${first.body?.nextCursor ?? ""}`);
    expect(next.body?.items[0]?.noticeId).toBe(items[1]?.noticeId);
  });

  test("권한: 대표 목록은 위임 강사·강사·다른 학원 대표 403, 로그인 안 함 401", async () => {
    expect((await ownerList("delegate", "A")).json).toMatchObject({ code: "FORBIDDEN" });
    expect((await ownerList("ins1", "A")).status).toBe(403);
    expect((await ownerList("ownerB", "A")).status).toBe(403);
    expect((await ownerList(undefined, "A")).status).toBe(401);
  });

  test("권한: 강사 경로는 instructor 역할만 — 대표 403, 로그인 안 함 401", async () => {
    expect((await insList("ownerA")).json).toMatchObject({ code: "FORBIDDEN" });
    expect((await insList(undefined)).status).toBe(401);
    expect((await read("ownerA", randomUUID())).status).toBe(403);
    expect((await read(undefined, randomUUID())).status).toBe(401);
  });
});
