// vitest 설정 — 프로젝트 2개로 나눈다(plan D11).
//   unit : DB 없이 도는 순수 로직 테스트. 병렬로 빠르게 돈다.
//   db   : 파일 이름이 `*.db.test.ts` 인 테스트. 테스트 DB(kdance_next_test)를 실제로 쓰므로
//          파일을 하나씩 차례로 돌린다(fileParallelism: false). DB 에 못 붙으면 전부 건너뛴다.
// `.env` 를 여기서 먼저 읽어 두면 globalSetup 과 테스트 워커가 같은 환경 변수를 본다.
import "dotenv/config";

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  resolve: {
    // tsconfig 의 `@/*` 경로 별칭과 같게 맞춘다.
    alias: { "@": root },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/**/*.db.test.ts", "node_modules/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["tests/**/*.db.test.ts"],
          globalSetup: ["tests/setup/global-setup.ts"],
          // 앱 코드의 싱글턴 `db`(prisma/db.ts)는 DATABASE_URL 로 풀을 만든다. 테스트 워커에서는
          // 그것이 개발 DB 가 아니라 테스트 DB 를 가리키도록 덮어쓴다(TEST_DATABASE_URL 이 있을 때만).
          env: process.env["TEST_DATABASE_URL"] ? { DATABASE_URL: process.env["TEST_DATABASE_URL"] } : {},
          fileParallelism: false,
          // 잠금 대기·동시 20건 같은 실측이 있어 기본 5초보다 넉넉히 둔다.
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
