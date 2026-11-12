# Phase 5(구현) 산출물 — T-M3-1(값 상수·금액·시각 도우미)

- 슬라이스: S0-M3(순수 로직 이식) · 작성 2026-11-06 · 커밋하지 않음
- 진행: 테스트 먼저(RED: 모듈 없음으로 2 파일 실패) → 구현(GREEN) → 타입 검사

## 1. 바꾼 파일 (전부 새 파일)

| 파일 | 내용 |
|---|---|
| `admin-web/lib/domain/constants.ts` | 공유 계약 §4.1(상태·구분 값 집합) 21개 값 집합을 `as const` 배열 + 타입 별칭으로 소유(§4.2(값 소유 모듈)). `03_data-model.md` §3 표를 그대로 옮김 |
| `admin-web/lib/domain/money.ts` | `ceilMulDiv`(BigInt 올림 나눗셈, 입력·결과 안전 정수 검사, 0 나눗셈 RangeError, 음수는 수학적 올림) · `computePriceBreakdown`(정가 → 혜택 할인 → 쿠폰 → 예매 수수료 → 최종, 할인 0 줄 포함, 결과 freeze) · `PRICE_LINE_KINDS`·`PriceLine` |
| `admin-web/lib/domain/time.ts` | `import "temporal-polyfill/full/global"` · `KST_TIME_ZONE` · `Clock`(§4.10) · `systemClock`·`fixedClock` · `toKstDate`·`toKstTimeOfDay`·`kstToday`·`formatKstDate` · `parseTimeOfDay`/`formatTimeOfDay`(`"HH:MM"`) · `parseKstDate`(`"YYYY-MM-DD"`, 없는 날짜 거부) · `kstDateRangeToInstants`(KST 날짜 범위 → [start, endExclusive)) · `isWithinKstTimeWindow`(가능 시간대 판정, KST 자정 넘는 회차는 밖) |
| `admin-web/tests/unit/money.test.ts` | 19 사례 — 나누어떨어짐·1 모자람 올림 경계, 곱이 2^53 초과해도 정확, 음수 올림, 0 나눗셈, 안전 정수 초과·소수·NaN·무한대 입력 예외, 결과 초과 예외, 0 줄 포함 가격 내역, 순서, 한글 이름, 0 미만 방지, 수수료는 할인에 안 깎임, freeze |
| `admin-web/tests/unit/time.test.ts` | 19 사례 — Clock, **KST 자정 경계**(UTC 14:59:59 / 15:00:00, 연말 넘김), 날짜 범위 변환, 형식 파싱·거부, 가능 시간대 경계·초과·자정 넘김·UTC/KST 날짜 차이 |

## 2. 실행 결과

```
$ cd /home/user/kdance/admin-web && npx vitest run tests/unit/money.test.ts tests/unit/time.test.ts
 RUN  v4.1.11 /home/user/kdance/admin-web
 Test Files  2 passed (2)
      Tests  38 passed (38)

$ npx tsc --noEmit -p .
(출력 없음)
```

- `vitest.config.*` 를 만들지 않고 CLI 로 돌렸다. 테스트는 `@/` 별칭 대신 상대 경로로 import 한다(설정 없이 별칭이 풀리지 않기 때문)
- `temporal-polyfill` 1.0.5 가 이미 `node_modules` 에 있다(T-M1-1(R2 스파이크) 쪽 설치로 보임). 그래서 「차단」 없음. `package.json`·lock 은 건드리지 않았다
- TypeScript 6.0.3 의 `lib.esnext.temporal.d.ts` 가 전역 `Temporal` 타입을 주고, 폴리필 타입과 충돌하지 않았다

## 3. 계약과 다르게 한 점 · 해석한 점

1. **`computePriceBreakdown` 의 `bookingFee` 를 선택 인자(`bookingFee?: number`)로 했다.** `06-ports.md` §4.3 은 `bookingFee: number` 인데, `README.md` §4.6 은 「`booking_fee` 는 해당 상품일 때만」 줄을 넣으라고 한다. 숫자 하나로는 「대상 아님」과 「0원」을 구별할 수 없어서, 생략 = 줄 없음, 0 명시 = 0 줄로 나눴다. 시그니처 표기를 맞출지 Phase 8(코드 리뷰)에서 판단 필요
2. **0 미만 막기는 할인 뒤 금액에만 건다.** `03-checkout-payment.md` §3 의 `final = list − benefit − coupon (+ booking_fee)`, 「0 미만이면 0」을 「할인 뒤 소계를 0 으로 막고 수수료를 더한다」로 읽었다. 수수료가 할인에 먹히지 않게 하려는 해석이다
3. **할인 줄 `amount` 는 양수(빼는 금액)로 담는다.** 계약 예시에 할인 줄 부호가 없어서 DB 할인 칸(`>= 0`)과 같은 부호로 정했다. 화면은 `kind` 를 보고 「−」를 붙여야 한다
4. **`ceilMulDiv` 는 음수를 거부하지 않고 수학적 올림을 한다.** 금액 ≥ 0 규칙은 호출하는 쪽(`computePriceBreakdown` 은 직접 검사, 환불액 산정은 T-M3 해당 Task)이 지킨다. 옛 Python `_ceil_amount` 는 음이 아닌 값만 전제했다
5. 줄 표시 이름(정가·혜택 할인·쿠폰 할인·예매 수수료·최종 결제액)은 계약에 「정가」 하나만 있어 나머지는 FR-283(결제액 계산 순서) 용어로 붙였다

## 4. 발견한 이슈 · 미해결

- **(확인 필요) DB `ck_orders_total_formula` 와 가격 내역의 어긋남.** `03_data-model.md` §2-1 의 CHECK 는 `total_amount = list − benefit − coupon` 이다. ① 할인이 정가를 넘어 0 으로 막히면 이 등식이 깨지고 ② 예매 수수료가 붙으면 최종액이 `total_amount` 와 다르다. 1회차는 혜택·쿠폰 0, 수수료 없음(정규)이라 지금은 안 터진다. 원데이·이벤트형을 열 때 CHECK 에 수수료 칸을 넣을지, `total_amount` 의 뜻을 바꿀지 Phase 3(구현 계획)에서 정해야 한다
- **`refund_events.event_type` 6종은 넣지 않았다.** data-model §2-1 이 「앱 상수(§4.2)」라고만 하고 §3 표에는 없다. 지시대로 §3 표만 옮겼다. 값은 `backend/app/services/cancellation.py` 의 `RefundEventType` 에 있으니 환불 이식 Task 가 같은 파일에 더하면 된다
- `time.ts` 가 폴리필을 side-effect import 한다. R-09(Prisma 의 `Temporal.Instant` 와 폴리필 클래스 일치)는 이 Task 범위 밖이라 미검증
- `npm run test:unit` 스크립트는 아직 없다(T-M1-1 소유)
