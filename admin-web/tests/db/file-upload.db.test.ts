// S1-1.6(파일 올리기 API) — `POST /api/files`(계약 07 §1)를 진짜 Better Auth 세션 + 진짜 PostgreSQL + 임시 폴더 디스크로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-1-6.db.test.ts 였는데, 기능 이름(file-upload)으로 바꿨다.
//   핵심 두 가지(verify):
//     ① PDF 확장자를 단 실행 파일은 422 FILE_TYPE_NOT_ALLOWED — 표에도 디스크에도 아무것도 남지 않는다
//     ② 정상 파일은 201 + fileId. 응답이 계약 모양이고, 표 1행과 디스크 바이트가 같다
//   나머지: 사진은 public·증빙은 private · 10MB 초과 422 · purpose 오류·파일 없음 422 · 세션 없음 401
//   · 2단계 전 401 · 회원 계정 403 · 올린 이름의 경로 부분은 버린다.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { LocalDiskFileStorage } from "@/lib/server/adapters/local-disk-file-storage";
import { createUploadFileRoute, uploadFileResponseSchema } from "@/lib/server/services/file-upload";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "file-upload-test-secret-0123456789-0123456789";
const BASE = "http://localhost:3000";

// 형식마다 첫 바이트(매직 넘버) + 조금의 내용
const PDF = new Uint8Array([...Buffer.from("%PDF-1.7\n"), ...Buffer.from("증빙 본문")]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
// Windows 실행 파일의 첫 바이트 "MZ"
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

describe.skipIf(!dbAvailable())("POST /api/files(계약 07 §1)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let storageDir: string;
  let POST: ReturnType<typeof createUploadFileRoute>;
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  /** auth.user + 세션. twoFactor=true 면 2단계를 마친 세션이다 */
  async function makeUser(key: string, twoFactor: boolean): Promise<string> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: key, displayUsername: key },
      { method: "admin" },
    );
    if (twoFactor) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    return user.id;
  }

  async function makeStaff(key: string, twoFactor: boolean): Promise<void> {
    const authUserId = await makeUser(key, twoFactor);
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      authUserId,
      key,
    ]);
    staffIds[key] = id;
  }

  /** 실제 라우트처럼 multipart 로 부른다. 201 이면 본문을 계약 스키마로 검사한다 */
  async function upload(who: string | undefined, fields: { purpose?: string; bytes?: Uint8Array<ArrayBuffer>; name?: string; type?: string }) {
    const form = new FormData();
    if (fields.purpose !== undefined) form.set("purpose", fields.purpose);
    if (fields.bytes !== undefined) {
      form.set("file", new File([fields.bytes], fields.name ?? "upload.bin", { type: fields.type ?? "" }));
    }
    const headers: Record<string, string> = who === undefined ? {} : { authorization: `Bearer ${tokens[who]}` };
    const res = await POST(new Request(`${BASE}/api/files`, { method: "POST", headers, body: form }), undefined);
    const body = (await res.json()) as Record<string, unknown>;
    if (res.status === 201) return { status: 201, body: uploadFileResponseSchema.parse(body), code: undefined };
    return { status: res.status, body: undefined, code: body["code"] };
  }

  const fileRows = async () => (await q("SELECT * FROM uploaded_files ORDER BY created_at")).rows as Record<string, unknown>[];
  const storedNames = async () => (await readdir(storageDir).catch(() => [] as string[])).filter((n) => !n.startsWith("."));

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    storageDir = await mkdtemp(join(tmpdir(), "kdance-file-upload-"));
    POST = createUploadFileRoute({
      db: handle.db,
      getSession: (headers) => auth.api.getSession({ headers }),
      fileStorage: new LocalDiskFileStorage({ rootDir: storageDir }),
    });

    await makeStaff("applicant", true); // 2단계를 마친 신청자(역할 없음 — staff_self)
    await makeStaff("first_factor_only", false); // 인증 앱 등록 전
    await makeUser("member", true); // 직원 계정이 없는 사람
  });

  beforeEach(async () => {
    await q("DELETE FROM uploaded_files");
    for (const name of await storedNames()) await rm(join(storageDir, name));
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
    await rm(storageDir, { recursive: true, force: true });
  });

  test("① PDF 확장자를 단 실행 파일은 422 FILE_TYPE_NOT_ALLOWED — 표·디스크에 남는 것이 없다", async () => {
    const res = await upload("applicant", {
      purpose: "merchant_evidence",
      bytes: EXE,
      name: "사업자등록증.pdf",
      type: "application/pdf",
    });
    expect(res).toMatchObject({ status: 422, code: "FILE_TYPE_NOT_ALLOWED" });
    expect(await fileRows()).toHaveLength(0);
    expect(await storedNames()).toHaveLength(0);
  });

  test("② 정상 PDF 증빙은 201 — 비공개 1행, 디스크 바이트·sha256 이 올린 것과 같다", async () => {
    const res = await upload("applicant", {
      purpose: "merchant_evidence",
      bytes: PDF,
      name: "사업자등록증.pdf",
      type: "application/pdf",
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      fileId: expect.any(String),
      displayName: "사업자등록증.pdf",
      mimeType: "application/pdf",
      sizeBytes: PDF.length,
      visibility: "private",
    });

    const [row, ...rest] = await fileRows();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      id: res.body?.fileId,
      uploader_account_id: staffIds["applicant"],
      purpose: "merchant_evidence",
      visibility: "private",
      mime_type: "application/pdf",
      size_bytes: PDF.length,
      sha256: createHash("sha256").update(PDF).digest("hex"),
      attached_at: null,
    });
    // 저장 키는 서버가 지은 <UUID>.pdf 이고, 올린 이름은 들어가지 않는다
    expect(String(row?.["storage_key"])).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    const stored = await new LocalDiskFileStorage({ rootDir: storageDir }).get(String(row?.["storage_key"]));
    expect(stored).toEqual(PDF);
  });

  test("학원 사진은 공개(public)로 저장된다", async () => {
    const res = await upload("applicant", { purpose: "academy_photo", bytes: PNG, name: "강의실.png", type: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ mimeType: "image/png", visibility: "public" });
  });

  test("올린 이름의 경로 부분은 버리고 파일 이름만 보여 준다", async () => {
    const res = await upload("applicant", { purpose: "merchant_evidence", bytes: PDF, name: "../../etc/증빙.pdf" });
    expect(res.status).toBe(201);
    expect(res.body?.displayName).toBe("증빙.pdf");
  });

  test("10MB 를 넘으면 422 FILE_TOO_LARGE, 10MB 꼭 맞으면 201", async () => {
    const limit = 10 * 1024 * 1024;
    const tooBig = new Uint8Array(limit + 1);
    tooBig.set(PDF);
    expect(await upload("applicant", { purpose: "merchant_evidence", bytes: tooBig, name: "큰.pdf" })).toMatchObject({
      status: 422,
      code: "FILE_TOO_LARGE",
    });
    const exact = new Uint8Array(limit);
    exact.set(PDF);
    expect((await upload("applicant", { purpose: "merchant_evidence", bytes: exact, name: "딱.pdf" })).status).toBe(201);
    expect(await fileRows()).toHaveLength(1);
  });

  test("purpose 값이 틀리거나 파일 칸이 없으면 422 VALIDATION_FAILED", async () => {
    // 없는 목적 값. 예전에는 "poster" 를 썼는데 S2-2.8(수업 포스터 올리기)에서 진짜 목적이 되어, 버린 이름 event_poster 로 바꿨다
    expect(await upload("applicant", { purpose: "event_poster", bytes: PDF, name: "a.pdf" })).toMatchObject({
      status: 422,
      code: "VALIDATION_FAILED",
    });
    expect(await upload("applicant", { purpose: "merchant_evidence" })).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect(await fileRows()).toHaveLength(0);
  });

  test("세션 없음 401 · 2단계 전 401 SECOND_FACTOR_REQUIRED · 회원 계정 403", async () => {
    const body = { purpose: "merchant_evidence", bytes: PDF, name: "a.pdf" };
    expect(await upload(undefined, body)).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(await upload("first_factor_only", body)).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    expect(await upload("member", body)).toMatchObject({ status: 403, code: "STAFF_ACCOUNT_REQUIRED" });
    expect(await fileRows()).toHaveLength(0);
    expect(await storedNames()).toHaveLength(0);
  });
});
