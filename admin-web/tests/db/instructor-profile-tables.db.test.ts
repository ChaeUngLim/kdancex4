// S2-1.1(강사 테이블) — 강사 표 네 개가 설계(data-model §8-3)대로 생겼는지 실제 PostgreSQL 에서 확인한다.
// 목표 「강사 프로필·활동 장르·가능 시간·사업자등록번호(선택)·본인확인 CI 칸이 있다」를 칸마다 확인한다.
// 확인하는 것:
//   ① 목표의 칸이 전부 있다 — 프로필·활동 장르·사업자등록번호(NULL 허용)·개인 일정(가능 시간)·직원 계정의 CI
//   ② 프로필은 계정 하나에 한 행, 실제 직원 계정·실제 파일만 가리킨다
//   ③ 활동 장르는 4장르 중 하나만 된다(FR-011b 한 장르 — 칸이 하나라 여러 개를 넣을 자리가 없다)
//   ④ 사업자등록번호는 비워도 되고(수용 ⑤), 넣으면 숫자 10자리만 된다. 번호 없이 등록증만 붙일 수 없다
//   ⑤ 소개 500자 · 경력 0~80년
//   ⑥ 본인확인 CI — 같은 CI 로 두 번째 직원 계정은 거부되고, 본인확인 전(NULL) 계정은 여럿이어도 된다(수용 ④)
//   ⑦ 활동 지역은 같은 지역 두 번 거부, 자격·대회는 종류 둘·이름 1~100자·종류 안 순서 번호 하나
//   ⑧ 개인 일정(가능 시간) — 반복 기본값 none, 끝 > 시작, 제목 1~50자, 반복 안 하면 끝 날짜 없음, 기간 조회가 색인을 쓴다
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { GENRES, INSTRUCTOR_CREDENTIAL_KINDS, PERSONAL_EVENT_REPEATS } from "../../lib/domain/constants";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("강사 프로필·지역·자격·개인 일정 표", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 계정 id — 끝나고 이것만 지운다. 프로필은 계정 하나에 한 행이라 시험마다 새 계정을 쓴다.
  const accounts: string[] = [];
  const files: string[] = [];

  // 위반이 나야 하는 입력을 넣고, 그 제약 이름이 오류에 찍혔는지 본다.
  // 계약에서 만든 CHECK 는 이름 뒤에 8자리 해시가 붙어서 「포함」으로 비교한다.
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 직원 계정 하나를 만든다. CI 를 넘기면 본인확인을 끝낸 계정이다.
  const newAccount = async (ci: string | null = null) => {
    const id = randomUUID();
    accounts.push(id);
    await q(
      "INSERT INTO staff_accounts (id, auth_user_id, display_name, identity_ci_hash, updated_at) VALUES ($1, $2, '강사 시험', $3, now())",
      [id, `instr-profile-${id}`, ci],
    );
    return id;
  };

  // 올린 파일 하나. purpose 의 강사용 값(instructor_photo 등)은 이 Task 범위가 아니라 기존 값으로 외래 키만 본다.
  const newFile = async (owner: string, purpose = "merchant_evidence") => {
    const id = randomUUID();
    files.push(id);
    await q(
      `INSERT INTO uploaded_files (id, uploader_account_id, purpose, visibility, storage_key, mime_type, size_bytes, sha256, display_name)
       VALUES ($1, $2, $3, 'private', $4, 'image/png', 100, 'x', '등록증.png')`,
      [id, owner, purpose, `instr-profile/${id}`],
    );
    return id;
  };

  // 프로필 한 줄. 넘긴 칸만 덮어쓴다 — 빼면 DB 기본값·NULL 이 들어가는지 볼 수 있다.
  const insertProfile = async (row: Record<string, unknown>) => {
    const full: Record<string, unknown> = {
      activity_genre: "salsa_bachata",
      signup_completed_at: new Date(),
      updated_at: new Date(),
      ...row,
    };
    const cols = Object.keys(full);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    await q(
      `INSERT INTO instructor_profiles (${cols.join(", ")}) VALUES (${marks})`,
      cols.map((k) => full[k]),
    );
  };

  const insertEvent = async (row: Record<string, unknown>) => {
    const full: Record<string, unknown> = {
      id: randomUUID(),
      title: "개인 연습",
      starts_at: new Date("2026-12-01T10:00:00Z"),
      ends_at: new Date("2026-12-01T12:00:00Z"),
      ...row,
    };
    const cols = Object.keys(full);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    const result = await q(
      `INSERT INTO instructor_personal_events (${cols.join(", ")}) VALUES (${marks}) RETURNING id`,
      cols.map((k) => full[k]),
    );
    return result.rows[0].id as string;
  };

  // 색인을 쓰는지 본다. 행이 적으면 플래너가 순차 탐색을 고르므로, 이 연결에서만 순차 탐색을 끄고 계획을 읽는다.
  const planOf = async (sql: string, params: unknown[]) => {
    const client = await handle.pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      const { rows } = await client.query(`EXPLAIN ${sql}`, params);
      return rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
    } finally {
      await client.query("RESET enable_seqscan");
      client.release();
    }
  };

  beforeAll(() => {
    handle = openTestDb();
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 자식부터 지운다: 강사 표 넷 → 파일 → 계정.
    for (const table of ["instructor_personal_events", "instructor_credentials", "instructor_regions", "instructor_profiles"]) {
      await q(`DELETE FROM ${table} WHERE staff_account_id = ANY($1)`, [accounts]);
    }
    await q("DELETE FROM uploaded_files WHERE id = ANY($1)", [files]);
    await q("DELETE FROM staff_accounts WHERE id = ANY($1)", [accounts]);
    await closeTestDb(handle);
  });

  test("① 목표의 칸이 전부 있다 — 프로필·활동 장르·사업자등록번호(선택)·가능 시간(개인 일정)·CI", async () => {
    const { rows } = await q(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND (table_name, column_name) IN (
         ('instructor_profiles', 'activity_genre'), ('instructor_profiles', 'bio'), ('instructor_profiles', 'career_years'),
         ('instructor_profiles', 'photo_file_id'), ('instructor_profiles', 'business_registration_number'),
         ('instructor_profiles', 'business_registration_file_id'), ('instructor_profiles', 'signup_completed_at'),
         ('instructor_personal_events', 'starts_at'), ('instructor_personal_events', 'ends_at'),
         ('instructor_personal_events', 'repeat_rule'), ('staff_accounts', 'identity_ci_hash'))
       ORDER BY table_name, column_name`,
    );
    const nullable = Object.fromEntries(rows.map((r) => [`${r.table_name}.${r.column_name}`, r.is_nullable]));
    expect(nullable).toEqual({
      "instructor_personal_events.ends_at": "NO",
      "instructor_personal_events.repeat_rule": "NO",
      "instructor_personal_events.starts_at": "NO",
      "instructor_profiles.activity_genre": "NO",
      "instructor_profiles.bio": "YES",
      "instructor_profiles.business_registration_file_id": "YES",
      // 사업자등록번호는 선택(수용 ⑤) — NULL 이 된다.
      "instructor_profiles.business_registration_number": "YES",
      "instructor_profiles.career_years": "YES",
      "instructor_profiles.photo_file_id": "YES",
      "instructor_profiles.signup_completed_at": "NO",
      // CI 는 직원 계정 칸이다 — 본인확인 전 계정은 NULL.
      "staff_accounts.identity_ci_hash": "YES",
    });
  });

  test("② 프로필은 계정 하나에 한 행이고, 실제 계정·실제 파일만 가리킨다", async () => {
    const account = await newAccount();
    // 사진은 다른 계정이 올린 파일로 둔다 — 아래 「계정 지우기」가 프로필 외래 키에서 걸리는지만 보려고.
    const photo = await newFile(await newAccount(), "academy_photo");
    await insertProfile({ staff_account_id: account, photo_file_id: photo });
    // 같은 계정에 두 번째 프로필 → 기본 키가 막는다.
    await expectViolation(insertProfile({ staff_account_id: account }), "instructor_profiles_pkey");
    // 없는 계정 · 없는 파일 → 외래 키가 막는다.
    await expectViolation(insertProfile({ staff_account_id: randomUUID() }), "instructor_profiles_staff_account_id_fkey");
    const other = await newAccount();
    await expectViolation(
      insertProfile({ staff_account_id: other, photo_file_id: randomUUID() }),
      "instructor_profiles_photo_file_id_fkey",
    );
    // 프로필이 남은 계정은 지울 수 없다(Restrict).
    await expectViolation(q("DELETE FROM staff_accounts WHERE id = $1", [account]), "instructor_profiles_staff_account_id_fkey");
  });

  test("③ 활동 장르는 4장르 중 하나만 된다", async () => {
    expect([...GENRES]).toEqual(["dance_sport", "argentine_tango", "swing", "salsa_bachata"]);
    for (const genre of GENRES) {
      await insertProfile({ staff_account_id: await newAccount(), activity_genre: genre });
    }
    await expectViolation(
      insertProfile({ staff_account_id: await newAccount(), activity_genre: "kpop" }),
      "instructor_profiles_activity_genre_check",
    );
    // 장르 없이 가입 완료된 프로필은 없다.
    await expectViolation(
      insertProfile({ staff_account_id: await newAccount(), activity_genre: null }),
      "activity_genre",
    );
  });

  test("④ 사업자등록번호는 비워도 되고, 넣으면 숫자 10자리만 — 번호 없이 등록증만 붙일 수 없다", async () => {
    // 비운 채 가입(수용 ⑤).
    const blank = await newAccount();
    await insertProfile({ staff_account_id: blank });
    const { rows } = await q(
      "SELECT business_registration_number, business_registration_file_id, marketing_opt_in_at FROM instructor_profiles WHERE staff_account_id = $1",
      [blank],
    );
    expect(rows[0]).toEqual({ business_registration_number: null, business_registration_file_id: null, marketing_opt_in_at: null });

    // 나중에 마이에서 번호·등록증을 넣는다.
    const file = await newFile(blank);
    await q(
      "UPDATE instructor_profiles SET business_registration_number = '1234567890', business_registration_file_id = $2 WHERE staff_account_id = $1",
      [blank, file],
    );

    for (const bad of ["123-45-67890", "123456789", "12345678901", "12345abcde"]) {
      await expectViolation(
        insertProfile({ staff_account_id: await newAccount(), business_registration_number: bad }),
        "ck_instr_profiles_brn",
      );
    }
    const noNumber = await newAccount();
    await expectViolation(
      insertProfile({ staff_account_id: noNumber, business_registration_file_id: await newFile(noNumber) }),
      "ck_instr_profiles_brn_file",
    );
  });

  test("⑤ 소개는 500자까지, 경력은 0~80년", async () => {
    await insertProfile({ staff_account_id: await newAccount(), bio: "가".repeat(500), career_years: 0 });
    await insertProfile({ staff_account_id: await newAccount(), career_years: 80 });
    await expectViolation(
      insertProfile({ staff_account_id: await newAccount(), bio: "가".repeat(501) }),
      "ck_instr_profiles_bio",
    );
    await expectViolation(insertProfile({ staff_account_id: await newAccount(), career_years: -1 }), "ck_instr_profiles_career");
    await expectViolation(insertProfile({ staff_account_id: await newAccount(), career_years: 81 }), "ck_instr_profiles_career");
  });

  test("⑥ 본인확인 CI — 같은 CI 로 두 번째 직원 계정은 거부, 본인확인 전(NULL) 계정은 여럿이어도 된다", async () => {
    const ci = `ci-${randomUUID()}`;
    await newAccount(ci);
    await expectViolation(newAccount(ci), "uq_staff_accounts_ci");
    await newAccount(null);
    await newAccount(null);
  });

  test("⑦ 활동 지역 중복 거부 · 자격·대회는 종류 둘, 이름 1~100자, 종류 안 순서 번호 하나", async () => {
    const account = await newAccount();
    const region = (sido: string, gu: string) =>
      q("INSERT INTO instructor_regions (staff_account_id, region_sido, region_gu) VALUES ($1, $2, $3)", [account, sido, gu]);
    await region("서울", "강남구");
    await region("서울", "마포구");
    await expectViolation(region("서울", "강남구"), "instructor_regions_pkey");

    expect([...INSTRUCTOR_CREDENTIAL_KINDS]).toEqual(["qualification", "competition"]);
    const credential = (kind: string, title: string, position: number) =>
      q("INSERT INTO instructor_credentials (id, staff_account_id, kind, title, position) VALUES ($1, $2, $3, $4, $5)", [
        randomUUID(),
        account,
        kind,
        title,
        position,
      ]);
    await credential("qualification", "생활스포츠지도사 2급", 0);
    // 종류가 다르면 같은 순서 번호를 써도 된다.
    await credential("competition", "2025 서울 오픈 라틴 1위", 0);
    await expectViolation(credential("qualification", "다른 자격", 0), "uq_instr_cred_position");
    await expectViolation(credential("award", "무엇", 1), "instructor_credentials_kind_check");
    await expectViolation(credential("qualification", "", 1), "ck_instr_cred_title");
    await expectViolation(credential("qualification", "가".repeat(101), 1), "ck_instr_cred_title");
  });

  test("⑧ 개인 일정(가능 시간) — 기본 반복 none, 끝 > 시작, 제목 1~50자, 반복 규칙, 기간 조회 색인", async () => {
    const account = await newAccount();
    expect([...PERSONAL_EVENT_REPEATS]).toEqual(["none", "weekly", "daily"]);

    const id = await insertEvent({ staff_account_id: account });
    const { rows } = await q("SELECT repeat_rule, repeat_until FROM instructor_personal_events WHERE id = $1", [id]);
    expect(rows[0]).toEqual({ repeat_rule: "none", repeat_until: null });

    // 매주 반복 · 끝나는 날 있음 / 없음(지울 때까지) 둘 다 된다.
    await insertEvent({ staff_account_id: account, repeat_rule: "weekly", repeat_until: "2027-02-28" });
    await insertEvent({ staff_account_id: account, repeat_rule: "daily" });

    await expectViolation(
      insertEvent({ staff_account_id: account, ends_at: new Date("2026-12-01T10:00:00Z") }),
      "ck_personal_time",
    );
    await expectViolation(insertEvent({ staff_account_id: account, title: "" }), "ck_personal_title");
    await expectViolation(insertEvent({ staff_account_id: account, title: "가".repeat(51) }), "ck_personal_title");
    await expectViolation(
      insertEvent({ staff_account_id: account, repeat_rule: "none", repeat_until: "2027-01-01" }),
      "ck_personal_repeat",
    );
    await expectViolation(insertEvent({ staff_account_id: account, repeat_rule: "monthly" }), "instructor_personal_events_repeat_rule_check");
    await expectViolation(insertEvent({ staff_account_id: randomUUID() }), "instructor_personal_events_staff_account_id_fkey");

    // 「이 강사의 이 기간 일정」 조회(겹침 판정·일정 화면)가 ix_personal_account_time 을 쓴다.
    const plan = await planOf(
      "SELECT id FROM instructor_personal_events WHERE staff_account_id = $1 AND starts_at < $2 ORDER BY starts_at",
      [account, new Date("2027-01-01T00:00:00Z")],
    );
    expect(plan).toContain("ix_personal_account_time");
  });
});
