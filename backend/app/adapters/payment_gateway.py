"""결제 게이트웨이(PG) 어댑터 — 환불 실행 경계.

이 모듈은 **환불 1건을 PG에 요청하고 그 결과를 도메인 용어로 되돌려주는 것**만
책임진다. 상태 전이 판정·DB 쓰기·알림은 취소 오케스트레이션 서비스
(``app/services/cancellation.py``)의 몫이다.

PG사 = 포트원(PortOne)
------------------------
``docs/payment-method-policy.md`` "결제수단 라우팅 규칙 — 방식 A / 방식 B"에서
**방식 B의 PG로 포트원이 확정**됐다. 같은 문서가 "가짜 어댑터를 쓰더라도 포트원
응답 스키마를 흉내 낼 것"을 명시하므로, 이 파일의 요청/응답 모델은 포트원 V2
``POST /payments/{paymentId}/cancel``의 실제 필드에 1:1로 대응한다.

| 포트원 V2 필드 | 이 모듈 |
|---|---|
| ``paymentId`` | ``RefundRequest.payment_key`` |
| ``reason`` (필수) | ``RefundRequest.reason`` |
| ``amount`` | ``RefundRequest.amount`` |
| ``refundAccount.bank`` / ``.number`` / ``.holderName`` / ``.holderPhoneNumber`` | ``RefundAccount`` 4개 필드 |
| ``cancellation.status`` ∈ ``SUCCEEDED``/``REQUESTED``/``FAILED`` | ``RefundStatus`` (아래 매핑표) |
| ``cancellation.id`` | ``RefundResult.gateway_refund_id`` |
| ``cancellation.pgCancellationId`` | ``RefundResult.pg_cancellation_id`` |
| ``cancellation.totalAmount`` | ``RefundResult.total_amount`` |
| ``cancellation.requestedAt`` / ``.cancelledAt`` | 동명 필드 |

**핵심은 ``REQUESTED`` → ``pending`` 매핑이다.** 포트원은 가상계좌 환불처럼 즉시
완결되지 않는 취소를 ``REQUESTED``로 돌려준다. 이 상태를 실패로 접어버리면 정상
환불이 실패로 기록된다. ``RefundStatus.pending``을 1급 상태로 두는 이유가 이것이다
(``docs/payment-method-policy.md`` §4 "환불의 ``pending``은 오류가 아니라 정상 상태").

포트원 응답 파싱(:func:`parse_portone_cancel_response`)은 **프로덕션 코드**이고,
:class:`FakePaymentGateway`는 포트원 모양의 페이로드를 만들어 그 파서에 통과시킨다.
실 연동 시 교체되는 것은 "HTTP 호출" 한 겹뿐이고, 상태 매핑·필드 해석은 지금
테스트로 덮인 채 그대로 살아남는다.

**범위 밖:** 카드 승인취소(Q2 확정). ``method == "card"`` 요청은
:class:`UnsupportedPaymentMethodError`로 **시끄럽게** 실패한다.
"""

# 학습 주석: SCH-04(어댑터 3종: PG/알림/슬롯락) 반영
#
# 사전 개념 (이 파일을 읽기 전에):
# - Protocol과 포트/어댑터 패턴의 기본 개념은 app/adapters/__init__.py에서
#   설명했다 — 여기서는 반복하지 않는다.
# - Fake 객체(테스트 더블): 진짜 외부 API(여기서는 포트원 결제 취소 API) 없이도
#   서비스 로직을 테스트하기 위해 만든 가짜 구현체다. 아래 FakePaymentGateway는
#   실제로 HTTP 요청을 보내는 대신, 생성 시 받은 규칙(fail_on에 있으면 실패,
#   pending_on에 있으면 대기)에 따라 인메모리에서 결과를 "연기"한다. 네트워크도
#   포트원 계약도 실제 돈도 없이 "PG가 실패를 돌려주면 서비스가 어떻게
#   반응하는가" 같은 시나리오를 0.1초 만에 검증할 수 있다.
# - 이 파일에서 Fake가 특히 중요한 이유: parse_portone_cancel_response()가
#   실 연동과 Fake가 함께 쓰는 프로덕션 함수라서, Fake 기반 테스트가
#   "포트원의 REQUESTED가 pending으로 제대로 번역되는가" 같은 실제로 틀리기
#   쉬운 지점을 그대로 검증한다.

