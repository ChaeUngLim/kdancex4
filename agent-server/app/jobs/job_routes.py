"""`POST /v1/jobs` — Next.js 가 맡기는 비동기 작업 접수 (계약 16 §1-4 · §7-1, SX-2.2(포스터 → 초안 추출)).

처음 보는 사람용 요약
- 대표가 포스터를 올리면 Next.js 가 작업 한 줄(`ai_jobs`)을 만들고 이 경로로 「읽어 달라」고 맡긴다.
  이 경로는 받자마자 202 로 답하고, 실제 읽기는 응답 뒤에 따로 돈다. 모델 호출이 10초 넘게 걸려서
  Next.js 요청을 그동안 붙잡아 두지 않으려는 것이다. 결과는 끝난 뒤 Next.js 내부 경로로 알린다.
- 받는 작업 종류는 `poster_extract`(포스터 읽기)와 `promo_image`(SX-6.4(영어 번역·이미지 생성 경로))다.
  `kind` 값으로 payload 모양을 고른다(맞지 않으면 422). `faq_draft`(SX-3.9(대표 앱 자주 묻는 질문 답변 승인))는
  그 Task 에서 더한다 — 그 전에는 422.
- 같은 `jobId` 를 두 번 받으면 두 번째는 200 으로 「이미 받았다」만 답하고 다시 돌리지 않는다.
- 작업은 동시에 1건만 돈다(계약 16 §7-1 「worker 는 동시 1건」) — GPU 8GB 를 대화와 나눠 쓰기 때문이다.

계약과 다르게 둔 것(숨기지 않는다)
- 계약은 「안에서 Redis Streams 에 넣고 worker 가 꺼낸다」고 적었다. 이 Task 는 프로세스 안 대기열
  (asyncio 잠금 1개)로 했다 — 에이전트 서버 의존성에 Redis 가 아직 없고, 대화 우선(FR-265)을 걸
  대화 대기열도 아직 없다. 서버가 재시작되면 돌던 작업은 사라지고 Next.js `sweep` 이 기한 뒤 닫는다.
"""

import asyncio
import hmac
from dataclasses import dataclass, field
from functools import lru_cache
from collections.abc import Mapping
from typing import Annotated, Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, field_validator

from app.jobs.poster_job import NextInternalClient, PosterJob, run_poster_job
from app.jobs.promo_job import PromoJob, run_promo_job
from app.planner.text_client import OpenAICompatTextClient, TextClient
from app.poster.poster_extractor import validate_field_keys
from app.poster.vision_client import OpenAICompatVisionClient, VisionClient
from app.promo.cloudflare_engine import CloudflareFluxSchnellEngine
from app.promo.engine_catalog import DEFAULT_ENGINE_ID, enabled_engine_ids
from app.promo.image_engine import ImageEngine
from app.promo.prompt_translator import PromoCondition
from app.settings import load_settings

router = APIRouter()

# 포스터 파일은 Next.js 내부 경로에서만 받는다 — 다른 주소(바깥 사이트)로 요청을 보내게 하지 않는다
_POSTER_FILE_PREFIX = "/api/internal/ai/jobs/"
_DEADLINE_MIN_MS = 1_000
_DEADLINE_MAX_MS = 600_000


class PosterExtractPayload(BaseModel):
    """`poster_extract` 작업의 payload(계약 16 §7-1). 모르는 칸이 오면 거부한다."""

    model_config = ConfigDict(extra="forbid")

    extractionId: str = Field(min_length=1, max_length=100)
    fileUrl: str = Field(min_length=1, max_length=300)
    targetKind: Literal["class", "party", "performance", "competition"]
    fieldKeys: list[str] = Field(min_length=1, max_length=30)

    @field_validator("fileUrl")
    @classmethod
    def _internal_file_only(cls, value: str) -> str:
        # 「/api/internal/ai/jobs/{jobId}/file」 모양만. '..' 로 다른 경로로 빠지는 것도 막는다
        if not value.startswith(_POSTER_FILE_PREFIX) or not value.endswith("/file") or ".." in value:
            raise ValueError("fileUrl 은 /api/internal/ai/jobs/{jobId}/file 이어야 한다")
        return value

    @field_validator("fieldKeys")
    @classmethod
    def _known_keys(cls, value: list[str]) -> list[str]:
        return list(validate_field_keys(value))


