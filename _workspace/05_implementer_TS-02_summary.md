# Phase 5 — TS-02 구현 산출물: 도메인 모델 7개 + 초기 마이그레이션

- 작성일: 2026-09-14 / 담당: kdance-implementer (TS-02)
- 입력: `_workspace/04_task-splitter_tasks.md` §TS-02, §4.1·4.2·4.4 / `_workspace/03_impl-planner_plan.md` §2.4~2.6, §3 #9~#16
- 상태: **완료.** 완료 기준 4개 중 Docker 불요 항목 전부 충족. 실 DB 적용은 TS-11 소관.

---

## 1. 변경한 파일

| 경로 | 구분 | 변경 요약 |
|---|---|---|
| `backend/app/models/refund.py` | **[신규]** | `Refund`. `idempotency_key` 명명 UNIQUE + partial unique index `UNIQUE(reservation_id) WHERE status <> 'failed'`. status/reason CHECK, 금액·bp 범위 CHECK 4종, 환불계좌 3컬럼, `gateway_refund_id`, `failure_code/message` |
| `backend/app/models/refund_event.py` | **[신규]** | `RefundEvent` append-only 감사 로그. `TimestampMixin`을 **의도적으로 쓰지 않음**(`updated_at`이 있으면 수정 가능한 테이블로 읽힘) — `created_at`만 직접 선언. `payload` JSONB 기본값 `{}` |
| `backend/app/models/__init__.py` | **[수정]** | 7개 모델 전부 re-export (`Academy`, `ClassSchedule`, `Order`, `Payment`, `Reservation`, `Refund`, `RefundEvent`) + `Base`/`TimestampMixin` |
| `backend/alembic/versions/0001_initial_domain.py` | **[신규]** | 손작성 초기 리비전. `revision="0001_initial_domain"`, `down_revision=None`. upgrade 17문(테이블 7 + 인덱스 10), downgrade 역순 17문 |

### 이미 존재하던 파일 (건드리지 않음)

`academy.py` · `class_schedule.py` · `order.py` · `payment.py` · `reservation.py` 5개는 **착수 시점에 이미 작성돼 있었다**(mtime 14:52, git 미추적). 전부 읽어 §4.1 값 집합·CHECK 제약·JSONB 기본값·`reserved_count` CHECK가 계약과 일치함을 확인했고, 일치했으므로 **수정하지 않았다.** 이 태스크가 만든 것은 refund 2종뿐이다.

---

## 2. 공유 계약 준수 확인 (§4.1 / §4.2 / §4.4)

| 항목 | 실제 CHECK 제약 | 일치 |
|---|---|---|
| `reservations.status` | `status IN ('held', 'confirmed', 'cancelled')` | O |
| `orders.status` | `status IN ('pending', 'paid', 'refunded')` | O |
| `payments.method` | `method IN ('virtual_account', 'card')` | O |
| `refunds.status` | `status IN ('succeeded', 'pending', 'failed')` | O |
| `refunds.reason` | `reason IN ('member_request')` — **`academy_fault` 없음** | O |
| partial unique index | `WHERE status <> 'failed'` | O |
| `academies.refund_policy_tiers` | JSONB `DEFAULT '[]'::jsonb NOT NULL` | O |

**§4.2 계층 방향 준수:** `grep -rn "RefundStatus\|CancellationReason" backend/app/models/` → 히트 0. 모델은 adapters/services를 import하지 않고 CHECK 제약에 문자열 리터럴을 직접 쓴다.

---

## 3. 검증 결과

```
$ uv run python -c "from app.models import Base; print(sorted(Base.metadata.tables))"
['academies', 'class_schedules', 'orders', 'payments', 'refund_events', 'refunds', 'reservations']   # 7개

$ uv run pytest -q
1 passed, 2 warnings in 0.24s      # test_health.py 회귀 없음
```

### Docker 없이 수행한 추가 검증 (계획에 없던 보강)

`alembic upgrade head --sql` / `downgrade 0001_initial_domain:base --sql`은 **오프라인 모드라 DB 연결 없이 실행된다.** 이를 이용해 TS-11을 앞당겨 부분 검증했다.

