# Phase 9(완료 검증) — S0-1(R2 스파이크·러너 바닥) · 2026-11-19

## 판정: COMPLETE

직접 재실행한 결과(2026-11-19, DB 기동 상태).

| 명령 | 결과 |
|---|---|
| `flock … npm test`(admin-web) | 9 files, 192 passed |
| `flock … npm run test:db -- tests/spike/r2-prisma8.db.test.ts` | 6 passed |
| `./node_modules/.bin/tsc --noEmit`(admin-web) | exit 0 |
| `npm run build`(admin-web) | 성공, 라우트 `ƒ /api/health` 포함 |
| backend `uv run pytest -q` | 186 passed |
| mobile `./node_modules/.bin/tsc --noEmit` | 출력 없음(exit 0) |

## 수용 기준 대조(마스터 플랜 S0-1 수용 ①~④)

| # | 기준 | 판정 | 근거 |
|---|---|---|---|
| ① | 콜백 throw 시 ORM·SQL·raw 쓰기 모두 롤백 | 충족 | `tests/spike/r2-prisma8.db.test.ts` S-1(60줄~). 재실행 6 passed. research §3-1 표: 세 쓰기 모두 없음 |
| ② | 남은 자리 1개 + 조건부 UPDATE 동시 20건 → 1건 성공 | 충족 | S-3(181줄~). 성공 1 · 0행 19 · 오류 0, 풀 25로 연결 20개 실제 겹침 |
| ③ | 부분 유니크 충돌 INSERT 가 예외 없이 0행 | 충족 | S-4(219줄~). 예외 없이 0행, 같은 tx 계속 사용 가능 |
| ④ | `next build` 가 계약 JSON import·temporal polyfill 경로를 빌드 | 충족 | `app/api/health/route.ts` 가 `prisma/db.ts`(`contract.json` import 19줄 · `temporal-polyfill/full/global` 12줄)를 import. 재실행 `npm run build` 성공. T-M1-3 보고: `next start` 후 `/api/health` 200 |

## S0-M1 완료선과 Task 행

| 항목 | 판정 | 근거 |
|---|---|---|
| 스파이크 결과 표 + 대체 경로 선택 기록 | 충족 | `03_research.md` §3-1: 표 S-1~S-6, 「판정: Prisma db.transaction + raw 레인, 대체 경로 안 씀」 |
| `npm run build` 성공 · `npm test` 통과 | 충족 | 위 재실행 |
| T-M1-1 (6개 모두 실행, skip 0) | 충족 | 6 passed |
| T-M1-2 (판정) | 충족 | §3-1 판정 줄. `withPgTransaction` 은 `db.ts` 에 비상용으로 남김 |
| T-M1-3 (health·빌드) | 충족 | `tests/unit/health.test.ts` 가 `npm test` 에 포함, build 성공 |
| T-M1-4 (Better Auth 스모크) | 충족 | `auth-smoke.db.test.ts` 2 passed(DB 8 = 6 + 2, 192 안에 포함) |
| T-M1-5 (기록 마감) | 충족 | `CLAUDE.md` 23줄 「192 passed(단위 184 + DB 8) … 8 skipped」 수치가 실측과 일치. `tech-stack.md` 166줄 R2 행 「2026-11-19 실측 통과」 |
| AC-14(R2 스파이크) | 충족 | `tests/spike/r2-prisma8.db.test.ts` + 결과 표 `03_research.md`. 참고: AC-14 는 `01_req-analyst_requirements.md` 에 없다(`grep` 0건) — Phase 3·4(`03_impl-planner_plan.md` 191줄, `04_task-splitter_tasks.md` 288줄)에서 추가된 기준이다. 요구사항 원본에는 반영되지 않았으나 추적은 된다 |

## 리뷰·테스트 문서
- `08_code-reviewer_review.md`: PASS(CRITICAL 0 · HIGH 0). MEDIUM M-1·M-2·M-4 는 `07_bug-fixer_fixes.md` 에서 수정됨(`vitest.config.mts` env, `global-setup.ts` `_test` 가드, `db.ts` `globalThis` 싱글턴). 수정 뒤 192 passed 가 이번 재실행과 일치
- `06_test-runner_results.md`: 192 passed, DB 없을 때 184 passed·8 skipped 기록. 이번 실행으로 DB 기동 상태 수치 재확인

## S0-2 로 넘긴 항목(막지 않음)
- M-3: 계약이 바뀌면 `globalSetup` 의 `prisma db update` 가 데이터 손실 변경을 거부해 DB 테스트가 통째로 멈춘다 — 테스트 DB 스키마 초기화 후 재시도, 실패 시 `stderr` 노출 필요
- LOW 6건(L-1~L-6, `08_code-reviewer_review.md`)

## 미검증·주의
- 이번 단계에서 M-1·M-2 수정의 개별 동작(가드가 실제로 막는지)은 직접 시험하지 않았다. `07_bug-fixer_fixes.md` 의 도달 불가 주소 시험 기록을 그대로 인정했다
- 마스터 플랜 R27(알려진 취약점) 「S0-1 에서 먼저 다시 잰다」 — 재측정 결과 문서를 찾지 못했다. 수용 ①~④ 에는 없어 판정에는 영향이 없다. S0-2 전에 `npm audit` 를 돌릴지 오케스트레이터가 결정할 것
- UI 변경 없음(API 헬스 경로뿐) — 스크린샷 검증 해당 없음
- 변경 전부 미커밋 상태(`git status`: `app/api/`·`prisma/`·`tests/*`·`vitest.config.mts` untracked)

## 다음 액션
Phase 9.5 로 진행하고 S0-2(데이터 계약 1판·DB 테스트 바닥)로 넘어간다. Phase 7 로 되돌릴 사유 없음.
