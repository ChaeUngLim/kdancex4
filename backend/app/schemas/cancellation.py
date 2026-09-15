"""예약 취소 API의 요청·응답 스키마.

이 모듈이 지는 책임은 **경계 검증과 형태 변환** 둘뿐이다. 금액을 계산하지도,
DB를 읽지도 않는다. 서비스 계층의 결과 dataclass
(:class:`~app.services.cancellation.CancellationOutcome` ·
:class:`~app.services.cancellation.CancellationPreview`)를 JSON으로 옮기는 일만 한다.

환불 계좌 필수 검증을 왜 여기 두는가
------------------------------------
"가상계좌 환불이면 수취 계좌가 반드시 있어야 한다"는 **결제수단의 성질**이지 특정
PG사의 요구가 아니다. 어댑터(``app/adapters/payment_gateway.py``)에만 두면 PG를
갈아끼울 때 같이 사라지고, 서비스에 두면 웹 요청 형태에 대한 판정이 도메인 안으로
샌다. 그래서 **스키마 계층**이 1차로 막고(422), 어댑터가 2차로 막는다
(``REFUND_ACCOUNT_REQUIRED`` 실패 결과). 방어가 2겹인 건 돈이 걸려서다.

``method``는 왜 선택값인가
--------------------------
클라이언트가 결제수단을 **말해 주면** 스키마가 즉시 422로 막을 수 있다. 하지만
결제수단의 권위는 언제나 DB의 ``payments.method``이고 클라이언트가 보낸 값은
참고 정보다. 그래서 ``method``를 필수로 만들지 않는다 — 생략하면 검증이
어댑터 쪽 2차 방어로 넘어갈 뿐, 잘못된 값을 보냈다고 해서 그 값으로 환불이
실행되지는 않는다 (서비스는 ``payments.method``만 본다).
"""

# 학습 주석: SCH-06(Pydantic 스키마 + 라우터 + main.py) 반영
#
# 사전 개념 요약 (6개월차 비전공자용)
# - Pydantic 스키마 자체의 개념은 ``app/schemas/__init__.py`` 참고.
# - ``model_validator(mode="after")``: 필드 하나하나의 형식 검증(타입·길이 등)이
#   전부 끝난 뒤에, "필드들 사이의 관계"를 검증하고 싶을 때 쓴다. 예를 들어
#   ``method``가 가상계좌인데 ``refund_account``가 없는 조합은 필드 각각은
#   유효해도 전체로는 무효다 — 이런 조합 규칙은 필드 하나만 보는 ``Field()``로는
#   표현할 수 없다. 검증기가 ``ValueError``를 던지면 Pydantic이 자동으로
#   ``ValidationError``로 감싸고, FastAPI가 이를 422 응답으로 바꾼다 — 라우터가
#   따로 처리하지 않아도 된다.

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.adapters.payment_gateway import PaymentMethod, RefundAccount, RefundStatus
from app.services.cancellation import CancellationOutcome, CancellationPreview

__all__ = [
    "CancelRequest",
    "CancelResponse",
    "CancellationPreviewResponse",
    "RefundAccountIn",
]


