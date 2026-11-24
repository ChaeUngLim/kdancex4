// Prisma 8 프로젝트 설정 — CLI(`prisma contract emit` · `db update` · `db migrate`)가 읽는다.
// 계약 원본은 `prisma/contract.prisma`, 마이그레이션은 `migrations/app/` 에 쌓인다(plan D17).
// `dotenv/config` 가 `.env` 를 읽어 DATABASE_URL 을 채운다 — 접속 문자열을 이 파일에 직접 쓰지 않는다.
import "dotenv/config";
import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";

export default definePrismaConfig({
  orm: ormConfig({
    contract: "./prisma/contract.prisma",
    db: {
      connection: process.env["DATABASE_URL"]!,
    },
    migrations: { dir: "migrations" },
  }),
});
