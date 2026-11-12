# 요청 (2026-09-20)

## 원문
"Prisma 8 RC 스택 전환 해줘" — 기존 FastAPI 백엔드를 Next.js + Prisma 8 로 교체한다.

## 결정문
`docs/kdancex4_service_definition_and_tech_stack.md` 「11-3. 백엔드 교체」

| 대상 | 전 | 후 |
|---|---|---|
| API | FastAPI Route | Next.js Route Handler / Server Action |
| DB 접근 | SQLAlchemy 2 + psycopg3 | Prisma 8 (`@prisma/orm-postgres`) |
| 마이그레이션 | Alembic | `prisma migration` / `prisma db` |
| 테스트 | pytest 159개 | TypeScript 테스트로 재작성 |
| 배포 | 로컬 Docker | Vercel |

유지: PostgreSQL 18.6 + pgvector(스키마 그대로, 접근 계층만 교체) · mobile(Expo/RN, API 계약 유지) · `_workspace/` 기록 · 하네스 9단계 · ECC

## 이 세션에서 실측·확정된 전제 (2026-09-20, 추정 금지)

설치 완료 (admin-web):
```
next 16.3.5 · react 19.3.0 · typescript 7.0.2 · tailwindcss 4.3.3 (+@tailwindcss/postcss)
prisma 8.0.0-rc.15 (CLI) · @prisma/orm-postgres 8.0.0-rc.11 (런타임)
better-auth 1.7.5 · pg 8.22.0 · zod 4.6.5 · zustand 5.0.15 · @tanstack/react-query 5.103.1
ai 7.0.107 · @langchain/langgraph 1.4.16 · @langchain/core 1.2.12 · @modelcontextprotocol/sdk 1.30.0
```
런타임: Node 24.21.0 LTS (Krypton)
DB: PostgreSQL 18.6 + pgvector 0.8.6 (`pgvector/pgvector:0.8.6-pg18`)
    `postgresql://kdance:kdance@localhost:5433/kdance` — 테이블 0개, vector 확장 미생성

## 반드시 지킬 제약

1. **Prisma 8 은 계약 기반이다.** `new PrismaClient()` 를 쓰지 않는다 — 8 에 그 API 가 없다.
   런타임은 `@prisma/client` 가 아니라 `@prisma/orm-postgres`.
   형태: `postgres<Contract>({ contractJson, url })`. 스캐폴딩: `prisma orm init --target postgres --authoring psl`.
2. **인증은 Better Auth + kysely/pg 직결.** prisma 어댑터를 쓰지 않는다
   (`@better-auth/prisma-adapter` 는 Prisma 7 API 전제. better-auth 의 정식 dependency 라
   설치는 되지만 설정에서 고르지 않으면 쓰이지 않는다).
   쓸 것: `@better-auth/kysely-adapter` (`createKyselyAdapter` · `getPostgresSchema` 확인됨).
   `package.json` 의 `overrides {"better-auth":{"prisma":"$prisma"}}` 는 설치 충돌 회피용 —
   지우면 `npm install` 이 ERESOLVE 로 깨진다.
3. **검증은 `npx next build`.** admin-web 의 `npm run lint` 는 별도 사유
   (eslint-config-next 16 × eslint 9 순환 설정)로 이미 깨져 있다. mobile 은 `npx tsc --noEmit`.
4. **버전을 기억으로 쓰지 않는다.** `package.json` · `node_modules` · `npm view dist-tags` 에서 읽는다.
5. **mobile 은 범위 밖.** Expo 58.0.0-preview.3 + RN 0.88.0-rc.0. API 계약만 유지한다.

## 이관 부채 (전환 비용이 싼 이유)

- kdance DB 에 테이블이 하나도 없다. Alembic 마이그레이션은 1개뿐(`0001_initial_domain.py`).
- 기존 `backend/`: FastAPI + SQLAlchemy 2 + Alembic + psycopg3, pytest 159개.
- **기존 SCH-01~07 은 전부 이 FastAPI 코드를 설명한다** — 교체되면 대상이 사라진다.
  Phase 3 에서 폐기/보존/재작성 중 무엇으로 할지 판단해 사용자에게 보고할 것.
  직전 회차 산출물은 `_workspace_20260920_183143/` 에 보관했다.

## 진행 방식

범위가 크므로 Phase 3/4 에서 단계를 잘게 쪼개고, **각 단계마다 `next build` 로 그린을 확인할 수
있는 순서**로 배치한다. Phase 4 까지 나온 뒤 사용자 승인을 받고 Phase 5 로 진입한다.
