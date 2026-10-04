"""수업 슬롯 락 어댑터 (Redis).

가상계좌는 사용자가 앱을 벗어나 은행에서 이체해야 하므로 **입금 대기 상태**가
생긴다. 그동안 같은 슬롯이 중복 예약되지 않도록 Redis에 짧은 TTL 락을 건다
(``docs/policy/payment-method-policy.md`` "가상계좌 결제의 구조적 차이 — 슬롯 홀드 필요").

이번 슬라이스가 다루는 건 **해제(release)뿐**이다. 예약 취소가 확정되면 해당
스케줄의 슬롯 락을 지워 다시 예약 가능하게 만든다. 락을 거는 쪽(acquire)은 예약
생성 경로에 있고, 그 경로 자체가 이번 범위 밖이다(F6 — 결제 생성 경로 없음).
지금 acquire를 추측해서 넣으면 쓰이지도 않는 API가 고정된다.

**Redis 장애가 예외를 밖으로 던지지 않는다.**
``infra/docker-compose.yml``의 redis에는 볼륨이 없다 — 재시작하면 전부 날아간다.
즉 Redis는 진실의 원천이 아니라 단기 캐시다. 이중 환불을 구조적으로 막는 것은
``refunds`` 테이블의 부분 유니크 인덱스이지 이 락이 아니다(Phase 3 D5).
그런 캐시의 장애로 **이미 돈이 움직인 환불 트랜잭션이 롤백되는 쪽이 훨씬 나쁘다.**
그래서 이 모듈의 모든 실패는 경고 로그 + no-op으로 끝나고, 호출자는 반환된
``bool``로 성공 여부만 알 수 있다.
"""

# 학습 주석: SCH-04(어댑터 3종: PG/알림/슬롯락) 반영
#
# 사전 개념 (이 파일을 읽기 전에):
# - Protocol과 포트/어댑터 패턴은 app/adapters/__init__.py에서 설명했다 —
#   SlotLock도 같은 구조다(NullSlotLock이 Fake 역할).
# - Redis: 데이터를 메모리에 두고 아주 빠르게 읽고 쓰는 오픈소스 key-value
#   저장소다. 이 프로젝트는 "짧게만 유지되면 되는 상태"(슬롯 락, 쿠폰 중복사용
#   방지)를 DB 대신 Redis에 둔다. infra/docker-compose.yml의 redis 컨테이너에는
#   볼륨이 없어 재시작하면 값이 전부 사라진다 — 즉 Redis는 "진실의 원천"이
#   아니라 없어져도 그만인 단기 캐시일 뿐이다.
# - 느슨한 연결(lazy connection): RedisSlotLock은 생성자에서 곧바로 Redis에
#   접속하지 않는다. release()가 실제로 처음 호출될 때가 돼서야 접속을
#   시도한다(아래 _get_client()). 생성자에서 바로 접속을 시도하면, Redis가
#   꺼져 있는 로컬 개발 환경에서는 이 클래스를 만드는 것(의존성 주입) 자체가
#   실패해버린다. 연결을 실제로 필요한 순간까지 미뤄야 Redis 없이도 나머지
#   기능을 켜고 테스트할 수 있다.
# - 예외를 삼키는 방어적 설계: release()는 Redis 관련 오류가 나도 예외를 밖으로
#   던지지 않고 False만 돌려준다. 핵심 이유는 "이미 돈이 움직인 환불
#   트랜잭션이 부가적인 캐시 정리 실패 때문에 롤백되면 안 된다"는 것이다 —
#   자세한 근거는 release() 위 주석 참고.

from __future__ import annotations

import logging
from typing import Any, Protocol, runtime_checkable

__all__ = [
    "SLOT_LOCK_KEY_NAMESPACE",
    "NullSlotLock",
    "RedisSlotLock",
    "SlotLock",
    "slot_lock_key",
]

logger = logging.getLogger(__name__)

#: 슬롯 락 키 네임스페이스. **고정값이다.**
#:
#: Redis 인스턴스 하나를 쿠폰 중복사용 방지 락(§4.6)과 함께 쓰므로, 네임스페이스를
#: 나누지 않으면 서로의 키를 지운다. 값을 바꾸면 예약 생성 경로가 거는 락과
#: 여기서 지우는 키가 어긋나 **락이 영영 안 풀린다** — 반드시 양쪽을 같이 고친다.
SLOT_LOCK_KEY_NAMESPACE = "kdance:slot"

#: Redis가 죽어 있을 때 빨리 포기하기 위한 타임아웃(초).
#: 기본값(무제한)이면 취소 API가 Redis 장애에 붙들려 멈춘다.
_DEFAULT_TIMEOUT_SECONDS = 1.0


