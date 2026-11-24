"""`POST /v1/intro-drafts` — 소개 문구 틀(동기) (SX-6.6(소개 문구 초안), 계약 16 §1-4 · §4-7).

Next.js 가 수업 편집 직원의 요청을 받아 이 경로를 부르고, 받은 `bodyTemplate` 의 자리표시자를 수업 데이터로 채운다.
포스터·홍보 이미지와 달리 작업 대기열이 없다 — 문장 두세 개라 바로 답한다(Next.js 쪽 제한 시간 20초).
"""

from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from app.jobs.job_routes import _error, _token_ok
from app.planner.text_client import OpenAICompatTextClient, TextClient
from app.promo.intro_writer import KNOWN_PLACEHOLDERS, IntroRequest, IntroWriterError, write_intro_template
from app.settings import load_settings

router = APIRouter()


class IntroDraftBody(BaseModel):
    """요청 본문. 수업 숫자(facts)는 싣지 않는다 — 모르는 칸이 오면 거부한다."""

    model_config = ConfigDict(extra="forbid")

    classTitle: str = Field(min_length=1, max_length=60)
    genre: str | None = Field(default=None, max_length=30)
    emphasis: str | None = Field(default=None, max_length=60)
    placeholders: list[str] = Field(min_length=3, max_length=len(KNOWN_PLACEHOLDERS))

    @field_validator("placeholders")
    @classmethod
    def _known(cls, value: list[str]) -> list[str]:
        unknown = [name for name in value if name not in KNOWN_PLACEHOLDERS]
        if unknown:
            raise ValueError(f"모르는 자리표시자: {unknown}")
        return value


class IntroRuntime:
    """경로가 쓰는 재료 — 진짜는 kdance-llm, 테스트는 가짜 대화 모델로 바꿔 끼운다."""

    def __init__(self, *, agent_api_token: str, text: TextClient) -> None:
        self.agent_api_token = agent_api_token
        self.text = text


@lru_cache(maxsize=1)
def get_intro_runtime() -> IntroRuntime:
    settings = load_settings()
    return IntroRuntime(
        agent_api_token=settings.agent_api_token,
        # 문장 두세 개 + 자리표시자 — 400 토큰이면 넉넉하다. Next.js 가 20초에 끊으므로 그 전에 끝낸다
        text=OpenAICompatTextClient(
            base_url=settings.llm_base_url, model_name=settings.llm_chat_model, timeout_seconds=18.0, max_tokens=400
        ),
    )


@router.post("/v1/intro-drafts")
async def intro_draft(
    request: Request,
    runtime: Annotated[IntroRuntime, Depends(get_intro_runtime)],
    x_agent_token: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    if not _token_ok(x_agent_token, runtime.agent_api_token):
        return _error(401, "UNAUTHORIZED", "에이전트 토큰이 맞지 않아요")
    try:
        body = IntroDraftBody.model_validate(await request.json())
    except ValueError as error:
        fields = (
            [{"path": ".".join(str(p) for p in e["loc"]), "message": e["msg"]} for e in error.errors()]
            if isinstance(error, ValidationError)
            else []
        )
        return _error(422, "VALIDATION_FAILED", "입력값을 확인해 주세요", fields)

    try:
        result = await write_intro_template(
            IntroRequest(
                class_title=body.classTitle,
                genre=body.genre,
                emphasis=body.emphasis,
                placeholders=tuple(body.placeholders),
            ),
            runtime.text,
        )
    except IntroWriterError:
        return _error(503, "AI_UNAVAILABLE", "지금은 소개 문구를 만들 수 없어요. 직접 써 주세요")
    return JSONResponse(
        status_code=200,
        content={"bodyTemplate": result.body_template, "model": result.model},
        headers={"Cache-Control": "no-store"},
    )
