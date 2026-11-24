// S1-4.1(학원 공지·받는 사람 테이블 묶음) — 학원 공지 표 두 개가 설계(data-model §7-6 끝)대로 생겼는지 실제 PostgreSQL 에서 확인한다.
// 확인하는 것:
//   ① 초안은 status 를 빼고 넣어도 draft 로 채워지고, 올린 시각·받는 사람 수는 비어 있다
//   ② ck_staff_notice_published — 「올렸는데 시각 없음」·「초안인데 시각 있음」을 DB 가 거부한다
//   ③ 분류는 휴강·수업 변경·학원 일정·기타 넷, 상태는 초안·올림 둘만 된다
//   ④ 제목은 1~100자만 된다
//   ⑤ 받는 사람 표 — 한 공지에 같은 강사는 한 번만, 실제 공지·실제 직원 계정만, 읽음 시각은 처음에 비어 있다
//   ⑥ 학원·쓴 사람은 실제 행만 되고, 「이 학원 최근 공지」 조회가 ix_staff_notices_academy_pub 색인으로 찾아진다
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { STAFF_NOTICE_CATEGORIES, STAFF_NOTICE_STATUSES } from "../../lib/domain/constants";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("학원 공지·받는 사람 표", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 행 id — 끝나고 이것만 지운다.
  const academy = randomUUID();
  const owner = randomUUID();
  const instructorA = randomUUID();
  const instructorB = randomUUID();

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

  // 공지 한 줄. 넘긴 칸만 덮어쓴다 — status·published_at 을 빼면 DB 기본값이 채워지는지 볼 수 있다.
  const insertNotice = async (row: Record<string, unknown> = {}) => {
    const full: Record<string, unknown> = {
      id: randomUUID(),
      academy_id: academy,
      author_account_id: owner,
      category: "class_cancelled",
      title: "이번 주 토요일 휴강",
      body: "토요일 수업은 쉽니다.",
      updated_at: new Date(),
      ...row,
    };
    const cols = Object.keys(full);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    const result = await q(
      `INSERT INTO academy_staff_notices (${cols.join(", ")}) VALUES (${marks}) RETURNING id`,
      cols.map((k) => full[k]),
    );
    return result.rows[0].id as string;
  };

  const insertRecipient = (noticeId: string, instructorId: string) =>
    q("INSERT INTO academy_staff_notice_recipients (notice_id, instructor_account_id) VALUES ($1, $2)", [
      noticeId,
      instructorId,
    ]);

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

  beforeAll(async () => {
    handle = openTestDb();
    for (const [id, name] of [
      [owner, "공지 시험 대표"],
      [instructorA, "공지 시험 강사 A"],
      [instructorB, "공지 시험 강사 B"],
    ]) {
      await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, $3, now())", [
        id,
        `staff-notice-${id}`,
        name,
      ]);
    }
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '공지 시험 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
      [academy],
    );
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 자식부터 지운다: 받는 사람 → 공지 → 학원·계정.
    await q(
      "DELETE FROM academy_staff_notice_recipients WHERE notice_id IN (SELECT id FROM academy_staff_notices WHERE academy_id = $1)",
      [academy],
    );
    await q("DELETE FROM academy_staff_notices WHERE academy_id = $1", [academy]);
    await q("DELETE FROM academies WHERE id = $1", [academy]);
    await q("DELETE FROM staff_accounts WHERE id = ANY($1)", [[owner, instructorA, instructorB]]);
    await closeTestDb(handle);
  });

  test("① 상태를 빼고 넣으면 초안(draft)이고, 올린 시각·받는 사람 수는 비어 있다", async () => {
    const id = await insertNotice();
    const { rows } = await q("SELECT status, published_at, recipient_count FROM academy_staff_notices WHERE id = $1", [id]);
    expect(rows[0]).toEqual({ status: "draft", published_at: null, recipient_count: null });
  });

  test("② ck_staff_notice_published — 상태와 올린 시각이 어긋나면 거부한다", async () => {
    // 올렸다면서 시각이 없다 → 거부.
    await expectViolation(insertNotice({ status: "published" }), "ck_staff_notice_published");
    // 초안인데 시각이 있다 → 거부.
    await expectViolation(insertNotice({ status: "draft", published_at: new Date() }), "ck_staff_notice_published");

    // 맞는 짝은 들어간다: 올림 + 시각 + 받는 사람 수.
    const id = await insertNotice({ status: "published", published_at: new Date(), recipient_count: 2 });
    // 이미 있는 초안을 올리면서 시각을 빠뜨린 갱신도 거부한다(올리기 트랜잭션의 실수를 DB 가 막는다).
    const draft = await insertNotice();
    await expectViolation(
      q("UPDATE academy_staff_notices SET status = 'published' WHERE id = $1", [draft]),
      "ck_staff_notice_published",
    );
    const { rows } = await q("SELECT status, recipient_count FROM academy_staff_notices WHERE id = $1", [id]);
    expect(rows[0]).toEqual({ status: "published", recipient_count: 2 });
  });

  test("③ 분류 넷·상태 둘만 된다", async () => {
    expect([...STAFF_NOTICE_CATEGORIES]).toEqual(["class_cancelled", "class_changed", "academy_schedule", "other"]);
    expect([...STAFF_NOTICE_STATUSES]).toEqual(["draft", "published"]);
    for (const category of STAFF_NOTICE_CATEGORIES) {
      await insertNotice({ category });
    }
    await expectViolation(insertNotice({ category: "event" }), "academy_staff_notices_category_check");
    // 「지움」·「보관」 같은 상태는 없다 — 올린 공지는 고치지도 지우지도 않는다.
    await expectViolation(insertNotice({ status: "archived" }), "academy_staff_notices_status_check");
  });

  test("④ 제목은 1~100자만 된다", async () => {
    await insertNotice({ title: "가".repeat(100) });
    await insertNotice({ title: "가" });
    await expectViolation(insertNotice({ title: "" }), "ck_staff_notice_title_length");
    await expectViolation(insertNotice({ title: "가".repeat(101) }), "ck_staff_notice_title_length");
  });

  test("⑤ 받는 사람 — 같은 강사 중복 거부, 실제 공지·계정만, 읽음 시각은 처음에 비어 있다", async () => {
    const notice = await insertNotice({ status: "published", published_at: new Date(), recipient_count: 2 });
    await insertRecipient(notice, instructorA);
    await insertRecipient(notice, instructorB);
    // 한 공지에 같은 강사를 두 번 넣으면 기본 키(notice_id, instructor_account_id)가 막는다.
    await expectViolation(insertRecipient(notice, instructorA), "academy_staff_notice_recipients_pkey");
    // 없는 공지·없는 계정은 외래 키가 막는다.
    await expectViolation(
      insertRecipient(randomUUID(), instructorA),
      "academy_staff_notice_recipients_notice_id_fkey",
    );
    await expectViolation(
      insertRecipient(notice, randomUUID()),
      "academy_staff_notice_recipients_instructor_account_id_fkey",
    );

    const { rows } = await q(
      "SELECT instructor_account_id, read_at FROM academy_staff_notice_recipients WHERE notice_id = $1 ORDER BY instructor_account_id",
      [notice],
    );
    expect(rows).toEqual(
      [instructorA, instructorB].sort().map((id) => ({ instructor_account_id: id, read_at: null })),
    );

    // 받는 사람이 남아 있는 공지는 지울 수 없다(Restrict — 이력을 연쇄 삭제하지 않는다).
    await expectViolation(
      q("DELETE FROM academy_staff_notices WHERE id = $1", [notice]),
      "academy_staff_notice_recipients_notice_id_fkey",
    );
  });

  test("⑥ 학원·쓴 사람은 실제 행만 되고, 학원별 최근 공지 조회가 ix_staff_notices_academy_pub 를 쓴다", async () => {
    await expectViolation(insertNotice({ academy_id: randomUUID() }), "academy_staff_notices_academy_id_fkey");
    await expectViolation(
      insertNotice({ author_account_id: randomUUID() }),
      "academy_staff_notices_author_account_id_fkey",
    );

    const plan = await planOf(
      "SELECT id FROM academy_staff_notices WHERE academy_id = $1 AND status = 'published' ORDER BY published_at DESC LIMIT 20",
      [academy],
    );
    expect(plan).toContain("ix_staff_notices_academy_pub");
  });
});
