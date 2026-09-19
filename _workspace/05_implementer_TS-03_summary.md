# Phase 5 — TS-03 환불액 산정 순수 함수 + 수수료 정책 + 단위 테스트

- 작성일: 2026-09-14 / 담당: kdance-implementer (TS-03)
- 입력: `_workspace/04_task-splitter_tasks.md` §TS-03, §1, §4.2, §4.3 / `_workspace/03_impl-planner_plan.md`
- 상태: **완료.** 완료 기준 4개 전부 충족, 실제 실행으로 검증됨(Docker 불필요).

---

## 1. 변경한 파일

| 경로 | 상태 | 변경 요약 |
|---|---|---|
| `backend/app/services/refund_policy.py` | **기존 파일 검증 + 주석 2곳 수정** | 파일이 이미 존재했다(§3 이슈 A). 로직을 명세와 대조해 전수 검증했고, 완료 기준을 깨는 주석 2곳만 고쳤다. **산정 로직은 한 줄도 바꾸지 않았다.** |
| `backend/app/services/fee_policy.py` | **신규** | Q4 확정값 4개 상수 + 각 상수별 "산정 미반영 사유" 주석. 파일 상단 `# Q4 확정(2026-09-14, requirements §9)` |
| `backend/tests/test_refund_policy.py` | **신규** | 테스트 함수 24개 → 파라미터라이즈 전개 **50건**. skip 0 |

**이 3개 파일 외에는 아무것도 건드리지 않았다.** `tests/conftest.py`는 만들지 않았다(TS-07 소유, §3 웨이브 표 지시). `app/models/*`, `app/adapters/*`(TS-02·TS-04 소유)는 읽지도 수정하지도 않았다.

### `refund_policy.py`에서 고친 2곳 (둘 다 주석/독스트링, 동작 변화 0)

`_ceil_amount`의 독스트링이 완료 기준 grep을 두 번 깨뜨렸다.

1. 원문에 `paid_amount * rate_bp / 10000`이라는 수식이 있었다 → **`grep "/ 100"`이 `/ 10000`을 부분문자열로 잡는다.** 산문 서술로 교체.
2. 1차 수정에서 "``round()``를 쓰면 안 된다"고 **왜 안 쓰는지** 설명하며 `round(`를 문자 그대로 적었다 → `grep "round("` 히트. "표준 반올림 함수"로 교체.

둘 다 계산 경로가 아니라 문서화 텍스트였지만, 완료 기준이 grep 히트 0을 요구하므로 맞췄다.

---

## 2. 완료 기준 대조 (실행 결과)

| 완료 기준 | 결과 |
|---|---|
| `uv run pytest tests/test_refund_policy.py -v` → skip 없이 전부 통과 | **50 passed, 0 skipped, 0 failed** |
| 24:00:00 정각이 100% 환불로 **단정**되는 테스트 존재 | `test_exactly_24h_before_start_is_full_refund` PASSED. 추가로 파라미터라이즈 `[24:00:00-...-86400-10000-100000]` PASSED |
| `grep -n "float\|/ 100\|round(" app/services/refund_policy.py` → 히트 0 | **count=0** |
| `uv run pytest` 전체 초록 | **51 passed** (`test_health.py` 1건 포함, 회귀 없음) |

### 공유 계약(§4.2·§4.3) 준수

- `CancellationReason` StrEnum을 **이 모듈이 소유**한다. 멤버는 `MEMBER_REQUEST = "member_request"` **하나뿐**이며, `test_cancellation_reason_has_only_member_request`가 값 집합을 문자 단위로 못박는다 — TS-02의 `refunds.reason` CHECK 제약과 어긋나면 이 테스트가 깨진다. `academy_fault`는 넣지 않았다.
- §4.3 시그니처 그대로: `calculate_refund(paid_amount, starts_at, now, tiers, reason) -> RefundCalculation`. `now`는 파라미터 주입이며 모듈 어디에서도 시스템 시각을 읽지 않는다.

### 명세대로 확인한 산정 규칙

