# Phase 5(구현) 결과 — FR-022a(첫 화면 장르 선택·유지) 단일 전환 + 세부 장르

T1(서버) → T2(mobile) 순서로 끝냈다. 테스트를 먼저 써서 실패(RED)를 본 뒤 구현했다. 커밋은 하지 않았다.

## 바꾼 파일

### T1 서버 (admin-web)
| 파일 | 바꾼 것 |
|---|---|
| `admin-web/prisma/contract.prisma` | `members.base_sub_genre ClassSubGenre?` 칸과 `@@check ck_members_base_sub_genre`(NULL 이거나 dance_sport→latin/standard, salsa_bachata→salsa/bachata). 수업 쪽 `ck_classes_genre_sub` 와 같은 짝 |
| `admin-web/prisma/contract.json` · `contract.d.ts` | `npm run db:emit` 로 다시 만든 계약 |
| `admin-web/migrations/app/20261125T0249_member_base_sub_genre/`(새 폴더) · `migrations/snapshots/aca2767…/`(새 폴더) | `prisma migration plan` 이 만든 마이그레이션: 칸 추가 + CHECK 2개(짝 규칙, 값 집합). 맨 앞 작업에 한국어 주석 한 줄을 달았다 |
| `admin-web/lib/server/services/member-profile.ts` | `memberBaseGenreRequestSchema` 에 `baseSubGenre?: enum \| null` 추가, 짝이 맞지 않으면 superRefine 으로 422(`fields: baseSubGenre`), transform 으로 안 보낸 값은 null. UPDATE 가 `base_sub_genre` 도 늘 함께 덮어쓴다(`NULLIF(…, '')`) |
| `admin-web/lib/server/services/member-signup.ts` | `memberSchema`(계약 `Member`)에 `baseSubGenre` 추가, `readMemberView` 가 읽어 채운다 → GET /api/me · PUT 응답 둘 다 |
| `admin-web/lib/server/services/home-offerings.ts` | WHERE 에 `AND (m.base_sub_genre IS NULL OR c.sub_genre = m.base_sub_genre)` 한 줄. 응답 모양은 그대로 |
| `admin-web/tests/db/member-profile.db.test.ts` | 테스트 2개 추가 — 세부 장르 저장·조회·422 조합 5종·null/탱고로 바꾸면 전체로 돌아감 / DB CHECK 직접 위반 |
| `admin-web/tests/db/home-offerings.db.test.ts` | `member()` 도우미에 `baseSubGenre` 선택 인자, 테스트 1개 추가 — 라틴만·스탠다드만·전체(B_early 를 테스트 동안만 스탠다드로 바꿨다가 되돌림) |
| `_workspace/03_contracts/01-member-onboarding.md` | `Member` 예시에 `baseSubGenre`, §6 요청 칸·422 조건·덮어쓰기 규칙 표 |
| `_workspace/03_contracts/02-catalog.md` | §1 조건 표에 「세부 장르」 행 |

### T2 mobile
| 파일 | 바꾼 것 |
|---|---|
| `mobile/lib/onboarding/types.ts` | `SUB_GENRES`·`SubGenre`·`SUB_GENRES_OF`, `Member.baseSubGenre` |
| `mobile/lib/onboarding/labels.ts` | `SUB_GENRE_LABELS`(라틴·스탠다드·살사·바차타) |
| `mobile/lib/onboarding/members-api.ts` | `saveBaseGenre(baseGenre, baseSubGenre)` — 세부 장르는 null 이어도 늘 보낸다 |
| `mobile/app/base-genre.tsx` | 세부 장르 칩 줄(전체 + 그 장르의 세부 장르, 탱고·스윙은 없음). 카드를 바꾸면 칩은 「전체」로. 홈에서 올 때(`from=home&genre=&sub=`) 주소 값으로 미리 선택(useState 초기값 함수, 주소 값은 목록 대조로 검증), 제목 「메인 장르 바꾸기」·단계 표시 숨김·버튼 「…로 바꾸기」, 저장 뒤 `router.back()`. 온보딩은 기존대로 `router.replace(HOME_ROUTE)` |
| `mobile/app/(tabs)/home.tsx` | (오늘 미커밋 fetchMe 변경 위에) `FeedState.baseSubGenre`, 머리말 제목 「댄스스포츠」 + 작은 글씨 「(라틴)」, 옆에 「장르 바꾸기」 버튼(role button, hitSlop 으로 터치 48 확보). 돌아오면 기존 useFocusEffect 가 목록·제목을 새로 읽는다 |

새 useEffect 는 쓰지 않았다(home.tsx 의 첫 로드 useEffect 는 원래 있던 것). 색은 `lib/theme` 토큰만 썼다.
`mobile/app/_layout.tsx`·`mobile/app/offering/[id].tsx` 의 미커밋 변경은 이 작업 전부터 있던 것이고 건드리지 않았다.

## 마이그레이션 방법·결과
1. `contract.prisma` 수정 → `npm run db:emit`
2. `./node_modules/.bin/prisma migration plan --from 20261124T1618_level_offer_notification --name member_base_sub_genre`
   - `--from` 없이 돌리면 `MIGRATION.PLAN_ORIGIN_UNKNOWN` 으로 거부된다(디스크에 `db` ref 가 없음). 마지막 마이그레이션 폴더 이름을 출발점으로 주면 된다
