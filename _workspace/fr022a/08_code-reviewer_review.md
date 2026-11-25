# Phase 8(코드 리뷰) — FR-022a(첫 화면 장르 선택·유지) 단일 전환 + 세부 장르

- 리뷰 날짜: 2026-11-25
- 입력: `_workspace/fr022a/04_tasks.md`, `_workspace/fr022a/05_implementer_summary.md`, `git diff`(미커밋 작업 트리)
- 07_bug-fixer_fixes.md: 없음
- 방법: diff 를 직접 읽고 호출 경로를 따라갔다(서브 리뷰어 에이전트는 부르지 않았다 — 바뀐 범위가 파일 13개·로직 몇십 줄이라 직접 보는 편이 빠르다). 개발 DB `kdance_next` 에서 제약 이름과 기존 행 분포를 직접 조회했다. 테스트는 다시 돌리지 않았다(구현 요약의 334 passed·1768 passed·tsc 2건을 근거로 둔다 — Phase 9(완료 검증)에서 다시 돌릴 것).

## 판정: **PASS**

CRITICAL 0 · HIGH 0. MEDIUM 3건(이번 작업 2 + 같은 날 다른 수정 1)은 머지를 막지 않지만 Phase 9 전에 정리하면 좋다.

---

## 확인해서 문제없던 것 (CONFIRMED)

| 관점 | 근거 |
|---|---|
| 세부 장르 검증 | `admin-web/lib/server/services/member-profile.ts:104-116` — `z.enum(CLASS_SUB_GENRES).nullable().optional()` + `superRefine` 가 `SUB_GENRES_OF`(class-registration.ts:49, 수업 등록과 같은 표)로 짝을 본다. 탱고·스윙은 표에 키가 없어 `?? []` 로 모든 값이 거부된다. 422 경로는 테스트 5조합으로 확인(`member-profile.db.test.ts` 추가분) |
| NULL 처리 | 칸 생략·`null` → transform 에서 `null`. UPDATE 는 `NULLIF(${… ?? ""}, '')`(222행)로 늘 두 칸을 함께 덮어써, 탱고로 바꾸면 옛 「라틴」이 남지 않는다. 읽기는 `COALESCE(base_sub_genre::text,'')` → `""`→`null`(member-signup.ts) — 기존 `base_genre` 처리와 같은 방식 |
| SQL 필터 | `home-offerings.ts:313` `AND (m.base_sub_genre IS NULL OR c.sub_genre = m.base_sub_genre)` — `m` 은 305행 `JOIN members m ON m.id = ${memberId}::uuid` 로 이미 있는 별칭. 회원 값을 요청이 아니라 저장된 행에서 읽어 우회 불가. 커서 페이지에도 같은 조건이 걸린다 |
| raw SQL 값 바인딩 | 새로 넣은 값은 모두 tagged template 자리(`${…}`)로 들어간다. 문자열 이어 붙이기 없음. 게다가 값은 zod enum 을 통과한 4종뿐 |
| 마이그레이션이 기존 행을 깨는가 | `20261125T0249_member_base_sub_genre` — `ADD COLUMN … text`(NULL 허용, 기본값 없음 → 테이블 재작성 없음) + CHECK 2개. 둘 다 `IS NULL` 이면 참이라 기존 행이 전부 통과한다. 개발 DB 실측: 회원 81행 중 80행 `base_sub_genre` NULL, 1행 `dance_sport|latin`(시연) — 깨진 행 없음 |
| DB 이중 방어 | 짝 CHECK `ck_members_base_sub_genre_5f6db99c` + 값 집합 CHECK `members_base_sub_genre_check_9db5ca8a` 가 실제 DB 에 있다(조회 확인). `base_genre` 를 바꾸는 쓰기는 `member-profile.ts:222` 하나뿐이고 거기서 두 칸을 같이 쓰므로, 장르만 바뀌어 CHECK 에 걸려 500 이 나는 경로는 없다(`grep base_genre` 로 확인 — dev-demo 스크립트들은 `base_sub_genre` 를 안 넣어 NULL) |
| 계약과 구현 | 계약 01 §3 `Member.baseSubGenre`, §6 요청 칸·422·덮어쓰기 표, 계약 02 §1 「세부 장르」 행이 구현과 같다 |
| mobile — useEffect | 새로 쓴 useEffect 없음. `home.tsx:107` 의 것은 원래 있던 첫 로드. base-genre 미리 선택은 `useState` 초기값 함수로 했다 |
| mobile — 라우트 파라미터 검증 | `base-genre.tsx` `parseGenre`·`parseSubGenre` 가 목록 대조로만 받는다. `string[]` 이 와도 `===` 비교라 `null` 로 떨어진다. 짝이 안 맞는 `sub` 는 「전체」 |
| mobile — 접근성 | 칩 줄 `radiogroup`+`radio`+`accessibilityState.checked`, 「장르 바꾸기」 `accessibilityRole="button"`·`accessibilityLabel`, 제목 `header`. 칩 높이 `MIN_TOUCH`(48) |
| 장르를 바꾸면 칩 초기화 | `selectGenre` — 다른 카드를 고르면 `setSub(null)`. 댄스스포츠의 「라틴」이 살사로 넘어가지 않는다 |

