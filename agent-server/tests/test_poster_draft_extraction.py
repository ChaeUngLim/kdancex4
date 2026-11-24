"""포스터 → 수업 초안 추출 테스트 (SX-2.2(포스터 → 초안 추출)).

verify 의 `tests/test_sx_2_2.py` 는 Task 번호 이름이라 기능 이름으로 바꿨다.

- 앞부분: 가짜 모델로 추출 규칙(칸 거르기·신뢰도·재시도·주입 무시)과 `POST /v1/jobs` 경로를 본다.
- 끝 테스트 둘은 **진짜 kdance-llm(Qwen 비전)** 에 표본 포스터를 보내 칸이 채워지고 칸별
  신뢰도가 나오는지 본다. 모델 서버가 꺼져 있으면 건너뛴다(skip) — 완료 판정 때는 켜고 돌린다.
- SX-2.6(포스터 초안 기간 칸): 개강일·종료일·회차 수 칸 3개를 더했다. 기간이 적힌 포스터는 그 값을 읽고,
  적히지 않은 포스터는 날짜를 지어내지 않고 비워 둔다(검토 화면이 「확인필요」 빈 칸으로 보인다).
"""

import json
import urllib.request
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient

from app.jobs.job_routes import JobRuntime, get_job_runtime
from app.jobs.poster_job import NextInternalClient
from app.main import app
from app.poster.field_rules import POSTER_FIELD_KEYS
from app.poster.poster_extractor import (
    ExtractionFailedError,
    build_response_schema,
    extract_poster_draft,
)
from app.poster.vision_client import OpenAICompatVisionClient
from app.settings import load_settings

FIXTURES = Path(__file__).parent / "fixtures"
SAMPLE_POSTER = FIXTURES / "class_poster_sample.png"
# 기간(2026.12.05 ~ 2026.12.26 · 4회)이 적힌 표본 — 같은 폴더 HTML 을 헤드리스 Chromium 으로 찍었다(SX-2.6)
PERIOD_POSTER = FIXTURES / "class_poster_with_period.png"
AGENT_TOKEN = "test-agent-token"


@pytest.fixture
def anyio_backend() -> str:
    # 비동기 테스트는 asyncio 위에서만 돌린다(trio 는 쓰지 않는다)
    return "asyncio"


class FakeVision:
    """정해 둔 답을 차례로 돌려주는 가짜 모델. 받은 요청도 기록한다."""

    model_name = "fake-vision"

    def __init__(self, answers: list[str]) -> None:
        self._answers = list(answers)
        self.calls: list[dict[str, Any]] = []

    async def complete_json(self, **kwargs: Any) -> str:
        self.calls.append(kwargs)
        return self._answers.pop(0)


def _answer(fields: dict[str, Any]) -> str:
    return json.dumps({"fields": fields}, ensure_ascii=False)


GOOD_FIELDS = {
    "genre": {"value": "salsa_bachata", "confidence": 0.95},
    "title": {"value": "바차타 센슈얼 입문 · 11월", "confidence": 0.97},
    "weekday": {"value": ["sat"], "confidence": 0.9},
    "start_time": {"value": "19:00", "confidence": 0.93},
    "price_amount": {"value": 180000, "confidence": 0.71},
    "capacity_male": {"value": None, "confidence": None},
}
KEYS = list(GOOD_FIELDS)


# ---------- 추출 규칙(가짜 모델) ----------


@pytest.mark.anyio
async def test_draft_has_value_and_confidence_per_requested_field() -> None:
    vision = FakeVision([_answer(GOOD_FIELDS)])

    draft = await extract_poster_draft(
        image_bytes=b"img", content_type="image/png", field_keys=KEYS, client=vision
    )

    result = draft.to_result()
    assert [f["key"] for f in result["fields"]] == KEYS
    by_key = {f["key"]: f for f in result["fields"]}
    assert by_key["price_amount"] == {"key": "price_amount", "value": 180000, "confidence": 0.71}
    assert by_key["capacity_male"] == {"key": "capacity_male", "value": None, "confidence": None}
    # 전체 신뢰도는 못 읽은 칸을 0 으로 센 평균: (0.95+0.97+0.9+0.93+0.71+0)/6
    assert result["overallConfidence"] == pytest.approx(0.74)
    assert result["model"] == "fake-vision"
    assert len(vision.calls) == 1


