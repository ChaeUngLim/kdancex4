// S2-2.8a(강사 소속 학원 홀 목록 API) — `GET /api/instructor/affiliations/{affiliationId}/rooms`(계약 11 §3-4)를
// 진짜 세션 + PostgreSQL 로 확인한다.
//   왜 필요한가: 강사 앱 수업 등록(I2)이 홀을 고르려면 이 목록이 있어야 한다. 남의 학원 홀이나 보관한 홀이 섞이면
//   고를 수 없는 홀로 등록을 시도해 422 로 끝난다.
//   확인하는 것: 내 active 소속 + class_submit 이면 그 학원의 active 홀만(지점 이름 → 홀 이름 순) · 다른 학원·보관 홀은 안 나옴
//   · 남의 소속·없는 id·모양이 틀린 id 는 404 · 대기·해제된 소속은 409 · 위임이 없거나 웹 위임(class_manage)만 있으면 403
//   · 강사 역할이 아니면 403 · 응답이 계약 스키마(strict)를 지키고 Cache-Control 에 no-store.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { affiliationRoomListSchema, createListAffiliationRoomsRoute } from "@/lib/server/services/instructor-affiliation-rooms";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 비밀값 검사가 진짜 키로 오인하지 않게 한다
const SECRET = "affiliation-rooms-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

