// S1-2.1(소속·초대·위임 테이블 묶음) — 강사 소속·초대 링크·위임 세 테이블이
// data-model §7-5 그대로 실제 PostgreSQL 에 있는지, 소속 흐름의 핵심 규칙을 DB 가 직접 막는지 확인한다.
// 표 자체는 S0-3.5a(가드용 최소 테이블)가 §7-5 의 칸을 전부 넣어 먼저 만들었다. 그래서 이 Task 는
// 마이그레이션을 더하지 않고, 「남은 칸이 없다」는 사실과 소속 흐름(S1-2) 규칙을 이 테스트로 고정한다.
// 확인하는 것:
//   ① 칸 목록 — 세 테이블의 칸이 §7-5 목록과 정확히 같다(빠진 칸도, 설계에 없는 칸도 없다)
//   ② 색인     — uq_affiliations_open 은 대기·소속 행만 보는 부분 유니크, 조회 색인 둘, 토큰 해시 유니크
//   ③ uq_affiliations_open — 같은 학원·같은 강사의 「중복 대기」를 거부한다(계약 08 Phase 6 DB 목록)
//   ④ ck_aff_rejected      — 거절이면 사유 코드가 꼭 있고, 거절이 아니면 사유 코드가 없다
//   ⑤ 초대 1회용          — 조건부 UPDATE 를 동시에 두 번 보내도 한 건만 성공한다(S1-2 수용 ①)
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";

// data-model §7-5 의 칸 목록(「ts」 = created_at·updated_at). 이 목록이 설계 원본과 DB 를 잇는 짝이다.
const DESIGNED_COLUMNS: Record<string, string[]> = {
  instructor_affiliations: [
    "id",
    "academy_id",
    "instructor_account_id",
    "status",
    "source",
    "invite_id",
    "applicant_message",
    "is_academy_employee",
    "requested_at",
    "decided_at",
    "decided_by_account_id",
    "reject_reason_code",
    "reject_reason_text",
    "released_at",
    "release_initiated_by",
    // 열린 해제 요청 표시(S2-1.4, data-model §8-2 — 원본은 affiliation_release_requests)
    "release_requested_at",
    // 학원 색 번호 0~11(S2-1.9, data-model §8-2 — 강사 캘린더의 학원 구분색)
    "calendar_color_index",
    "created_at",
    "updated_at",
  ],
  instructor_invites: [
    "id",
    "academy_id",
    "created_by_account_id",
    "token_hash",
    "expires_at",
    "used_at",
    "used_by_account_id",
    "revoked_at",
    "created_at",
  ],
  instructor_delegations: ["affiliation_id", "permission", "granted_at", "granted_by_account_id"],
};