- **24h 경계는 전액 환불 쪽 포함.** 비율표에 24h 티어(50%)가 있어도 정확히 24:00:00 전이면 100%가 나온다 — 플랫폼 고정 규칙이 학원 비율표를 이긴다. 23:59:59 / 24:00:00 / 24:00:01 세 건을 같은 파라미터라이즈 테이블에 넣어 회귀가 한눈에 보이게 했다.
- 티어 해석: `h <= tier.hours_before_start`인 티어 중 `hours_before_start` **최솟값**. 없으면 0%. 순서 무관(`test_tier_order_does_not_matter`가 뒤섞은 표와 정렬된 표의 결과 동일성을 단정).
- 올림: `-(-paid_amount * rate_bp // 10000)`. 정수 연산만. 1원 올림 케이스 8건 파라미터라이즈(`1000×3333bp → 334`, `1×1bp → 1` 등).
- clamp, bp 0/10000, `paid_amount=0` 전부 커버.

---

## 3. 구현 중 발견한 이슈

### A. `refund_policy.py`가 이미 존재했다 — Phase 5 이전 실행 잔여물 **[해소됨, 단 오케스트레이터 확인 권장]**

착수 시 `backend/app/services/refund_policy.py`가 타임스탬프 14:53로 **이미 존재**했다(`[신규]`로 배정된 파일인데). 세션 시작 시점의 git status에도 `backend/app/services/`가 untracked로 잡혀 있었으므로 **이번 호출 중 다른 병렬 에이전트가 쓴 것이 아니라, 그 이전에 만들어진 것**이다. 같은 시각대에 `app/models/*.py`(TS-02 대상)도 5개 존재했다.

→ **판단:** TS-03의 소유 파일이므로 임의로 덮어쓰지 않고 명세와 전수 대조해 검증했다. 로직이 §TS-03 요구와 §4.2·§4.3 계약에 정확히 부합했으므로 **보존**하고 주석 2곳만 고쳤다. 덮어썼다면 동일한 결과물을 다시 만들었을 뿐이다.

→ **오케스트레이터 확인 필요:** Phase 5가 이전에 부분 실행됐다면 TS-02·TS-04의 진행 상태도 중복/충돌 여부를 점검해야 한다. 특히 `app/models/`에 `refund.py`·`refund_event.py`와 `0001_initial_domain.py`가 아직 없어 **TS-02는 미완 상태로 보인다**(현재 병렬 실행 중이라면 정상).

### B. `app/services/__init__.py`가 없다 **[동작에는 문제 없음, TS-05 결정 사항]**

`app/models/`에는 `__init__.py`가 있으나 `app/services/`에는 없다. Python 3 암묵적 네임스페이스 패키지로 동작하므로 `from app.services.refund_policy import ...`는 정상이며 실제로 전 테스트가 통과한다.

→ **내 태스크 범위 밖이라 만들지 않았다.** TS-03 대상 파일 목록에 없고, 같은 디렉터리에 `cancellation.py`를 추가하는 **TS-05가 결정하는 편이 맞다**. 패키지 일관성을 맞추려면 TS-05에서 추가할 것.

### C. `calculate_refund`가 잘못된 비율표에 `ValueError`를 던진다 — **TS-06 preview 경로에 500 위험 [TS-05·TS-06이 반드시 처리할 것]**

`refund_policy.py`는 `tiers` JSONB의 구조·범위를 검증하고 어긋나면 `ValueError`를 던진다(키 누락, bp 범위 밖, `hours_before_start` 1~720 밖, dict 아님, float 값). 이 방어 자체는 타당하다 — JSONB는 DB가 구조를 보장하지 않으므로 엉뚱한 금액을 송금하느니 터뜨리는 게 낫다.

**다만 호출부에 파급이 있다:**
- TS-06의 `GET /reservations/{id}/cancellation-preview`는 DB에 이미 저장된 `academies.refund_policy_tiers`를 그대로 넘긴다. TS-06의 Pydantic 쓰기 검증이 붙기 **전에** 저장된 행이나, DB에 직접 넣은 행이 있으면 **preview가 500을 뱉는다.**
- TS-05의 취소 트랜잭션도 같은 예외를 탄다.

