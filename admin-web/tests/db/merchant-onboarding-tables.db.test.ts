// S1-1.2(입점 신청·증빙·정산 계좌 테이블 묶음) — 입점 흐름의 네 표가 실제 PostgreSQL 에서
// 설계(data-model §7-3·§7-9, 계약 07 「Phase 6(테스트)」 DB 행)대로 지켜지는지 확인한다.
// 확인하는 것:
//   ① merchant_applications — 한 계정에 열린 신청은 하나(uq_merchant_app_open). 끝난 신청 뒤에는 새 신청 가능
//   ② merchant_applications — 거절 ↔ 사유 코드, 승인 ↔ 학원 id 짝(ck_merchant_app_rejected·ck_merchant_app_approved), 초안은 판매자 칸이 비어도 됨
//   ③ uploaded_files — 입점 증빙은 공개 불가(ck_files_evidence_private), 크기 1바이트~10MB(ck_files_size), 형식 4종(ck_files_mime)
//   ④ merchant_application_documents — 한 신청에 같은 종류 한 장(PK), 한 파일은 한 신청에만(uq_app_docs_file)
//   ⑤ academy_payout_accounts — 학원당 active 계좌 하나(uq_payout_accounts_active), 바꾼 뒤 새 계좌 가능, 끝 4자리는 숫자 4개
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

const TEN_MB = 10 * 1024 * 1024; // 10,485,760바이트 — ck_files_size 의 위쪽 끝(플랜 6-8 추천값)