from __future__ import annotations

import hashlib
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Protocol, runtime_checkable

__all__ = [
    "PORTONE_CANCELLATION_STATUS_MAP",
    "FakePaymentGateway",
    "PaymentGateway",
    "PaymentGatewayError",
    "PaymentMethod",
    "RefundAccount",
    "RefundRequest",
    "RefundResult",
    "RefundStatus",
    "UnsupportedPaymentMethodError",
    "parse_portone_cancel_response",
]


# --------------------------------------------------------------------------- #
# 값 집합
# --------------------------------------------------------------------------- #


class RefundStatus(StrEnum):
    """환불 상태.

    **이 모듈이 소유한다** (Phase 4 공유 계약 §4.2). 서비스·라우터·모델 주석은
    전부 여기를 참조한다 — 모델(``app/models/refund.py``)은 계층 역전을 피하려고
    import 대신 CHECK 제약에 같은 문자열을 직접 쓰므로, 값이 **문자 단위로**
    ``refunds.status`` CHECK 및 부분 유니크 인덱스(``WHERE status <> 'failed'``)와
    일치해야 한다. 철자를 바꾸면 마이그레이션 없이는 깨진다.

    ``pending``은 오류가 아니라 **정상 상태**다. 가상계좌 환불은 원거래 취소가
    아니라 회원 계좌로의 별도 송금이라 즉시 완결되지 않는다. bool로 모델링하면
    나중에 서비스·모델·API가 전부 바뀐다.
    """

    SUCCEEDED = "succeeded"
    PENDING = "pending"
    FAILED = "failed"


class PaymentMethod(StrEnum):
    """결제수단. ``payments.method`` CHECK 값 집합과 문자 단위로 일치 (공유 계약 §4.1)."""

    VIRTUAL_ACCOUNT = "virtual_account"
    CARD = "card"


#: 포트원 V2 ``PaymentCancellation.status`` → 도메인 :class:`RefundStatus` 매핑.
#:
#: 포트원은 ``SucceededPaymentCancellation`` / ``RequestedPaymentCancellation`` /
#: ``FailedPaymentCancellation`` 세 변종을 ``status`` 필드로 discriminate 한다.
#: 여기 없는 값(포트원이 나중에 변종을 추가하는 경우 — 공식 SDK의
#: ``isUnrecognizedPaymentCancellation``이 다루는 상황)은 ``failed``로 떨어뜨리되
#: ``failure_code``에 원문을 남겨 조용히 묻히지 않게 한다.
PORTONE_CANCELLATION_STATUS_MAP: Mapping[str, RefundStatus] = {
    "SUCCEEDED": RefundStatus.SUCCEEDED,
    "REQUESTED": RefundStatus.PENDING,
    "FAILED": RefundStatus.FAILED,
}

#: 포트원이 모르는 상태를 돌려줬을 때 쓰는 실패 코드.
UNRECOGNIZED_STATUS_CODE = "UNRECOGNIZED_CANCELLATION_STATUS"

#: 환불계좌 없이 가상계좌 환불을 시도했을 때의 실패 코드.
#: 정상 경로에서는 스키마 계층(``schemas/cancellation.py``)이 먼저 422로 막는다.
REFUND_ACCOUNT_REQUIRED_CODE = "REFUND_ACCOUNT_REQUIRED"

#: 포트원 ``reason``은 필수 문자열이다. 이번 슬라이스의 취소 사유는
#: ``member_request`` 하나뿐이라(공유 계약 §4.1) 기본값을 둔다.
DEFAULT_CANCEL_REASON = "회원 요청 취소"


# --------------------------------------------------------------------------- #
# 예외
# --------------------------------------------------------------------------- #


# 이 파일이 밖으로 던질 수 있는 예외 전부의 공통 조상. 서비스 계층(SCH-05)이
# "PG 어댑터 쪽에서 난 문제인가"를 한 번에 잡고 싶을 때 이 타입 하나만 보면 된다.
class PaymentGatewayError(Exception):
    """PG 어댑터 계층의 기반 예외."""


