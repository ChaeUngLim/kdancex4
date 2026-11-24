"""에이전트 서버 뼈대 — health 응답 테스트 (SX-1.1(에이전트 서버 뼈대))."""

from fastapi.testclient import TestClient

from app.main import app


def test_health_returns_ok_without_token() -> None:
    # 토큰 헤더 없이 불러도 200 과 {"status":"ok"} 가 와야 한다(계약 16 §1-4).
    response = TestClient(app).get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
