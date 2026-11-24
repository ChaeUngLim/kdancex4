// Prisma 8 런타임 입구 — 서버 코드는 모두 여기서 `db` 를 가져다 쓴다(plan D3·D17).
//
// 왜 풀(pg.Pool)을 직접 만드나(BYO 풀):
//   Prisma 8 은 `url` 을 주면 풀을 스스로 만든다. 하지만 Better Auth(Kysely)와 대체 경로
//   `withPgTransaction` 도 같은 DB 연결을 써야 한다. 풀을 하나만 만들어 셋이 나눠 쓰면
//   접속 수가 두 배로 늘지 않고, 풀의 생명주기(닫기)도 우리 손에 있다(runtime.md 「Ownership」).
//
// 주의: `db.close()` 는 우리가 넘긴 풀을 닫지 않는다. 스크립트·테스트는 `pool.end()` 까지 불러야 끝난다.

// Node 24 에는 전역 Temporal 이 없다 → 첫 쿼리 전에 폴리필을 전역에 심는다(data-model §0 「시각」).
// 이 import 가 빠지면 시각 칸을 읽을 때 RUNTIME.TEMPORAL_UNAVAILABLE 가 난다.
import "temporal-polyfill/full/global";

import postgres, { type PostgresBindingOptions } from "@prisma/orm-postgres/runtime";
import { contractFromJson } from "@prisma/orm-postgres/static";
import { Pool, type PoolClient } from "pg";

import type { Contract } from "./contract.d";
import contractJson from "./contract.json" with { type: "json" };

// 계약 JSON 을 한 번만 검증해 타입을 붙인다. Contract 타입 인자는 여기 한 곳에만 쓴다.
export const contract = contractFromJson<Contract>(contractJson);

/**
 * 접속 문자열로 풀과 Prisma 클라이언트를 한 쌍 만든다.
 * 앱은 아래 모듈 싱글턴을 쓰고, 테스트는 테스트 DB 주소로 이 함수를 따로 부른다.
 */
export function createDb(connectionString: string | undefined, options: { poolMax?: number } = {}) {
  // poolMax: 한 풀이 동시에 여는 DB 연결 수(pg 기본 10). 동시성 시험처럼 더 많은 연결이 필요할 때만 넘긴다.
  const pool = new Pool({ connectionString, max: options.poolMax });
  // 타입만 맞추는 변환이다. 실행되는 pg 는 한 벌(8.22.0)이지만, Prisma 는 자기 안에
  // @types/pg 8.20.4 를 고정해 두고 우리는 ^8.23.1 을 써서 두 Pool 타입이 서로 다르다고 나온다
  // (8.23 에 생긴 getTransactionStatus 하나 차이). 런타임 객체는 같은 클래스다.
  //
  // `unknown` 을 거치면 컴파일러가 아무 값이나 통과시키므로, 변환 전에 Prisma 가 실제로 쓰는
  // 최소 모양(connect·query·end)만은 satisfies 로 확인한다. Pool 이 아닌 값을 넘기면 여기서 막힌다.
  // 종료 조건: Prisma 가 @types/pg 를 우리 버전(^8.23)으로 올리면 이 변환을 지우고 pool 을 그대로 넘긴다.
  const checkedPool = pool satisfies Pick<Pool, "connect" | "query" | "end">;
  const client = postgres({ contract, pg: checkedPool as unknown as PrismaPgBinding });
  return { pool, db: client };
}

type PrismaPgBinding = NonNullable<PostgresBindingOptions["pg"]>;

export type Db = ReturnType<typeof createDb>["db"];

// 모듈 싱글턴 — 요청마다 새 풀을 만들면 접속 폭주가 난다(runtime.md Pitfall 8).
// 연결은 첫 쿼리 때 맺어지므로 DATABASE_URL 이 아직 없어도 import 는 실패하지 않는다.
//
// 개발 서버(next dev)는 파일을 저장할 때마다 이 모듈을 다시 평가한다. 그냥 `const` 로 만들면 그때마다
// 새 풀이 생기고 이전 풀은 연결(최대 10개)을 쥔 채 남는다. 그래서 `globalThis` 에 한 번만 만들어 두고
// 다시 평가돼도 같은 것을 재사용한다. 운영 빌드는 모듈을 한 번만 평가하므로 동작이 같다.
const globalForDb = globalThis as unknown as { __kdanceDb?: ReturnType<typeof createDb> };
const shared = (globalForDb.__kdanceDb ??= createDb(process.env["DATABASE_URL"]));
export const pool = shared.pool;
export const db = shared.db;

/**
 * 대체 경로(plan D3 3단계): Prisma 의 `db.transaction` 을 쓰지 않고 풀에서 연결 하나를 빌려
 * BEGIN/COMMIT 을 직접 한다. 콜백이 throw 하면 ROLLBACK 한다.
 *
 * T-M1-2(스파이크 판정, 2026-11-19): S-1~S-6 이 모두 통과해 기본 경로 — Prisma `db.transaction`
 * + 필요한 곳만 raw 레인 — 를 쓴다(근거: `_workspace/03_research.md` §3-1). 이 함수는 Prisma 의
 * 트랜잭션에 문제가 생겼을 때를 위한 비상용으로만 남긴다. 새 코드에서 부르지 않는다.
 */
export async function withPgTransaction<T>(
  targetPool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await targetPool.connect();
  // ROLLBACK 이 실패하면 그 연결의 상태를 알 수 없다(끊김 등). 풀에 돌려주면 다음 요청이 망가진 연결을
  // 받으므로, release(오류) 로 풀이 그 연결을 버리게 한다. 이 값이 undefined 이면 정상 반납이다.
  let discardReason: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // 롤백 자체가 실패해도 원래 오류를 던져야 원인을 잃지 않는다.
    await client.query("ROLLBACK").catch((rollbackError: unknown) => {
      discardReason = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    });
    throw error;
  } finally {
    client.release(discardReason);
  }
}
