// db 테스트 공용 도우미 — S0-M1(기반·스파이크)만 이 파일을 고친다(실행 규칙 「픽스처 소유」).
// 다른 Task 는 자기 픽스처를 tests/fixtures/<영역>.ts 에 새로 만들고, 이 파일은 읽기만 한다.
import { inject } from "vitest";
import type { Pool } from "pg";

import { createDb } from "../../prisma/db";

declare module "vitest" {
  export interface ProvidedContext {
    /** globalSetup 이 테스트 DB 에 붙었는지. false 면 db 테스트를 건너뛴다. */
    dbAvailable: boolean;
    /** 테스트 DB 접속 문자열(붙지 못했으면 빈 문자열). */
    testDatabaseUrl: string;
  }
}

export type TestDb = ReturnType<typeof createDb>;

/** `describe.skipIf(!dbAvailable())` 로 쓴다. */
export function dbAvailable(): boolean {
  return inject("dbAvailable");
}

/** 테스트 DB 용 풀 + Prisma 클라이언트 한 쌍. 끝나면 closeTestDb 로 닫는다. */
export function openTestDb(options: { poolMax?: number } = {}): TestDb {
  return createDb(inject("testDatabaseUrl"), options);
}

export async function closeTestDb(handle: TestDb): Promise<void> {
  // db.close() 는 우리가 넘긴 풀을 닫지 않는다(runtime.md 「Ownership」) — 풀은 따로 닫는다.
  await handle.db.close();
  await handle.pool.end();
}

/**
 * public 스키마의 모든 테이블을 비운다. 테스트마다 깨끗한 상태에서 시작하기 위해서다(plan D11).
 * 핸들러가 스스로 트랜잭션을 열기 때문에 「바깥 트랜잭션 롤백」 격리는 쓸 수 없어 테이블 비우기를 쓴다.
 * prisma_contract 스키마(계약 표식)는 건드리지 않는다.
 */
export async function truncateAll(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ name: string }>(
    "SELECT quote_ident(tablename) AS name FROM pg_tables WHERE schemaname = 'public'",
  );
  if (rows.length === 0) return;
  const tables = rows.map((r) => `public.${r.name}`).join(", ");
  // audit_logs 는 추가 전용이라 트리거가 TRUNCATE 도 막는다(S0-2.2). 테스트 DB 를 비울 때만 잠깐 꺼서 비우고 다시 켠다.
  // 한 연결에서 이어서 해야 하므로 전용 연결을 하나 빌려 쓴다.
  const hasAudit = rows.some((r) => r.name === "audit_logs");
  const client = await pool.connect();
  try {
    if (hasAudit) await client.query("ALTER TABLE public.audit_logs DISABLE TRIGGER USER");
    await client.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
    if (hasAudit) await client.query("ALTER TABLE public.audit_logs ENABLE TRIGGER USER");
  } finally {
    client.release();
  }
}
