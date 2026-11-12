# Phase 5(구현) 보고 — T-A5-3(홈·상세·결제 대기·캘린더 화면 + 취소 화면 이전)

- 슬라이스: US1-A5(mobile 화면) · 작성 2026-11-06
- 결과: 화면 6개 + 공용 조각 6개를 만들고 `mobile/App.tsx` 를 지웠다. `tsc --noEmit` exit 0. 서버 API 가 아직 없어 **화면 실행은 미검증**이다(T-A5-4(웹 실행 시도·화면 확인)에서 확인)
- 새 패키지 설치 0건. `mobile/.env` 는 열지 않았다

## 1. 만든·지운 파일

| 파일 | 내용 |
|---|---|
| `mobile/app/(tabs)/_layout.tsx` | 탭 묶음(홈·캘린더). `Tabs` 는 `expo-router/js-tabs` 에서 가져온다 — 설치본 58.0.30 의 `expo-router` 루트 `Tabs` 는 `@deprecated` 표시. 탭바는 `tabBar` 속성으로 `MemberTabBar` 를 끼웠다 |
| `mobile/app/(tabs)/home.tsx` | 홈 목록(보드 M7) |
| `mobile/app/(tabs)/calendar.tsx` | 월 달력 + 날짜별 확정 회차(보드 M11) |
| `mobile/app/offering/[id].tsx` | 수업 상세 · 자리 · 결제 수단 · 공지 · 결제 시작(보드 M8) |
| `mobile/app/checkout/[orderId].tsx` | 결제 대기 · 가상계좌 안내 · 기한 · 셀프 취소(보드 M9) |
| `mobile/app/reservation/[id]/cancel.tsx` | 옛 `App.tsx` 취소·환불계좌 화면 이전 |
| `mobile/lib/catalog/types.ts` | 계약 02~05 응답·요청 타입 |
| `mobile/lib/catalog/format.ts` | 금액·KST 시각·장르·자리·은행 이름, 가격 내역 정렬(순수 함수) |
| `mobile/lib/catalog/theme.ts` | 색·간격 토큰(아이보리 `#F4F1EC` · 갈색 `#A8620A` · 주 버튼 flame `#E4482B`) |
| `mobile/lib/catalog/use-api-resource.ts` | GET 훅(로딩·오류·완료, 화면 떠나면 요청 취소), 라우트 인자 검사, `Idempotency-Key` 생성 |
| `mobile/lib/catalog/tab-bar.tsx` | 회원 하단 탭 5칸(홈·학원·AI 플래너·캘린더·마이). 학원·AI 플래너·마이는 「준비 중」으로 눌리지 않음 |
| `mobile/lib/catalog/ui.tsx` | 상세 화면 틀(뒤로 가기 + 하단 탭), 로딩·오류·빈 상태, 버튼, 체크 줄, 공지 상자(갈색 왼쪽 막대), 가격 내역, 정원 막대 |
| `mobile/App.tsx` | **삭제.** 지우기 전에 grep 으로 확인했고 import 하는 곳은 없었다. `index.ts` 주석에만 이름이 남아 있다(5절) |

하단 탭은 상세 화면(수업 상세·결제 대기·취소)에도 보인다. 상세는 들어온 영역 탭을 켠다 — 수업 상세·결제는 홈, 취소는 캘린더.

## 2. 화면별 API 호출과 상태 처리

공통: 모든 호출은 `apiFetch`(세션 bearer)를 거친다. 오류는 서버 `detail` 문장을 그대로 보여 주고 `code` 로 다음 행동을 고른다 — `UNAUTHENTICATED` → `/login`, `SIGNUP_INCOMPLETE` → `/signup`, `BASE_GENRE_REQUIRED` → `/base-genre`(T-A5-2(가입·취향 화면 5종) 경로), 그 밖은 「다시 시도」. 라우트 인자는 영문·숫자·`-`·`_` 100자 이내만 받고 `encodeURIComponent` 로 넣는다.

