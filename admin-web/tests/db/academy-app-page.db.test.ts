// S1-1.20(학원 앱 페이지 API) — `PUT /api/academies/{academyId}/app-page` 를 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-1-20.db.test.ts 였는데, 기능 이름(academy-app-page)으로 바꿨다.
//   핵심(verify): 사진 id 를 최대 10장까지 순서대로 저장하고, 11장이면 422 이며 아무것도 바뀌지 않는다.
//   나머지: 전체 교체(빠진 사진은 자리 행이 지워지고 attached_at 이 비워진다) · 같은 사진 두 번·남의 사진·증빙 파일·없는 파일 422
//   · 다른 학원 대표·운영자 403 · 2단계 전·로그인 안 함 401 · 붙은 사진은 그 학원 대표가 내려받을 수 있다.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { academyAppPageResponseSchema, createAcademyAppPageRoute } from "@/lib/server/services/academy-app-page";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "academy-app-page-test-secret-0123456789-0123";
const BASE = "http://localhost:3000";

describe.skipIf(!dbAvailable())("학원 앱 페이지(계약 07 §4)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let PUT: ReturnType<typeof createAcademyAppPageRoute>;
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

  async function makeAcademy(key: string, owner: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, registration_verified_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', 'active', now(), now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `${key} 학원`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
  }

  /** 아직 어디에도 안 붙은 파일 한 장(기본은 학원 사진) */
  async function makeFile(owner: string, purpose = "academy_photo"): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO uploaded_files (id, uploader_account_id, purpose, visibility, storage_key, mime_type, size_bytes, sha256, display_name)
       VALUES ($1, $2, $3, $4, $5, 'image/png', 10, 'x', '강의실.png')`,
      [id, staffIds[owner], purpose, purpose === "merchant_evidence" ? "private" : "public", `k-${id}.png`],
    );
    return id;
  }
  const makeFiles = async (owner: string, n: number) => Promise.all(Array.from({ length: n }, () => makeFile(owner)));

  async function put(who: string | undefined, academy: string, body: unknown) {
    const academyId = academyIds[academy] ?? academy;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    const res = await PUT(
      new Request(`${BASE}/api/academies/${academyId}/app-page`, { method: "PUT", headers, body: JSON.stringify(body) }),
      { params: Promise.resolve({ academyId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: academyAppPageResponseSchema.parse(json), json, res };
    return { status: res.status, body: undefined, json, res };
  }

  async function photoRows(academy: string): Promise<string[]> {
    const { rows } = await q("SELECT file_id FROM academy_photos WHERE academy_id = $1 ORDER BY position", [academyIds[academy]]);
    return rows.map((r: { file_id: string }) => r.file_id);
  }
  async function attachedAt(fileId: string): Promise<unknown> {
    const { rows } = await q("SELECT attached_at FROM uploaded_files WHERE id = $1", [fileId]);
    return rows[0]?.attached_at;
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    PUT = createAcademyAppPageRoute({ db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }) });

    await makeStaff("ownerA");
    await makeStaff("ownerB");
    await makeStaff("ownerNo2fa", { twoFactor: false });
    await makeStaff("admin", { roles: ["admin"] });
    await makeAcademy("A", "ownerA");
    await makeAcademy("B", "ownerB");
    await makeAcademy("C", "ownerNo2fa");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("10장까지 배열 순서대로 저장 — 소개 글은 앞뒤 공백을 지우고, 사진에 주인 표시가 찍힌다", async () => {
    const files = await makeFiles("ownerA", 10);
    const res = await put("ownerA", "A", { tagline: "  홍대 살사 바차타  ", intro: "초보 환영 · 매주 소셜", photoFileIds: files });
    expect(res.status).toBe(200);
    expect(res.res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.body).toEqual({ academyId: academyIds["A"], tagline: "홍대 살사 바차타", intro: "초보 환영 · 매주 소셜", photoFileIds: files });
    expect(await photoRows("A")).toEqual(files);
    for (const id of files) expect(await attachedAt(id)).not.toBeNull();
    const { rows } = await q("SELECT tagline, intro FROM academies WHERE id = $1", [academyIds["A"]]);
    expect(rows[0]).toEqual({ tagline: "홍대 살사 바차타", intro: "초보 환영 · 매주 소셜" });
  });

  test("verify: 11장이면 422 VALIDATION_FAILED(photoFileIds) 이고 저장된 사진·글은 그대로", async () => {
    const before = await photoRows("A");
    const files = await makeFiles("ownerA", 11);
    const res = await put("ownerA", "A", { tagline: "바뀌면 안 됨", intro: null, photoFileIds: files });
    expect(res.status).toBe(422);
    expect(res.json["code"]).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(res.json)).toContain("photoFileIds");
    expect(await photoRows("A")).toEqual(before);
    for (const id of files) expect(await attachedAt(id)).toBeNull();
    const { rows } = await q("SELECT tagline FROM academies WHERE id = $1", [academyIds["A"]]);
    expect(rows[0].tagline).toBe("홍대 살사 바차타");
  });

  test("전체 교체 — 순서를 바꾸고 일부를 빼면 빠진 사진은 자리 행이 지워지고 attached_at 이 비워진다, 빈 글은 null", async () => {
    const current = await photoRows("A");
    const fresh = await makeFile("ownerA");
    const next = [current[3]!, fresh, current[0]!];
    const res = await put("ownerA", "A", { tagline: "", intro: "   ", photoFileIds: next });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ academyId: academyIds["A"], tagline: null, intro: null, photoFileIds: next });
    expect(await photoRows("A")).toEqual(next);
    for (const id of next) expect(await attachedAt(id)).not.toBeNull();
    const dropped = current.filter((id) => !next.includes(id));
    expect(dropped).toHaveLength(8);
    for (const id of dropped) expect(await attachedAt(id)).toBeNull();
    // 0장도 된다
    const empty = await put("ownerA", "A", { tagline: null, intro: null, photoFileIds: [] });
    expect(empty.status).toBe(200);
    expect(await photoRows("A")).toEqual([]);
    for (const id of next) expect(await attachedAt(id)).toBeNull();
  });

  test("쓸 수 없는 사진은 422 photoFileIds.N — 같은 사진 두 번 · 남의 사진 · 다른 학원에 걸린 사진 · 증빙 파일 · 없는 파일", async () => {
    const mine = await makeFile("ownerA");
    const dup = await put("ownerA", "A", { tagline: null, intro: null, photoFileIds: [mine, mine] });
    expect(dup.status).toBe(422);

    const othersFile = await makeFile("ownerB");
    const others = await put("ownerA", "A", { tagline: null, intro: null, photoFileIds: [mine, othersFile] });
    expect(others.status).toBe(422);
    expect(JSON.stringify(others.json)).toContain("photoFileIds.1");

    // 학원 B 에 걸린 사진을 학원 B 대표가 올렸어도, 학원 A 로는 가져올 수 없다
    const bPhoto = await makeFile("ownerB");
    expect((await put("ownerB", "B", { tagline: null, intro: null, photoFileIds: [bPhoto] })).status).toBe(200);
    expect((await put("ownerA", "A", { tagline: null, intro: null, photoFileIds: [bPhoto] })).status).toBe(422);

    const evidence = await makeFile("ownerA", "merchant_evidence");
    const ev = await put("ownerA", "A", { tagline: null, intro: null, photoFileIds: [evidence] });
    expect(ev.status).toBe(422);
    expect(JSON.stringify(ev.json)).toContain("photoFileIds.0");

    expect((await put("ownerA", "A", { tagline: null, intro: null, photoFileIds: [randomUUID()] })).status).toBe(422);
    expect((await put("ownerA", "A", { tagline: null, intro: null, photoFileIds: ["not-a-uuid"] })).status).toBe(422);
    // 칸을 빠뜨리거나 모르는 칸 · 너무 긴 한 줄 소개
    expect((await put("ownerA", "A", { tagline: null, photoFileIds: [] })).status).toBe(422);
    expect((await put("ownerA", "A", { tagline: null, intro: null, photoFileIds: [], extra: 1 })).status).toBe(422);
    expect((await put("ownerA", "A", { tagline: "가".repeat(61), intro: null, photoFileIds: [] })).status).toBe(422);

    expect(await photoRows("A")).toEqual([]);
    expect(await attachedAt(mine)).toBeNull();
    expect(await photoRows("B")).toEqual([bPhoto]);
  });

  test("권한 — 다른 학원 대표·운영자 403, 2단계 전 401 SECOND_FACTOR_REQUIRED, 로그인 안 함 401", async () => {
    const body = { tagline: null, intro: null, photoFileIds: [] };
    expect((await put("ownerB", "A", body)).status).toBe(403);
    expect((await put("admin", "A", body)).status).toBe(403);
    const no2fa = await put("ownerNo2fa", "C", body);
    expect(no2fa.status).toBe(401);
    expect(no2fa.json["code"]).toBe("SECOND_FACTOR_REQUIRED");
    expect((await put(undefined, "A", body)).status).toBe(401);
  });

  test("DB 유니크 — 한 파일은 한 자리에만(uq_academy_photos_file)", async () => {
    const file = await makeFile("ownerA");
    await q("INSERT INTO academy_photos (academy_id, file_id, position) VALUES ($1, $2, 0)", [academyIds["A"], file]);
    await expect(
      q("INSERT INTO academy_photos (academy_id, file_id, position) VALUES ($1, $2, 1)", [academyIds["A"], file]),
    ).rejects.toThrow(/uq_academy_photos_file/);
    await q("DELETE FROM academy_photos WHERE academy_id = $1", [academyIds["A"]]);
  });
});
