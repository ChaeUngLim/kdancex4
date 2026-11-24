// S1-1.7(파일 내려받기 권한) — `GET /api/files/{fileId}`(계약 07 §1 · 수용 ⑥)를 진짜 Better Auth 세션 + 진짜 PostgreSQL
// + 임시 폴더 디스크로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-1-7.db.test.ts 였는데, 기능 이름(file-download)으로 바꿨다.
//   핵심(verify): 대표 B 가 대표 A 의 증빙을 열면 403, 운영자는 200
//   나머지: 올린 사람 200 · 붙은 학원의 대표(올린 사람이 아니어도) 200 — 입점 증빙·통장 사본 두 자리
//   · 포스터 읽기 원본(poster_extractions)은 그 학원 대표 200(SX-2.5)
//   · 승인 전(학원 없음) 증빙은 다른 대표 403 · 없는 파일·모양 틀린 id 404 · 세션 없음 401 · 2단계 전 401 · 회원 계정 403
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { newStorageKey } from "@/lib/domain/upload-file";
import { LocalDiskFileStorage } from "@/lib/server/adapters/local-disk-file-storage";
import { createDownloadFileRoute } from "@/lib/server/services/file-download";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "file-download-test-secret-0123456789-0123456789";
const BASE = "http://localhost:3000";
const PDF = new Uint8Array([...Buffer.from("%PDF-1.7\n"), ...Buffer.from("대표 A 의 사업자등록증")]);