class UnsupportedPaymentMethodError(PaymentGatewayError):
    """이번 슬라이스가 지원하지 않는 결제수단으로 환불을 시도했다.

    카드 승인취소는 Q2 확정상 범위 밖이다. 조용히 가상계좌 경로로 흘려보내면
    존재하지 않는 환불계좌로 송금을 시도하는 꼴이 된다 — **눈에 보이는 구멍**을
    남기는 쪽이 낫다.
    """

    def __init__(self, method: str) -> None:
        self.method = method
        super().__init__(
            f"지원하지 않는 결제수단입니다: {method!r}. "
            f"이번 슬라이스는 {PaymentMethod.VIRTUAL_ACCOUNT!s} 환불만 지원한다 "
            f"(카드 승인취소는 Q2 확정상 범위 밖)."
        )


# --------------------------------------------------------------------------- #
# 요청/응답 모델
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class RefundAccount:
    """환불 수취 계좌.

    가상계좌 결제는 원거래 취소 수단이 없어 **플랫폼이 회원 계좌로 새로 송금**한다.
    그래서 이 정보가 필요하다.

    필드명은 도메인/DB 쪽 표기를 따르고, 포트원 요청 본문으로 나갈 때
    :meth:`to_portone_payload`가 ``bank``/``number``/``holderName``/
    ``holderPhoneNumber``로 바꾼다 — PG를 갈아끼울 때 바뀌는 건 이 메서드 하나다.

    ``holder_phone_number``는 포트원 기준 선택값이지만 **스마트로 가상계좌 취소에는
    필수**다. 지금 자리를 비워두면 나중에 시그니처가 바뀐다.
    """

    bank_code: str
    account_number: str
    holder_name: str
    holder_phone_number: str | None = None

    def to_portone_payload(self) -> dict[str, str]:
        """포트원 V2 ``refundAccount`` 오브젝트 형태로 변환."""
        payload = {
            "bank": self.bank_code,
            "number": self.account_number,
            "holderName": self.holder_name,
        }
        if self.holder_phone_number:
            payload["holderPhoneNumber"] = self.holder_phone_number
        return payload


@dataclass(frozen=True, slots=True)
class RefundRequest:
    """환불 1건 요청.

    결제수단을 **요청 안의 태그**로 두고 메서드를 카드/가상계좌로 쪼개지 않는다
    (Phase 3 D4). 포트원도 취소 API가 하나이고 ``refundAccount`` 유무로 갈린다.

    :param payment_key: 원거래 식별자. 포트원 ``paymentId``.
    :param method: :class:`PaymentMethod` 값. DB에서 읽은 평문 ``str``도 그대로 받는다.
    :param amount: 환불 금액(원). **정수만** — 부동소수 금지.
    :param idempotency_key: 같은 논리 요청의 재시도를 같은 결과로 되돌리는 키.
    :param refund_account: 가상계좌 환불 시 필수. 검증은 스키마 계층이 먼저 한다.
    :param reason: 포트원 ``reason``(필수 문자열).
    """

    payment_key: str
    method: str
    amount: int
    idempotency_key: str
    refund_account: RefundAccount | None = None
    reason: str = DEFAULT_CANCEL_REASON

    def to_portone_payload(self) -> dict[str, Any]:
        """포트원 V2 ``POST /payments/{paymentId}/cancel`` 요청 본문 형태로 변환."""
        payload: dict[str, Any] = {
            "paymentId": self.payment_key,
            "reason": self.reason,
            "amount": self.amount,
        }
        if self.refund_account is not None:
            payload["refundAccount"] = self.refund_account.to_portone_payload()
        return payload


@dataclass(frozen=True, slots=True)
class RefundResult:
    """환불 요청의 결과. 포트원 ``PaymentCancellation`` 한 건에 대응한다.

    ``raw_response``에는 파싱 전 원본 페이로드를 그대로 보관한다 — 감사 로그
    (``refund_events``)에 PG 원문을 남길 수 있어야 분쟁 시 근거가 된다.
    """

    status: RefundStatus
    gateway_refund_id: str | None = None
    pg_cancellation_id: str | None = None
    total_amount: int | None = None
    requested_at: datetime | None = None
    cancelled_at: datetime | None = None
    failure_code: str | None = None
    failure_message: str | None = None
    raw_response: Mapping[str, Any] = field(default_factory=dict)

    @property
    def is_succeeded(self) -> bool:
        return self.status is RefundStatus.SUCCEEDED

    @property
    def is_pending(self) -> bool:
        return self.status is RefundStatus.PENDING

    @property
    def is_failed(self) -> bool:
        return self.status is RefundStatus.FAILED


