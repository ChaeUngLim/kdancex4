# Phase 5(구현) 산출물: T-M3-5(본인확인·알림 포트와 가짜 구현)

- 슬라이스: S0-M3(순수 로직 이식) · 작성 2026-11-06 · 커밋하지 않음
- 진행 순서: 테스트를 먼저 썼다(RED: 모듈이 없어 파일 1개 실패). 그다음 구현해 GREEN을 확인하고 타입 검사를 돌렸다
- `package.json`·lock은 손대지 않았고 설치한 것도 없다. Node 내장 `node:crypto`만 쓴다. vitest 설정 파일도 만들지 않았다

## 1. 바꾼 파일 (모두 새 파일)

| 파일 | 내용 |
|---|---|
| `admin-web/lib/server/ports/identity.ts` | 공유 계약 §4.10의 `IdentityVerificationPort`와 결과 타입 `IdentityVerificationResult`. 성별은 `lib/domain/constants.ts`의 `Gender`를 쓴다 |
| `admin-web/lib/server/ports/notification-sender.ts` | §4.10의 `NotificationSenderPort.deliver(notificationIds)`. 주석에 plan D7(기록은 트랜잭션 안, 발송은 커밋 뒤)을 적었다 |
| `admin-web/lib/server/fakes/fake-identity.ts` | `FakeIdentityVerification`이 `issue`(dev 발급)와 `verify`를 함께 맡는다. 생성자로 `secret`·`ciPepper`·`clock`을 받는다. `FAKE_IDENTITY_TOKEN_TTL_MINUTES = 10`(01-member-onboarding.md §2) |
| `admin-web/lib/server/fakes/fake-notification-sender.ts` | `FakeNotificationSender`. 호출을 순서대로 기록하고(얼린 복사본) `deliveredIds()`·`reset()`을 제공한다. 실제 발송은 하지 않는다 |
| `admin-web/tests/unit/adapters-identity-notification.test.ts` | 25개 사례. 본인확인 19개(이 중 `test.each` 5개), 알림 6개 |

## 2. 실제 출력

```
$ cd /home/user/kdance/admin-web && npx vitest run tests/unit/adapters-identity-notification.test.ts
 RUN  v4.1.11 /home/user/kdance/admin-web
 Test Files  1 passed (1)
      Tests  25 passed (25)
   Duration  168ms

$ npx tsc --noEmit -p .
tests/unit/adapters-pg.test.ts(17,8): error TS2307: Cannot find module '../../lib/server/fakes/fake-payment-gateway' ...
tests/unit/adapters-pg.test.ts(21,8): error TS2307: Cannot find module '../../lib/server/fakes/hmac-webhook-verifier' ...
tests/unit/adapters-pg.test.ts(33,8): error TS2307: Cannot find module '../../lib/server/ports/payment-gateway' ...
tests/unit/adapters-pg.test.ts(39,8): error TS2307: Cannot find module '../../lib/server/ports/webhook-verifier' ...
(exit 2)
```

- **tsc는 exit 2다. 오류 4건은 모두 T-M3-4(PG 포트·가짜 PG·웹훅 검증기 이식)의 `tests/unit/adapters-pg.test.ts`에서 난다.** 그 Task가 테스트를 먼저 쓴 RED 단계라 구현 파일이 아직 없어서다. 이 Task 파일을 가리키는 오류는 0건이다(`grep -v adapters-pg.test.ts` 결과가 비어 있음). T-M3-4가 끝난 뒤 오케스트레이터가 `tsc` exit 0을 다시 확인해야 한다
- 만료 판정 확인: 「만료 시각 직전까지는 통과, 만료 시각부터는 expired」 사례에서 `expiresAt − 1ms`이면 통과하고, `expiresAt`과 `+1시간`이면 `{ ok: false, reason: "expired" }`가 나온다
- 위조 판정 확인: 서명 바꿈·내용 바꿈·다른 비밀값·같은 바이트의 다른 표기·위조이면서 만료된 토큰·모양이 틀린 토큰 5종이 모두 `{ ok: false, reason: "invalid" }`가 나온다

## 3. 옛 테스트 → TS 테스트 / 폐기 대응표 (`backend/tests/test_adapters.py`)

### 이식한 것(알림)

| 옛 테스트 | 새 테스트 | 바뀐 점 |
|---|---|---|
| `test_fake_notification_sender_records_both_directions` | 「deliver 호출을 순서대로 기록하고 실제로는 아무것도 보내지 않는다」 | 회원·관리자 두 메서드를 없앴다. 양쪽 수신은 이제 `notifications` 행 2건(`payment_confirmed_member`·`payment_confirmed_owner`)이고 포트는 그 id만 받는다(§4.10·D7) |
| `test_fake_notification_sender_copies_payload` | 「기록은 호출자 배열의 복사본이다…」 | payload dict 대신 id 배열을 복사한다. 기록이 얼려 있는지도 확인한다 |
| `test_notification_events_cover_pending_separately_from_failure` | 「환불 처리 중 알림이 환불 실패 알림과 따로 있다」 | 옛 `NotificationEvent` enum이 `NOTIFICATION_KINDS`(§4.1)로 옮겨 갔다 |
| (새 사례) | 「포트 모양을 만족한다」·「빈 목록은 기록하지 않는다」·「reset 은 기록을 비운다」 | 옛 `reset()`에 대응한다 |