1. **upgrade/downgrade 양방향 SQL 생성 성공** — 문법 오류 없음
2. **마이그레이션 DDL == 모델 DDL 문자 단위 대조**: 17문 vs 17문, 실질 불일치 **0건**. 차이로 잡힌 2건은 (a) alembic이 붙이는 `-- Running upgrade` 주석 접두, (b) `refunds`의 UNIQUE/FK 제약 **나열 순서**뿐으로 둘 다 의미 동일
3. **downgrade 역순 완전성**: DROP INDEX 10 + DROP TABLE 7 = upgrade가 만든 전 객체. CHECK·FK·UNIQUE 제약은 테이블 귀속이라 `DROP TABLE`이 함께 제거

> 다만 이것은 **SQL 생성** 검증이지 **실행** 검증이 아니다. `--autogenerate` 빈 diff와 실제 up/down 왕복은 여전히 TS-11(Docker 필요) 소관이며, 통과했다고 기록해서는 안 된다.

---

## 4. 구현 중 발견한 이슈

### 4.1 [수정함] `idempotency_key` UNIQUE에 이름이 없으면 autogenerate가 diff를 낸다

초안은 `mapped_column(..., unique=True)`였다. 이러면 제약에 이름이 없어 PG가 `refunds_idempotency_key_key`를 자동 부여하는데, 손작성 마이그레이션이 다른 이름을 쓰면 **TS-11의 "autogenerate 빈 diff" 완료 기준이 깨진다.** 명명 `UniqueConstraint("idempotency_key", name="uq_refunds_idempotency_key")`로 교체했다.

같은 이유로 마이그레이션의 `PrimaryKeyConstraint`에는 **이름을 붙이지 않았다.** 모델이 PK를 명명하지 않으므로, 마이그레이션만 명명하면 `alembic upgrade`로 만든 스키마와 TS-07 conftest의 `Base.metadata.create_all()`로 만든 스키마의 제약 이름이 갈린다.

### 4.2 [계획 한계 — 수정 안 함] "환불액 > 결제액 불가"를 CHECK만으로는 완결할 수 없다

계획 §2.3이 "상한을 DB CHECK로도 건다"고 하나, PG의 CHECK는 **다른 테이블(`payments.amount`)을 참조할 수 없다.** 행 내부로 가능한 최대치인 `CHECK (refunded_amount <= requested_amount)` + 각 금액 `>= 0`까지만 걸었다. 결제액 대비 상한은 **TS-03의 clamp가 유일한 방어선**이다. 이중 방어라는 계획 서술은 절반만 성립한다 — Phase 9가 이 수용 기준을 "부분 가능"으로 본 것과 일치한다.

### 4.3 [정보] `class_schedules`에 `ends_at`이 없다

수용 기준은 "이미 시작/**종료**된 건 거부"인데 스키마에는 `starts_at`만 있다(계획 §3 #10이 그렇게 정의). 실무상 `starts_at <= now` 거부가 종료 건도 포함하므로 **기능적 구멍은 아니다.** 다만 TS-05가 "종료" 판정을 별도로 하려 들면 참조할 컬럼이 없다. 스키마 변경 없이 `starts_at` 단일 기준으로 거부하는 것을 권한다.

### 4.4 [정보] 착수 시점에 모델 5개가 이미 존재했다

§1에 적은 대로다. 계획은 7개 전부 [신규]로 표기했으나 실제로는 2개만 신규였다. 이전 실행이 중단된 흔적으로 보인다. 기존 5개가 계약과 일치해 **덮어쓰지 않았다** — 병렬 태스크의 산출물일 가능성을 배제할 수 없어 임의 수정을 피했다.

---

## 5. 미해결 / 후속

| 항목 | 처리 |
|---|---|
| `alembic upgrade head` 실제 실행, `--autogenerate` 빈 diff, `downgrade base` 왕복 | **TS-11 (Docker 필요).** 본 태스크의 완료 기준 아님 |
| 백엔드 린터(ruff 등) 미설정 — `uv run ruff` 실패 | 이 태스크 범위 밖. 도입 여부는 별건 |
| Phase 7 필요 사항 | **없음.** 빌드·문법·테스트 전부 통과 |

## 6. Phase 6(테스트) 대상 파일

```
backend/app/models/refund.py
backend/app/models/refund_event.py
backend/app/models/__init__.py
backend/alembic/versions/0001_initial_domain.py
```

DB 없이 검증 가능한 범위: metadata 테이블 7개 등록, 모델 import, 마이그레이션 오프라인 SQL 생성. 제약 실동작(CHECK 위반 INSERT 거부, partial unique index 충돌)은 **TS-12에서만** 실측 가능하다.