| 화면 | 호출 | 상태 처리 |
|---|---|---|
| 홈 | `GET /api/home/offerings?limit=20&cursor=` | 첫 로딩 · 오류(기준 장르 없음 409 → 기준 장르 화면 버튼) · 빈 목록 안내 · 당겨서 새로 고침 · 끝에 닿으면 `nextCursor` 로 이어 붙이기 · 다른 화면에서 돌아오면 다시 읽기. 조건은 보내지 않는다(서버가 프로필로 거름). 모든 자리 `remaining<=0` 이면 「마감」 태그 |
| 수업 상세 | `GET /api/offerings/{id}` · `POST /api/orders`(+`Idempotency-Key`) | 기본 자리 = `defaultSeatKind`. 마감이어도 기본 선택을 바꾸지 않고 버튼 글자 「남 자리 마감」 + 비활성(AC-7(성별 자리 기본값)). 결제 버튼 조건: 환불 공지 있음 · 가격 내역 있음 · 고른 자리 `available` · 공지 확인 체크 · 전송 중 아님 · `myReservation` 없음(FR-282(결제 화면 필수 표시)). 수단 기본 가상계좌(FR-111), 카드 선택 가능. 키는 자리·수단이 바뀌면 새로 만든다. `SEAT_SOLD_OUT`·`CHECKOUT_CLOSED` 면 상세를 다시 읽는다. 성공 → `router.replace('/checkout/{orderId}')` |
| 결제 대기 | `GET /api/orders/{orderId}` · `POST /api/orders/{orderId}/cancel` | 단계 = 서버 상태 + 기한. `pending` 이고 `dueAt <= now` 면 「기한 지남」(30초마다 시계 갱신). `paid` → 캘린더 버튼, `expired`·`cancelled` → 끝 상태, 홈 버튼만. 가상계좌: 은행·계좌번호(복사 가능 글자)·예금주·입금액, 기한과 남은 시간. 「입금 상태 새로고침」은 GET 만 다시 한다(확정은 웹훅, AC-3(웹훅 신뢰성)). 셀프 취소는 `waiting` 일 때만, 실패(`ORDER_NOT_CANCELLABLE`)면 문장 표시 후 다시 읽기 |
| 캘린더 | `GET /api/me/calendar?from=YYYY-MM-01&to=YYYY-MM-말일` | 한 달 범위(≤31일). 회차를 KST 날짜별로 묶어 점 표시, 날짜를 누르면 그날 회차 목록. 로딩·오류·「확정된 수업이 없어요」. 탭으로 돌아오면 다시 읽기. 회차마다 「취소·환불 안내」 → `/reservation/{reservationId}/cancel` |
| 예약 취소 | `GET /api/reservations/{id}/cancellation-preview` · `POST /api/reservations/{id}/cancel` | 미리보기를 받기 전에는 폼 자체가 없다 → 확정 버튼도 없다. `cancellable=false` 면 사유 문장 + 체크·확정 비활성. 가상계좌만 환불 계좌 3칸. 결과 화면: 상태(완료·접수·실패)·환불액·실패 사유 |

시각은 서버 UTC 값에 9시간을 더해 표시한다(KST 는 일광 절약 시간이 없다). Hermes 의 `Intl` 시간대 지원 차이를 피하려는 선택이다.

## 3. 취소 화면 이전 때 바뀐 점

| 항목 | 옛 `App.tsx` | 새 `reservation/[id]/cancel.tsx` |
|---|---|---|
| 신원 | `X-User-Id` 고정 데모 UUID | 세션 토큰(`apiFetch`) |
| 주소 | `EXPO_PUBLIC_API_URL ?? localhost:8000` 직접 `fetch` | `apiFetch` 가 정한 주소 + `/api` 접두 |
| 예약 ID | 손으로 입력 | 라우트 인자(캘린더에서 진입) |
| 헬스 확인 | `/health` 표시 | 뺐다(제품 화면에 필요 없음) |
| 칸 이름 | snake_case(`refund_amount` 등) | camelCase(`refundAmount`·`refundAccount.bankCode` 등) |
| 요청 본문 | `{refund_account}` | `{method, refundAccount?}` — 미리보기의 `paymentMethod` 를 같이 보내 서버 1차 검증(422)을 켠다 |
| 오류 | `HTTP {status}` 문장 | 서버 `detail` 문장, 인증 오류는 로그인 안내 |
| 취소 불가 | 표시 없음 | `cancellable`·`reasonCode` 로 사유 표시, 확정 막음 |
| 그대로 둔 것 | — | 「확정 전에 예상 환불액을 반드시 보여 준다」, 동의 체크, 가상계좌만 계좌 입력, `pending` 은 정상 상태 문구, `Idempotency-Key` 미전송(서버가 결정적으로 만든다) |

## 4. 계약 모호점

