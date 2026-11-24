// S2-2.8(수업 포스터 올리기) — 포스터 파일을 올려 수업에 붙이고, 상세 응답에 주소가 나오는지 진짜 세션 + PostgreSQL 로 확인한다.
//   계약: _workspace/03_contracts/11-instructor.md §4-6(포스터) · 07 §1(파일 올리기)
//   verify 의 이름은 tests/db/s2-2-8.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① verify: 강사가 포스터를 올리고(2단계 없이, 공개) 수업에 붙이면 상세 응답의 posterUrl 에 주소가 있다 + 감사 class.updated
//   ② 승인 대기 중에도 바로 바뀐다(「바로 바뀌는 값」) — 옛 포스터는 「주인 없음」으로 돌아가고, 같은 값을 두 번 보내도 기록은 한 줄
//   ③ 대표가 떼면(null) posterUrl 이 null
//   ④ 거부: 남이 올린 파일 · 다른 목적 파일 · 다른 수업에 붙은 파일 · 없는 파일 422 · PDF 포스터 422 · 남의 수업 403 · 모르는 칸 422
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { LocalDiskFileStorage } from "@/lib/server/adapters/local-disk-file-storage";
import { classPosterResponseSchema, createClassPosterRoute } from "@/lib/server/services/class-poster";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createUploadFileRoute, uploadFileResponseSchema } from "@/lib/server/services/file-upload";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "class-poster-test-secret-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from("수업 포스터")]);
const PDF = new Uint8Array([...Buffer.from("%PDF-1.7 포스터")]);