describe.skipIf(!dbAvailable())("입점 신청·증빙·정산 계좌 표", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 계정·학원 id — 끝나고 이것만 지운다.
  const applicant = randomUUID();
  const otherApplicant = randomUUID();
  const operator = randomUUID();
  const academy = randomUUID();
  const accounts = [applicant, otherApplicant, operator];

  // 제약 위반이면 PostgreSQL 오류의 constraint 칸에 제약 이름이 담긴다(이름 뒤에 해시가 붙으므로 포함 여부로 본다).
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 입점 신청 한 줄. 초안이 기본이라 판매자 칸은 비워 둔다(설계상 초안은 NULL 허용).
  const insertApplication = (accountId: string, overrides: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = { id: randomUUID(), applicant_account_id: accountId, updated_at: new Date(), ...overrides };
    const cols = Object.keys(row);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    return q(`INSERT INTO merchant_applications (${cols.join(", ")}) VALUES (${marks}) RETURNING id`, cols.map((k) => row[k]));
  };

  // 올린 파일 한 줄. storage_key 는 서버가 짓는 이름이라 겹치지 않게 무작위로 만든다.
  const insertFile = (overrides: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      uploader_account_id: applicant,
      purpose: "merchant_evidence",
      visibility: "private",
      storage_key: `test/${randomUUID()}`,
      mime_type: "application/pdf",
      size_bytes: 1024,
      sha256: "0".repeat(64),
      display_name: "사업자등록증.pdf",
      ...overrides,
    };
    const cols = Object.keys(row);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    return q(`INSERT INTO uploaded_files (${cols.join(", ")}) VALUES (${marks}) RETURNING id`, cols.map((k) => row[k]));
  };

  // 정산 계좌 한 줄. 계좌번호 원문 대신 시험용 바이트를 넣는다(실제로는 암호문).
  const insertPayout = (overrides: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      academy_id: academy,
      bank_code: "004",
      account_enc: Buffer.from("test-ciphertext"),
      account_last4: "1234",
      holder_name: "시험 대표",
      created_by_account_id: operator,
      ...overrides,
    };
    const cols = Object.keys(row);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    return q(`INSERT INTO academy_payout_accounts (${cols.join(", ")}) VALUES (${marks}) RETURNING id`, cols.map((k) => row[k]));
  };

  beforeAll(async () => {
    handle = openTestDb();
    for (const id of accounts) {
      await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '입점 시험 계정', now())", [
        id,
        `merchant-tables-${id}`,
      ]);
    }
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '입점 시험 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
      [academy],
    );
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 자식부터 지운다: 증빙 연결·계좌 → 신청·파일 → 학원·계정.
    await q(
      `DELETE FROM merchant_application_documents
        WHERE application_id IN (SELECT id FROM merchant_applications WHERE applicant_account_id = ANY($1))`,
      [accounts],
    );
    await q("DELETE FROM academy_payout_accounts WHERE academy_id = $1", [academy]);
    await q("DELETE FROM merchant_applications WHERE applicant_account_id = ANY($1)", [accounts]);
    await q("DELETE FROM uploaded_files WHERE uploader_account_id = ANY($1)", [accounts]);
    await q("DELETE FROM academies WHERE id = $1", [academy]);
    await q("DELETE FROM staff_accounts WHERE id = ANY($1)", [accounts]);
    await closeTestDb(handle);
  });

  test("① 한 계정에 열린 신청은 하나 — 초안이 있는데 두 번째 열린 신청은 거부(uq_merchant_app_open)", async () => {
    const { rows } = await insertApplication(applicant);
    // 초안·제출·심사 중 어느 상태로 넣어도 두 번째 열린 신청이다.
    for (const status of ["draft", "submitted", "in_review"]) {
      await expectViolation(insertApplication(applicant, { status }), "uq_merchant_app_open");
    }
    // 다른 계정은 자기 신청을 따로 연다.
    await insertApplication(otherApplicant);

    // 첫 신청을 철회하면(끝난 신청) 새 신청을 열 수 있다 — 끝난 신청은 몇 개든 남는다.
    await q("UPDATE merchant_applications SET status = 'withdrawn' WHERE id = $1", [rows[0].id]);
    const reopened = await insertApplication(applicant, { status: "submitted", submitted_at: new Date() });
    expect(reopened.rowCount).toBe(1);
    const { rows: counts } = await q(
      "SELECT count(*)::int AS n FROM merchant_applications WHERE applicant_account_id = $1",
      [applicant],
    );
    expect(counts[0].n).toBe(2);
  });

  test("② 거절에는 사유 코드가, 승인에는 학원 id 가 꼭 있다", async () => {
    // 사유 없이 거절 · 거절이 아닌데 사유가 남음 — 둘 다 거부.
    await expectViolation(insertApplication(operator, { status: "rejected" }), "ck_merchant_app_rejected");
    await expectViolation(insertApplication(operator, { reject_reason_code: "info_mismatch" }), "ck_merchant_app_rejected");
    // 학원 없이 승인 · 승인이 아닌데 학원 id — 둘 다 거부.
    await expectViolation(insertApplication(operator, { status: "approved" }), "ck_merchant_app_approved");
    await expectViolation(insertApplication(operator, { academy_id: academy }), "ck_merchant_app_approved");
    // 사유 코드는 정해진 4종만.
    await expectViolation(
      insertApplication(operator, { status: "rejected", reject_reason_code: "just_because" }),
      "merchant_applications_reject_reason_code_check",
    );

    // 짝이 맞으면 들어간다: 사유가 있는 거절 → (끝난 신청이라) 같은 계정의 승인 신청도 들어간다.
    await insertApplication(operator, { status: "rejected", reject_reason_code: "registration_missing", decided_at: new Date() });
    await insertApplication(operator, { status: "approved", academy_id: academy, decided_at: new Date() });
  });

  test("② 초안은 판매자 칸이 비어 있어도 저장된다(제출 때 앱이 검사)", async () => {
    const { rows } = await q(
      `SELECT business_name, business_registration_number, registration_type, payout_account_enc, status
         FROM merchant_applications WHERE applicant_account_id = $1 AND status = 'draft'`,
      [otherApplicant],
    );
    expect(rows).toEqual([
      { business_name: null, business_registration_number: null, registration_type: null, payout_account_enc: null, status: "draft" },
    ]);
  });

  test("③ 입점 증빙은 공개(public)로 둘 수 없다(ck_files_evidence_private)", async () => {
    await expectViolation(insertFile({ purpose: "merchant_evidence", visibility: "public" }), "ck_files_evidence_private");
    // 증빙이 아닌 학원 사진은 공개해도 된다.
    const photo = await insertFile({ purpose: "academy_photo", visibility: "public", mime_type: "image/jpeg" });
    expect(photo.rowCount).toBe(1);
  });

  test("③ 파일 크기는 1바이트~10MB 만 받는다(ck_files_size)", async () => {
    await expectViolation(insertFile({ size_bytes: 0 }), "ck_files_size");
    await expectViolation(insertFile({ size_bytes: TEN_MB + 1 }), "ck_files_size");
    // 경계값은 들어간다.
    expect((await insertFile({ size_bytes: 1 })).rowCount).toBe(1);
    expect((await insertFile({ size_bytes: TEN_MB })).rowCount).toBe(1);
  });

  test("③ 형식은 JPEG·PNG·WebP·PDF 만, 저장 이름은 겹치지 않는다", async () => {
    await expectViolation(insertFile({ mime_type: "image/gif" }), "ck_files_mime");
    const key = `test/${randomUUID()}`;
    await insertFile({ storage_key: key });
    await expectViolation(insertFile({ storage_key: key }), "uq_files_storage_key");
  });

  test("④ 한 신청에 같은 종류 증빙은 한 장, 한 파일은 한 곳에만 붙는다", async () => {
    const { rows: app } = await q(
      "SELECT id FROM merchant_applications WHERE applicant_account_id = $1 AND status = 'draft'",
      [otherApplicant],
    );
    const fileOne = (await insertFile({ uploader_account_id: otherApplicant })).rows[0].id;
    const fileTwo = (await insertFile({ uploader_account_id: otherApplicant })).rows[0].id;
    const attach = (kind: string, fileId: string) =>
      q("INSERT INTO merchant_application_documents (application_id, doc_kind, file_id) VALUES ($1, $2, $3)", [app[0].id, kind, fileId]);

    await attach("business_registration", fileOne);
    // 같은 종류를 한 장 더 — PK(application_id, doc_kind) 위반.
    await expectViolation(attach("business_registration", fileTwo), "merchant_application_documents_pkey");
    // 같은 파일을 다른 종류로 또 붙임 — uq_app_docs_file 위반.
    await expectViolation(attach("academy_registration", fileOne), "uq_app_docs_file");
    // 다른 종류 · 다른 파일은 들어간다.
    await attach("academy_registration", fileTwo);
    // 종류는 정해진 4종만.
    const fileThree = (await insertFile({ uploader_account_id: otherApplicant })).rows[0].id;
    await expectViolation(attach("bank_statement", fileThree), "merchant_application_documents_doc_kind_check");
  });

  test("⑤ 학원당 active 계좌는 하나 — 두 번째는 거부, 옛 계좌를 replaced 로 닫으면 새 계좌 가능", async () => {
    const first = await insertPayout();
    await expectViolation(insertPayout({ account_last4: "5678" }), "uq_payout_accounts_active");

    // 바꾸기 = 옛 행 replaced + 새 행 active 를 한 트랜잭션에서(data-model §7-3).
    const client = await handle.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE academy_payout_accounts SET status = 'replaced', replaced_at = now() WHERE id = $1", [first.rows[0].id]);
      await client.query(
        `INSERT INTO academy_payout_accounts (id, academy_id, bank_code, account_enc, account_last4, holder_name, created_by_account_id)
         VALUES ($1, $2, '088', $3, '5678', '시험 대표', $4)`,
        [randomUUID(), academy, Buffer.from("test-ciphertext-2"), operator],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    const { rows } = await q("SELECT status, account_last4 FROM academy_payout_accounts WHERE academy_id = $1 ORDER BY created_at, status", [academy]);
    expect(rows.map((r: { status: string }) => r.status).sort()).toEqual(["active", "replaced"]);
  });

  test("⑤ 끝 4자리는 숫자 4개만, 상태는 active·replaced 만", async () => {
    await expectViolation(insertPayout({ account_last4: "12a4", status: "replaced" }), "ck_payout_accounts_last4");
    await expectViolation(insertPayout({ account_last4: "123", status: "replaced" }), "ck_payout_accounts_last4");
    await expectViolation(insertPayout({ status: "closed" }), "academy_payout_accounts_status_check");
  });
});
