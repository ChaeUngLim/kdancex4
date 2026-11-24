# 07 bug-fixer — S0-1 리뷰 MEDIUM 3건 수정

- M-2: `admin-web/tests/setup/global-setup.ts` — `assertTestDatabaseName` 추가. DB 이름이 `_test` 로 끝나지 않으면 접속·`db update` 전에 한국어 오류로 throw(skip 아님). URL 이 없으면 기존대로 skip.
- M-1: `admin-web/vitest.config.mts` db 프로젝트 `env` 에 `DATABASE_URL = TEST_DATABASE_URL`(있을 때만). 앱 싱글턴 `db` 가 테스트 DB 를 본다.
- M-4: `admin-web/prisma/db.ts` 싱글턴을 `globalThis.__kdanceDb ??=` 로 한 번만 생성(HMR 풀 누적 방지).
- 확인: `npm test` 192 passed(9 files), `tsc --noEmit` OK, `npm run build` 성공. 가드 시험은 `TEST_DATABASE_URL=postgresql://x:y@127.0.0.1:1/kdance_next` (도달 불가 주소)로 실행 → 연결 없이 가드 오류로 즉시 중단. 개발 DB 는 건드리지 않음.
- S0-2 로 넘김: M-3(계약 변경 시 `db update` 거부 대비 스키마 초기화), LOW 전부.
- 영향: 다른 태스크 파일 영향 없음. package.json·계약·마이그레이션·스파이크 테스트 미변경.
