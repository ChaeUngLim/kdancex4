"""학원 환불 비율표 관리 API (admin-web 전용).

.. warning::

   **F7 — 이 경로에는 인증도 권한 검사도 없다.**

   지금 이 API는 학원 ID만 알면 누구나 **그 학원의 환불 비율표를 바꿀 수 있다.**
   비율표를 0%로 바꿔 두면 이후 모든 취소가 무환불이 되므로, 영향은 설정 변경이
   아니라 **금전 피해**다.

   이유는 취소 API와 같다 — 이번 슬라이스에 인증·회원·권한 모델이 전혀 없다
   (Phase 3 §2.7). 예약 취소 쪽은 ``X-User-Id`` 헤더라는 자리 표시자라도 있지만
   (``app/deps.py``의 :func:`~app.deps.current_user_id`), 여기 붙일 "이 사람이 이
   학원의 관리자인가"는 판정할 근거 자체가 없다. 헤더를 요구해 봐야 아무 UUID나
   넣으면 통과하므로, **있는 척하는 검사보다 없는 게 낫다**고 보고 넣지 않았다.

   **프로덕션 배포 전 반드시 막는다.** 붙일 자리는 이 파일의 라우터 의존성 한 곳이다
   (``dependencies=[Depends(require_academy_admin)]``). 그전까지 이 경로는
   **외부에 노출하면 안 된다.**
"""

# 학습 주석: SCH-06(Pydantic 스키마 + 라우터 + main.py) 반영
#
# 사전 개념 요약 (6개월차 비전공자용)
# - APIRouter·Pydantic 스키마 개념은 ``app/routers/__init__.py``·
#   ``app/schemas/__init__.py`` 참고. 이 파일이 새로 보여주는 건 개념이 아니라
#   "인증이 아예 없는 API를 왜 이 상태로 배포 전까지 두었는가"라는 리스크다 —
#   바로 위 모듈 docstring의 F7 경고를 반드시 먼저 읽을 것.

from __future__ import annotations

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.academy import Academy
from app.schemas.academy import RefundPolicyResponse, RefundPolicyUpdate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/academies", tags=["admin"])

AcademyId = Annotated[uuid.UUID, Path(description="학원 ID")]


# GET·PUT 두 엔드포인트가 공통으로 쓰는 조회 헬퍼. 학원이 없으면 여기서 404로
# 끝내므로, 두 엔드포인트 본문은 "학원이 있다"고 가정하고 이어갈 수 있다.
def _get_academy(session: Session, academy_id: uuid.UUID) -> Academy:
    academy = session.get(Academy, academy_id)
    if academy is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"학원을 찾을 수 없습니다: {academy_id}",
        )
    return academy


def _to_response(academy: Academy) -> RefundPolicyResponse:
    """저장된 JSONB를 응답 스키마로 옮긴다.

    검증 실패를 500이 아니라 **422**로 바꾸는 이유: 이 API가 생기기 전에 들어갔거나
    SQL로 직접 넣은 값이 스키마를 안 지킬 수 있다. 그때 500을 내면 관리자는
    "화면이 고장났다"만 보고 **고칠 방법을 못 찾는다.** 422와 함께 사유를 주면
    PUT 한 번으로 덮어써서 복구할 수 있다 — PUT은 조회 결과에 의존하지 않는다.
    """
    try:
        return RefundPolicyResponse(
            academy_id=academy.id,
            refund_policy_tiers=academy.refund_policy_tiers or [],
        )
    except ValidationError as exc:
        logger.warning(
            "저장된 환불 비율표가 스키마를 위반합니다 (academy_id=%s): %s",
            academy.id,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                "저장된 환불 비율표가 올바른 형태가 아닙니다. "
                "비율표를 다시 저장하면 복구됩니다."
            ),
        ) from exc


@router.get(
    "/{academy_id}/refund-policy",
    response_model=RefundPolicyResponse,
    summary="환불 비율표 조회",
)
# admin-web(SCH-08 소관, Next.js)의 환불 비율표 설정 화면이 진입 시 부른다.
def get_refund_policy(
    academy_id: AcademyId,
    session: Annotated[Session, Depends(get_db)],
) -> RefundPolicyResponse:
    """학원의 환불 비율표를 돌려준다.

    비율표가 비어 있는 건 정상이다 — "24시간 미만이면 전부 0%"라는 뜻이고,
    ``academies.refund_policy_tiers``의 기본값이기도 하다.
    """
    return _to_response(_get_academy(session, academy_id))


@router.put(
    "/{academy_id}/refund-policy",
    response_model=RefundPolicyResponse,
    summary="환불 비율표 저장",
)
# admin-web이 비율표 설정 화면에서 저장 버튼을 누르면 부른다. payload가 이미
# RefundPolicyUpdate 타입이라는 것 자체가 검증이 끝났다는 뜻이다 — FastAPI가
# 이 함수 본문을 실행하기 전에 스키마 검증을 마친다(위 사전 개념 요약 참고).
def update_refund_policy(
    academy_id: AcademyId,
    payload: RefundPolicyUpdate,
    session: Annotated[Session, Depends(get_db)],
) -> RefundPolicyResponse:
    """비율표를 **통째로 교체**한다 (PATCH가 아니다).

    부분 갱신을 지원하지 않는 이유: 비율표는 행 하나하나가 아니라 **표 전체가 하나의
    정책**이다. 행 단위로 고치게 하면 "12시간 행만 지웠더니 24시간 행이 그 구간까지
    덮게 됐다" 같은 일이 저장 시점엔 안 보인다. 전체를 받으면 정렬·중복 검증
    (``RefundPolicyUpdate``)이 항상 표 전체에 걸린다.

    검증은 요청 본문이 파싱될 때 이미 끝났다 — 여기 도달한 값은 범위·정렬·중복이
    전부 통과한 것이다. 실패는 FastAPI가 422로 돌려준다.
    """
    academy = _get_academy(session, academy_id)

    # 새 리스트를 **대입**한다. 기존 리스트를 제자리에서 수정하면 SQLAlchemy가
    # 변경을 감지하지 못하고(JSONB는 기본적으로 변경 추적 대상이 아니다) UPDATE가
    # 조용히 누락된다 — 저장 버튼을 눌렀는데 아무 일도 안 일어나는 그 버그다.
    academy.refund_policy_tiers = payload.to_jsonb()
    session.commit()
    session.refresh(academy)

    logger.info(
        "환불 비율표를 갱신했습니다 (academy_id=%s, tiers=%d)",
        academy.id,
        len(academy.refund_policy_tiers),
    )
    return _to_response(academy)
