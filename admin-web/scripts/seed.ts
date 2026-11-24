// `npm run db:seed` — 표준 시드(학원 1·정규 수업 1·8회차·남 6 여 6)를 「테스트 DB」에 넣는다.
// 개발 DB(kdance_next)에는 넣지 않는다: 이 데이터는 테스트 픽스처이고 화면이 읽는 데이터가 아니다
// (실제 학원·수업은 S1-1·S2-2 가 만든다). 그래서 DB 이름이 `_test` 로 끝나는 주소만 받는다.
// 같은 명령을 여러 번 돌려도 결과가 같다(고정 id + ON CONFLICT DO NOTHING).
import "dotenv/config";

import pg from "pg";

import { insertSeedFixtures } from "../tests/fixtures/seed-fixtures.ts";
import { assertTestDatabaseName } from "../tests/setup/test-database.ts";

const url = process.env["TEST_DATABASE_URL"];
if (!url) {
  console.error("TEST_DATABASE_URL 이 없습니다. admin-web/.env 에 테스트 DB 주소를 적으세요(.env.example 참고).");
  process.exit(1);
}
// 개발 DB 에 실수로 넣지 않도록 이름 가드를 먼저 통과시킨다.
assertTestDatabaseName(url);

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const summary = await insertSeedFixtures(pool);
  console.log(
    `시드 완료: 학원 1 · 수업 1 · 회차 ${summary.sessionIds.length} · 자리 묶음 2 · 남 ${summary.maleMemberIds.length} 여 ${summary.femaleMemberIds.length}`,
  );
} catch (error) {
  // 스키마가 없으면(테스트를 한 번도 안 돌린 DB) 여기로 온다 — 먼저 `npm run test:db` 로 스키마를 올린다.
  console.error("시드 실패:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
