"""FastAPI 애플리케이션 조립 지점.

여기서 하는 일은 **붙이는 것**뿐이다. 경로 구현은 ``app/routers/``에 있다.
"""

# 학습 주석: SCH-06(Pydantic 스키마 + 라우터 + main.py) 반영
#
# 사전 개념 요약 (6개월차 비전공자용)
# - include_router: ``app/routers/__init__.py`` 참고 — 여기서 각 모듈의
#   ``router``를 ``app`` 하나에 실제로 붙인다.
# - CORS(Cross-Origin Resource Sharing)란: 브라우저는 기본적으로 "이 페이지를
#   내려준 출처(origin)와 다른 출처의 API"로 보내는 요청 결과를 스크립트가
#   읽지 못하게 막는다(보안 기본값). admin-web(Next.js, localhost:3000)이
#   backend를 호출하려면 서버가 "이 출처는 허용한다"고 응답 헤더에 명시해야
#   하고, 그 설정을 담당하는 것이 아래 ``CORSMiddleware``다. 모바일(Expo)은
#   브라우저가 아니라 이 규칙 자체와 무관하다.
# - OpenAPI 스키마(``app.openapi()``): FastAPI가 등록된 라우트·스키마를 훑어서
#   자동으로 만들어내는 API 명세(JSON)다. ``/docs`` 화면도 이걸로 그려진다.
#   ``app.routes``를 직접 읽는 대신 ``app.openapi()["paths"]``를 보면, FastAPI
#   내부 구현(라우터를 감싸는 방식 등)이 버전마다 바뀌어도 "실제로 클라이언트가
#   호출할 수 있는 경로 목록"을 안정적으로 얻을 수 있다 —
#   ``backend/tests/test_schemas.py``의 ``test_all_routes_are_mounted``가 이
#   방식을 쓴다.

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import admin_academies, reservations

app = FastAPI(title="kdance")

#: 브라우저에서 API를 호출하는 출처. admin-web은 Next.js 개발 서버(기본 3000)뿐이다.
#: 모바일(Expo/React Native)은 브라우저가 아니라 CORS 대상이 아니다.
#:
#: 와일드카드(``*``)를 쓰지 않는다. 이 API는 ``X-User-Id`` 헤더 하나로 신원을
#: 주장하므로(F7), 아무 페이지나 호출할 수 있게 열어두면 임시 인증의 구멍이 그대로
#: 브라우저로 노출된다. 배포 출처가 생기면 **설정으로 빼서** 여기에 더한다.
ALLOWED_ORIGINS = [
    "http://localhost:3000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    # 쿠키·세션을 쓰지 않는다. 켜 둘 이유가 없고, 켜면 출처 검사가 더 민감해진다.
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    # X-User-Id(F7)·Idempotency-Key·Content-Type이 필요하다.
    allow_headers=["*"],
)

app.include_router(reservations.router)
app.include_router(admin_academies.router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