1. **결제 대기 화면의 공지 본문이 응답에 없다.** `GET /api/orders/{id}` 는 `refundNoticeVersionId`·`intermediaryNoticeVersion` 만 주고, `offeringId` 도 없어 상세를 다시 불러 본문을 얻을 수도 없다. FR-282(결제 화면 필수 표시)는 결제 화면에 공지 본문을 요구한다. 지금은 상세 화면(결제 시작 전)에서 본문 두 개를 보여 주고 체크를 받으며, 결제 대기 화면은 「주문에 고정된 판본」만 표시한다. 계약에 `refundNotice.body`·`intermediaryNotice.body`(또는 `offeringId`)를 넣을지 판단 필요
2. **홈 응답에 기준 장르가 없다.** 헤더의 장르 이름을 첫 수업의 `genre` 로 보여 준다. 목록이 비면 「오늘의 수업」. `GET /api/home/offerings` 에 `baseGenre` 를 넣거나 회원 조회로 받을지 정해야 한다
3. **`myReservation` 모양 미정.** 계약 예시가 `null` 뿐이라 `unknown` 으로 받고 「null 이 아니면 이미 신청함 → 결제 버튼 끔」으로만 쓴다
4. **이관 취소 API 의 camelCase 칸 목록은 Phase 5 가 옛 스키마에서 1:1 로 옮긴다**고만 적혀 있다. 이 화면은 `backend/app/schemas/cancellation.py` 를 직접 읽고 camelCase 로 옮겼다(`reasonCode`·`appliedTierHours`·`refundAccount.holderPhoneNumber` 포함, 마지막 것은 화면에서 안 받음). T-M4-x(취소 API 이관)의 zod 스키마와 대조 필요
5. **`reasonCode` 값 집합.** 옛 값(`class_already_started` 등 소문자)이 그대로인지, 새 오류 코드(`CLASS_ALREADY_STARTED`)로 바뀌는지 계약에 없다. 화면은 옛 값 2개만 문장으로 바꾸고 나머지는 일반 문장
6. **카드 결제 흐름.** `cardCheckout.checkoutKey`(가짜 결제창 키)를 앱이 어떻게 쓰는지 정의가 없다. 「카드 결제창은 아직 연결 전」 안내만 둔다
7. **`expired` 주문 후 재신청.** 화면은 홈으로 돌려보낸다. 같은 판매 단위 상세로 바로 보내려면 응답에 `offeringId` 가 필요하다(1번과 같은 원인)

## 5. 필요 변경 (이 Task 의 파일이 아니라 손대지 않음)

- `mobile/app/_layout.tsx`: 루트 `/` 에 화면이 없다(`app/index.tsx` 없음). 앱을 켜면 Unmatched 가 뜬다. 세션 유무로 `/login` 또는 `/home` 으로 보내는 `app/index.tsx`(또는 루트 `Redirect`)가 필요하다 — T-A5-2 의 `nextOnboardingRoute` 를 재사용하는 게 자연스럽다
- `mobile/index.ts`: 주석이 「`App.tsx` 는 … 파일만 남아 있고」라고 적고 있다. 파일이 지워졌으니 문장을 고쳐야 한다(동작 영향 없음)
- `mobile/lib/api.ts`: 401(`UNAUTHENTICATED`)을 받으면 `clearSessionToken()` 을 부르는 자리가 없다. 화면들은 로그인 화면으로 안내만 한다. 래퍼 한 곳에서 지우는 편이 맞다
- `mobile/lib/onboarding/theme.ts` 와 `mobile/lib/catalog/theme.ts` 가 따로 있다(병렬 작업이라 나뉨). 색 값이 같은지 확인 후 한 파일로 합칠 Task 필요

## 6. 판단 기록

- **하단 탭을 커스텀 컴포넌트 하나로**: 상세 화면이 탭 묶음 밖(`offering/`·`checkout/`·`reservation/`, 배정된 경로)이라 라이브러리 탭바가 그 화면에는 그려지지 않는다. 같은 `MemberTabBar` 를 탭 묶음의 `tabBar` 와 상세 화면 아래에 같이 붙여 「모든 화면에 탭」 규칙을 지켰다
- **서버 캐시 라이브러리 없이 작은 훅**: 설치 금지 원칙. 필요한 건 불러오기·다시 불러오기·취소뿐
- **응답 검증(zod) 생략**: zod 가 mobile 에 없다. 화면이 `?.`·`?? 0` 으로 빈 값에 깨지지 않게 했다. 계약이 굳으면 경계 검증을 넣을지 검토
- **`Idempotency-Key`**: `crypto.randomUUID` 가 모든 기기 런타임에 있다는 보장이 없어 시각+난수. 회원 범위 유일성만 필요해 충분하다고 봤다
- 장르 테마 색·Geist/Noto 글꼴은 넣지 않았다(R7(보드와 화면 차이)·글꼴 미설치)

## 7. 검증 결과 원문

```
$ cd /home/user/kdance/mobile && ./node_modules/.bin/tsc --noEmit; echo "TSC_EXIT=$?"
TSC_EXIT=0
```

(T-A5-2 의 화면 파일이 같이 있는 상태에서 돌렸다.) 화면 실행·서버 연동은 미검증.
