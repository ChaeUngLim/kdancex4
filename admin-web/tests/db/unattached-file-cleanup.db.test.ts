// S1-1.35(주인 없는 올린 파일 정리 작업) — 진짜 PostgreSQL + 임시 폴더 디스크로 정리 규칙을 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-1-35.db.test.ts 였는데, 기능 이름(unattached-file-cleanup)으로 바꿨다.
//   핵심(verify): 붙은 파일은 그대로 · 붙지 않고 24시간 지난 파일은 표와 디스크에서 지워진다
// 확인하는 것:
//   ① 붙지 않은 25시간 된 파일 → 행·바이트 모두 사라진다
//   ② 붙은 파일(attached_at 찍힘)은 오래돼도 그대로 · 23시간 된 안 붙은 파일도 그대로
//   ③ attached_at 이 비어 있어도 신청 증빙·통장 사본이 가리키면 그대로(두 겹 판단)
//   ④ 정확히 24시간 된 파일은 지운다(경계)
//   ⑤ 다시 돌리면 0건(멱등) · 바이트가 이미 없어도 오류 아님
//   ⑥ 디스크 지우기가 실패해도 다른 파일 정리는 계속되고 storageFailed 로 센다
//   ⑦ 내부 경로: 토큰 없으면 401 이고 아무것도 안 지운다, 맞으면 200 과 결과
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { newStorageKey } from "@/lib/domain/upload-file";
import { LocalDiskFileStorage } from "@/lib/server/adapters/local-disk-file-storage";
import type { FileStoragePort } from "@/lib/server/ports/file-storage";
import { runUnattachedFileCleanup } from "@/lib/server/services/unattached-file-cleanup";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const PDF = new Uint8Array([...Buffer.from("%PDF-1.7\n"), ...Buffer.from("정리 시험 증빙")]);
// 작업이 도는 시각 — 2026-11-21 04:00 KST
const NOW = Temporal.Instant.from("2026-11-20T19:00:00Z");
const clock = fixedClock(NOW);
const hoursAgo = (h: number) => NOW.subtract({ hours: h }).toString();

