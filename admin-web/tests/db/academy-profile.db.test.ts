// S1-1.19(학원 정보·판매자 정보 수정 API) — `PATCH /api/academies/{academyId}/profile` 를 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-1-19.db.test.ts 였는데, 기능 이름(academy-profile)으로 바꿨다.
//   핵심(verify): 판매자 항목을 바꾸면 감사 `academy.seller_info_changed` 가 정확히 1행 남는다(바뀐 칸만 전후로).
//   나머지: 지점 정보 수정(보낸 칸만, null 은 지움) · 같은 값 재전송은 감사 0 · 등록 형태·사업자등록번호는 422(열린 점 ③)
//   · 남의 지점 id 는 422 이고 같은 요청의 판매자 변경도 되돌아간다 · 다른 학원 대표·운영자 403 · 2단계 전·로그인 안 함 401.
import { randomBytes, randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createFieldCipher } from "@/lib/server/field-encryption";
import { createAcademyProfileRoute, SELLER_INFO_CHANGED_AUDIT_ACTION } from "@/lib/server/services/academy-profile";
import { academySettingsResponseSchema } from "@/lib/server/services/academy-settings";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "academy-profile-test-secret-0123456789-01234";
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T00:00:00Z");

describe.skipIf(!dbAvailable())("학원 정보·판매자 정보 수정(계약 07 §4)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let PATCH: ReturnType<typeof createAcademyProfileRoute>;
  const cipher = createFieldCipher(randomBytes(32).toString("base64"));
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

  /** 입점 승인을 마친 학원 + 대표 연결 + 지점 하나 */
  async function makeAcademy(key: string, owner: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, registration_verified_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', 'active', now(), now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `${key} 학원`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
    branchIds[key] = randomUUID();
    await q(
      `INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, phone, opening_hours, facilities, updated_at)
       VALUES ($1, $2, '본점', '서울 마포구 테스트로 1', '서울', '마포구', '020000000', '평일 14:00~23:00', '마루 · 거울', now())`,
      [branchIds[key], academyIds[key]],
    );
  }

  async function patch(who: string | undefined, academy: string, body: unknown) {
    const academyId = academyIds[academy] ?? academy;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    const res = await PATCH(
      new Request(`${BASE}/api/academies/${academyId}/profile`, { method: "PATCH", headers, body: JSON.stringify(body) }),
      { params: Promise.resolve({ academyId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: academySettingsResponseSchema.parse(json), code: undefined, json, res };
    return { status: res.status, body: undefined, code: json["code"], json, res };
  }

  async function sellerAudits(academy: string) {
    const { rows } = await q(
      "SELECT actor_staff_account_id, before, after FROM audit_logs WHERE action = $1 AND target_id = $2 ORDER BY id",
      [SELLER_INFO_CHANGED_AUDIT_ACTION, academyIds[academy]],
    );
    return rows as { actor_staff_account_id: string; before: Record<string, unknown>; after: Record<string, unknown> }[];
  }

  async function sellerRow(academy: string) {
    const { rows } = await q(
      "SELECT business_name, representative_name, business_address, phone, mail_order_report_number, business_registration_number, registration_type FROM academies WHERE id = $1",
      [academyIds[academy]],
    );
    return rows[0] as Record<string, string | null>;
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    PATCH = createAcademyProfileRoute({
      db: handle.db,
      getSession: (headers: Headers) => auth.api.getSession({ headers }),
      fieldCipher: cipher,
      clock: fixedClock(NOW),
    });

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

  test("지점 정보 수정 — 보낸 칸만 바뀌고 null 은 지움, 판매자를 안 건드리면 감사 0행", async () => {
    const res = await patch("ownerA", "A", {
      branches: [
        {
          branchId: branchIds["A"],
          address: "  서울 마포구 새주소로 9  ",
          openingHours: "평일 15:00~23:00 · 토 12:00~20:00",
          parking: "건물 지하 2시간 무료",
          accessibility: "엘리베이터 있음",
          facilities: null,
          phone: "02-111-2222",
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.res.headers.get("cache-control")).toBe("private, no-store");
    // 응답은 설정 조회와 같은 본문 — 화면이 다시 불러오지 않고 바로 그린다
    expect(res.body!.branches).toEqual([
      {
        branchId: branchIds["A"],
        name: "본점",
        address: "서울 마포구 새주소로 9",
        region: { sido: "서울", gu: "마포구" },
        phone: "021112222",
        openingHours: "평일 15:00~23:00 · 토 12:00~20:00",
        facilities: null,
        parking: "건물 지하 2시간 무료",
        accessibility: "엘리베이터 있음",
      },
    ]);
    expect(await sellerAudits("A")).toHaveLength(0);

    // 안 보낸 칸은 그대로 — 주차만 바꿔도 운영시간·접근성이 지워지지 않는다
    const again = await patch("ownerA", "A", { branches: [{ branchId: branchIds["A"], parking: "주차 불가" }] });
    expect(again.body!.branches[0]).toMatchObject({
      parking: "주차 불가",
      openingHours: "평일 15:00~23:00 · 토 12:00~20:00",
      accessibility: "엘리베이터 있음",
    });
  });

  test("verify — 판매자 항목을 바꾸면 감사 1행(바뀐 칸만 전후로), 같은 값을 다시 보내면 감사가 늘지 않는다", async () => {
    const res = await patch("ownerA", "A", {
      seller: { businessName: "라틴하우스 상호", phone: "02-333-4444", businessAddress: "서울 마포구 테스트로 1" /* 지금과 같은 값 */ },
    });
    expect(res.status).toBe(200);
    expect(res.body!.seller).toMatchObject({ businessName: "라틴하우스 상호", phone: "023334444", businessAddress: "서울 마포구 테스트로 1" });

    const audits = await sellerAudits("A");
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_staff_account_id).toBe(staffIds["ownerA"]);
    expect(audits[0].before).toEqual({ businessName: "테스트 상호", phone: "02-000-0000" });
    expect(audits[0].after).toEqual({ businessName: "라틴하우스 상호", phone: "023334444" });

    // 같은 값 재전송 → 200, 감사 그대로 1행
    const same = await patch("ownerA", "A", { seller: { businessName: "라틴하우스 상호", phone: "023334444" } });
    expect(same.status).toBe(200);
    expect(await sellerAudits("A")).toHaveLength(1);

    // 통신판매업 신고번호는 채웠다가 비울 수 있다 — 각각 감사 1행씩
    await patch("ownerA", "A", { seller: { mailOrderReportNumber: "2026-서울마포-0001" } });
    const cleared = await patch("ownerA", "A", { seller: { mailOrderReportNumber: "" } });
    expect(cleared.body!.seller.mailOrderReportNumber).toBeNull();
    const all = await sellerAudits("A");
    expect(all).toHaveLength(3);
    expect(all[2].before).toEqual({ mailOrderReportNumber: "2026-서울마포-0001" });
    expect(all[2].after).toEqual({ mailOrderReportNumber: null });
  });

  test("못 바꾸는 칸·틀린 값은 422 이고 DB 가 그대로다(등록 형태 — 열린 점 ③ · 사업자등록번호 · 빈 상호)", async () => {
    const before = await sellerRow("A");
    const auditsBefore = (await sellerAudits("A")).length;
    for (const body of [
      { registrationType: "sports_facility" },
      { seller: { businessRegistrationNumber: "9999999999" } },
      { seller: { businessName: "   " } },
      { seller: { phone: "abc" } },
      { branches: [{ branchId: branchIds["A"], name: "새 이름" }] },
      { branches: [{ branchId: branchIds["A"] }, { branchId: branchIds["A"] }] },
    ]) {
      const res = await patch("ownerA", "A", body);
      expect([res.status, res.code]).toEqual([422, "VALIDATION_FAILED"]);
    }
    expect(await sellerRow("A")).toEqual(before);
    expect(await sellerAudits("A")).toHaveLength(auditsBefore);
  });

  test("남의 학원 지점 id 는 422 — 같은 요청의 판매자 변경과 감사도 함께 되돌아간다", async () => {
    const before = await sellerRow("A");
    const auditsBefore = (await sellerAudits("A")).length;
    const res = await patch("ownerA", "A", {
      seller: { representativeName: "바뀌면 안 되는 이름" },
      branches: [{ branchId: branchIds["B"], parking: "남의 지점" }],
    });
    expect([res.status, res.code]).toEqual([422, "VALIDATION_FAILED"]);
    expect(res.json["fields"]).toEqual([{ path: "branches.0.branchId", message: "이 학원의 지점이 아니에요" }]);
    expect(await sellerRow("A")).toEqual(before);
    expect(await sellerAudits("A")).toHaveLength(auditsBefore);
    const { rows } = await q("SELECT parking FROM academy_branches WHERE id = $1", [branchIds["B"]]);
    expect(rows[0].parking).toBeNull();
  });

  test("권한 — 다른 학원 대표·운영자 403, 2단계 전·로그인 안 함 401, 아무것도 바뀌지 않는다", async () => {
    const before = await sellerRow("A");
    const body = { seller: { businessName: "침입" } };
    expect((await patch("ownerB", "A", body)).status).toBe(403);
    expect((await patch("admin", "A", body)).status).toBe(403);
    const no2fa = await patch("ownerNo2fa", "C", body);
    expect([no2fa.status, no2fa.code]).toEqual([401, "SECOND_FACTOR_REQUIRED"]);
    expect((await patch(undefined, "A", body)).status).toBe(401);
    expect(await sellerRow("A")).toEqual(before);
    expect(await sellerAudits("C")).toHaveLength(0);
  });
});