# --------------------------------------------------------------------------- #
# 포트원 응답 파서 (실 연동에서도 그대로 쓰인다)
# --------------------------------------------------------------------------- #


def _parse_portone_datetime(value: Any) -> datetime | None:
    """포트원의 ISO 8601 시각 문자열을 tz-aware ``datetime``으로.

    파싱 실패는 예외로 올리지 않는다 — 시각 한 필드 때문에 환불 결과 전체를
    버리는 게 더 나쁘다. 상태(``status``)가 진짜 중요한 정보다.
    """
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


# 실 연동 어댑터(이번 슬라이스에는 없다)와 FakePaymentGateway가 같은 함수를
# 호출한다 — 그래서 이 함수만 정확하면 실 연동을 붙일 때 바뀌는 건 "HTTP
# 호출" 한 겹뿐이고, 상태 매핑은 Fake 기반 테스트로 이미 검증된 채 남는다.
def parse_portone_cancel_response(payload: Mapping[str, Any]) -> RefundResult:
    """포트원 V2 취소 응답(``{"cancellation": {...}}``)을 :class:`RefundResult`로.

    실 연동 어댑터와 :class:`FakePaymentGateway`가 **같은 함수**를 쓴다. 덕분에
    ``REQUESTED`` → ``pending`` 매핑처럼 틀리기 쉬운 부분이 Fake 기반 테스트로도
    실제로 검증된다.
    """
    cancellation = payload.get("cancellation")
    if not isinstance(cancellation, Mapping):
        return RefundResult(
            status=RefundStatus.FAILED,
            failure_code=UNRECOGNIZED_STATUS_CODE,
            failure_message="포트원 응답에 cancellation 오브젝트가 없습니다.",
            raw_response=dict(payload),
        )

    raw_status = str(cancellation.get("status", ""))
    status = PORTONE_CANCELLATION_STATUS_MAP.get(raw_status)

    failure_code = cancellation.get("failureCode")
    failure_message = cancellation.get("failureMessage")
    if status is None:
        # 포트원이 새 변종을 추가한 경우. 성공으로 넘겨짚지 않고 실패로 떨어뜨리되
        # 원문 상태를 코드에 남겨 원인을 추적할 수 있게 한다.
        status = RefundStatus.FAILED
        failure_code = failure_code or UNRECOGNIZED_STATUS_CODE
        failure_message = failure_message or (
            f"알 수 없는 포트원 취소 상태: {raw_status!r}"
        )

    total_amount = cancellation.get("totalAmount")

    return RefundResult(
        status=status,
        gateway_refund_id=cancellation.get("id"),
        pg_cancellation_id=cancellation.get("pgCancellationId"),
        total_amount=total_amount if isinstance(total_amount, int) else None,
        requested_at=_parse_portone_datetime(cancellation.get("requestedAt")),
        cancelled_at=_parse_portone_datetime(cancellation.get("cancelledAt")),
        failure_code=failure_code,
        failure_message=failure_message,
        raw_response=dict(payload),
    )


# --------------------------------------------------------------------------- #
# Protocol
# --------------------------------------------------------------------------- #


# 서비스 계층(app/services/cancellation.py, SCH-05)이 import하는 것은 구상
# 클래스가 아니라 바로 이 Protocol이다. @runtime_checkable을 붙여서
# isinstance(obj, PaymentGateway)로 "이 객체가 refund()를 가졌는지"까지 런타임에
# 확인할 수 있게 했다 — 아래 test_fake_gateway_satisfies_protocol이 그걸 쓴다.
@runtime_checkable
class PaymentGateway(Protocol):
    """환불 실행 포트. 메서드는 **하나뿐**이다.

    카드/가상계좌로 쪼개지 않는 이유: 포트원의 취소 API 자체가 하나이고 결제수단에
    따라 파라미터(``refundAccount``)만 달라진다. Protocol을 둘로 쪼개면 실제 API
    모양과 어긋난 채로 서비스가 분기를 떠안는다.

    구현체는 :class:`UnsupportedPaymentMethodError` **외의 예외를 밖으로 던지지
    않는 것을 지향**한다 — PG 장애는 ``RefundStatus.failed`` 결과로 표현되어야
    서비스가 사유를 감사 로그에 남길 수 있다.
    """

    def refund(self, request: RefundRequest) -> RefundResult:
        """환불 1건을 요청하고 결과를 돌려준다."""
        ...