describe.skipIf(!dbAvailable())("주인 없는 올린 파일 정리(uploaded_files, 플랜 6-7)", () => {
  let handle: TestDb;
  let storageDir: string;
  let storage: LocalDiskFileStorage;
  let staffId: string;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  /** 바이트를 디스크에 넣고 uploaded_files 1행을 만든다. createdAt·attachedAt 을 고를 수 있다 */
  async function storeFile(createdAt: string, attachedAt: string | null = null): Promise<{ id: string; key: string }> {
    const id = randomUUID();
    const key = newStorageKey("application/pdf");
    await storage.put(key, PDF);
    await q(
      `INSERT INTO uploaded_files (id, uploader_account_id, purpose, visibility, storage_key, mime_type, size_bytes, sha256,
                                   display_name, created_at, attached_at)
       VALUES ($1, $2, 'merchant_evidence', 'private', $3, 'application/pdf', $4, $5, '증빙.pdf', $6, $7)`,
      [id, staffId, key, PDF.length, "0".repeat(64), createdAt, attachedAt],
    );
    return { id, key };
  }

  const rowExists = async (id: string) =>
    Number((await q("SELECT count(*) AS n FROM uploaded_files WHERE id = $1", [id])).rows[0].n) === 1;
  const bytesExist = async (key: string) => (await storage.get(key)) !== null;

  beforeAll(async () => {
    handle = openTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "kdance-file-cleanup-"));
    storage = new LocalDiskFileStorage({ rootDir: storageDir });
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
    staffId = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '대표', 'active', now())", [
      staffId,
      `auth-${staffId}`,
    ]);
  });
  afterAll(async () => {
    await truncateAll(handle.pool);
    await closeTestDb(handle);
    await rm(storageDir, { recursive: true, force: true });
    const shared = await import("../../prisma/db");
    await shared.pool.end();
  });

  test("① 붙지 않고 24시간 지난 파일은 표 행과 디스크 바이트가 함께 지워진다", async () => {
    const old = await storeFile(hoursAgo(25));

    const result = await runUnattachedFileCleanup({ db: handle.db, fileStorage: storage, clock });

    expect(result).toEqual({ cutoff: "2026-11-19T19:00:00Z", deleted: 1, storageFailed: 0 });
    expect(await rowExists(old.id)).toBe(false);
    expect(await bytesExist(old.key)).toBe(false);
  });

  test("② 붙은 파일은 오래돼도 그대로고, 24시간이 안 된 안 붙은 파일도 그대로다", async () => {
    const attached = await storeFile(hoursAgo(24 * 30), hoursAgo(24 * 29));
    const fresh = await storeFile(hoursAgo(23));
    const old = await storeFile(hoursAgo(48));

    const result = await runUnattachedFileCleanup({ db: handle.db, fileStorage: storage, clock });

    expect(result.deleted).toBe(1);
    expect(await rowExists(attached.id)).toBe(true);
    expect(await bytesExist(attached.key)).toBe(true);
    expect(await rowExists(fresh.id)).toBe(true);
    expect(await bytesExist(fresh.key)).toBe(true);
    expect(await rowExists(old.id)).toBe(false);
    expect(await bytesExist(old.key)).toBe(false);
  });

  test("③ attached_at 이 비어 있어도 신청 증빙·통장 사본이 가리키는 파일은 지우지 않는다", async () => {
    const evidence = await storeFile(hoursAgo(72));
    const holderProof = await storeFile(hoursAgo(72));
    const appId = randomUUID();
    await q(
      "INSERT INTO merchant_applications (id, applicant_account_id, status, updated_at) VALUES ($1, $2, 'submitted', now())",
      [appId, staffId],
    );
    await q("INSERT INTO merchant_application_documents (application_id, doc_kind, file_id) VALUES ($1, 'business_registration', $2)", [
      appId,
      evidence.id,
    ]);
    const academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '정리 시험 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q(
      `INSERT INTO academy_payout_accounts (id, academy_id, bank_code, account_enc, account_last4, holder_name, created_by_account_id, holder_proof_file_id)
       VALUES ($1, $2, '004', $3, '1234', '학원', $4, $5)`,
      [randomUUID(), academyId, Buffer.from("test-ciphertext"), staffId, holderProof.id],
    );

    const result = await runUnattachedFileCleanup({ db: handle.db, fileStorage: storage, clock });

    expect(result.deleted).toBe(0);
    for (const f of [evidence, holderProof]) {
      expect(await rowExists(f.id)).toBe(true);
      expect(await bytesExist(f.key)).toBe(true);
    }
  });

  test("④ 정확히 24시간 된 파일은 지우고, 24시간에서 1초 모자란 파일은 남긴다", async () => {
    const exactly = await storeFile(hoursAgo(24));
    const almost = await storeFile(NOW.subtract({ hours: 23, minutes: 59, seconds: 59 }).toString());

    const result = await runUnattachedFileCleanup({ db: handle.db, fileStorage: storage, clock });

    expect(result.deleted).toBe(1);
    expect(await rowExists(exactly.id)).toBe(false);
    expect(await rowExists(almost.id)).toBe(true);
  });

  test("⑤ 다시 돌리면 0건이다 · 바이트가 이미 없는 행도 오류 없이 지운다", async () => {
    await storeFile(hoursAgo(30));
    const bytesGone = await storeFile(hoursAgo(30));
    await storage.delete(bytesGone.key);

    const first = await runUnattachedFileCleanup({ db: handle.db, fileStorage: storage, clock });
    const second = await runUnattachedFileCleanup({ db: handle.db, fileStorage: storage, clock });

    expect(first).toMatchObject({ deleted: 2, storageFailed: 0 });
    expect(second).toMatchObject({ deleted: 0, storageFailed: 0 });
    expect(await rowExists(bytesGone.id)).toBe(false);
  });

  test("⑥ 디스크 지우기가 한 건 실패해도 나머지는 지우고 실패 수를 센다", async () => {
    const a = await storeFile(hoursAgo(30));
    const b = await storeFile(hoursAgo(31));
    // a 의 바이트만 지우기에 실패하는 저장소
    const flaky: FileStoragePort = {
      put: (key, bytes) => storage.put(key, bytes),
      get: (key) => storage.get(key),
      delete: async (key) => {
        if (key === a.key) throw new Error("디스크 오류(시험)");
        await storage.delete(key);
      },
    };

    const result = await runUnattachedFileCleanup({ db: handle.db, fileStorage: flaky, clock });

    expect(result).toMatchObject({ deleted: 2, storageFailed: 1 });
    expect(await rowExists(a.id)).toBe(false);
    expect(await rowExists(b.id)).toBe(false);
    expect(await bytesExist(b.key)).toBe(false);
  });

  describe("⑦ 내부 경로 POST /api/internal/jobs/files/purge-unattached", () => {
    const TOKEN = "test-internal-token-file-cleanup";
    // 진짜 route.ts 를 부른다 — 공용 db(테스트 DB)와 deps.ts 의 로컬 디스크 저장소를 쓴다.
    // 저장소 위치는 FILE_STORAGE_DIR 로 이 파일의 임시 폴더를 가리키게 한다(처음 쓰는 요청에서 만들어진다).
    // 시각은 asOf(시험용 시계)로 정한다 — dev 경로가 켜진 환경에서만 받는다
    const call = async (headers: Record<string, string>, body = "{}") => {
      const { POST } = await import("../../app/api/internal/jobs/files/purge-unattached/route");
      return POST(new Request("http://localhost/api/internal/jobs/files/purge-unattached", { method: "POST", headers, body }), {});
    };

    beforeAll(() => {
      process.env["INTERNAL_API_TOKEN"] = TOKEN;
      process.env["KDANCE_DEV_ROUTES"] = "true";
      process.env["FILE_STORAGE_DIR"] = storageDir;
    });
    afterAll(() => {
      delete process.env["INTERNAL_API_TOKEN"];
      delete process.env["KDANCE_DEV_ROUTES"];
      delete process.env["FILE_STORAGE_DIR"];
    });

    test("토큰이 없으면 401 이고 아무것도 지우지 않는다", async () => {
      const old = await storeFile(hoursAgo(30));
      const response = await call({});
      expect(response.status).toBe(401);
      expect(await rowExists(old.id)).toBe(true);
      expect(await bytesExist(old.key)).toBe(true);
    });

    test("토큰이 맞으면 200 과 결과를 주고, asOf 기준으로 지운다", async () => {
      const old = await storeFile(hoursAgo(30));
      const fresh = await storeFile(hoursAgo(1));
      const response = await call(
        { "X-Internal-Token": TOKEN, "Content-Type": "application/json" },
        JSON.stringify({ asOf: NOW.toString() }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ cutoff: "2026-11-19T19:00:00Z", deleted: 1, storageFailed: 0 });
      expect(await rowExists(old.id)).toBe(false);
      expect(await bytesExist(old.key)).toBe(false);
      expect(await rowExists(fresh.id)).toBe(true);
    });

    test("모르는 칸이 오면 422 이고 지우지 않는다", async () => {
      const old = await storeFile(hoursAgo(30));
      const response = await call({ "X-Internal-Token": TOKEN }, JSON.stringify({ olderThanHours: 1 }));
      expect(response.status).toBe(422);
      expect(await rowExists(old.id)).toBe(true);
    });
  });
});
