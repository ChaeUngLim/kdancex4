// S1-1.17(등록 형태 변경 재심사) — `POST /api/academies/{academyId}/registration-change` 를 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-1-17.db.test.ts 였는데, 기능 이름(academy-registration-change)으로 바꿨다.
//   핵심(verify): 변경 신청을 내도 재심사 전 조회는 이전 형태다 — 대신 확인 전(엄격 기준, FR-087)으로 돌아간다.
//   나머지: 두 번 눌러도 신청 하나 · 다른 신청이 걸려 있으면 409 · 같은 형태·서류 규칙 422 · 남의 파일 422
//   · 다른 학원 대표 403 · 2단계 전 401 · 신청 칸 CHECK 제약.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  REGISTRATION_CHANGE_AUDIT_ACTION,
  academyRegistrationSchema,
  createRegistrationChangeRoute,
  readAcademyRegistration,
} from "@/lib/server/services/academy-registration-change";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "registration-change-test-secret-0123456789-01";
const BASE = "http://localhost:3000";

describe.skipIf(!dbAvailable())("등록 형태 변경 재심사(계약 07 §4)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let POST: ReturnType<typeof createRegistrationChangeRoute>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};

  async function makeStaff(key: string, opts: { twoFactor?: boolean } = {}) {
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
    staffIds[key] = id;
  }

  /** 입점 승인을 마친 학원(등록 형태 확인됨). 기본 형태는 fixture 의 'academy'(교육청 학원) */
  async function makeAcademy(key: string, owner: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, registration_verified_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', 'active', now(), now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], key],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
  }

  async function makeFile(owner: string, purpose = "merchant_evidence"): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO uploaded_files (id, uploader_account_id, purpose, visibility, storage_key, mime_type, size_bytes, sha256, display_name)
       VALUES ($1, $2, $3, $4, $5, 'application/pdf', 10, 'x', '증빙.pdf')`,
      [id, staffIds[owner], purpose, purpose === "merchant_evidence" ? "private" : "public", `k-${id}.pdf`],
    );
    return id;
  }

  async function change(who: string | undefined, academy: string, body: unknown) {
    const academyId = academyIds[academy] ?? academy;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    const res = await POST(
      new Request(`${BASE}/api/academies/${academyId}/registration-change`, { method: "POST", headers, body: JSON.stringify(body) }),
      { params: Promise.resolve({ academyId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: academyRegistrationSchema.parse(json), code: undefined, json };
    return { status: res.status, body: undefined, code: json["code"], json };
  }

  const auditCount = async (academy: string) =>
    (
      await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND target_id = $2", [
        REGISTRATION_CHANGE_AUDIT_ACTION,
        academyIds[academy],
      ])
    ).rows[0].n as number;

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    POST = createRegistrationChangeRoute({ db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }) });

    await makeStaff("ownerA");
    await makeStaff("ownerB");
    await makeStaff("ownerC");
    await makeStaff("ownerNo2fa", { twoFactor: false });
    await makeAcademy("A", "ownerA");
    await makeAcademy("B", "ownerB");
    await makeAcademy("C", "ownerC");
    await makeAcademy("D", "ownerNo2fa");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("변경 신청 전 — 이전 형태, 확인됨, 엄격 기준 아님, 신청 없음", async () => {
    const before = await readAcademyRegistration(handle.db, academyIds["A"]!);
    expect(before).toEqual({
      academyId: academyIds["A"],
      registrationType: "academy",
      registrationVerified: true,
      strictRefundStandard: false,
      pendingChange: null,
    });
  });

  test("재심사 전 조회는 이전 형태 — 신청은 따로 적히고 그동안 엄격 기준(FR-087)", async () => {
    const fileId = await makeFile("ownerA");
    const res = await change("ownerA", "A", { registrationType: "sports_facility", evidenceFileId: fileId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      academyId: academyIds["A"],
      registrationType: "academy",
      registrationVerified: false,
      strictRefundStandard: true,
      pendingChange: { registrationType: "sports_facility", evidenceFileId: fileId },
    });

    // 조회 함수(설정 조회·환불 공지가 쓰는 기준)도 이전 형태를 돌려준다
    const read = await readAcademyRegistration(handle.db, academyIds["A"]!);
    expect(read).toEqual(res.body);

    // DB: 정식 칸은 그대로, 확인 시각만 비었다. 서류 파일은 주인이 생겼다(정리 작업 대상 아님)
    const row = (
      await q(
        `SELECT registration_type, registration_verified_at, pending_registration_type, pending_registration_evidence_file_id,
                registration_change_requested_at FROM academies WHERE id = $1`,
        [academyIds["A"]],
      )
    ).rows[0];
    expect(row.registration_type).toBe("academy");
    expect(row.registration_verified_at).toBeNull();
    expect(row.pending_registration_type).toBe("sports_facility");
    expect(row.pending_registration_evidence_file_id).toBe(fileId);
    expect(row.registration_change_requested_at).not.toBeNull();
    const file = (await q("SELECT attached_at FROM uploaded_files WHERE id = $1", [fileId])).rows[0];
    expect(file.attached_at).not.toBeNull();

    // 감사 1행 — before 에 이전 형태·확인 여부, after 에 새 형태
    const audits = await q("SELECT actor_staff_account_id, before, after FROM audit_logs WHERE action = $1 AND target_id = $2", [
      REGISTRATION_CHANGE_AUDIT_ACTION,
      academyIds["A"],
    ]);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0].actor_staff_account_id).toBe(staffIds["ownerA"]);
    expect(audits.rows[0].before).toEqual({ registrationType: "academy", registrationVerified: true });
    expect(audits.rows[0].after).toMatchObject({ pendingRegistrationType: "sports_facility", evidenceFileId: fileId, strictRefundStandard: true });

    // 두 번 눌러도 신청은 하나 — 같은 본문 200, 감사 행도 그대로 1개
    const again = await change("ownerA", "A", { registrationType: "sports_facility", evidenceFileId: fileId });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(res.body);
    expect(await auditCount("A")).toBe(1);
  });

  test("다른 신청이 걸려 있으면 409 REGISTRATION_CHANGE_PENDING — 처음 신청을 덮어쓰지 않는다", async () => {
    const res = await change("ownerA", "A", { registrationType: "unregistered", evidenceFileId: null });
    expect(res).toMatchObject({ status: 409, code: "REGISTRATION_CHANGE_PENDING" });
    const read = await readAcademyRegistration(handle.db, academyIds["A"]!);
    expect(read?.registrationType).toBe("academy");
    expect(read?.pendingChange?.registrationType).toBe("sports_facility");
    expect(await auditCount("A")).toBe(1);
  });

  test("미등록으로 바꾸면 서류 없이 신청된다 — 이전 형태는 그대로, 엄격 기준", async () => {
    const res = await change("ownerB", "B", { registrationType: "unregistered", evidenceFileId: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      registrationType: "academy",
      registrationVerified: false,
      strictRefundStandard: true,
      pendingChange: { registrationType: "unregistered", evidenceFileId: null },
    });
  });

  test("입력 규칙 — 같은 형태 422 · 서류 빠짐 422 EVIDENCE_MISSING · 미등록에 서류 422 · 모르는 칸 422 · JSON 아님 400", async () => {
    expect(await change("ownerC", "C", { registrationType: "academy", evidenceFileId: await makeFile("ownerC") })).toMatchObject({
      status: 422,
      code: "VALIDATION_FAILED",
    });
    expect(await change("ownerC", "C", { registrationType: "tutoring_center", evidenceFileId: null })).toMatchObject({
      status: 422,
      code: "EVIDENCE_MISSING",
    });
    expect(await change("ownerC", "C", { registrationType: "unregistered", evidenceFileId: await makeFile("ownerC") })).toMatchObject({
      status: 422,
      code: "VALIDATION_FAILED",
    });
    expect(await change("ownerC", "C", { registrationType: "tutoring_center", evidenceFileId: null, extra: 1 })).toMatchObject({
      status: 422,
      code: "VALIDATION_FAILED",
    });
    const academyId = academyIds["C"]!;
    const bad = await POST(
      new Request(`${BASE}/api/academies/${academyId}/registration-change`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokens["ownerC"]}` },
        body: "not json",
      }),
      { params: Promise.resolve({ academyId }) },
    );
    expect(bad.status).toBe(400);
    // 어느 것도 학원 C 를 바꾸지 않았다
    const read = await readAcademyRegistration(handle.db, academyId);
    expect(read).toMatchObject({ registrationType: "academy", registrationVerified: true, pendingChange: null });
  });

  test("서류 파일 — 남의 파일 · 사진 용도 · 이미 붙은 파일은 모두 422(evidenceFileId)", async () => {
    const others = await makeFile("ownerB");
    const photo = await makeFile("ownerC", "academy_photo");
    const used = await makeFile("ownerC");
    await q("UPDATE uploaded_files SET attached_at = now() WHERE id = $1", [used]);
    for (const fileId of [others, photo, used, randomUUID()]) {
      const res = await change("ownerC", "C", { registrationType: "tutoring_center", evidenceFileId: fileId });
      expect(res).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
      expect(res.json["fields"]).toEqual([expect.objectContaining({ path: "evidenceFileId" })]);
    }
    expect(await auditCount("C")).toBe(0);
  });

  test("권한 — 다른 학원 대표 403 · 2단계 전 401 · 로그인 없음 401", async () => {
    const fileId = await makeFile("ownerB");
    expect(await change("ownerB", "C", { registrationType: "tutoring_center", evidenceFileId: fileId })).toMatchObject({ status: 403 });
    expect(await change("ownerNo2fa", "D", { registrationType: "unregistered", evidenceFileId: null })).toMatchObject({
      status: 401,
      code: "SECOND_FACTOR_REQUIRED",
    });
    expect(await change(undefined, "C", { registrationType: "unregistered", evidenceFileId: null })).toMatchObject({ status: 401 });
    expect(await auditCount("C")).toBe(0);
  });

  test("DB 제약 — 새 형태와 신청 시각은 함께 차거나 함께 빈다, 신청 없이 서류만 둘 수 없다", async () => {
    const id = academyIds["C"]!;
    await expect(q("UPDATE academies SET pending_registration_type = 'academy' WHERE id = $1", [id])).rejects.toThrow(
      /ck_academies_registration_change/,
    );
    await expect(q("UPDATE academies SET registration_change_requested_at = now() WHERE id = $1", [id])).rejects.toThrow(
      /ck_academies_registration_change/,
    );
    const fileId = await makeFile("ownerC");
    await expect(q("UPDATE academies SET pending_registration_evidence_file_id = $2 WHERE id = $1", [id, fileId])).rejects.toThrow(
      /ck_academies_registration_change/,
    );
    await expect(q("UPDATE academies SET pending_registration_type = 'hobby', registration_change_requested_at = now() WHERE id = $1", [id])).rejects.toThrow(
      /pending_registration_type_check/,
    );
  });
});
