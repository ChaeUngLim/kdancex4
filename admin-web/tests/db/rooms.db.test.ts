// S1-2.3(강의실 테이블) — 강의실 표(rooms)가 data-model §7-3 대로 실제 PostgreSQL 에 있는지 확인한다.
// 확인하는 것:
//   ① 칸 목록          — rooms 의 칸이 §7-3 목록과 정확히 같다
//   ② uq_rooms_branch_name — 같은 지점의 쓰는 중(active) 강의실 이름은 겹칠 수 없다.
//                         다른 지점은 같은 이름이 되고, 보관(archived)한 강의실 이름은 다시 쓸 수 있다
//   ③ status 기본값     — 상태를 안 적고 넣으면 active 다. 정해진 두 값 밖은 거부한다
//   ④ ck_rooms_base_capacity — 기본 정원은 비워 둘 수 있지만, 적으면 1명 이상이다
//   ⑤ 겹침 제약 없음    — 시간 겹침은 M2 의 class_sessions 가 막는다(data-model §8 결정 ②). rooms 에는 EXCLUDE 가 없다
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";

// data-model §7-3 의 rooms 칸 목록. 이 목록이 설계 원본과 DB 를 잇는 짝이다.
const DESIGNED_COLUMNS = [
  "id",
  "branch_id",
  "name",
  "size_sqm",
  "base_capacity",
  "facilities",
  "status",
  "created_at",
  "updated_at",
];

describe.skipIf(!dbAvailable())("강의실 표(rooms)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 행의 id — 끝나고 이것만 지운다.
  const academyId = randomUUID();
  const branchA = randomUUID();
  const branchB = randomUUID();

  // 제약 위반이면 PostgreSQL 오류의 constraint 칸에 제약 이름이 담긴다(이름 뒤에 해시가 붙으므로 포함 여부로 본다).
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 상태를 적지 않고 강의실을 하나 넣는다 — 기본값이 무엇인지 보려고 status 칸을 일부러 뺐다.
  const insertRoom = (branchId: string, name: string, capacity: number | null = null) =>
    q(
      `INSERT INTO rooms (id, branch_id, name, base_capacity, updated_at)
       VALUES (uuidv7(), $1, $2, $3, now()) RETURNING id, status`,
      [branchId, name, capacity],
    );

  beforeAll(async () => {
    handle = openTestDb();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS}) VALUES ($1, '강의실 시험 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    // 같은 학원에 지점 둘 — 「같은 지점」과 「다른 지점」을 나눠 보려고.
    for (const [id, name] of [
      [branchA, '홍대점'],
      [branchB, '강남점'],
    ]) {
      await q(
        `INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at)
         VALUES ($1, $2, $3, '서울 시험 주소', '서울', '마포구', now())`,
        [id, academyId, name],
      );
    }
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 자식부터 지운다: 강의실 → 지점 → 학원.
    await q("DELETE FROM rooms WHERE branch_id = ANY($1)", [[branchA, branchB]]);
    await q("DELETE FROM academy_branches WHERE academy_id = $1", [academyId]);
    await q("DELETE FROM academies WHERE id = $1", [academyId]);
    await closeTestDb(handle);
  });

  test("① rooms 의 칸이 data-model §7-3 목록과 정확히 같다", async () => {
    const { rows } = await q(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'rooms'`,
    );
    const actual = rows.map((r) => r.column_name as string);
    expect(actual.sort()).toEqual([...DESIGNED_COLUMNS].sort());
  });

  test("③ status 를 적지 않으면 active 로 들어간다", async () => {
    const { rows } = await insertRoom(branchA, "A홀", 20);
    expect(rows[0].status).toBe("active");
  });

  test("② uq_rooms_branch_name — 같은 지점에 같은 이름의 강의실은 거부한다", async () => {
    // ③ 이 홍대점에 「A홀」을 이미 넣었다.
    await expectViolation(insertRoom(branchA, "A홀"), "uq_rooms_branch_name");
  });

  test("② 다른 지점에는 같은 이름을 쓸 수 있다", async () => {
    const { rows } = await insertRoom(branchB, "A홀");
    expect(rows).toHaveLength(1);
  });

  test("② 보관한 강의실의 이름은 같은 지점에서 다시 쓸 수 있다", async () => {
    await q("UPDATE rooms SET status = 'archived', updated_at = now() WHERE branch_id = $1 AND name = 'A홀'", [branchA]);
    const { rows } = await insertRoom(branchA, "A홀");
    expect(rows[0].status).toBe("active");
    // 보관 1개 + 새로 쓰는 1개가 함께 남는다(지난 수업 기록이 옛 강의실을 가리킬 수 있어 지우지 않는다).
    const { rows: all } = await q("SELECT status FROM rooms WHERE branch_id = $1 AND name = 'A홀' ORDER BY status", [branchA]);
    expect(all.map((r) => r.status)).toEqual(["active", "archived"]);
  });

  test("③ 정해진 두 값(active·archived) 밖의 상태는 거부한다", async () => {
    await expectViolation(
      q(`INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES (uuidv7(), $1, 'B홀', 'deleted', now())`, [branchA]),
      "rooms_status_check",
    );
  });

  test("④ ck_rooms_base_capacity — 기본 정원 0 은 거부하고, 비워 두는 것은 받는다", async () => {
    await expectViolation(insertRoom(branchA, "C홀", 0), "ck_rooms_base_capacity");
    const { rows } = await insertRoom(branchA, "D홀", null);
    expect(rows).toHaveLength(1);
  });

  test("없는 지점을 가리키는 강의실은 외래 키가 막는다", async () => {
    await expectViolation(insertRoom(randomUUID(), "E홀"), "rooms_branch_id_fkey");
  });

  test("⑤ rooms 에는 겹침(EXCLUDE) 제약이 없다 — M2 의 class_sessions 몫이다", async () => {
    const { rows } = await q(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'public.rooms'::regclass AND contype = 'x'`,
    );
    expect(rows).toHaveLength(0);
  });
});