describe.skipIf(!dbAvailable())("강사 소속 학원 홀 목록(계약 11 §3-4)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const roomIds: Record<string, string> = {};
  const affiliations: Record<string, string> = {};
  const deps = () => ({
    db: handle.db,
    getSession: (h: Headers) => auth.api.getSession({ headers: h }),
    clock: fixedClock(NOW),
  });

  async function makeStaff(key: string, roles: string[]) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
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

  async function makeAcademy(key: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `학원 ${key}`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds["owner"]]);
  }

  async function makeBranch(academy: string, name: string) {
    const id = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, $3, '서울 강남구 1', '서울', '강남구', now())",
      [id, academyIds[academy], name],
    );
    return id;
  }

  async function makeRoom(key: string, branch: string, name: string, status: "active" | "archived" = "active") {
    roomIds[key] = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, $3, $4, now())", [roomIds[key], branch, name, status]);
  }

  /** 소속 한 줄과 위임들을 DB 로 바로 만든다(신청·승인 경로는 다른 Task 가 본다) */
  async function affiliate(key: string, academy: string, instructor: string, status: string, permissions: string[]) {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, released_at, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'application', now(),
               CASE WHEN $3 IN ('active','released') THEN now() END,
               CASE WHEN $3 = 'released' THEN now() END, now())
       RETURNING id`,
      [academyIds[academy], staffIds[instructor], status],
    );
    affiliations[key] = (rows[0] as { id: string }).id;
    for (const permission of permissions) {
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        affiliations[key],
        permission,
        staffIds["owner"],
      ]);
    }
  }

  /** 앱(Bearer)으로 목록을 부른다 */
  const listRooms = (who: string, affiliationId: string) =>
    createListAffiliationRoomsRoute(deps())(
      new Request(`${BASE}/api/instructor/affiliations/${affiliationId}/rooms`, { headers: { authorization: `Bearer ${tokens[who]}` } }),
      { params: Promise.resolve({ id: affiliationId }) },
    );

  async function expectError(res: Response, status: number, code: string) {
    expect(res.status).toBe(status);
    expect(((await res.json()) as { code: string }).code).toBe(code);
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("iu", ["instructor"]);
    await makeStaff("other", ["instructor"]);
    for (const k of ["A", "B", "C", "D", "E", "F"]) await makeAcademy(k);

    // 학원 A: 지점 둘(본점·강남점), 홀 셋 + 보관한 홀 하나. 학원 B: 다른 학원의 홀
    const aMain = await makeBranch("A", "본점");
    const aGangnam = await makeBranch("A", "강남점");
    await makeRoom("A-main-B", aMain, "B홀");
    await makeRoom("A-main-A", aMain, "A홀");
    await makeRoom("A-gangnam-A", aGangnam, "A홀");
    await makeRoom("A-main-old", aMain, "옛홀", "archived");
    await makeRoom("B-main-A", await makeBranch("B", "본점"), "A홀");

    await affiliate("mine", "A", "iu", "active", ["class_submit"]); // 정상
    await affiliate("others", "B", "other", "active", ["class_submit"]); // 남의 소속
    await affiliate("pending", "C", "iu", "pending", []); // 승인 대기
    await affiliate("released", "D", "iu", "released", ["class_submit"]); // 해제됨
    await affiliate("noDelegation", "E", "iu", "active", []); // 위임 없음
    await affiliate("webOnly", "F", "iu", "active", ["class_manage", "roster_manage"]); // 웹 위임만
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("내 active 소속 + class_submit 이면 그 학원의 active 홀만, 지점 이름 → 홀 이름 순 — 다른 학원·보관 홀은 안 나온다", async () => {
    const res = await listRooms("iu", affiliations["mine"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = affiliationRoomListSchema.parse(await res.json());

    // 글자 번호 순: 「강남점」(U+AC15) < 「본점」(U+BCF8)
    expect(body.items).toEqual([
      { roomId: roomIds["A-gangnam-A"], branchName: "강남점", name: "A홀" },
      { roomId: roomIds["A-main-A"], branchName: "본점", name: "A홀" },
      { roomId: roomIds["A-main-B"], branchName: "본점", name: "B홀" },
    ]);
    const ids = body.items.map((i) => i.roomId);
    expect(ids).not.toContain(roomIds["A-main-old"]); // 보관한 홀
    expect(ids).not.toContain(roomIds["B-main-A"]); // 다른 학원 홀
  });

  test("남의 소속·없는 id·uuid 가 아닌 id 는 모두 같은 404 NOT_FOUND — 남의 소속이 있는지 드러내지 않는다", async () => {
    await expectError(await listRooms("iu", affiliations["others"]), 404, "NOT_FOUND");
    await expectError(await listRooms("iu", randomUUID()), 404, "NOT_FOUND");
    await expectError(await listRooms("iu", "not-a-uuid"), 404, "NOT_FOUND");
    // 대표도 남의(강사) 소속을 이 경로로 읽지 못한다 — 강사 역할이 아니라 403
    await expectError(await listRooms("owner", affiliations["mine"]), 403, "FORBIDDEN");
  });

  test("소속이 active 가 아니면 409 AFFILIATION_STATE_CONFLICT — 승인 대기·해제됨 둘 다(해제 전 위임이 남아 있어도)", async () => {
    await expectError(await listRooms("iu", affiliations["pending"]), 409, "AFFILIATION_STATE_CONFLICT");
    await expectError(await listRooms("iu", affiliations["released"]), 409, "AFFILIATION_STATE_CONFLICT");
  });

  test("앱 위임 class_submit 이 꺼져 있으면 403 FORBIDDEN — 위임이 없거나 웹 위임(class_manage)만 있어도", async () => {
    await expectError(await listRooms("iu", affiliations["noDelegation"]), 403, "FORBIDDEN");
    await expectError(await listRooms("iu", affiliations["webOnly"]), 403, "FORBIDDEN");
  });

  test("대표가 위임을 끄면 바로 다음 요청부터 403, 다시 켜면 200 — 매 요청 DB 에서 읽는다", async () => {
    await q("DELETE FROM instructor_delegations WHERE affiliation_id = $1 AND permission = 'class_submit'", [affiliations["mine"]]);
    await expectError(await listRooms("iu", affiliations["mine"]), 403, "FORBIDDEN");
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_submit', $2)", [
      affiliations["mine"],
      staffIds["owner"],
    ]);
    expect((await listRooms("iu", affiliations["mine"])).status).toBe(200);
  });

  test("홀이 하나도 없는 학원이면 빈 목록 200 — 화면이 「홀이 없어요」를 그릴 수 있게", async () => {
    await q("UPDATE rooms SET status = 'archived' WHERE branch_id IN (SELECT id FROM academy_branches WHERE academy_id = $1)", [
      academyIds["A"],
    ]);
    const res = await listRooms("iu", affiliations["mine"]);
    expect(res.status).toBe(200);
    expect(affiliationRoomListSchema.parse(await res.json())).toEqual({ items: [] });
  });
});