@pytest.mark.anyio
async def test_invalid_format_value_becomes_unread() -> None:
    fields = {
        "start_time": {"value": "25:00", "confidence": 0.99},  # 없는 시각
        "genre": {"value": "kpop", "confidence": 0.9},  # 값 목록 밖
        "price_amount": {"value": "180,000원", "confidence": 0.9},  # 정수가 아님
        "weekday": {"value": ["sun", "sat", "sat"], "confidence": 1.7},  # 중복·순서·신뢰도 1 초과
    }
    vision = FakeVision([_answer(fields)])

    draft = await extract_poster_draft(
        image_bytes=b"img", content_type="image/png", field_keys=list(fields), client=vision
    )

    by_key = {f.key: f for f in draft.fields}
    for key in ("start_time", "genre", "price_amount"):
        assert by_key[key].value is None and by_key[key].confidence is None
    assert by_key["weekday"].value == ["sat", "sun"]
    assert by_key["weekday"].confidence == 1.0


def test_period_fields_are_part_of_field_keys() -> None:
    # 기간 칸 3개는 시간 칸 바로 뒤에 온다(검토 화면 칸 순서 = 이 순서, admin-web constants.ts 와 같다)
    keys = list(POSTER_FIELD_KEYS)
    assert keys[keys.index("end_time") + 1 : keys.index("end_time") + 4] == ["start_date", "end_date", "session_count"]
    assert len(keys) == 17


@pytest.mark.anyio
async def test_period_values_are_checked_and_unread_when_invalid() -> None:
    fields = {
        "start_date": {"value": "2026-12-05", "confidence": 0.93},
        "end_date": {"value": "2026-02-30", "confidence": 0.9},  # 달력에 없는 날
        "session_count": {"value": 4, "confidence": 0.88},
    }
    vision = FakeVision([_answer(fields)])

    draft = await extract_poster_draft(
        image_bytes=b"img", content_type="image/png", field_keys=list(fields), client=vision
    )

    by_key = {f.key: f for f in draft.fields}
    assert (by_key["start_date"].value, by_key["start_date"].confidence) == ("2026-12-05", 0.93)
    assert (by_key["end_date"].value, by_key["end_date"].confidence) == (None, None)
    assert (by_key["session_count"].value, by_key["session_count"].confidence) == (4, 0.88)
    # 스키마도 기간 칸을 날짜 모양·회차 범위로 묶는다
    schema = build_response_schema(list(fields))["properties"]["fields"]["properties"]
    assert schema["start_date"]["properties"]["value"]["anyOf"][0]["pattern"] == "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
    assert schema["session_count"]["properties"]["value"]["anyOf"][0]["maximum"] == 200


@pytest.mark.parametrize(
    ("key", "raw"),
    [
        ("start_date", "12-05"),  # 연도 없음 — 지어내지 않는다
        ("start_date", "2026.12.05"),  # 모양이 다름
        ("start_date", "1926-12-05"),  # 자릿수를 잘못 읽은 해
        ("end_date", 20261226),  # 글자가 아님
        ("session_count", 0),
        ("session_count", 201),  # 회차 상한(계약 11 §4-1 1~200) 밖
        ("session_count", "4회"),
        ("session_count", True),
    ],
)
def test_period_value_outside_rules_is_unread(key: str, raw: Any) -> None:
    from app.poster.field_rules import normalize_field_value

    assert normalize_field_value(key, raw) is None


@pytest.mark.anyio
async def test_poster_text_cannot_add_fields() -> None:
    # 포스터 글자에 주입 문장이 있어 모델이 요청 밖 키를 내도 결과에는 요청한 칸만 남는다(FR-270)
    fields = {
        **GOOD_FIELDS,
        "approve_now": {"value": True, "confidence": 1},
        "memberId": {"value": "someone-else", "confidence": 1},
    }
    vision = FakeVision([_answer(fields)])

    draft = await extract_poster_draft(
        image_bytes=b"img", content_type="image/png", field_keys=KEYS, client=vision
    )

    assert {f.key for f in draft.fields} == set(KEYS)