# CancelRequest.refund_account 필드의 타입. 라우터(reservations.py)의 cancel()이
# 이 값의 .to_domain()을 호출해 서비스(cancel_reservation)에 넘긴다.
class RefundAccountIn(BaseModel):
    """환불 수취 계좌 (가상계좌 환불 전용).

    길이 상한은 ``refunds`` 컬럼 정의와 맞췄다 — ``String(20)`` / ``String(64)`` /
    ``String(100)``. 여기서 안 막으면 DB INSERT 단계에서 터지고, 그때는 이미 PG
    호출 직전이라 실패 지점이 훨씬 나쁘다.

    ``holder_phone_number``는 포트원 기준 선택값이지만 스마트로 가상계좌 취소에는
    필수다. 지금 자리를 비워두면 나중에 요청 형태가 바뀐다.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    bank_code: Annotated[str, Field(min_length=1, max_length=20)]
    account_number: Annotated[str, Field(min_length=1, max_length=64)]
    holder_name: Annotated[str, Field(min_length=1, max_length=100)]
    holder_phone_number: Annotated[str | None, Field(max_length=20)] = None

    def to_domain(self) -> RefundAccount:
        """어댑터가 쓰는 :class:`RefundAccount`로 변환한다.

        스키마 타입을 서비스로 그대로 넘기지 않는다 — 서비스가 Pydantic에 묶이면
        단위 테스트가 무거워지고, 요청 본문 형태가 바뀔 때마다 서비스가 바뀐다.
        """
        return RefundAccount(
            bank_code=self.bank_code,
            account_number=self.account_number,
            holder_name=self.holder_name,
            holder_phone_number=self.holder_phone_number,
        )


# 라우터(reservations.py)의 POST /reservations/{id}/cancel이 요청 본문을 받을 때
# 쓰는 타입이다. FastAPI가 요청이 들어올 때마다 이 클래스로 파싱을 시도하고,
# 실패하면 cancel() 함수 본문이 실행되기 전에 422를 돌려준다.
class CancelRequest(BaseModel):
    """``POST /reservations/{id}/cancel`` 요청 본문.

    본문 전체가 **선택**이다. 카드 결제 취소는 보낼 것이 없고, 가상계좌 취소만
    ``refund_account``가 필요하다. 취소 사유(``reason``)는 받지 않는다 — 값 집합이
    ``member_request`` 하나뿐이라(Q5) 받아 봐야 신뢰할 수 없는 입력이 하나 느는
    것뿐이다. 학원 귀책 취소가 생기면 그때 관리자 전용 경로와 함께 추가한다.

    ``extra="forbid"``인 이유: 오타 난 필드(``refundAccount`` 등)가 조용히 무시되면
    회원은 계좌를 입력했다고 믿는데 서버는 못 받은 상태가 된다.
    """

    model_config = ConfigDict(extra="forbid")

    method: PaymentMethod | None = None
    refund_account: RefundAccountIn | None = None

    @model_validator(mode="after")
    def _refund_account_required_for_virtual_account(self) -> CancelRequest:
        """가상계좌라고 선언했으면 수취 계좌 없이는 통과시키지 않는다 (422)."""
        if (
            self.method is PaymentMethod.VIRTUAL_ACCOUNT
            and self.refund_account is None
        ):
            raise ValueError(
                "가상계좌 환불에는 refund_account(bank_code/account_number/"
                "holder_name)가 필요합니다."
            )
        return self


# 라우터가 cancel_reservation()의 반환값(CancellationOutcome, 서비스 계층
# dataclass)을 이 스키마로 감싸 JSON으로 내보낸다 — from_outcome()이 그 변환이다.
class CancelResponse(BaseModel):
    """``POST /reservations/{id}/cancel`` 응답.

    **PG 환불 실패도 이 스키마로 200과 함께 돌아간다.** 비-2xx로 바꾸면 실패 사유
    (``failure_code``/``failure_message``)를 담은 본문이 클라이언트의 에러 처리로
    빨려 들어가 회원에게 "왜 실패했는지"를 못 보여준다. 요청은 정상적으로 처리됐고
    (환불 행과 감사 로그가 남았다) 결과가 실패인 것이라, 상태는 본문에 싣는다.
    구분이 필요한 클라이언트는 ``status``를 본다.
    """

    model_config = ConfigDict(extra="forbid")

    reservation_id: uuid.UUID
    refund_id: uuid.UUID
    status: RefundStatus
    requested_amount: int
    refunded_amount: int
    refund_rate_bp: int
    hours_before_start: int
    reservation_status: str
    slot_restored: bool
    replayed: bool
    failure_code: str | None = None
    failure_message: str | None = None
    gateway_refund_id: str | None = None

    @classmethod
    def from_outcome(cls, outcome: CancellationOutcome) -> CancelResponse:
        return cls(
            reservation_id=outcome.reservation_id,
            refund_id=outcome.refund_id,
            status=outcome.status,
            requested_amount=outcome.requested_amount,
            refunded_amount=outcome.refunded_amount,
            refund_rate_bp=outcome.refund_rate_bp,
            hours_before_start=outcome.hours_before_start,
            reservation_status=outcome.reservation_status,
            slot_restored=outcome.slot_restored,
            replayed=outcome.replayed,
            failure_code=outcome.failure_code,
            failure_message=outcome.failure_message,
            gateway_refund_id=outcome.gateway_refund_id,
        )


# 라우터의 GET /reservations/{id}/cancellation-preview가 preview_cancellation()의
# 반환값(CancellationPreview, 서비스 계층 dataclass)을 이 스키마로 감싼다.
class CancellationPreviewResponse(BaseModel):
    """``GET /reservations/{id}/cancellation-preview`` 응답 — 예상 환불액 사전 고지.

    클래스 이름에 ``Response``가 붙은 이유는 서비스의
    :class:`~app.services.cancellation.CancellationPreview` dataclass와 이름이
    겹치기 때문이다. 같은 이름 둘을 한 파일에서 쓰면 어느 계층의 것인지 읽는 사람이
    매번 확인해야 한다. **JSON 필드명은 계약 그대로**이므로 클라이언트에는 영향이 없다.

    ``payment_method``와 ``paid_amount``가 여기 있는 건 장식이 아니다. 모바일은
    "가상계좌일 때만 환불 계좌를 입력받는다"는 규칙(Q2)을 **확정 요청을 보내기 전에**
    지켜야 하고, 그러려면 결제수단을 미리 알아야 한다. 없으면 클라이언트는 항상 계좌를
    받거나 422를 맞고 나서야 폼을 띄우는 두 나쁜 선택만 남는다 (TS-09 I-2).

    ``cancellable=False``일 때도 **금액은 채워서 보낸다.** 화면이 "왜 못 하는지"와
    "했다면 얼마였는지"를 같이 보여줄 수 있어야 한다.
    """

    model_config = ConfigDict(extra="forbid")

    reservation_id: uuid.UUID
    #: ``payments.method`` 값(``virtual_account`` / ``card``). 결제 원거래가 없으면 None.
    payment_method: PaymentMethod | None
    paid_amount: int
    refund_amount: int
    refund_rate_bp: int
    hours_before_start: int
    seconds_before_start: int
    applied_tier_hours: int | None
    starts_at: datetime
    cancellable: bool
    #: 취소 불가 사유. :class:`~app.services.cancellation.CancellationError` 의
    #: ``code``와 같은 값이다 (``class_already_started`` 등). 가능하면 None.
    reason_code: str | None = None

    @classmethod
    def from_preview(cls, preview: CancellationPreview) -> CancellationPreviewResponse:
        # ``payment_method``를 그대로 넘겨 Pydantic이 검증하게 둔다. 알 수 없는 값을
        # 조용히 None으로 접으면 클라이언트는 "결제 원거래가 없다"로 읽는다 — 실제
        # 뜻과 정반대다. ``payments.method`` CHECK 제약이 값 집합을 보장하므로
        # 여기서 터지는 건 데이터가 깨졌다는 뜻이고, 그건 조용히 넘길 일이 아니다.
        return cls(
            reservation_id=preview.reservation_id,
            payment_method=preview.payment_method,
            paid_amount=preview.paid_amount,
            refund_amount=preview.refund_amount,
            refund_rate_bp=preview.refund_rate_bp,
            hours_before_start=preview.hours_before_start,
            seconds_before_start=preview.seconds_before_start,
            applied_tier_hours=preview.applied_tier_hours,
            starts_at=preview.starts_at,
            cancellable=preview.cancellable,
            reason_code=preview.reason_code,
        )