describe.skipIf(!dbAvailable())("수업 포스터 올리기(계약 11 §4-6)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let storageDir: string;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const roomIds: Record<string, string> = {};

  const deps = () => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: fixedClock(NOW) });
  const classes = () => createClassRegistrationRoutes(deps());
  const poster = () => createClassPosterRoute(deps());

  async function makeStaff(key: string, roles: string[], genre?: string) {
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
      `강사 ${key}`,
    ]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    if (genre !== undefined) {
      await q(
        "INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, $2, now(), now())",
        [id, genre],
      );
    }
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
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '서울 강남구 1', '서울', '강남구', now())",
      [branch, academyIds[key]],
    );
    roomIds[key] = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomIds[key], branch]);
    await q("INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body) VALUES (uuidv7(), $1, 'regular', 1, '공지')", [
      academyIds[key],
    ]);
  }

  async function affiliate(academy: string, instructor: string, permissions: string[]) {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyIds[academy], staffIds[instructor]],
    );
    for (const p of permissions) {
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        (rows[0] as { id: string }).id,
        p,
        staffIds["owner"],
      ]);
    }
  }

  const bearer = (who: string) => ({ authorization: `Bearer ${tokens[who]}` });

  /** 정규 수업 하나를 임시 저장한다. startTime 을 달리해 같은 강사의 수업끼리 겹치지 않게 한다 */
  async function createClass(who: string, startTime: string, endTime: string) {
    const body = {
      academyId: academyIds["A"],
      classKind: "regular",
      title: `쌈바(입문) ${startTime}`,
      genre: "dance_sport",
      subGenre: "latin",
      discipline: "samba",
      targetLevel: "entry",
      targetAges: ["all"],
      roomId: roomIds["A"],
      priceAmount: 300000,
      schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime, endTime, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
      capacity: { mode: "gender_split", male: 6, female: 6 },
      refundDeadlineOn: null,
      introText: null,
      instructorAccountId: null,
    };
    const res = await classes().create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: { ...bearer(who), "content-type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify(body),
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    return classRegistrationSchema.parse(await res.json());
  }

  async function upload(who: string, purpose: string, bytes: Uint8Array<ArrayBuffer>, name: string, type: string) {
    const form = new FormData();
    form.set("purpose", purpose);
    form.set("file", new File([bytes], name, { type }));
    const route = createUploadFileRoute({ ...deps(), fileStorage: new LocalDiskFileStorage({ rootDir: storageDir }) });
    const res = await route(new Request(`${BASE}/api/files`, { method: "POST", headers: bearer(who), body: form }), undefined);
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status !== 201) return { status: res.status, code: json["code"] as string, fileId: "", visibility: "" };
    const body = uploadFileResponseSchema.parse(json);
    return { status: 201, code: "", fileId: body.fileId, visibility: body.visibility };
  }
  const uploadPoster = (who: string) => upload(who, "poster", PNG, "포스터.png", "image/png");

  async function putPoster(who: string, classId: string, body: unknown) {
    const res = await poster()(
      new Request(`${BASE}/api/classes/${classId}/poster`, {
        method: "PUT",
        headers: { ...bearer(who), "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ classId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function readClass(who: string, classId: string) {
    const res = await classes().read(new Request(`${BASE}/api/classes/${classId}`, { headers: bearer(who) }), {
      params: Promise.resolve({ classId }),
    });
    expect(res.status).toBe(200);
    return classRegistrationSchema.parse(await res.json());
  }

  const attachedAt = async (fileId: string) =>
    ((await q("SELECT attached_at FROM uploaded_files WHERE id = $1", [fileId])).rows[0] as { attached_at: Date | null }).attached_at;
  const posterAudits = async (classId: string) =>
    (
      await q(
        "SELECT actor_role, before::text AS before, after::text AS after FROM audit_logs WHERE target_id = $1 AND action = 'class.updated' ORDER BY id",
        [classId],
      )
    ).rows as { actor_role: string; before: string; after: string }[];

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    storageDir = await mkdtemp(join(tmpdir(), "kdance-class-poster-"));

    await makeStaff("owner", ["owner"]);
    await makeStaff("junho", ["instructor"], "dance_sport");
    await makeStaff("mina", ["instructor"], "dance_sport");
    await makeAcademy("A");
    await affiliate("A", "junho", ["class_submit"]);
    await affiliate("A", "mina", ["class_submit"]);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
    await rm(storageDir, { recursive: true, force: true });
  });

  test("① verify: 포스터를 붙인 뒤 상세 응답에 주소가 있다(강사 앱 · 2단계 없이 · 공개 파일)", async () => {
    const draft = await createClass("junho", "18:00", "19:00");
    expect(draft.posterUrl).toBeNull();

    // 강사 앱(Bearer, 2단계 없음)에서 올린다 — 회원 화면에 보이는 그림이라 공개
    const file = await uploadPoster("junho");
    expect(file).toMatchObject({ status: 201, visibility: "public" });
    expect(await attachedAt(file.fileId)).toBeNull();

    const put = await putPoster("junho", draft.classId, { fileId: file.fileId });
    expect(put.status).toBe(200);
    expect(classPosterResponseSchema.parse(put.body)).toEqual({ classId: draft.classId, posterUrl: `/api/files/${file.fileId}` });

    // 상세 응답에 같은 주소가 있다 · 상태는 그대로 임시 저장 · 파일은 「주인 있음」
    const detail = await readClass("junho", draft.classId);
    expect(detail.posterUrl).toBe(`/api/files/${file.fileId}`);
    expect(detail.status).toBe("draft");
    expect(await attachedAt(file.fileId)).not.toBeNull();
    // 대표도 같은 주소를 본다
    expect((await readClass("owner", draft.classId)).posterUrl).toBe(`/api/files/${file.fileId}`);
    // 감사 class.updated 1줄(강사가 바꿈)
    const audits = await posterAudits(draft.classId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_role: "instructor" });
    expect(JSON.parse(audits[0]!.after)).toEqual({ posterFileId: file.fileId });
  });

  test("② 승인 대기 중에도 바로 바뀐다 · 옛 포스터는 주인 없음으로 · 같은 값 두 번이면 기록 한 줄", async () => {
    const draft = await createClass("junho", "10:00", "11:00");
    const first = await uploadPoster("junho");
    expect((await putPoster("junho", draft.classId, { fileId: first.fileId })).status).toBe(200);

    const submitted = await classes().submit(
      new Request(`${BASE}/api/classes/${draft.classId}/submit`, {
        method: "POST",
        headers: { ...bearer("junho"), "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ classId: draft.classId }) },
    );
    expect(submitted.status).toBe(200);
    expect((await readClass("junho", draft.classId)).status).toBe("pending_approval");

    // 승인 대기 중 — 가격·일정 고치기(PUT /api/classes/{id})는 409 이지만 포스터는 승인 없이 바뀐다
    const second = await uploadPoster("junho");
    const changed = await putPoster("junho", draft.classId, { fileId: second.fileId });
    expect(changed.status).toBe(200);
    const detail = await readClass("junho", draft.classId);
    expect(detail.posterUrl).toBe(`/api/files/${second.fileId}`);
    expect(detail.status).toBe("pending_approval");
    expect(await attachedAt(first.fileId)).toBeNull();
    expect(await attachedAt(second.fileId)).not.toBeNull();

    // 같은 값을 다시 보내도 200 · 감사는 늘지 않는다(붙이기 2번 = 2줄)
    expect((await putPoster("junho", draft.classId, { fileId: second.fileId })).status).toBe(200);
    expect(await posterAudits(draft.classId)).toHaveLength(2);
  });

  test("③ 대표가 떼면(null) posterUrl 이 null · 감사는 대표 이름으로", async () => {
    const draft = await createClass("junho", "14:00", "15:00");
    const file = await uploadPoster("junho");
    expect((await putPoster("junho", draft.classId, { fileId: file.fileId })).status).toBe(200);

    const cleared = await putPoster("owner", draft.classId, { fileId: null });
    expect(cleared.status).toBe(200);
    expect(classPosterResponseSchema.parse(cleared.body)).toEqual({ classId: draft.classId, posterUrl: null });
    expect((await readClass("junho", draft.classId)).posterUrl).toBeNull();
    expect(await attachedAt(file.fileId)).toBeNull();
    const audits = await posterAudits(draft.classId);
    expect(audits.at(-1)).toMatchObject({ actor_role: "owner" });
    expect(JSON.parse(audits.at(-1)!.after)).toEqual({ posterFileId: null });
  });

  test("④ 거부: 남의 파일 · 다른 목적 · 다른 수업에 붙은 파일 · 없는 파일 422 · PDF 422 · 남의 수업 403 · 모르는 칸 422", async () => {
    const mine = await createClass("junho", "07:00", "08:00");
    const other = await createClass("junho", "08:30", "09:30");
    const minasClass = await createClass("mina", "12:00", "13:00");

    const expect422 = async (body: unknown) => {
      const res = await putPoster("junho", mine.classId, body);
      expect(res.status).toBe(422);
      expect(res.body["code"]).toBe("VALIDATION_FAILED");
    };

    // 남이 올린 포스터
    const minasFile = await uploadPoster("mina");
    await expect422({ fileId: minasFile.fileId });
    // 다른 목적(프로필 사진)
    const photo = await upload("junho", "instructor_photo", PNG, "사진.png", "image/png");
    expect(photo.status).toBe(201);
    await expect422({ fileId: photo.fileId });
    // 다른 수업에 이미 붙은 포스터
    const used = await uploadPoster("junho");
    expect((await putPoster("junho", other.classId, { fileId: used.fileId })).status).toBe(200);
    await expect422({ fileId: used.fileId });
    // 없는 파일 · 모르는 칸 · fileId 모양 틀림
    await expect422({ fileId: randomUUID() });
    await expect422({ fileId: null, posterUrl: "https://evil.example/x.png" });
    await expect422({ fileId: "not-a-uuid" });
    // 포스터는 그림만 — PDF 는 올릴 때 거부
    const pdf = await upload("junho", "poster", PDF, "포스터.pdf", "application/pdf");
    expect(pdf).toMatchObject({ status: 422, code: "FILE_TYPE_NOT_ALLOWED" });

    // 남의 수업(같은 학원 다른 강사가 올린 수업) — 403
    const forbidden = await putPoster("junho", minasClass.classId, { fileId: null });
    expect(forbidden.status).toBe(403);
    // 거부된 요청은 아무것도 바꾸지 않았다
    expect((await readClass("junho", mine.classId)).posterUrl).toBeNull();
    expect(await posterAudits(mine.classId)).toHaveLength(0);
  });
});