### 폐기한 것(슬롯 락): plan D8(Q11(슬롯 잠금 수단): Redis 슬롯 락 폐기)

| 옛 테스트 | 폐기 사유 |
|---|---|
| `test_slot_lock_key_namespace_is_fixed` | Redis 키 공간(`kdance:slot`)이 없어진다. 정원은 DB만 권위를 갖는다 |
| `test_redis_slot_lock_construction_opens_no_socket` | `RedisSlotLock`을 이관하지 않는다 |
| `test_redis_slot_lock_release_returns_false_when_redis_is_down` | 같은 이유. 「Redis가 꺼져도 예외가 없다」를 지킬 대상이 사라진다 |
| `test_redis_slot_lock_release_swallows_client_errors` | 같은 이유 |
| `test_redis_slot_lock_release_deletes_namespaced_key` | 같은 이유 |
| `test_null_slot_lock_records_releases` | `NullSlotLock`이 없다. 포트가 없으니 가짜 구현도 없다(06-ports.md 표 「슬롯 락: 없음」) |
| `test_slot_lock_implementations_satisfy_protocol` | 같은 이유 |

옛 PG 사례(`test_refund_status_*`·`test_parse_portone_*`·`test_fake_gateway_*` 등)는 T-M3-4가 맡으므로 이 표에 넣지 않았다.

## 4. 보안 결정

1. **토큰 모양**: `base64url(JSON).base64url(HMAC-SHA256(secret, "kdance.fake-identity.v1." + 내용 조각))`. 앞에 붙인 문자열이 용도와 버전을 갈라 주므로, 같은 비밀값을 다른 HMAC 용도에 잘못 쓰더라도 서명이 서로 섞이지 않는다
2. **상수 시간 비교**: `timingSafeEqual`을 쓴다. 길이가 다르면 이 함수가 예외를 던지므로 길이(32바이트)를 먼저 거른다. 길이는 비밀이 아니다
3. **서명의 다른 표기 거부**: base64url 43글자의 마지막 글자는 하위 2비트가 버려져서, 다른 글자인데 같은 바이트로 풀리는 표기가 생긴다. 다시 인코딩한 값이 원문과 같은지 확인해 이런 표기를 막고, 테스트로 실증했다
4. **판정 순서는 서명이 먼저, 만료가 나중**: 위조 토큰에는 「만료」라는 정보도 주지 않고 `invalid`만 돌려준다
5. **서명이 맞아도 내용을 다시 검사한다**: 버전·이름(공백만 있으면 안 됨, 100자 이하)·성별(`GENDERS`)·생년월일(없는 날짜 거부)·전화(`^01\d{8,9}$`)·personKey·exp(안전 정수)를 본다. 모양이 틀리면 `invalid`이고 예외를 던지지 않는다. `issue`도 같은 검사를 하며, 틀리면 RangeError를 낸다
6. **CI 해시는 `HMAC-SHA256(pepper, personKey)`의 hex**다. 계약대로 personKey를 앞 문자열 없이 그대로 넣는다. 결과 객체에 personKey 원문이 없다는 것도 테스트로 확인했다
7. **키 검사**: secret·pepper가 32자보다 짧으면 생성자에서 RangeError를 낸다. 두 값이 같아도 거부한다(서명 키와 CI 키를 한 비밀에 묶지 않으려고). 오류 메시지에는 환경 변수 이름만 싣고 값은 넣지 않는다. 이것도 테스트로 확인했다
8. 로그·`console`은 쓰지 않는다. 오류 메시지에 토큰 원문·personKey·비밀값이 들어가지 않는다

## 5. 발견한 이슈와 미해결

- **(알려진 한계) 토큰은 서명만 하고 암호화하지 않는다.** 토큰을 가진 쪽은 이름·전화·personKey를 base64로 풀어 읽을 수 있다. dev 전용 시드 값만 다루므로 받아들였다. 실제 기관을 붙일 때는 기관 콜백 결과를 서버 안에서만 다뤄야 한다
- **(계약 해석) `issue`는 포트 밖의 메서드다.** §4.10 포트에는 `verify`만 있다. dev 경로 `POST /api/dev/identity/fake-verify`가 쓸 발급 함수를 가짜 클래스에 두었다. 그 경로를 만드는 Task는 포트 타입이 아니라 `FakeIdentityVerification` 타입으로 주입받아야 한다
- **(계약 해석) 시계 주입**: §4.10의 `verify`가 `now`를 인자로 받으므로 생성자의 `Clock`은 `issue`의 만료 계산에만 쓴다
- **`deps.ts`에 아직 연결하지 않았다.** 환경 변수 `FAKE_IDENTITY_SECRET`·`IDENTITY_CI_PEPPER`를 읽어 주입하는 일과 `.env.example` 항목 추가는 범위 밖이다(T-M3-6 또는 T-A1 계열 몫)
- `NotificationSenderPort`의 실패 처리 규칙(커밋 뒤 발송이 실패해도 업무 결과를 뒤집지 않는다)은 포트 주석에만 적었다. 실제 호출 지점의 처리는 T-A4 계열에서 검증해야 한다

## 6. 차단

없음. 다만 `tsc --noEmit -p .`의 exit 0은 T-M3-4가 끝나야 성립한다(§2 참고).