# --------------------------------------------------------------------------- #
# Fake 구현
# --------------------------------------------------------------------------- #


def _deterministic_id(prefix: str, seed: str) -> str:
    """시드에서 결정적으로 만드는 식별자. 같은 입력 → 항상 같은 출력."""
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
    return f"{prefix}_{digest}"


# PaymentGateway를 상속하지 않고도(Protocol이라 상속이 필요 없다) refund()만
# 구현해서 "PaymentGateway답게" 동작하는 Fake 객체(테스트 더블)다. TS-07의 DB
# 통합 테스트와 SCH-05의 서비스 테스트가 실제 포트원 없이 이 클래스를 주입받아
# "PG가 성공/대기/실패를 돌려주면 서비스가 어떻게 반응하는가"를 검증한다.
class FakePaymentGateway:
    """테스트·로컬 개발용 PG. **인메모리 원장 + 완전 결정적 동작.**

    포트원 모양의 응답 페이로드를 만들어 :func:`parse_portone_cancel_response`에
    통과시킨다. 즉 Fake가 흉내 내는 것은 "HTTP 응답 본문"까지이고, 그 뒤의 해석은
    실 연동과 **같은 코드**를 탄다.

    실패/지연 주입:

    * ``fail_on={payment_key, ...}`` — 해당 원거래는 ``failed``
    * ``pending_on={payment_key, ...}`` — 해당 원거래는 ``pending`` (포트원 ``REQUESTED``)
    * ``force_pending=True`` — 전부 ``pending``
    * 그 외 — ``succeeded``

    멱등성: ``idempotency_key``가 같은 두 번째 호출은 PG를 다시 "때리지" 않고
    원장에 적힌 첫 결과를 그대로 돌려준다. 실 PG의 멱등 처리와 같은 모양이라
    서비스의 재시도 경로를 여기서 검증할 수 있다.

    시각: ``clock``을 주입하면 타임스탬프까지 결정적이다. 주입하지 않으면
    ``datetime.now(UTC)``를 쓴다 — 시각은 단정 대상이 아닌 테스트가 대부분이라
    기본값을 실시계로 둔다.
    """

    def __init__(
        self,
        *,
        fail_on: set[str] | None = None,
        pending_on: set[str] | None = None,
        force_pending: bool = False,
        failure_code: str = "PG_PROVIDER_ERROR",
        failure_message: str = "PG사에서 환불 요청을 거절했습니다.",
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.fail_on: set[str] = set(fail_on or ())
        self.pending_on: set[str] = set(pending_on or ())
        self.force_pending = force_pending
        self.failure_code = failure_code
        self.failure_message = failure_message
        self._clock: Callable[[], datetime] = clock or (lambda: datetime.now(UTC))

        #: 호출된 요청 전체 (순서 보존). 서비스가 PG를 몇 번 불렀는지 단정할 때 쓴다.
        self.calls: list[RefundRequest] = []
        #: ``idempotency_key`` → 확정된 결과. 이게 인메모리 "원장"이다.
        self.ledger: dict[str, RefundResult] = {}

    # -- 내부 -------------------------------------------------------------- #

    def _portone_status(self, request: RefundRequest) -> str:
        if request.payment_key in self.fail_on:
            return "FAILED"
        if self.force_pending or request.payment_key in self.pending_on:
            return "REQUESTED"
        return "SUCCEEDED"

    def _build_portone_response(
        self, request: RefundRequest, status: str
    ) -> dict[str, Any]:
        """포트원 V2 ``CancelPaymentResponse`` 모양의 페이로드를 만든다."""
        now = self._clock()
        cancellation: dict[str, Any] = {
            "status": status,
            "id": _deterministic_id("cancel", request.idempotency_key),
            "totalAmount": request.amount,
            "taxFreeAmount": 0,
            "vatAmount": 0,
            "reason": request.reason,
            "requestedAt": now.isoformat(),
            "trigger": "API",
        }
        if status == "SUCCEEDED":
            cancellation["pgCancellationId"] = _deterministic_id(
                "pg", request.idempotency_key
            )
            cancellation["cancelledAt"] = now.isoformat()
        elif status == "REQUESTED":
            # 가상계좌 환불의 정상 경로. 송금이 아직 안 끝났으므로 cancelledAt도
            # pgCancellationId도 없다 — 실 포트원 응답과 같은 모양이다.
            pass
        else:
            cancellation["failureCode"] = self.failure_code
            cancellation["failureMessage"] = self.failure_message
        return {"cancellation": cancellation}

    # -- PaymentGateway ---------------------------------------------------- #

    # 이 메서드 안에서 카드 결제와 환불계좌 누락은 겉보기엔 둘 다 "잘못된
    # 입력"이지만 서로 다르게 처리한다. 카드는 "이 코드 경로가 아예 존재하면
    # 안 되는" 프로그래밍 오류(범위 밖 결제수단이 취소 경로에 들어온 것)라
    # 예외로 시끄럽게 막고, 환불계좌 누락은 "PG가 거절할 만한" 런타임 실패라
    # 아래에서 예외 대신 failed 결과로 돌려준다(§4.4). 전자를 로그 한 줄로
    # 덮으면 안 되고, 후자는 감사 로그에 사유가 남아야 하기 때문이다.
    def refund(self, request: RefundRequest) -> RefundResult:
        if request.method == PaymentMethod.CARD:
            # 원장에도 calls에도 남기지 않는다 — 실행되지 않은 요청이다.
            raise UnsupportedPaymentMethodError(request.method)
        if request.method != PaymentMethod.VIRTUAL_ACCOUNT:
            raise UnsupportedPaymentMethodError(request.method)

        self.calls.append(request)

        cached = self.ledger.get(request.idempotency_key)
        if cached is not None:
            return cached

        if request.refund_account is None:
            # 스키마 계층이 이미 422로 막지만 어댑터에서 2차 방어한다. 예외가 아니라
            # failed 결과로 돌려주는 이유: 서비스가 사유를 감사 로그에 남기고
            # 회원에게 실패 사유를 보여줄 수 있어야 한다.
            result = RefundResult(
                status=RefundStatus.FAILED,
                failure_code=REFUND_ACCOUNT_REQUIRED_CODE,
                failure_message="가상계좌 환불에는 환불 수취 계좌가 필요합니다.",
            )
        else:
            payload = self._build_portone_response(
                request, self._portone_status(request)
            )
            result = parse_portone_cancel_response(payload)

        # 실패는 원장에 확정하지 않는다. 실패 건 재시도는 도메인상 허용이고
        # (``refunds`` 부분 유니크 인덱스가 ``WHERE status <> 'failed'``),
        # 원장에 못박으면 fail_on을 풀어도 계속 실패하는 Fake가 된다.
        if result.status is not RefundStatus.FAILED:
            self.ledger[request.idempotency_key] = result
        return result

    # -- 테스트 편의 -------------------------------------------------------- #

    def settle(self, idempotency_key: str) -> RefundResult:
        """``pending`` 건을 ``succeeded``로 확정한다.

        실제로는 포트원 웹훅이 하는 일이다. 웹훅 수신 경로는 이번 슬라이스 범위
        밖이지만, 원장이 상태 전이를 표현할 수 있어야 나중에 그 경로를 붙일 때
        Fake를 뜯어고치지 않는다.
        """
        current = self.ledger[idempotency_key]
        settled = replace(
            current,
            status=RefundStatus.SUCCEEDED,
            pg_cancellation_id=_deterministic_id("pg", idempotency_key),
            cancelled_at=self._clock(),
        )
        self.ledger[idempotency_key] = settled
        return settled

    def reset(self) -> None:
        """호출 기록과 원장을 비운다 (주입 설정은 유지)."""
        self.calls.clear()
        self.ledger.clear()
