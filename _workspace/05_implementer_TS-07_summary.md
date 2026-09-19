# Phase 5 구현 결과 — TS-07 테스트 하네스 + DB 통합 테스트 작성

- 작성일: 2026-09-15 / 담당: kdance-implementer (TS-07) — 이 요약은 서브에이전트가 세션
  한도(429)로 중단된 후 오케스트레이터가 실제 파일 상태를 검증해 재구성했다.
- 입력: `_workspace/04_task-splitter_tasks.md` §TS-07
- 상태: **완료.** 완료 기준 3개 전부 실측 통과.

---

## 1. 변경한 파일

| 경로 | 구분 | 변경 요약 |
|---|---|---|
| `backend/tests/conftest.py` | 기존 파일 확인만(무수정) | 착수 시점에 이미 완성돼 있었다 — `db_engine`/`db_connection`/`db_session`(`join_transaction_mode="create_savepoint"`), `pytest_runtest_setup`(requires_db skip 훅), `Scenario` 빌더, `committed_scenario`(동시성용 별도 커넥션) 등 스펙이 요구한 픽스처가 전부 존재해 손대지 않았다 |
| `backend/tests/test_cancel_api.py` | **신규** | `POST /reservations/{id}/cancel` DB 통합 테스트 8건 + 동시성 테스트 1건 |
| `backend/tests/test_admin_refund_policy.py` | **신규** | `GET`/`PUT /admin/academies/{id}/refund-policy` DB 통합 테스트 5건 + 검증 실패 파라미터라이즈 12건 |

---

## 2. 완료 기준 검증

| 완료 기준 | 결과 |
|---|---|
| Docker 없이 `uv run pytest`가 초록 — DB 테스트는 skipped, 나머지 passed, error 0 | **159 passed, 27 skipped, 0 failed, 0 error** |
| `uv run pytest -m requires_db --collect-only` → 대상 테스트 전부 수집 | **27/186 tests collected (159 deselected)** — 신규 두 파일의 모든 테스트가 `pytestmark = pytest.mark.requires_db`로 수집됨 |
| 동시성 테스트가 단일 커넥션 픽스처에 의존하지 않음이 코드상 확인 가능 | `test_concurrent_cancel_requests_refund_only_once`는 `db_engine`/`committed_scenario`만 받고 `db_session`/`api_client`는 쓰지 않는다. 요청마다 새 커넥션을 여는 `committed_clients()` 헬퍼를 통해 `app.dependency_overrides[get_db]`를 재정의해 진짜 2개 커넥션으로 `SELECT ... FOR UPDATE` 경합을 재현한다 |

---

## 3. `test_cancel_api.py` 커버리지

- 정상 취소(200, 전액 환불, 좌석 반납, 감사 로그 3종)
- PG `pending` 응답 — 실패가 아니라 정상 경로임을 별도로 확인(좌석 반납 O, `refunded_amount=0`)
- 타인 요청 403(404로 감추지 않음), 존재하지 않는 예약 404, 이미 취소된 예약 409(환불 기록 없는 경우만), 이미 시작한 수업 409
- **멱등 재생**: 중복 요청은 409가 아니라 200 + 같은 환불 행, `slot_restored=False`
- PG 실패: 200 + `status="failed"`, 좌석·예약 상태는 그대로, 사유가 DB에 기록됨
- **동시 2건 요청**: `threading.Barrier(2)` + `ThreadPoolExecutor`로 두 요청을 동시에 보내고, `SET LOCAL lock_timeout`으로 락 버그 시 무한 대기 대신 실패하게 만듦 — 최종적으로 환불 1건·정원 -1·PG 호출 1회만 확인

## 4. `test_admin_refund_policy.py` 커버리지

- 조회: 저장된 비율표 그대로 반환, 존재하지 않는 학원 404, 빈 비율표(`[]`)는 에러가 아니라 정상 200
- 저장: PUT은 부분 수정(PATCH)이 아니라 **전체 교체** — 재조회·DB 직접 조회로 이중 확인(JSONB 제자리 수정 시 SQLAlchemy가 변경을 못 감지해 UPDATE가 조용히 누락되는 함정을 잡기 위함)
- 빈 배열 PUT은 유효한 입력(비율표를 지우는 유일한 수단)
- **검증 실패 12종**(오름차순 위반/중복 시간/bp 범위 초과·음수/시간 0·721/문자열 시간/부동소수 bp/미정의 필드/필수 필드 누락/최상위가 배열/타일 개수 초과) — 전부 422이며, **기존 비율표가 그대로 남아 있는지**까지 확인(일부만 저장되는 사고 방지)

---

## 5. 구현 중 발견한 이슈

없음으로 확인됨 — conftest.py가 이미 스펙대로 완성돼 있어 두 테스트 파일 작성 외에 추가 작업이 필요하지 않았다. 서비스/스키마 로직(`services/cancellation.py`, `schemas/*`)은 읽기만 하고 수정하지 않았다.

## 6. 미해결 사항

- **실제 DB 실행은 여전히 미검증** — 이 환경에 Docker가 없어 27건은 `skipped` 상태다. 실제 실행·잠금 경합·IntegrityError 수렴 확인은 **SCH-12(DB 통합 테스트 실행)**의 몫이다.
- Phase 7 필요 사항: **없음.**

## 7. Phase 6(테스트) 대상 파일

```
backend/tests/test_cancel_api.py
backend/tests/test_admin_refund_policy.py
```
