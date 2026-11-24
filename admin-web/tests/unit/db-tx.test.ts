// withPgTransaction(대체 트랜잭션 경로) 단위 테스트 — DB 불필요, 가짜 풀·연결을 쓴다.
// 리뷰 L-2: ROLLBACK 이 실패한 연결은 상태를 알 수 없으므로 풀에 돌려주지 않고 버려야 한다.
import { describe, expect, test } from "vitest";
import type { Pool, PoolClient } from "pg";

import { withPgTransaction } from "../../prisma/db";

// 호출 기록을 남기는 가짜 연결. failOn 에 적힌 SQL 은 실패한다.
function makeFakePool(failOn: string[] = []) {
  const queries: string[] = [];
  const released: Array<Error | boolean | undefined> = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (failOn.includes(sql)) throw new Error(`${sql} 실패`);
      return { rows: [] };
    },
    release: (arg?: Error | boolean) => {
      released.push(arg);
    },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, queries, released };
}

describe("withPgTransaction", () => {
  test("성공하면 COMMIT 하고 연결을 정상 반납한다", async () => {
    const { pool, queries, released } = makeFakePool();
    const result = await withPgTransaction(pool, async () => 42);
    expect(result).toBe(42);
    expect(queries).toEqual(["BEGIN", "COMMIT"]);
    expect(released).toEqual([undefined]);
  });

  test("콜백이 throw 하면 ROLLBACK 하고 연결을 정상 반납한다", async () => {
    const { pool, queries, released } = makeFakePool();
    await expect(
      withPgTransaction(pool, async () => {
        throw new Error("원래 오류");
      }),
    ).rejects.toThrow("원래 오류");
    expect(queries).toEqual(["BEGIN", "ROLLBACK"]);
    expect(released).toEqual([undefined]);
  });

  test("ROLLBACK 이 실패하면 원래 오류를 던지고 연결을 오류와 함께 폐기한다", async () => {
    const { pool, released } = makeFakePool(["ROLLBACK"]);
    await expect(
      withPgTransaction(pool, async () => {
        throw new Error("원래 오류");
      }),
    ).rejects.toThrow("원래 오류");
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });

  test("COMMIT 이 실패하면 ROLLBACK 을 시도한다", async () => {
    const { pool, queries } = makeFakePool(["COMMIT"]);
    await expect(withPgTransaction(pool, async () => 1)).rejects.toThrow("COMMIT 실패");
    expect(queries).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
  });
});