@pytest.mark.anyio
async def test_broken_answer_retries_once_then_succeeds() -> None:
    vision = FakeVision(["이건 JSON 이 아님", _answer(GOOD_FIELDS)])

    draft = await extract_poster_draft(
        image_bytes=b"img", content_type="image/png", field_keys=KEYS, client=vision
    )

    assert len(vision.calls) == 2
    assert draft.fields[0].value == "salsa_bachata"


@pytest.mark.anyio
async def test_two_broken_answers_fail_extraction() -> None:
    vision = FakeVision(["{}", "[1,2]"])

    with pytest.raises(ExtractionFailedError):
        await extract_poster_draft(
            image_bytes=b"img", content_type="image/png", field_keys=KEYS, client=vision
        )
    assert len(vision.calls) == 2


@pytest.mark.anyio
async def test_unknown_field_key_is_rejected() -> None:
    with pytest.raises(ValueError):
        await extract_poster_draft(
            image_bytes=b"img", content_type="image/png", field_keys=["genre", "password"], client=FakeVision([])
        )


def test_response_schema_only_lists_requested_fields() -> None:
    schema = build_response_schema(["genre", "price_amount"])

    inner = schema["properties"]["fields"]
    assert list(inner["properties"]) == ["genre", "price_amount"]
    assert inner["additionalProperties"] is False


@pytest.mark.anyio
async def test_vision_client_sends_image_and_json_schema() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.update(json.loads(request.content))
        return httpx2.Response(200, json={"choices": [{"message": {"content": _answer(GOOD_FIELDS)}}]})

    client = OpenAICompatVisionClient(
        base_url="http://llm.test/v1", model_name="qwen3.5:9b", transport=httpx2.MockTransport(handler)
    )

    answer = await client.complete_json(
        system_prompt="s", user_prompt="u", image_bytes=b"\x89PNG", content_type="image/png", json_schema={"a": 1}
    )

    assert json.loads(answer)["fields"]["genre"]["value"] == "salsa_bachata"
    assert seen["response_format"]["type"] == "json_schema"
    image_part = seen["messages"][1]["content"][0]
    assert image_part["image_url"]["url"].startswith("data:image/png;base64,")


# ---------- POST /v1/jobs 경로 ----------


class FakeNext:
    """가짜 Next.js 내부 경로 — 포스터 파일을 내주고, 결과 전달을 기록한다."""

    def __init__(self, poster: bytes) -> None:
        self.poster = poster
        self.results: list[tuple[str, dict[str, Any]]] = []
        self.internal_tokens: list[str | None] = []

    def handler(self, request: httpx2.Request) -> httpx2.Response:
        self.internal_tokens.append(request.headers.get("x-internal-token"))
        path = request.url.path
        if request.method == "GET" and path.endswith("/file"):
            return httpx2.Response(200, content=self.poster, headers={"content-type": "image/png"})
        if request.method == "POST" and path.endswith("/result"):
            job_id = path.split("/")[-2]
            self.results.append((job_id, json.loads(request.content)))
            return httpx2.Response(200, json={"applied": True})
        return httpx2.Response(404)


def _runtime(vision: FakeVision, fake_next: FakeNext) -> JobRuntime:
    return JobRuntime(
        agent_api_token=AGENT_TOKEN,
        vision=vision,
        next_client=NextInternalClient(
            base_url="http://next.test",
            internal_token="test-internal-token",
            transport=httpx2.MockTransport(fake_next.handler),
        ),
    )


def _job_body(job_id: str = "job-1", **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "jobId": job_id,
        "kind": "poster_extract",
        "deadlineMs": 120000,
        "payload": {
            "extractionId": "ext-1",
            "fileUrl": f"/api/internal/ai/jobs/{job_id}/file",
            "targetKind": "class",
            "fieldKeys": KEYS,
        },
    }
    body.update(overrides)
    return body


