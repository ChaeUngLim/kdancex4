# T-M3-3(결제 기한 산정) 구현 보고

슬라이스 S0-M3(순수 로직 이식) · DB 불필요 · 테스트 먼저(RED: 모듈 없음으로 실패 확인 → GREEN)

## 변경한 파일

| 파일 | 변경 |
|---|---|
| `admin-web/lib/domain/payment-deadline.ts` (신규) | `computeDueAt`(공유 계약 §4.3 시그니처 그대로, 순수 함수) · `DeadlineConfig` · `DEFAULT_DEADLINE_CONFIG`(15분 / 24시간 / 60분, 동결 객체) · `loadDeadlineConfig(env = process.env)`(환경 변수 읽기 분리) · `ComputeDueAtInput` |
| `admin-web/tests/unit/payment-deadline.test.ts` (신규) | 19개. 카드 2 · 가상계좌 7(같은 순간 경계, ±1초 경계, 첫 회차 1시간 안, 오프셋 무관, 설정 주입) · 환경 변수 10(기본값, 세 변수, 빈 문자열, 잘못된 값 6종) |

`time.ts`·`constants.ts`(T-M3-1(값 상수·금액·시각 도우미))는 import 만 했다. `PaymentMethod` 는 `constants.ts` 의 것을 쓴다. vitest 설정 파일은 만들지 않았다(상대 경로 import).

## 규칙

- card = `issuedAt + PAYMENT_CARD_DEADLINE_MINUTES`
- virtual_account = min(`issuedAt + PAYMENT_VA_DEADLINE_HOURS`, `firstSessionStartsAt − PAYMENT_VA_CUTOFF_MINUTES`). 같은 순간이면 그 순간
- 환경 변수 이름은 `03-checkout-payment.md` §4 표에 있는 3개 그대로다. 지어낸 이름은 없다
- 값이 비었거나 없으면 기본값을 쓰고, 양의 정수가 아니면(0, 음수, 소수, 공백 섞임, 단위 붙임) `RangeError` 를 던진다

## 검증 (실제 출력)

```
$ npx vitest run tests/unit/payment-deadline.test.ts
 Test Files  1 passed (1)
      Tests  19 passed (19)
$ npx tsc --noEmit -p .
tsc exit 0
```

## 발견한 이슈 · 결정 필요

1. **기한이 이미 지난 경우(첫 회차가 1시간 안)**: contracts 에 처리 방식이 있어서 따랐다. `03-checkout-payment.md` §1 5단계가 「기한이 이미 지났으면 409 `CHECKOUT_CLOSED`」로 막는다. 그래서 `computeDueAt` 은 판정하지 않고 계산값을 그대로 돌려준다(과거 순간일 수 있음, 테스트로 고정). **T-A3-1(주문 생성) 담당에게 전달할 것**: 비교는 `dueAt <= now` 로 해야 한다. §5 만료 정리의 `due_at <= now` 와 경계를 맞추려는 것으로, `<` 로 쓰면 기한과 같은 순간에 주문이 생긴 뒤 바로 만료된다.
2. **카드 기한의 기준 시각 표현이 서로 다르다(경미)**: spec FR-285(결제 기한)와 전제 18 은 「결제 창을 연 뒤」라고 쓰고, contracts §4 는 「주문 시각」이라고 쓴다. 함수는 호출자가 넘긴 `issuedAt` 을 그대로 쓰므로 코드에는 영향이 없다. 무엇을 넘길지는 T-A3-1 이 정한다. 1회차는 주문 생성과 결제 생성이 같은 트랜잭션이라 두 시각이 사실상 같다.
3. **spec 과 contracts 의 가상계좌 기한 표현 차이(확인만)**: FR-285 표에는 「수업 시작 시각 중 이른 쪽」으로 적혀 있지만, 전제 18 과 contracts 는 「수업 시작 1시간 전」이다. 구현은 전제 18·contracts 를 따랐다. FR-285 본문이 전제 18 로 값을 넘기므로 모순으로 보지는 않는다.
4. `admin-web/.env.example` 에 세 변수를 적지 않았다. 이 Task 의 파일 목록 밖이라서다. 문서화가 필요하면 env 예시 파일을 맡은 Task 에서 넣어야 한다.

## 미해결

없음. 커밋하지 않았다.
