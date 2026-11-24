// S1-2.13(강의실 목록·추가·보관 API) — 계약 07 §4 의 rooms 세 경로를 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-2-13.db.test.ts 였는데, 기능 이름(academy-rooms)으로 바꿨다.
//   핵심(verify): 같은 지점 같은 이름 409 ROOM_NAME_TAKEN · 다른 학원 대표 403 · 보관 뒤 목록에서 빠짐.
//   나머지: 빈 칸은 null · 다른 지점은 같은 이름 허용 · 보관한 이름 재사용 · 남의 지점 422 · 잘못된 값 422
//   · 보관 두 번 200 같은 본문 · 남의/없는 강의실 404 · 운영자 403 · 2단계 전·로그인 안 함 401.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createArchiveRoomRoute,
  createCreateRoomRoute,
  createListRoomsRoute,
  roomListResponseSchema,
  roomSchema,
} from "@/lib/server/services/academy-rooms";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "academy-rooms-test-secret-0123456789-0123456";
const BASE = "http://localhost:3000";

describe.skipIf(!dbAvailable())("강의실 목록·추가·보관(계약 07 §4)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let LIST: ReturnType<typeof createListRoomsRoute>;
  let CREATE: ReturnType<typeof createCreateRoomRoute>;
  let ARCHIVE: ReturnType<typeof createArchiveRoomRoute>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const branchIds: Record<string, string> = {};

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

  async function makeAcademy(key: string, owner: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, registration_verified_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', 'active', now(), now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `${key} 학원`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
  }

  async function makeBranch(key: string, academy: string, name: string) {
    branchIds[key] = randomUUID();
    await q(
      `INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at)
       VALUES ($1, $2, $3, '서울 마포구 어딘가 1', '서울', '마포구', now())`,
      [branchIds[key], academyIds[academy], name],
    );
  }

  function headersFor(who: string | undefined): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    return headers;
  }

  async function list(who: string | undefined, academy: string) {
    const academyId = academyIds[academy] ?? academy;
    const res = await LIST(new Request(`${BASE}/api/academies/${academyId}/rooms`, { headers: headersFor(who) }), {
      params: Promise.resolve({ academyId }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json, body: res.status === 200 ? roomListResponseSchema.parse(json) : undefined, res };
  }

  async function create(who: string | undefined, academy: string, body: unknown) {
    const academyId = academyIds[academy] ?? academy;
    const res = await CREATE(
      new Request(`${BASE}/api/academies/${academyId}/rooms`, { method: "POST", headers: headersFor(who), body: JSON.stringify(body) }),
      { params: Promise.resolve({ academyId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json, body: res.status === 201 ? roomSchema.parse(json) : undefined, res };
  }

  async function archive(who: string | undefined, academy: string, roomId: string) {
    const academyId = academyIds[academy] ?? academy;
    const res = await ARCHIVE(
      new Request(`${BASE}/api/academies/${academyId}/rooms/${roomId}/archive`, { method: "POST", headers: headersFor(who) }),
      { params: Promise.resolve({ academyId, roomId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json, body: res.status === 200 ? roomSchema.parse(json) : undefined };
  }

  const roomCount = async () => Number((await q("SELECT count(*) FROM rooms")).rows[0].count);

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    const deps = { db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }) };
    LIST = createListRoomsRoute(deps);
    CREATE = createCreateRoomRoute(deps);
    ARCHIVE = createArchiveRoomRoute(deps);

    await makeStaff("ownerA");
    await makeStaff("ownerB");
    await makeStaff("ownerNo2fa", { twoFactor: false });
    await makeStaff("admin", { roles: ["admin"] });
    await makeAcademy("A", "ownerA");
    await makeAcademy("B", "ownerB");
    await makeAcademy("C", "ownerNo2fa");
    await makeBranch("A1", "A", "홍대점");
    await makeBranch("A2", "A", "강남점");
    await makeBranch("B1", "B", "신촌점");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("처음 목록은 비어 있다", async () => {
    const res = await list("ownerA", "A");
    expect(res.status).toBe(200);
    expect(res.res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.body).toEqual({ items: [] });
  });

  test("추가 — 201, 이름 앞뒤 공백을 지우고 모든 칸을 돌려준다. 빈 칸은 null", async () => {
    const full = await create("ownerA", "A", {
      branchId: branchIds["A1"],
      name: "  A홀 ",
      sizeSqm: 60,
      baseCapacity: 24,
      facilities: "마루 · 전신 거울 · 음향",
    });
    expect(full.status).toBe(201);
    expect(full.body).toMatchObject({
      branchId: branchIds["A1"],
      branchName: "홍대점",
      name: "A홀",
      sizeSqm: 60,
      baseCapacity: 24,
      facilities: "마루 · 전신 거울 · 음향",
      status: "active",
    });
    const bare = await create("ownerA", "A", { branchId: branchIds["A1"], name: "B홀", facilities: "   " });
    expect(bare.status).toBe(201);
    expect(bare.body).toMatchObject({ name: "B홀", sizeSqm: null, baseCapacity: null, facilities: null });
    const { rows } = await q("SELECT size_sqm, base_capacity, facilities FROM rooms WHERE id = $1", [bare.body?.roomId]);
    expect(rows[0]).toEqual({ size_sqm: null, base_capacity: null, facilities: null });

    const listed = await list("ownerA", "A");
    expect(listed.body?.items.map((r) => r.name)).toEqual(["A홀", "B홀"]);
    expect(listed.body?.items[0]).toEqual(full.body);
  });

  test("verify: 같은 지점에 같은 이름이면 409 ROOM_NAME_TAKEN 이고 행이 늘지 않는다 — 다른 지점은 같은 이름 허용", async () => {
    const before = await roomCount();
    const dup = await create("ownerA", "A", { branchId: branchIds["A1"], name: "A홀" });
    expect(dup.status).toBe(409);
    expect(dup.json["code"]).toBe("ROOM_NAME_TAKEN");
    expect(await roomCount()).toBe(before);

    const other = await create("ownerA", "A", { branchId: branchIds["A2"], name: "A홀" });
    expect(other.status).toBe(201);
    expect(other.body?.branchName).toBe("강남점");
  });

  test("verify: 다른 학원 대표는 학원 A 의 세 경로 모두 403 — 아무것도 바뀌지 않는다", async () => {
    const before = await roomCount();
    const [room] = (await list("ownerA", "A")).body?.items ?? [];
    expect(room).toBeDefined();

    expect((await list("ownerB", "A")).status).toBe(403);
    const c = await create("ownerB", "A", { branchId: branchIds["A1"], name: "침입홀" });
    expect(c.status).toBe(403);
    expect(c.json["code"]).toBe("FORBIDDEN");
    expect((await archive("ownerB", "A", room!.roomId)).status).toBe(403);

    expect(await roomCount()).toBe(before);
    const { rows } = await q("SELECT status FROM rooms WHERE id = $1", [room!.roomId]);
    expect(rows[0].status).toBe("active");
  });

  test("verify: 보관하면 목록에서 빠지고, 같은 이름으로 새 강의실을 만들 수 있다. 두 번 보관해도 200 같은 본문", async () => {
    const before = (await list("ownerA", "A")).body!.items;
    const target = before.find((r) => r.name === "B홀")!;

    const first = await archive("ownerA", "A", target.roomId);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ...target, status: "archived" });

    const after = (await list("ownerA", "A")).body!.items;
    expect(after.map((r) => r.roomId)).not.toContain(target.roomId);
    expect(after).toHaveLength(before.length - 1);
    // 지우지 않고 상태만 바꾼다
    const { rows } = await q("SELECT status FROM rooms WHERE id = $1", [target.roomId]);
    expect(rows[0].status).toBe("archived");

    const again = await archive("ownerA", "A", target.roomId);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);

    const reuse = await create("ownerA", "A", { branchId: branchIds["A1"], name: "B홀" });
    expect(reuse.status).toBe(201);
    expect(reuse.body?.roomId).not.toBe(target.roomId);
  });

  test("남의 지점·없는 지점 422 branchId, 잘못된 값 422, JSON 아님 400", async () => {
    const foreign = await create("ownerA", "A", { branchId: branchIds["B1"], name: "C홀" });
    expect(foreign.status).toBe(422);
    expect(foreign.json["fields"]).toEqual([expect.objectContaining({ path: "branchId" })]);
    expect((await create("ownerA", "A", { branchId: randomUUID(), name: "C홀" })).status).toBe(422);

    for (const body of [
      { branchId: branchIds["A1"], name: "   " },
      { branchId: branchIds["A1"], name: "C홀", baseCapacity: 0 },
      { branchId: branchIds["A1"], name: "C홀", sizeSqm: 12.5 },
      { branchId: branchIds["A1"], name: "C홀", status: "archived" },
      { name: "C홀" },
    ]) {
      const res = await create("ownerA", "A", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.json["code"]).toBe("VALIDATION_FAILED");
    }

    const academyId = academyIds["A"]!;
    const res = await CREATE(
      new Request(`${BASE}/api/academies/${academyId}/rooms`, { method: "POST", headers: headersFor("ownerA"), body: "{" }),
      { params: Promise.resolve({ academyId }) },
    );
    expect(res.status).toBe(400);
  });

  test("남의 학원 강의실·없는 강의실·모양 틀린 id 보관은 404", async () => {
    const theirs = await create("ownerB", "B", { branchId: branchIds["B1"], name: "신촌홀" });
    expect(theirs.status).toBe(201);
    expect((await archive("ownerA", "A", theirs.body!.roomId)).status).toBe(404);
    expect((await archive("ownerA", "A", randomUUID())).status).toBe(404);
    expect((await archive("ownerA", "A", "not-a-uuid")).status).toBe(404);
    const { rows } = await q("SELECT status FROM rooms WHERE id = $1", [theirs.body!.roomId]);
    expect(rows[0].status).toBe("active");
    // 학원 B 목록에는 B 의 강의실만
    expect((await list("ownerB", "B")).body?.items.map((r) => r.name)).toEqual(["신촌홀"]);
  });

  test("운영자 403 · 2단계 전 401 · 로그인 안 함 401", async () => {
    expect((await list("admin", "A")).status).toBe(403);
    const no2fa = await list("ownerNo2fa", "C");
    expect(no2fa.status).toBe(401);
    expect(no2fa.json["code"]).toBe("SECOND_FACTOR_REQUIRED");
    expect((await create(undefined, "A", { branchId: branchIds["A1"], name: "X홀" })).status).toBe(401);
  });
});
