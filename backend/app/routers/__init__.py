"""HTTP 라우터 패키지.

각 모듈이 ``router`` 하나를 노출하고 ``app/main.py``가 그것만 붙인다.
여기서 하위 모듈을 import하지 않는다 — ``main.py``가 유일한 조립 지점이다.
"""

# 학습 주석: SCH-06(Pydantic 스키마 + 라우터 + main.py) 반영
#
# 사전 개념 요약 (6개월차 비전공자용)
# - APIRouter란: FastAPI 엔드포인트를 전부 ``app`` 객체 하나에 직접 등록하면
#   파일 하나가 끝없이 길어진다. ``APIRouter``는 "이 모듈이 담당하는
#   엔드포인트들"을 하나로 묶어두는 그릇이고(``prefix="/reservations"`` 같은
#   공통 경로도 여기서 지정한다), ``app/main.py``가
#   ``app.include_router(router)``로 그릇들을 최종적으로 하나의 앱에 조립한다.
#   각 라우터 모듈은 자기 몫의 경로만 신경 쓰면 되고, "전체 API가 어떻게
#   구성되는지"는 ``main.py`` 한 곳만 보면 된다.