---

## CRITICAL

없음.

## HIGH

없음.

## MEDIUM

### M1. 홈에서 들어간 기준 장르 화면에 화면 안 「뒤로」 수단이 없다 — CONFIRMED (판정: MEDIUM, 막지 않음)
- 위치: `mobile/app/_layout.tsx:20` `<Stack.Screen name="base-genre" options={{ headerShown: false }} />`(같은 날 다른 수정) + `mobile/app/base-genre.tsx` 가 `from=home` 일 때도 닫기 버튼을 그리지 않음
- 재현: 홈 → 「장르 바꾸기」 → 마음을 바꿔 그냥 나가고 싶다 → 화면 안에는 저장 버튼밖에 없다
- 심각도 근거: 이 앱은 Android 대상(CLAUDE.md `com.kdancex3`)이라 하드웨어·제스처 뒤로가 늘 있고, Expo 웹은 브라우저 뒤로가 된다. 갇히는 일은 없고 데이터도 안 바뀐다(저장을 눌러야만 PUT). 그래서 HIGH 가 아니다. 다만 저장 버튼만 있는 화면은 「꼭 골라야 나갈 수 있다」로 읽혀, 원래 값을 다시 눌러 저장하는 헛요청이 생길 수 있다. 화면 규칙 결정(닫기 버튼 위치·문구)이 필요해 별도 Task 로 넘기는 것을 권한다
- 제안: `fromHome` 일 때만 `OnboardingScreen` 머리에 「닫기」 또는 「취소」 텍스트 버튼(`router.back()`)을 두거나, `_layout` 에서 `base-genre` 를 경로별로 다르게 하지 말고 화면 쪽에서 처리. 온보딩 경로에는 계속 두지 않는다(가입 화면으로 돌아가면 안 됨)

### M2. 데이터 모델 문서에 `members.base_sub_genre` 가 없다 — CONFIRMED
- 위치: `_workspace/03_data-model.md` §2-2 members(이번 diff 에 없음). 구현 요약 「남은 문제」 첫 줄도 같은 지적
- 문제: 설계 산출물 4종 중 `data-model.md` 가 실제 스키마보다 뒤처진다. 다음 작업자가 이 문서로 members 를 보면 칸과 CHECK 를 모른다
- 제안: §2-2 members 행에 `base_sub_genre text NULL`·`ck_members_base_sub_genre` 한 줄 추가(Phase 9 전)

### M3. (같은 날 다른 수정 — fetchMe) 내 정보 조회가 실패하면 이미 받은 홈 목록까지 오류 화면이 된다 — CONFIRMED
- 위치: `mobile/app/(tabs)/home.tsx:87` `Promise.all([apiFetch(목록), fetchMe()])`
- 재현: `GET /api/me` 만 일시적으로 실패(네트워크 끊김·5xx) → `Promise.all` 이 거부 → catch 에서 `status: 'error'` → 목록 응답이 성공했어도 `ErrorView`
- 이번 FR 과의 관계: fetchMe 를 붙인 것은 오늘 앞선 「기준 장르 제목」 수정이고, 이번 작업은 그 결과에 `baseSubGenre` 를 얹었을 뿐이다. 홈에 들어올 때마다(포커스 복귀 포함) 요청이 2개가 되는 것도 같은 출처
- 제안: `Promise.allSettled` 로 바꿔 목록만 성공하면 목록은 보여 주고 제목은 이전 값 유지. 또는 홈 목록 응답에 `baseGenre`·`baseSubGenre` 를 같이 실어 요청 하나로 줄이기(계약 02 §1 변경이 필요해 별도 결정)