→ **권고:** TS-05/TS-06에서 `ValueError`를 잡아 422 또는 "학원 환불 정책이 올바르지 않습니다" 류의 명시적 오류로 변환할 것. 이 변환은 내 태스크 범위가 아니라 손대지 않았다.

### D. `RefundCalculation`이 §4.3 명세보다 필드가 많다 **[정보 공유]**

§4.3은 `refund_amount: int, refund_rate_bp: int, hours_before_start: ...`까지만 적고 있다. 실제 구현은 여기에 두 필드가 더 있다:

- `seconds_before_start: int` — 경계 판정의 **실제 근거**(`hours_before_start`는 내림이라 23:59:59와 23:00:00을 구분하지 못한다). 감사 로그·디버깅에 이게 있어야 한다.
- `applied_tier_hours: int | None` — 적용된 티어. 24h 규칙이 적용됐거나 매칭 티어가 없으면 `None`.

§4.3이 `hours_before_start: ...`로 끝을 열어 둔 서술이라 계약 위반은 아니다. **TS-05가 `refund_events` 감사 로그에 `seconds_before_start`·`applied_tier_hours`를 남기면 "왜 이 금액이 나왔는지"가 사후 재현 가능해진다** — 권고 사항이다.

### E. 고정한 미정의 동작 2건 **[명세에 없어 내가 결정함]**

명세가 다루지 않았으나 구현상 결정이 강제된 지점이다. 둘 다 테스트로 못박아 뒀다.

1. **`hours_before_start` 중복 티어** → 앞에 나온 것을 쓴다(`test_duplicate_tier_hours_uses_first_occurrence`). 중복은 TS-06 쓰기 경로에서 막을 예정이나 이미 저장된 데이터가 들어올 수 있어, 조용히 뒤의 것을 쓰거나 예외를 던지는 대신 동작을 결정적으로 고정했다.
2. **이미 시작한 수업(`now > starts_at`)** → 예외 없이 0%를 반환한다(`test_after_start_is_zero_refund_without_raising`). 상태 전이 거부는 TS-05의 책임이며, 순수 함수가 여기서 던지면 preview 경로가 500이 된다.

---

## 4. 미해결 사항

**이 태스크 범위 내 미해결 없음.** 완료 기준 4개 전부 실측 통과.

Phase 7(오류 수정)로 넘길 항목도 **없다** — 발견한 이슈 A·B·C·D·E는 전부 다른 태스크(TS-02/05/06)의 소유 영역이거나 정보 공유이며, 내 태스크의 빌드·테스트는 깨지지 않았다.

**후속 태스크가 받아야 할 항목:**

| 항목 | 수신 태스크 |
|---|---|
| C. `ValueError` → HTTP 오류 변환 (preview 500 위험) | **TS-05, TS-06** |
| B. `app/services/__init__.py` 추가 여부 결정 | TS-05 |
| D. 감사 로그에 `seconds_before_start`·`applied_tier_hours` 기록 권고 | TS-05 |
| A. Phase 5 이전 부분 실행 잔여물 점검 (TS-02 미완 가능성) | **오케스트레이터** |

---

## 5. Phase 6(테스트) 대상

```
backend/app/services/refund_policy.py
backend/app/services/fee_policy.py
backend/tests/test_refund_policy.py
```

재현 명령:

```bash
cd /home/user/kdance/backend
uv run pytest tests/test_refund_policy.py -v      # 50 passed, skip 0
uv run pytest                                      # 51 passed
grep -c "float\|/ 100\|round(" app/services/refund_policy.py   # 0
```

`fee_policy.py`는 상수 선언만이라 이번 슬라이스에서 이를 읽는 코드가 없다 — **단위 테스트를 붙이지 않았다.** 상수값 자체를 재단정하는 테스트는 동어반복이라 회귀를 못 잡는다. 값의 실효는 정산 모듈이 생길 때 검증 대상이 된다.