3. `prisma migration check` → All checks passed
4. 개발 DB: `npm run db:migrate -- --yes` → kdance_next 에 칸·CHECK 2개 적용, 마커 `aca27672…`. 회원 80행 그대로(`base_sub_genre` 전부 NULL = 「전체」), 시연 데이터 삭제 없음
5. 테스트 DB: 따로 할 일 없음 — `tests/setup/global-setup.ts` 가 매 실행마다 kdance_next_test 스키마를 비우고 `prisma db migrate` 로 migrations/app 전체를 다시 올린다. 새 마이그레이션이 그대로 반영됐다(아래 DB 테스트 통과로 확인)
6. dev 서버(:3000)는 끄지 않았다. 재시작 없이 새 칸을 읽고 쓴다 — Expo 웹에서 PUT·GET 이 `baseSubGenre` 를 주고받았고 DB 에 `dance_sport|latin` 이 저장됐다

## 테스트 명령과 결과
| 명령 | 결과 |
|---|---|
| RED: `flock … npm run test:db -- tests/db/home-offerings.db.test.ts tests/db/member-profile.db.test.ts` (구현 전) | 2 failed · 24 passed — 새 테스트 2개만 실패(DB CHECK 테스트는 마이그레이션 직후라 통과) |
| `flock /tmp/kdance-next-test.lock npm run test:db -- tests/db/home-offerings.db.test.ts tests/db/member-profile.db.test.ts tests/db/member-signup.db.test.ts tests/db/m3-member-flow.db.test.ts tests/db/home-offerings-sort.db.test.ts tests/db/permission-matrix.db.test.ts` | 6 files, **334 passed** (로그 `_workspace/evidence/fr022a/test-db.log`) |
| `npm run test:unit` | 127 files, **1768 passed** |
| admin-web `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit` | exit 0 |
| mobile `npx tsc --noEmit` | exit 0, 출력 없음 |

중간에 한 번 500 이 났다 — Prisma 8 raw SQL 값 자리에 `null` 을 넣으면 `unsupported JS value type for raw-SQL interpolation` 이 난다. putProfile 과 같은 방법(빈 글자 + `NULLIF`)으로 고쳤다.

## 화면 검증 (Playwright, Expo 웹 390×844)
시연 로그인 계정을 새로 만들어(`DEMO_SIGNUP_EMAIL=demo-fr022a@example.com ./node_modules/.bin/jiti scripts/dev-demo-app-signup.ts`, 비밀번호는 스크립트 상수) 약관 → 본인확인 → 가입 → 취향 → 기준 장르 → 홈을 실제로 지나갔다. 개발 DB 회원이 80 → 81명이 됐다(삭제 없음).
| 파일(`_workspace/evidence/fr022a/screens/`) | 확인한 것 |
|---|---|
| `01-onboarding-dance-sport-chips.png` | AC-2·AC-5 온보딩 4/4, 댄스스포츠 고르면 칩 전체·라틴·스탠다드, 기본 전체, 그대로 진행 가능 |
| `02-home-dance-sport-all.png` | AC-1·AC-3 제목 「댄스스포츠」 + 「장르 바꾸기」, 전체라 스탠다드·라틴 섞여 나옴 |
| `03-change-from-home-latin.png` | 홈에서 온 화면(단계 표시 없음, 「메인 장르 바꾸기」), 라틴 선택, 버튼 「댄스스포츠(라틴)로 바꾸기」 |
| `04-home-latin-only.png` | AC-3·AC-4 돌아온 홈 제목 「댄스스포츠(라틴)」(괄호 작게), 라틴 수업 3개만 |
| `05-switch-to-salsa-chips-reset.png` | AC-2 살사/바차타로 바꾸면 칩 전체·살사·바차타, 「전체」로 되돌아감 |
| `06-prefilled-latin.png` | 다시 들어오면 지금 값(댄스스포츠·라틴)이 미리 선택됨 |

콘솔 오류 1건은 가입 전 `GET /api/me` 403(SIGNUP_INCOMPLETE)으로, 원래 흐름의 정상 응답이다.

## 남은 문제·메모
- `_workspace/03_data-model.md` §2-2 members 에는 `base_sub_genre` 칸을 적지 않았다(배정 범위가 계약 01·02 였다). Phase 9 전에 한 줄 더하는 게 맞다
- spec `specs/001-ai-dance-class-platform/spec.md` FR-022a 는 고치지 않았다 — 이미 「댄스스포츠(라틴)」 괄호 표기를 적고 있고 요구사항이 바뀌지 않았다
- 홈에서 들어간 기준 장르 화면은 머리말이 없어(`_layout.tsx` 에서 headerShown:false — 오늘 미커밋 변경) 화면 안 「뒤로」 버튼이 없다. 안드로이드 뒤로 키·브라우저 뒤로는 된다. 닫기 버튼이 필요하면 따로 정한다
- RN 웹 접근성 트리에 라디오 `checked` 상태가 드러나지 않는다(기존 카드도 같음, 이번에 생긴 문제 아님)
- 「장르 바꾸기」 버튼 높이는 36(hitSlop 6 으로 터치 영역 48)
- `npm run test:db` 전체와 `npm run build` 는 돌리지 않았다(지시대로 바꾼 영역만)
- prisma CLI 가 매번 「agent skills are out of date」 안내를 낸다 — 이번 작업과 무관, 손대지 않았다