## LOW

### L1. 계약 문서의 CHECK 이름이 실제 DB 이름과 다르다 — CONFIRMED
- `_workspace/03_contracts/01-member-onboarding.md:106` 은 `ck_members_base_sub_genre`, 실제 DB 는 `ck_members_base_sub_genre_5f6db99c`(Prisma 가 해시를 붙임). 수업 쪽 `ck_classes_genre_sub_71b8723b` 도 같은 방식이라 프로젝트 관례이긴 하다. 오류 로그로 제약을 찾을 때 헷갈릴 수 있어 「(DB 이름은 해시 접미사가 붙는다)」 한마디면 충분

### L2. 「장르 바꾸기」 버튼 높이 36 — CONFIRMED, 영향 작음
- `mobile/app/(tabs)/home.tsx:307` `minHeight: 36` + `hitSlop={6}` 으로 터치 영역은 48. 다른 곳은 `MIN_TOUCH` 상수를 쓰는데 여기만 숫자 36. 상수로 두면 의도가 읽힌다

### L3. 다른 요청이 도는 중에 돌아오면 새로 읽기가 버려진다 — PLAUSIBLE
- `home.tsx:78` `if (busy.current) return;` — 다음 장 불러오기(`more`) 중에 장르 화면으로 갔다가 빨리 돌아오면 `useFocusEffect` 의 `refresh()` 가 그냥 무시돼 옛 장르 목록·제목이 남을 수 있다. 원래 있던 가드라 이번 변경의 결함은 아니고, 사람이 재현하기는 어렵다

### L4. 테스트가 공유 바닥 데이터를 잠깐 바꾼다 — CONFIRMED, 안전하게 처리됨
- `home-offerings.db.test.ts` 새 테스트가 `B_early` 를 스탠다드(왈츠)로 바꾸고 `finally` 에서 `latin/samba` 로 되돌린다. 원래 값을 상수로 가정하므로 바닥 데이터가 바뀌면 조용히 틀어진다. 원래 값을 먼저 읽어 두고 되돌리면 더 단단하다

### L5. (같은 날 다른 수정 — periodText) 접미사 비교가 「18회」와 「8회」를 같게 본다 — PLAUSIBLE
- `home.tsx:68` `item.label.endsWith(\`${sessionCount}회\`)` — 회차 8개인 판매 단위의 이름이 「… 18회」로 끝나면 덧붙이지 않는다. 서버가 만드는 기본 이름이면 숫자가 같아 문제없지만, 대표가 이름을 직접 쓰는 경우엔 생길 수 있다. `/(^|\D)8회$/` 처럼 앞이 숫자가 아닌지 보면 된다

---

## 같은 날 다른 수정(이번 FR 범위 밖) — 참고사항

판정에는 넣지 않았다.

| 파일 | 내용 | 의견 |
|---|---|---|
| `mobile/app/_layout.tsx` | login·base-genre 머리말 숨김, 가입 단계 한국어 제목 | 주소 이름 노출을 없앤 것은 맞다. 부작용이 M1 |
| `mobile/app/offering/[id].tsx` `weeklyTimeText` | 모든 회차 요일을 주 순서로 모음 | 정상. 시각은 첫 회차 것만 써서, 요일마다 시각이 다른 수업이면 요약이 한쪽만 보여 준다(LOW 수준, 아래 회차 카드에 전체가 있다) |
| `home.tsx` `periodText` | 「8회 · 8회」 중복 제거 | L5 |
| `home.tsx` fetchMe·HomeHeader 제목 | 첫 수업 장르 대신 내 기준 장르 | 방향은 맞다. 실패 처리가 M3 |

## 검증 공백(이 리뷰가 확인하지 않은 것)

- 테스트·타입 검사는 다시 돌리지 않았다(구현 요약 수치를 근거로 둠). `npm run build` 와 `npm run test:db` 전체는 구현 단계에서도 안 돌렸다 — Phase 9 에서 돌릴 것
- 스크린샷 6장(`_workspace/evidence/fr022a/screens/`)은 열어 보지 않았다