describe.skipIf(!dbAvailable())("GET /api/files/{fileId}(계약 07 §1 · 수용 ⑥)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let storageDir: string;
  let storage: LocalDiskFileStorage;
  let GET: ReturnType<typeof createDownloadFileRoute>;
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyA = randomUUID();
  const academyB = randomUUID();
  const files: Record<string, string> = {};
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

  async function makeStaff(key: string, twoFactor: boolean): Promise<string> {
    const authUserId = await makeUser(key, twoFactor);
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      authUserId,
      key,
    ]);
    staffIds[key] = id;
    return id;
  }

  /** 디스크에 바이트를 넣고 uploaded_files 1행을 만든다(POST /api/files 가 남기는 것과 같은 모양) */
  async function storeFile(uploaderKey: string, displayName: string): Promise<string> {
    const id = randomUUID();
    const storageKey = newStorageKey("application/pdf");
    await storage.put(storageKey, PDF);
    await q(
      `INSERT INTO uploaded_files (id, uploader_account_id, purpose, visibility, storage_key, mime_type, size_bytes, sha256, display_name)
       VALUES ($1, $2, 'merchant_evidence', 'private', $3, 'application/pdf', $4, $5, $6)`,
      [id, staffIds[uploaderKey], storageKey, PDF.length, "0".repeat(64), displayName],
    );
    return id;
  }

  /** 신청서에 증빙을 붙인다. academyId 를 주면 승인된 신청(학원이 생긴 뒤)이다 */
  async function attachToApplication(applicantKey: string, fileId: string, academyId: string | null): Promise<void> {
    const appId = randomUUID();
    await q(
      `INSERT INTO merchant_applications (id, applicant_account_id, status, academy_id, updated_at) VALUES ($1, $2, $3, $4, now())`,
      [appId, staffIds[applicantKey], academyId === null ? "submitted" : "approved", academyId],
    );
    await q("INSERT INTO merchant_application_documents (application_id, doc_kind, file_id) VALUES ($1, 'business_registration', $2)", [
      appId,
      fileId,
    ]);
  }

  async function download(who: string | undefined, fileId: string) {
    const headers: Record<string, string> = who === undefined ? {} : { authorization: `Bearer ${tokens[who]}` };
    const res = await GET(new Request(`${BASE}/api/files/${fileId}`, { headers }), { params: Promise.resolve({ fileId }) });
    if (res.status === 200) return { status: 200, bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers, code: undefined };
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, bytes: undefined, headers: res.headers, code: body["code"] };
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    storageDir = await mkdtemp(join(tmpdir(), "kdance-file-download-"));
    storage = new LocalDiskFileStorage({ rootDir: storageDir });
    GET = createDownloadFileRoute({ db: handle.db, getSession: (headers) => auth.api.getSession({ headers }), fileStorage: storage });

    await makeStaff("owner_a", true); // 학원 A 대표 — 자기 증빙을 올렸다
    await makeStaff("owner_b", true); // 학원 B 대표 — 남의 학원
    await makeStaff("admin", true); // 운영자
    await makeStaff("applicant_x", true); // 학원 A 신청을 대신 낸 사람(대표 아님)
    await makeStaff("pending_applicant", true); // 아직 승인 전인 신청자
    await makeStaff("first_factor_only", false); // 인증 앱 등록 전
    await makeUser("member", true); // 직원 계정이 없는 사람
    await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'admin')", [staffIds["admin"]]);

    for (const [academyId, name] of [
      [academyA, "학원 A"],
      [academyB, "학원 B"],
    ] as const) {
      await q(
        `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
         VALUES ($1, $2, '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
        [academyId, name],
      );
    }
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyA, staffIds["owner_a"]]);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyB, staffIds["owner_b"]]);

    // 대표 A 가 올리고 학원 A 의 승인된 신청에 붙은 증빙
    files["evidenceA"] = await storeFile("owner_a", "사업자등록증.pdf");
    await attachToApplication("owner_a", files["evidenceA"], academyA);
    // 신청자 X 가 올렸지만 학원 A 신청에 붙은 증빙 — 대표 A 는 「붙은 학원의 대표」로 연다
    files["evidenceByX"] = await storeFile("applicant_x", "신고증.pdf");
    await attachToApplication("applicant_x", files["evidenceByX"], academyA);
    // 운영자가 올린 학원 A 의 통장 사본(정산 계좌의 holder_proof_file_id)
    files["holderProof"] = await storeFile("admin", "통장사본.pdf");
    await q(
      `INSERT INTO academy_payout_accounts (id, academy_id, bank_code, account_enc, account_last4, holder_name, created_by_account_id, holder_proof_file_id)
       VALUES ($1, $2, '004', $3, '1234', '학원 A', $4, $5)`,
      [randomUUID(), academyA, Buffer.from("test-ciphertext"), staffIds["admin"], files["holderProof"]],
    );
    // 승인 전 신청서에 붙은 증빙(학원이 아직 없다)
    files["pendingEvidence"] = await storeFile("pending_applicant", "준비중.pdf");
    await attachToApplication("pending_applicant", files["pendingEvidence"], null);
    // 학원 A 소속 강사(대표 아님)가 올려 읽기를 시작한 포스터 — 아직 수업이 아니라 poster_extractions 에만 붙어 있다(SX-2.5)
    await makeStaff("instructor_a", true);
    files["posterSource"] = await storeFile("instructor_a", "포스터.png");
    await q(
      `INSERT INTO poster_extractions (id, academy_id, uploaded_by_staff_account_id, source_file_id, target_kind, status, updated_at)
       VALUES ($1, $2, $3, $4, 'class', 'queued', now())`,
      [randomUUID(), academyA, staffIds["instructor_a"], files["posterSource"]],
    );
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
    await rm(storageDir, { recursive: true, force: true });
  });

  test("대표 B 가 대표 A 의 증빙을 열면 403 FORBIDDEN — 주소(fileId)를 알아도 막는다", async () => {
    const res = await download("owner_b", files["evidenceA"]!);
    expect(res).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  test("운영자는 대표 A 의 증빙을 200 으로 연다 — 바이트가 같고 attachment 로 내려온다", async () => {
    const res = await download("admin", files["evidenceA"]!);
    expect(res.status).toBe(200);
    expect(res.bytes).toEqual(PDF);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="______.pdf"; filename*=UTF-8''${encodeURIComponent("사업자등록증.pdf")}`,
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("올린 사람(대표 A)은 200", async () => {
    expect((await download("owner_a", files["evidenceA"]!)).status).toBe(200);
  });

  test("붙은 학원의 대표는 자기가 올리지 않은 증빙도 200 — 남의 학원 대표는 403", async () => {
    expect((await download("owner_a", files["evidenceByX"]!)).status).toBe(200);
    expect((await download("applicant_x", files["evidenceByX"]!)).status).toBe(200);
    expect(await download("owner_b", files["evidenceByX"]!)).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  test("통장 사본은 그 학원 대표·운영자만 — 대표 A 200 · 대표 B 403", async () => {
    expect((await download("owner_a", files["holderProof"]!)).status).toBe(200);
    expect((await download("admin", files["holderProof"]!)).status).toBe(200);
    expect(await download("owner_b", files["holderProof"]!)).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  test("포스터 읽기 원본은 올린 강사·그 학원 대표 200 — 남의 학원 대표는 403(SX-2.5 검토 화면 O2)", async () => {
    expect((await download("instructor_a", files["posterSource"]!)).status).toBe(200);
    expect((await download("owner_a", files["posterSource"]!)).status).toBe(200);
    expect(await download("owner_b", files["posterSource"]!)).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  test("AI 홍보 이미지는 앱(Bearer)에서 2단계 없이 올린 강사가 연다 — 다른 직원은 403, 증빙은 여전히 2단계 필요(SX-6.9)", async () => {
    await makeStaff("promo_instructor", false); // 강사 앱 — 2단계가 없다
    await makeStaff("promo_other", false);
    const id = randomUUID();
    const storageKey = newStorageKey("image/png");
    await storage.put(storageKey, PDF);
    await q(
      `INSERT INTO uploaded_files (id, uploader_account_id, purpose, visibility, storage_key, mime_type, size_bytes, sha256, display_name)
       VALUES ($1, $2, 'class_promo_image', 'private', $3, 'image/png', $4, $5, '홍보.png')`,
      [id, staffIds["promo_instructor"], storageKey, PDF.length, "0".repeat(64)],
    );
    expect((await download("promo_instructor", id)).status).toBe(200);
    expect(await download("promo_other", id)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await download("promo_instructor", files["evidenceA"]!)).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
  });

  test("승인 전 신청의 증빙은 올린 사람·운영자만 — 다른 대표는 403", async () => {
    expect((await download("pending_applicant", files["pendingEvidence"]!)).status).toBe(200);
    expect((await download("admin", files["pendingEvidence"]!)).status).toBe(200);
    expect(await download("owner_a", files["pendingEvidence"]!)).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  test("없는 파일·모양이 틀린 id 는 404 NOT_FOUND", async () => {
    expect(await download("admin", randomUUID())).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await download("admin", "../../etc/passwd")).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("세션 없음 401 · 2단계 전 401 SECOND_FACTOR_REQUIRED · 회원 계정 403 — 파일이 있는지도 알려 주지 않는다", async () => {
    expect(await download(undefined, files["evidenceA"]!)).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(await download("first_factor_only", files["evidenceA"]!)).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    expect(await download("member", files["evidenceA"]!)).toMatchObject({ status: 403, code: "STAFF_ACCOUNT_REQUIRED" });
    expect(await download("first_factor_only", randomUUID())).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
  });
});
