// S0-3.5a(가드용 학원·대표·소속·위임 최소 테이블) — requireStaff 가드(S0-3.6)가 매 요청 읽는 표가
// 실제 PostgreSQL 에서 설계(data-model §7-3·§7-5)대로 지켜지는지 확인한다.
// 확인하는 것:
//   ① 존재   — academy_owners · instructor_affiliations · instructor_delegations(+ 외래 키 대상 instructor_invites)
//   ② 외래 키 — 없는 학원·계정·소속·초대를 가리키면 DB 가 막는다(가드가 「유령 소속」을 읽을 일이 없게)
//   ③ 위임 값 — roster_manage · class_manage 두 가지만 받는다(FR-081a, 2026-11-20 사용자 결정)
//   ④ 그 밖의 제약 — 학원당 active 대표 1명, 열린 소속 1개, 초대 경로·거절 사유 짝, 초대 사용 짝
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";

describe.skipIf(!dbAvailable())("가드용 표(academy_owners·instructor_affiliations·instructor_delegations)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 학원·계정 id — 끝나고 이것만 지운다.
  const academyA = randomUUID();
  const academyB = randomUUID();
  const ownerAccount = randomUUID();
  const instructorAccount = randomUUID();
  const otherInstructor = randomUUID();

  // 제약 위반이면 PostgreSQL 오류의 constraint 칸에 제약 이름이 담긴다(이름 뒤에 해시가 붙으므로 포함 여부로 본다).
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  const insertAffiliation = (fields: {
    academyId?: string;
    instructorId?: string;
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
        fields.academyId ?? academyA,
        fields.instructorId ?? instructorAccount,
        fields.status ?? "pending",
        fields.source ?? "application",
        fields.inviteId ?? null,
        fields.rejectReason ?? null,
      ],
    );

  const insertInvite = (tokenHash: string, used = false) =>
    q(
      `INSERT INTO instructor_invites
         (id, academy_id, created_by_account_id, token_hash, expires_at, used_at, used_by_account_id)
       VALUES (uuidv7(), $1, $2, $3, now() + interval '7 days', $4, $5) RETURNING id`,
      [academyA, ownerAccount, tokenHash, used ? new Date() : null, used ? instructorAccount : null],
    );

  beforeAll(async () => {
    handle = openTestDb();
    for (const [id, name] of [
      [academyA, "가드 시험 학원 A"],
      [academyB, "가드 시험 학원 B"],
    ]) {
      await q(
        `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS}) VALUES ($1, $2, '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
        [id, name],
      );
    }
    for (const id of [ownerAccount, instructorAccount, otherInstructor]) {
      await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '시험 직원', now())", [
        id,
        `guard-test-${id}`,
      ]);
    }
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 자식부터 지운다: 위임 → 소속 → 초대 → 대표 → 계정·학원.
    const academies = [academyA, academyB];
    await q(
      "DELETE FROM instructor_delegations WHERE affiliation_id IN (SELECT id FROM instructor_affiliations WHERE academy_id = ANY($1))",
      [academies],
    );
    await q("DELETE FROM instructor_affiliations WHERE academy_id = ANY($1)", [academies]);
    await q("DELETE FROM instructor_invites WHERE academy_id = ANY($1)", [academies]);
    await q("DELETE FROM academy_owners WHERE academy_id = ANY($1)", [academies]);
    await q("DELETE FROM staff_accounts WHERE id = ANY($1)", [[ownerAccount, instructorAccount, otherInstructor]]);
    await q("DELETE FROM academies WHERE id = ANY($1)", [academies]);
    await closeTestDb(handle);
  });

  test("① 세 테이블과 초대 테이블이 public 스키마에 있다", async () => {
    const { rows } = await q(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name`,
      [["academy_owners", "instructor_affiliations", "instructor_delegations", "instructor_invites"]],
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "academy_owners",
      "instructor_affiliations",
      "instructor_delegations",
      "instructor_invites",
    ]);
  });

  test("② 외래 키가 설계한 대상 표를 가리킨다", async () => {
    // 표.칸 → 대상 표 목록을 카탈로그에서 읽는다.
    const { rows } = await q(
      `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confrelid::regclass::text AS ref
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY($1)
       ORDER BY 1, 2`,
      [["academy_owners", "instructor_affiliations", "instructor_delegations", "instructor_invites"]],
    );
    expect(rows.map((r) => `${r.tbl}.${r.col} -> ${r.ref}`)).toEqual([
      "academy_owners.academy_id -> academies",
      "academy_owners.staff_account_id -> staff_accounts",
      "instructor_affiliations.academy_id -> academies",
      "instructor_affiliations.instructor_account_id -> staff_accounts",
      "instructor_affiliations.invite_id -> instructor_invites",
      "instructor_delegations.affiliation_id -> instructor_affiliations",
      "instructor_invites.academy_id -> academies",
    ]);
  });

  test("② 없는 학원을 가리키는 대표 행은 거부한다", async () => {
    await expectViolation(
      q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [
        randomUUID(),
        ownerAccount,
      ]),
      "academy_owners_academy_id_fkey",
    );
  });

  test("② 없는 직원 계정을 가리키는 소속 행은 거부한다", async () => {
    await expectViolation(insertAffiliation({ instructorId: randomUUID() }), "instructor_affiliations_instructor_account_id_fkey");
  });

  test("② 없는 초대를 가리키는 소속 행은 거부한다", async () => {
    await expectViolation(
      insertAffiliation({ source: "invite", inviteId: randomUUID() }),
      "instructor_affiliations_invite_id_fkey",
    );
  });

  test("② 없는 소속을 가리키는 위임 행은 거부한다", async () => {
    await expectViolation(
      q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'roster_manage', $2)", [
        randomUUID(),
        ownerAccount,
      ]),
      "instructor_delegations_affiliation_id_fkey",
    );
  });

  test("③ 위임은 roster_manage·class_manage·class_submit 만 받고, 같은 위임은 한 번만 켠다", async () => {
    const { rows } = await insertAffiliation({ status: "active" });
    const affiliationId = rows[0].id as string;
    const grant = (permission: string) =>
      q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        affiliationId,
        permission,
        ownerAccount,
      ]);

    await grant("roster_manage");
    await grant("class_manage");
    // 앱 「수업 등록 권한」(O31)은 웹 위임 2종과 별개의 값으로 받는다(2026-11-20 결정 D3 · 마이그레이션 20261121T0119_delegation_class_submit)
    await grant("class_submit");
    // 옛 3종 값·매출 위임은 DB 가 받지 않는다.
    for (const banned of ["roster_view", "headcount_manage", "settlement_view"]) {
      await expectViolation(grant(banned), "instructor_delegations_permission_check");
    }
    await expectViolation(grant("roster_manage"), "instructor_delegations_pkey");

    const { rows: on } = await q(
      "SELECT permission FROM instructor_delegations WHERE affiliation_id = $1 ORDER BY permission",
      [affiliationId],
    );
    expect(on.map((r) => r.permission)).toEqual(["class_manage", "class_submit", "roster_manage"]);
  });

  test("④ 학원당 active 대표는 한 명이고, 물러난(ended) 대표 행은 여럿 남는다", async () => {
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyB, ownerAccount]);
    await expectViolation(
      q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyB, otherInstructor]),
      "uq_academy_owners_active",
    );
    await q(
      "INSERT INTO academy_owners (id, academy_id, staff_account_id, status, ended_at) VALUES (uuidv7(), $1, $2, 'ended', now())",
      [academyB, otherInstructor],
    );
    await expectViolation(
      q("INSERT INTO academy_owners (id, academy_id, staff_account_id, status) VALUES (uuidv7(), $1, $2, 'retired')", [
        academyB,
        otherInstructor,
      ]),
      "academy_owners_status_check",
    );
  });

  test("④ 같은 학원·같은 강사에 열린(대기·소속) 소속은 하나뿐이고, 끝난 행은 몇 개든 된다", async () => {
    await insertAffiliation({ academyId: academyB, instructorId: otherInstructor, status: "pending" });
    await expectViolation(
      insertAffiliation({ academyId: academyB, instructorId: otherInstructor, status: "active" }),
      "uq_affiliations_open",
    );
    await insertAffiliation({ academyId: academyB, instructorId: otherInstructor, status: "withdrawn" });
    await insertAffiliation({ academyId: academyB, instructorId: otherInstructor, status: "released" });
  });

  test("④ 초대 경로는 초대 id 와, 거절은 사유 코드와 짝이 맞아야 한다", async () => {
    await expectViolation(insertAffiliation({ instructorId: otherInstructor, source: "invite" }), "ck_aff_source_invite");
    await expectViolation(
      insertAffiliation({ instructorId: otherInstructor, status: "rejected" }),
      "ck_aff_rejected",
    );
    await expectViolation(
      insertAffiliation({ instructorId: otherInstructor, status: "rejected", rejectReason: "too_busy" }),
      "instructor_affiliations_reject_reason_code_check",
    );
    await insertAffiliation({ instructorId: otherInstructor, status: "rejected", rejectReason: "genre_mismatch" });

    const { rows } = await insertInvite(`hash-${randomUUID()}`);
    await insertAffiliation({ instructorId: otherInstructor, source: "invite", inviteId: rows[0].id as string });
  });

  test("④ 초대는 토큰 해시가 겹치지 않고, 사용 시각과 사용자가 짝으로 채워진다", async () => {
    const token = `hash-${randomUUID()}`;
    await insertInvite(token);
    await expectViolation(insertInvite(token), "uq_invites_token_hash");
    await insertInvite(`hash-${randomUUID()}`, true);
    await expectViolation(
      q(
        `INSERT INTO instructor_invites (id, academy_id, created_by_account_id, token_hash, expires_at, used_at)
         VALUES (uuidv7(), $1, $2, $3, now() + interval '7 days', now())`,
        [academyA, ownerAccount, `hash-${randomUUID()}`],
      ),
      "ck_invites_used",
    );
  });
});