@pytest.fixture
def wired() -> Any:
    """가짜 모델·가짜 Next.js 를 끼운 앱. 테스트가 끝나면 원래대로 돌린다."""
    vision = FakeVision([_answer(GOOD_FIELDS)])
    fake_next = FakeNext(SAMPLE_POSTER.read_bytes())
    runtime = _runtime(vision, fake_next)
    app.dependency_overrides[get_job_runtime] = lambda: runtime
    try:
        yield TestClient(app), vision, fake_next
    finally:
        app.dependency_overrides.clear()


def test_job_accepted_then_result_reported_to_next(wired: Any) -> None:
    client, vision, fake_next = wired

    response = client.post("/v1/jobs", json=_job_body(), headers={"X-Agent-Token": AGENT_TOKEN})

    assert response.status_code == 202
    assert response.json() == {"jobId": "job-1", "accepted": True}
    # 응답 뒤 작업이 돌아 결과가 Next.js 로 갔다
    assert len(fake_next.results) == 1
    job_id, sent = fake_next.results[0]
    assert job_id == "job-1"
    assert sent["status"] == "succeeded"
    assert {f["key"] for f in sent["result"]["fields"]} == set(KEYS)
    assert all(token == "test-internal-token" for token in fake_next.internal_tokens)
    # 모델에는 Next.js 가 내준 포스터 바이트가 그대로 갔다
    assert vision.calls[0]["image_bytes"] == SAMPLE_POSTER.read_bytes()
    assert vision.calls[0]["content_type"] == "image/png"


def test_same_job_id_is_not_run_twice(wired: Any) -> None:
    client, _vision, fake_next = wired
    headers = {"X-Agent-Token": AGENT_TOKEN}

    first = client.post("/v1/jobs", json=_job_body(), headers=headers)
    second = client.post("/v1/jobs", json=_job_body(), headers=headers)

    assert (first.status_code, second.status_code) == (202, 200)
    assert second.json() == {"jobId": "job-1", "accepted": True}
    assert len(fake_next.results) == 1


def test_job_without_valid_token_is_rejected(wired: Any) -> None:
    client, _vision, fake_next = wired

    missing = client.post("/v1/jobs", json=_job_body())
    wrong = client.post("/v1/jobs", json=_job_body(), headers={"X-Agent-Token": "nope"})

    assert missing.status_code == wrong.status_code == 401
    assert missing.json()["code"] == "UNAUTHORIZED"
    assert fake_next.results == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"kind": "promo_image"},  # kind 와 payload 모양이 맞지 않음
        {"deadlineMs": 10},
        {"extra": 1},
        {"payload": {"extractionId": "e", "fileUrl": "http://evil.test/x", "targetKind": "class", "fieldKeys": ["genre"]}},
        {"payload": {"extractionId": "e", "fileUrl": "/api/internal/ai/jobs/j/file", "targetKind": "class", "fieldKeys": ["password"]}},
    ],
)
def test_invalid_job_body_returns_422(wired: Any, overrides: dict[str, Any]) -> None:
    client, _vision, fake_next = wired

    response = client.post("/v1/jobs", json=_job_body(**overrides), headers={"X-Agent-Token": AGENT_TOKEN})

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_FAILED"
    assert fake_next.results == []


def test_non_image_file_reports_extraction_failed() -> None:
    vision = FakeVision([_answer(GOOD_FIELDS)])
    fake_next = FakeNext(b"%PDF-1.7 not an image")
    app.dependency_overrides[get_job_runtime] = lambda: _runtime(vision, fake_next)
    try:
        response = TestClient(app).post("/v1/jobs", json=_job_body(), headers={"X-Agent-Token": AGENT_TOKEN})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 202
    _job_id, sent = fake_next.results[0]
    assert sent["status"] == "failed"
    assert sent["error"]["code"] == "EXTRACTION_FAILED"
    assert vision.calls == []  # 사진이 아니면 모델을 부르지 않는다