def slot_lock_key(schedule_id: Any) -> str:
    """스케줄 ID로 슬롯 락 키를 만든다 → ``kdance:slot:{schedule_id}``."""
    return f"{SLOT_LOCK_KEY_NAMESPACE}:{schedule_id}"


@runtime_checkable
class SlotLock(Protocol):
    """슬롯 락 포트.

    :meth:`release`는 **절대 예외를 던지지 않는다.** 해제 실패는 ``False`` 반환과
    경고 로그로만 표현된다.
    """

    def release(self, schedule_id: Any) -> bool:
        """슬롯 락을 해제한다. 성공(또는 이미 없음)이면 ``True``."""
        ...


# SlotLock Protocol을 상속하지 않고도 release()만 구현해 "SlotLock답게"
# 취급되는 실제 구현체다. 취소 오케스트레이션 서비스(SCH-05)가 환불 확정
# 트랜잭션 뒤에 호출한다. acquire()가 없는 이유는 이 슬라이스에 슬롯을 거는
# 쪽(예약 생성 경로)이 아직 없기 때문이다 — 모듈 독스트링 참고.
class RedisSlotLock:
    """Redis 기반 슬롯 락 해제기.

    연결은 **지연(lazy)** 이다. 생성자와 모듈 import 어디에서도 소켓을 열지 않으므로
    Redis가 꺼진 상태에서도 import·주입이 안전하다.
    """

    def __init__(
        self,
        redis_url: str | None = None,
        *,
        client: Any = None,
        timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._redis_url = redis_url
        self._client = client
        self._client_initialized = client is not None
        self._timeout_seconds = timeout_seconds

    def _get_client(self) -> Any:
        """Redis 클라이언트를 지연 생성한다. 실패하면 ``None``."""
        if self._client_initialized:
            return self._client

        self._client_initialized = True
        try:
            import redis

            from app.config import get_settings

            url = self._redis_url or get_settings().redis_url
            self._client = redis.Redis.from_url(
                url,
                socket_connect_timeout=self._timeout_seconds,
                socket_timeout=self._timeout_seconds,
            )
        except Exception:
            # 설정 로딩 실패, URL 파싱 실패, redis 패키지 문제 등 무엇이든.
            # 슬롯 락은 부가 기능이므로 여기서 죽으면 안 된다.
            logger.warning(
                "Redis 슬롯 락 클라이언트 생성 실패 — 슬롯 락 해제를 건너뜁니다. "
                "예약 정원(reserved_count) 복구는 DB 트랜잭션이 이미 처리했습니다.",
                exc_info=True,
            )
            self._client = None
        return self._client

    def release(self, schedule_id: Any) -> bool:
        """슬롯 락 키를 삭제한다.

        **어떤 예외도 밖으로 나가지 않는다.** 예외 종류를 좁히지 않고 ``Exception``을
        통째로 삼키는 것은 의도적이다 — redis-py는 연결 계열만 해도
        ``ConnectionError``/``TimeoutError``/``OSError``/``ValueError``를 상황에 따라
        내고, 여기서 하나라도 새 나가면 **환불 트랜잭션이 캐시 장애로 롤백된다.**
        대신 조용히 넘어가지 않도록 스택 트레이스를 경고 로그에 남긴다.

        :return: 키를 지웠거나 애초에 없었으면 ``True``. Redis에 닿지 못했으면 ``False``.
        """
        client = self._get_client()
        if client is None:
            return False

        key = slot_lock_key(schedule_id)
        try:
            client.delete(key)
        except Exception:
            logger.warning(
                "Redis 슬롯 락 해제 실패 (key=%s) — 무시하고 진행합니다. "
                "락은 TTL로 만료되며, 예약 가능 여부의 권위는 DB의 "
                "class_schedules.reserved_count다.",
                key,
                exc_info=True,
            )
            return False
        return True


# Redis 없이도 서비스 로직을 테스트하기 위한 Fake 객체다. 실제로 아무것도
# 지우지 않고 released 리스트에 기록만 남긴다 — "서비스가 해제를 호출했는가"만
# 확인하면 되는 테스트에 쓴다.
class NullSlotLock:
    """아무것도 하지 않는 슬롯 락. 테스트와 Redis 없는 로컬 실행용.

    해제 요청을 :attr:`released`에 기록하므로 "서비스가 해제를 호출했는가"는
    단정할 수 있다.
    """

    def __init__(self) -> None:
        self.released: list[str] = []

    def release(self, schedule_id: Any) -> bool:
        self.released.append(slot_lock_key(schedule_id))
        return True

    def reset(self) -> None:
        self.released.clear()