class PosterJobRequest(BaseModel):
    """`POST /v1/jobs` 포스터 읽기 요청(계약 16 §7-1)."""

    model_config = ConfigDict(extra="forbid")

    jobId: str = Field(min_length=1, max_length=100)
    kind: Literal["poster_extract"]
    deadlineMs: int = Field(ge=_DEADLINE_MIN_MS, le=_DEADLINE_MAX_MS)
    agentSessionToken: str | None = Field(default=None, repr=False)
    payload: PosterExtractPayload


class PromoConditionIn(BaseModel):
    """자동 조건 한 장 — Next.js 가 설정에서 꺼낸 id 와 고정 영어 문장(SX-6.2)."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z_]{2,40}$")
    textEn: str = Field(min_length=1, max_length=300)


class PromoImagePayload(BaseModel):
    """`promo_image` 작업의 payload(계약 16 §7-1). 모르는 칸이 오면 거부한다."""

    model_config = ConfigDict(extra="forbid")

    generationId: str = Field(min_length=1, max_length=100)
    # 수업에서 가져온 장르(admin-web Genre 값)
    genre: Literal["salsa_bachata", "argentine_tango", "swing", "dance_sport"]
    # 데이터 모델 ck_promo_gen_sentence 와 같은 1~200자
    sentenceKo: str = Field(min_length=1, max_length=200)
    autoConditions: list[PromoConditionIn] = Field(default_factory=list, max_length=10)
    # 글자 없음은 끌 수 없다 — true 만 받는다
    textless: Literal[True]
    # 사용자가 고른 엔진(FR-061a). 없으면 지금 연결된 기본 엔진. 꺼진·없는 엔진이면 422
    engineId: str = DEFAULT_ENGINE_ID

    @field_validator("engineId")
    @classmethod
    def _enabled_engine_only(cls, value: str) -> str:
        if value not in enabled_engine_ids():
            raise ValueError("켜진 이미지 엔진이 아니다")
        return value


class PromoJobRequest(BaseModel):
    """`POST /v1/jobs` 홍보 이미지 요청(계약 16 §7-1, SX-6.4)."""

    model_config = ConfigDict(extra="forbid")

    jobId: str = Field(min_length=1, max_length=100)
    kind: Literal["promo_image"]
    deadlineMs: int = Field(ge=_DEADLINE_MIN_MS, le=_DEADLINE_MAX_MS)
    agentSessionToken: str | None = Field(default=None, repr=False)
    payload: PromoImagePayload


# `kind` 값으로 둘 중 하나를 고른다 — kind 와 payload 가 맞지 않으면 422
JobRequest = Annotated[PosterJobRequest | PromoJobRequest, Field(discriminator="kind")]
_JOB_REQUEST: TypeAdapter[PosterJobRequest | PromoJobRequest] = TypeAdapter(JobRequest)


@dataclass
class JobRuntime:
    """작업 처리에 필요한 것 묶음 — 모델 연결, 이미지 엔진, Next.js 연결, 받은 jobId 목록, 동시 1건 잠금."""

    agent_api_token: str = field(repr=False)
    vision: VisionClient
    next_client: NextInternalClient
    # 홍보 이미지 — 번역용 대화 모델과 엔진 id → 어댑터(SX-6.4)
    text: TextClient | None = None
    image_engines: Mapping[str, ImageEngine] = field(default_factory=dict)
    accepted_job_ids: set[str] = field(default_factory=set)
    worker_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def run_poster(self, job: PosterJob) -> None:
        # 잠금을 잡은 작업 하나만 모델을 쓴다. 나머지는 여기서 차례를 기다린다
        async with self.worker_lock:
            await run_poster_job(job, vision=self.vision, next_client=self.next_client)

    async def run_promo(self, job: PromoJob) -> None:
        # 포스터와 같은 잠금 — GPU 의 대화 모델을 번역에 쓰므로 작업은 통틀어 동시 1건
        async with self.worker_lock:
            if self.text is None:
                return
            await run_promo_job(job, text=self.text, engines=self.image_engines, next_client=self.next_client)


@lru_cache(maxsize=1)
def get_job_runtime() -> JobRuntime:
    """서버 하나에 하나만 만든다. 테스트는 이 함수를 dependency_overrides 로 바꿔 끼운다."""
    settings = load_settings()
    return JobRuntime(
        agent_api_token=settings.agent_api_token,
        vision=OpenAICompatVisionClient(base_url=settings.llm_base_url, model_name=settings.llm_vision_model),
        next_client=NextInternalClient(
            base_url=settings.next_internal_base_url, internal_token=settings.internal_api_token
        ),
        text=OpenAICompatTextClient(base_url=settings.llm_base_url, model_name=settings.llm_chat_model),
        # 지금 연결된 엔진은 Cloudflare 하나. 로컬 엔진은 실측 뒤 어댑터를 만들어 여기에 더한다
        image_engines={
            CloudflareFluxSchnellEngine.engine_id: CloudflareFluxSchnellEngine(
                account_id=settings.cloudflare_account_id, api_token=settings.cloudflare_api_token
            )
        },
    )


def _error(status: int, code: str, detail: str, fields: list[dict[str, str]] | None = None) -> JSONResponse:
    """오류 모양은 계약 README 의 {detail, code, fields?} 를 따른다."""
    body: dict[str, Any] = {"detail": detail, "code": code}
    if fields is not None:
        body["fields"] = fields
    return JSONResponse(status_code=status, content=body, headers={"Cache-Control": "no-store"})


def _token_ok(given: str | None, expected: str) -> bool:
    # 서버에 토큰이 설정돼 있지 않으면 아무도 통과하지 못한다. 비교는 상수 시간(계약 16 §0)
    if not expected or not given:
        return False
    return hmac.compare_digest(given.encode(), expected.encode())


@router.post("/v1/jobs")
async def accept_job(
    request: Request,
    background: BackgroundTasks,
    runtime: Annotated[JobRuntime, Depends(get_job_runtime)],
    x_agent_token: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    """작업을 받아 202 로 답하고, 실제 처리는 응답 뒤에 돌린다."""
    if not _token_ok(x_agent_token, runtime.agent_api_token):
        return _error(401, "UNAUTHORIZED", "에이전트 토큰이 맞지 않아요")

    try:
        raw = await request.json()
        job_request = _JOB_REQUEST.validate_python(raw)
    except ValueError as error:
        # ValidationError 도 ValueError 의 하위 타입이다. 본문이 JSON 이 아니어도 여기로 온다
        fields = (
            [{"path": ".".join(str(p) for p in e["loc"]), "message": e["msg"]} for e in error.errors()]
            if isinstance(error, ValidationError)
            else []
        )
        return _error(422, "VALIDATION_FAILED", "입력값을 확인해 주세요", fields)

    headers = {"Cache-Control": "no-store"}
    body = {"jobId": job_request.jobId, "accepted": True}
    # 같은 jobId 는 두 번 돌리지 않는다(계약 16 §7-1) — 두 번째는 200 같은 본문
    if job_request.jobId in runtime.accepted_job_ids:
        return JSONResponse(status_code=200, content=body, headers=headers)
    runtime.accepted_job_ids.add(job_request.jobId)

    if isinstance(job_request, PromoJobRequest):
        promo = job_request.payload
        background.add_task(
            runtime.run_promo,
            PromoJob(
                job_id=job_request.jobId,
                engine_id=promo.engineId,
                sentence_ko=promo.sentenceKo,
                conditions=tuple(PromoCondition(id=c.id, text_en=c.textEn) for c in promo.autoConditions),
                deadline_ms=job_request.deadlineMs,
            ),
        )
        return JSONResponse(status_code=202, content=body, headers=headers)

    payload = job_request.payload
    job = PosterJob(
        job_id=job_request.jobId,
        file_url=payload.fileUrl,
        field_keys=tuple(payload.fieldKeys),
        deadline_ms=job_request.deadlineMs,
    )
    background.add_task(runtime.run_poster, job)
    return JSONResponse(status_code=202, content=body, headers=headers)
