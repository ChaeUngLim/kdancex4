// db 프로젝트의 globalSetup — 테스트 파일이 돌기 전에 한 번 실행된다(plan D11).
//
// 하는 일:
//   1) TEST_DATABASE_URL 로 접속을 시도한다. 실패하면 `dbAvailable=false` 를 넘겨
//      db 테스트 전체가 건너뛰게 한다(옛 backend conftest 의 requires_db 와 같은 규칙).
//   2) 접속되면 가드(DB 이름이 _test 로 끝나는지) 뒤에 스키마를 비우고 마이그레이션(migrations/app)을 처음부터 다시 적용한다.
//
// 왜 비우고 올리나: `db update` 는 칸 삭제 같은 데이터 손실 변경을 사람이 답해야 하는 질문으로 막는다.
// 테스트 DB 는 버려도 되는 DB 라 매번 비우면 계약이 어떻게 바뀌어도 멈추지 않는다.
// 2026-11-19 마이그레이션 파일이 생겨(S0-2.1·S0-2.2) 이 단계를 `prisma db migrate` 로 바꿨다 — 트리거 같은 계약 밖 SQL 까지 올리려는 것이다.
import { fileURLToPath } from "node:url";

import pg from "pg";
import type { TestProject } from "vitest/node";

import { applyMigrations, assertTestDatabaseName, resetTestSchema } from "./test-database";

const CONNECT_TIMEOUT_MS = 3_000;
const adminWebRoot = fileURLToPath(new URL("../../", import.meta.url));

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const url = process.env["TEST_DATABASE_URL"];
  // 가드는 접속·스키마 변경보다 먼저 돈다.
  if (url) assertTestDatabaseName(url);
  if (!url || !(await canConnect(url))) {
    // DB 가 없으면 skip — 실패가 아니라 「검증 안 됨」이다. 완료 판정 전에는 DB 를 띄워 다시 돌린다.
    project.provide("dbAvailable", false);
    project.provide("testDatabaseUrl", "");
    return;
  }

  // 가드를 통과한 테스트 DB 를 비우고 마이그레이션을 처음부터 다시 적용한다(리뷰 M-3). 실패하면 stderr 가 메시지에 붙는다.
  await resetTestSchema(url);
  applyMigrations(url, adminWebRoot);

  project.provide("dbAvailable", true);
  project.provide("testDatabaseUrl", url);
}