@pytest.mark.anyio
async def test_result_not_sent_when_next_is_down_does_not_raise() -> None:
    from app.jobs.poster_job import PosterJob, run_poster_job

    def down(_request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("Next.js 꺼짐")

    next_client = NextInternalClient(base_url="http://next.test", internal_token="t", transport=httpx2.MockTransport(down))
    job = PosterJob(job_id="job-9", file_url="/api/internal/ai/jobs/job-9/file", field_keys=("genre",), deadline_ms=5000)

    sent = await run_poster_job(job, vision=FakeVision([]), next_client=next_client)

    assert sent is None


# ---------- 진짜 비전 모델(kdance-llm) — 표본 포스터 1장 ----------


def _llm_is_up(base_url: str) -> bool:
    health = base_url.rstrip("/").removesuffix("/v1") + "/health"
    try:
        with urllib.request.urlopen(health, timeout=3) as response:
            return bool(response.status == 200)
    except OSError:
        return False


@pytest.mark.anyio
async def test_sample_poster_fills_class_draft_with_confidence() -> None:
    settings = load_settings()
    if not _llm_is_up(settings.llm_base_url):
        pytest.skip("kdance-llm(포트 11436)이 꺼져 있다 — 완료 판정 때는 켜고 돌린다")
    vision = OpenAICompatVisionClient(
        base_url=settings.llm_base_url, model_name=settings.llm_vision_model, timeout_seconds=180
    )

    draft = await extract_poster_draft(
        image_bytes=SAMPLE_POSTER.read_bytes(),
        content_type="image/png",
        field_keys=POSTER_FIELD_KEYS,
        client=vision,
    )

    result = draft.to_result()
    # 증거용으로 실제 결과를 출력한다(pytest -s 로 볼 수 있다)
    print(json.dumps(result, ensure_ascii=False))
    by_key = {f["key"]: f for f in result["fields"]}
    assert list(by_key) == list(POSTER_FIELD_KEYS)
    # 포스터에 적힌 값이 칸에 들어왔다
    assert "바차타" in by_key["title"]["value"]
    assert by_key["genre"]["value"] == "salsa_bachata"
    assert by_key["weekday"]["value"] == ["sat"]
    assert by_key["start_time"]["value"] == "19:00"
    assert by_key["end_time"]["value"] == "20:30"
    assert by_key["price_amount"]["value"] == 180000
    assert by_key["instructor_name"]["value"] == "김하늘"
    assert by_key["capacity_male"]["value"] == 6
    assert by_key["capacity_female"]["value"] == 6
    # 이 포스터에는 날짜가 없다 — 개강일·종료일을 지어내지 않고 비운다(검토 화면에서 확인필요 빈 칸)
    assert by_key["start_date"] == {"key": "start_date", "value": None, "confidence": None}
    assert by_key["end_date"] == {"key": "end_date", "value": None, "confidence": None}
    # 채워진 칸마다 0~1 신뢰도가 있고, 빈 칸은 신뢰도도 없다
    filled = [f for f in result["fields"] if f["value"] is not None]
    assert len(filled) >= 10
    for f in result["fields"]:
        if f["value"] is None:
            assert f["confidence"] is None
        else:
            assert 0.0 <= f["confidence"] <= 1.0
    assert 0.0 < result["overallConfidence"] <= 1.0


@pytest.mark.anyio
async def test_period_poster_fills_start_end_date_and_session_count() -> None:
    """SX-2.6 — 기간이 적힌 포스터 1장을 진짜 모델로 읽어 개강일·종료일·회차 수가 채워지는지 본다."""
    settings = load_settings()
    if not _llm_is_up(settings.llm_base_url):
        pytest.skip("kdance-llm(포트 11436)이 꺼져 있다 — 완료 판정 때는 켜고 돌린다")
    vision = OpenAICompatVisionClient(
        base_url=settings.llm_base_url, model_name=settings.llm_vision_model, timeout_seconds=180
    )

    draft = await extract_poster_draft(
        image_bytes=PERIOD_POSTER.read_bytes(),
        content_type="image/png",
        field_keys=POSTER_FIELD_KEYS,
        client=vision,
    )

    result = draft.to_result()
    print(json.dumps(result, ensure_ascii=False))
    by_key = {f["key"]: f for f in result["fields"]}
    assert by_key["start_date"]["value"] == "2026-12-05"
    assert by_key["end_date"]["value"] == "2026-12-26"
    assert by_key["session_count"]["value"] == 4
    for key in ("start_date", "end_date", "session_count"):
        assert 0.0 <= by_key[key]["confidence"] <= 1.0
    assert by_key["weekday"]["value"] == ["sat"]