describe.skipIf(!dbAvailable())("소속·초대·위임 테이블(instructor_affiliations·instructor_invites·instructor_delegations)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 학원·계정 id — 끝나고 이것만 지운다.
  const academyA = randomUUID();
  const academyB = randomUUID();
  const ownerAccount = randomUUID();
  const instructorX = randomUUID();
  const instructorY = randomUUID();
  const instructorZ = randomUUID();

  // 제약 위반이면 PostgreSQL 오류의 constraint 칸에 제약 이름이 담긴다.
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  const insertAffiliation = (fields: {
    academyId: string;
    instructorId: string;
    status?: string;
    source?: string;
    inviteId?: string | null;
    rejectReason?: string | null;
  }) =>
    q(
      `INSERT INTO instructor_affiliations
         (id, academy_id, instructor_account_id, status, source, invite_id, reject_reason_code, updated_at)
       VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, now()) RETURNING id`,
      [
        fields.academyId,
        fields.instructorId,
        fields.status ?? "pending",
        fields.source ?? "application",
        fields.inviteId ?? null,
        fields.rejectReason ?? null,
      ],
    );

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 4 });
    for (const [id, name] of [
      [academyA, "소속 시험 학원 A"],
      [academyB, "소속 시험 학원 B"],
    ]) {
      await q(
        `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS}) VALUES ($1, $2, '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
        [id, name],
      );
    }
    for (const id of [ownerAccount, instructorX, instructorY, instructorZ]) {
      await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '시험 직원', now())", [
        id,
        `affiliation-test-${id}`,
      ]);
    }
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 자식부터 지운다: 위임 → 소속 → 초대 → 계정·학원.
    const academies = [academyA, academyB];
    await q(
      "DELETE FROM instructor_delegations WHERE affiliation_id IN (SELECT id FROM instructor_affiliations WHERE academy_id = ANY($1))",
      [academies],
    );
    await q("DELETE FROM instructor_affiliations WHERE academy_id = ANY($1)", [academies]);
    await q("DELETE FROM instructor_invites WHERE academy_id = ANY($1)", [academies]);
    await q("DELETE FROM staff_accounts WHERE id = ANY($1)", [[ownerAccount, instructorX, instructorY, instructorZ]]);
    await q("DELETE FROM academies WHERE id = ANY($1)", [academies]);
    await closeTestDb(handle);
  });

  test("① 세 테이블의 칸이 data-model §7-5 목록과 정확히 같다", async () => {
    const { rows } = await q(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [Object.keys(DESIGNED_COLUMNS)],
    );
    for (const [table, designed] of Object.entries(DESIGNED_COLUMNS)) {
      const actual = rows.filter((r) => r.table_name === table).map((r) => r.column_name as string);
      // 순서는 상관없으니 정렬해서 견준다.
      expect(actual.sort(), `${table} 칸 목록`).toEqual([...designed].sort());
    }
  });

  test("① 새 소속 행의 기본값 — 대기(pending)로 시작하고 학원 직원 표시는 꺼져 있다", async () => {
    const { rows } = await insertAffiliation({ academyId: academyB, instructorId: instructorZ });
    const { rows: got } = await q(
      "SELECT status, is_academy_employee, requested_at IS NOT NULL AS has_requested_at FROM instructor_affiliations WHERE id = $1",
      [rows[0].id],
    );
    expect(got[0]).toEqual({ status: "pending", is_academy_employee: false, has_requested_at: true });
  });

  test("② 색인 — uq_affiliations_open 은 대기·소속만 보는 부분 유니크이고, 조회 색인·토큰 해시 유니크가 있다", async () => {
    // Prisma 는 색인 이름 뒤에 `_<해시>` 를 붙인다(예: uq_affiliations_open_1b600c7f). 그래서 앞부분으로 찾는다.
    const names = ["ix_aff_academy_status", "ix_aff_instructor", "uq_affiliations_open", "uq_invites_token_hash"];
    const { rows } = await q(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename IN ('instructor_affiliations', 'instructor_invites')`,
    );
    const defs: Record<string, string> = {};
    for (const name of names) {
      const hit = rows.filter((r) => (r.indexname as string).startsWith(`${name}_`) || r.indexname === name);
      expect(hit, `${name} 색인이 하나 있어야 한다`).toHaveLength(1);
      defs[name] = hit[0].indexdef as string;
    }
    expect(defs.uq_affiliations_open).toContain("UNIQUE");
    expect(defs.uq_affiliations_open).toContain("(academy_id, instructor_account_id)");
    // 부분 색인 조건 — 대기·소속 두 상태만 묶는다(끝난 행은 여럿 남을 수 있어야 하므로).
    expect(defs.uq_affiliations_open).toMatch(/WHERE .*pending.*active/);
    expect(defs.ix_aff_academy_status).toContain("(academy_id, status)");
    expect(defs.ix_aff_instructor).toContain("(instructor_account_id, status)");
    expect(defs.uq_invites_token_hash).toContain("UNIQUE");
  });

  test("③ uq_affiliations_open — 같은 학원에 대기 중인 강사가 다시 신청(대기)하면 거부한다", async () => {
    await insertAffiliation({ academyId: academyA, instructorId: instructorX });
    // 직접 신청이든 초대 링크든 두 번째 대기 행은 막힌다.
    await expectViolation(insertAffiliation({ academyId: academyA, instructorId: instructorX }), "uq_affiliations_open");
    const { rows: invite } = await q(
      `INSERT INTO instructor_invites (id, academy_id, created_by_account_id, token_hash, expires_at)
       VALUES (uuidv7(), $1, $2, $3, now() + interval '7 days') RETURNING id`,
      [academyA, ownerAccount, `hash-${randomUUID()}`],
    );
    await expectViolation(
      insertAffiliation({ academyId: academyA, instructorId: instructorX, source: "invite", inviteId: invite[0].id as string }),
      "uq_affiliations_open",
    );
    // 다른 학원이나 다른 강사는 막지 않는다.
    await insertAffiliation({ academyId: academyB, instructorId: instructorX });
    await insertAffiliation({ academyId: academyA, instructorId: instructorY });
  });

  test("③ uq_affiliations_open — 거절로 끝난 뒤 다시 신청하면 새 대기 행이 되고, 끝난 행을 다시 열지는 못한다", async () => {
    const { rows } = await q(
      "SELECT id FROM instructor_affiliations WHERE academy_id = $1 AND instructor_account_id = $2 AND status = 'pending'",
      [academyA, instructorY],
    );
    const firstId = rows[0].id as string;
    // 대표가 거절한다 → 열린 행이 없어진다.
    await q("UPDATE instructor_affiliations SET status = 'rejected', reject_reason_code = 'not_recruiting', decided_at = now() WHERE id = $1", [
      firstId,
    ]);
    // 다시 신청하면 새 행이다(끝난 행은 그대로 남는다).
    await insertAffiliation({ academyId: academyA, instructorId: instructorY });
    // 끝난 행을 대기로 되돌려 열린 행을 둘로 만들 수는 없다.
    await expectViolation(
      q("UPDATE instructor_affiliations SET status = 'pending', reject_reason_code = NULL WHERE id = $1", [firstId]),
      "uq_affiliations_open",
    );
    const { rows: all } = await q(
      "SELECT status FROM instructor_affiliations WHERE academy_id = $1 AND instructor_account_id = $2 ORDER BY status",
      [academyA, instructorY],
    );
    expect(all.map((r) => r.status)).toEqual(["pending", "rejected"]);
  });

  test("④ ck_aff_rejected — 사유 코드 없는 거절, 거절 아닌 행의 사유 코드를 둘 다 거부한다", async () => {
    // 넣을 때
    await expectViolation(
      insertAffiliation({ academyId: academyB, instructorId: instructorY, status: "rejected" }),
      "ck_aff_rejected",
    );
    await expectViolation(
      insertAffiliation({ academyId: academyB, instructorId: instructorY, status: "pending", rejectReason: "genre_mismatch" }),
      "ck_aff_rejected",
    );
    // 고칠 때 — 대기 행을 사유 없이 거절로 바꾸면 막힌다.
    const { rows } = await insertAffiliation({ academyId: academyB, instructorId: instructorY });
    await expectViolation(
      q("UPDATE instructor_affiliations SET status = 'rejected' WHERE id = $1", [rows[0].id]),
      "ck_aff_rejected",
    );
    // 사유 코드를 함께 넣으면 통과한다(other 면 글 사유도 함께 — 앱 규칙, DB 는 코드만 본다).
    await q(
      "UPDATE instructor_affiliations SET status = 'rejected', reject_reason_code = 'other', reject_reason_text = '모집 마감' WHERE id = $1",
      [rows[0].id],
    );
  });

  test("⑤ 초대 1회용 — 조건부 UPDATE 를 동시에 두 번 보내면 한 건만 성공한다", async () => {
    const tokenHash = `hash-${randomUUID()}`;
    await q(
      `INSERT INTO instructor_invites (id, academy_id, created_by_account_id, token_hash, expires_at)
       VALUES (uuidv7(), $1, $2, $3, now() + interval '7 days')`,
      [academyB, ownerAccount, tokenHash],
    );
    // data-model §7-5 의 한 문장 쓰기. 영향 행이 0 이면 앱이 거부한다.
    const accept = (accountId: string) =>
      q(
        `UPDATE instructor_invites SET used_at = now(), used_by_account_id = $2
         WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
        [tokenHash, accountId],
      );
    const results = await Promise.all([accept(instructorX), accept(instructorZ)]);
    expect(results.map((r) => r.rowCount).sort()).toEqual([0, 1]);

    // 이미 쓴 링크를 다시 써도 0 행이다.
    expect((await accept(instructorY)).rowCount).toBe(0);
    const { rows } = await q("SELECT used_by_account_id FROM instructor_invites WHERE token_hash = $1", [tokenHash]);
    expect([instructorX, instructorZ]).toContain(rows[0].used_by_account_id);
  });
});
