// 테스트 DB 를 안전하게 비우고 현재 계약대로 다시 올리는 도우미(리뷰 M-3·M-2).
// global-setup.ts 가 쓴다. DB 에 붙는 일(비우기)과 순수한 일(이름 검사·메시지 만들기)을 나눠
// 순수한 쪽은 DB 없이 단위 테스트할 수 있게 했다.
import { execFileSync } from "node:child_process";

import pg from "pg";

// 안전 가드: 테스트는 접속한 DB 를 통째로 비운다(DROP SCHEMA).
// 주소를 잘못 적어 개발 DB(kdance_next)를 가리키면 개발 데이터가 사라지므로,
// DB 이름이 `_test` 로 끝나지 않으면 연결하기도 전에 멈춘다. skip 이 아니라 실패다.
// 오류 메시지에는 주소 전체(비밀번호 포함)를 싣지 않고 DB 이름만 싣는다.
export function assertTestDatabaseName(url: string): void {
  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("TEST_DATABASE_URL 을 해석할 수 없습니다. postgresql://사용자:비밀번호@호스트:포트/DB이름_test 형식이어야 합니다.");
  }
  if (!dbName.endsWith("_test")) {
    throw new Error(
      `TEST_DATABASE_URL 의 DB 이름 "${dbName}" 이 "_test" 로 끝나지 않습니다. ` +
        "테스트는 스키마를 통째로 지우므로 개발 DB 에는 쓸 수 없습니다. 테스트 전용 DB(예: kdance_next_test)를 가리키게 고치세요.",
    );
  }
}

// CLI 가 실패하면 execFileSync 는 stdio 를 pipe 로 받은 탓에 사유가 오류 객체의 stderr 에만 남는다.
// 그걸 메시지에 붙여, 테스트 로그만 봐도 「왜 거부됐는지」 보이게 한다.
export function describeCliFailure(label: string, error: unknown): string {
  if (!(error instanceof Error)) return `${label} 실패: ${String(error)}`;
  const e = error as Error & { status?: number | null; stderr?: Buffer | string; stdout?: Buffer | string };
  const text = (v: Buffer | string | undefined) => (v ? v.toString().trim() : "");
  return [
    `${label} 실패 (종료 코드 ${e.status ?? "알 수 없음"}): ${e.message}`,
    `--- stderr ---\n${text(e.stderr) || "(비어 있음)"}`,
    `--- stdout ---\n${text(e.stdout) || "(비어 있음)"}`,
  ].join("\n");
}

// 테스트 DB 의 스키마를 비운다. 반드시 가드(assertTestDatabaseName)를 통과한 주소에만 쓴다.
// 왜 비우나: 계약이 바뀌면 `prisma db update` 가 데이터를 잃는 변경(칸 삭제·이름 변경)을 거부해
// DB 테스트 전체가 멈춘다. 테스트 DB 는 버려도 되는 DB 라 매번 비우고 계약대로 새로 올린다.
// prisma_contract 는 Prisma 가 계약 표식을 두는 스키마라 함께 지운다.
export async function resetTestSchema(url: string): Promise<void> {
  assertTestDatabaseName(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS prisma_contract CASCADE");
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end().catch(() => undefined);
  }
}

// 마이그레이션 폴더(migrations/app)를 순서대로 빈 DB 에 적용한다. 실패하면 CLI 의 stderr 를 붙여 던진다.
// 왜 `db update` 가 아니라 이걸 쓰나: 감사 기록의 수정·삭제 차단 트리거는 계약(contract.prisma)으로 표현되지 않고
// 마이그레이션의 rawSql 에만 있다. 계약만 올리면 트리거가 빠진 채로 테스트가 돌아 실제 DB 와 달라진다.
export function applyMigrations(url: string, adminWebRoot: string): void {
  assertTestDatabaseName(url);
  try {
    execFileSync("./node_modules/.bin/prisma", ["db", "migrate", "--db", url, "--yes"], {
      cwd: adminWebRoot,
      stdio: "pipe",
      env: { ...process.env, DO_NOT_TRACK: "1", PRISMA_DISABLE_TELEMETRY: "1" },
    });
  } catch (error) {
    throw new Error(describeCliFailure("prisma db migrate", error));
  }
}

// 현재 계약(prisma/contract.json)대로 빈 DB 에 스키마를 올린다. 실패하면 CLI 의 stderr 를 붙여 던진다.
export function applyContract(url: string, adminWebRoot: string): void {
  assertTestDatabaseName(url);
  try {
    execFileSync("./node_modules/.bin/prisma", ["db", "update", "--db", url, "--yes"], {
      cwd: adminWebRoot,
      stdio: "pipe",
      env: { ...process.env, DO_NOT_TRACK: "1", PRISMA_DISABLE_TELEMETRY: "1" },
    });
  } catch (error) {
    throw new Error(describeCliFailure("prisma db update", error));
  }
}
