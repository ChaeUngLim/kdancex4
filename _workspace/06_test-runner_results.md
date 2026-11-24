# Phase 6(테스트) — S0-1(R2 스파이크·러너 바닥) · 2026-11-19

오케스트레이터가 직접 실행했다(테스트 작성은 T-M1-1·T-M1-3·T-M1-4 가 이미 함).

| 명령 (admin-web) | 결과 |
|---|---|
| `flock /tmp/kdance-next-test.lock npm test` | Test Files 9 passed · Tests 192 passed (단위 184 + DB 8) |
| DB 접속 불가 상태로 `vitest run` | 184 passed · 8 skipped (DB 프로젝트 skip 확인) |
| `npm run test:db -- tests/spike/r2-prisma8.db.test.ts` | 6 passed — S-3 은 poolMax 25 로 연결 20 동시, 성공 1 |
| `npm run test:db -- tests/spike/auth-smoke.db.test.ts` | 2 passed |
| `tsc --noEmit` | 출력 없음 |
| `npm run build` | 성공(ƒ /api/health) |
| backend `uv run pytest -q` · mobile `tsc --noEmit` | 186 passed · 출력 없음(T0, 같은 날) |

판정: 전부 통과 → Phase 8(코드 리뷰)로.
