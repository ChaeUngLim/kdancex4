"""AI 플래너 대화 경로 테스트 (SX-5.8(말로 찾기 실동작·챗봇 대화형 AI 답변)).

- 이어 묻기: 「그중 토요일만」은 앞 강사·요일을 이어받아 좁히고, 다른 강사를 말하면 새로 찾는다.
- 답 문장 검사: 검색 결과 밖의 가격·요일·수업명·강사 이름·영어가 든 문장은 버린다(지어내기 금지).
- 질문 한 건의 이벤트 순서(계약 16 §3-2)와 `POST /v1/chat/stream` 의 토큰·본문 검사.
- 끝 테스트는 **진짜 kdance-llm** 에 답 문장을 쓰게 하고, 나온 문장의 숫자·요일·이름이 모두 결과 안에 있는지 본다.
  모델 서버가 꺼져 있으면 건너뛴다.
"""

import json
import re
import urllib.request
from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.planner.answer_writer import build_facts, count_sentence, sentence_is_grounded, template_details, template_sentences, write_details
from app.planner.chat_routes import ChatRuntime, get_chat_runtime
from app.planner.condition_extractor import CONDITION_KEYS, ConditionExtraction, ConditionExtractionFailedError
from app.planner.follow_up import carry_over
from app.planner.planner_run import PlannerDeps, PlannerRequest, run_planner
from app.planner.text_client import OpenAICompatTextClient
from app.settings import load_settings

JUNHO = "11111111-1111-4111-8111-111111111111"
HONGDAE = "22222222-2222-4222-8222-222222222222"
SEONGSU = "33333333-3333-4333-8333-333333333333"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def cond(**fields: Any) -> dict[str, Any]:
    base: dict[str, Any] = {key: None for key in CONDITION_KEYS}
    base["weekdays"] = []
    base.update(fields)
    return base


def offering(title: str, academy: str, weekday: str, start: str, end: str, price: int, status: str = "open", level: str = "entry") -> dict[str, Any]:
    oid = f"{abs(hash(title)) % 10**12:012d}"
    return {
        "offeringId": f"aaaaaaaa-aaaa-4aaa-8aaa-{oid}",
        "classId": f"bbbbbbbb-bbbb-4bbb-8bbb-{oid}",
        "title": title,
        "genre": "salsa_bachata",
        "isPrivateLesson": False,
        "academy": {"id": HONGDAE, "name": academy},
        "hall": "A홀",
        "pattern": [{"weekday": weekday, "startTime": start, "endTime": end}],
        "firstSessionDate": "2026-12-05",
        "lastSessionDate": "2026-12-27",
        "sessionCount": 4,
        "level": level,
        "pools": [{"seatKind": "male", "remaining": 3}],
        "priceAmount": price,
        "recruitStatus": status,
        "waitlistAvailable": False,
        "action": {"type": "open_offering", "offeringId": None},
    }


WEEKEND = [
    offering("살사 주말 입문", "살사포인트 홍대", "sat", "11:00", "12:30", 110000),
    offering("살사 온투 초중급", "라틴무브 성수", "sun", "13:00", "14:30", 135000, level="novice_intermediate"),
    offering("바차타 주말 초급", "살사포인트 홍대", "sun", "16:00", "17:30", 125000, status="full", level="beginner"),
]
JUNHO_WEEKEND = cond(instructor={"name": "이준호", "id": JUNHO}, weekdays=["sat", "sun"])


# ---- 이어 묻기 ---------------------------------------------------------------------------------


def test_follow_up_narrows_previous_weekdays_and_keeps_instructor_id() -> None:
    merged = carry_over(cond(weekdays=["sat"]), JUNHO_WEEKEND, "그중 토요일만", None)
    assert merged["instructor"] == {"name": "이준호", "id": JUNHO}
    assert merged["weekdays"] == ["sat"]


def test_follow_up_adds_level_and_keeps_weekdays() -> None:
    merged = carry_over(cond(level="beginner"), JUNHO_WEEKEND, "초급만", None)
    assert merged["weekdays"] == ["sat", "sun"] and merged["level"] == "beginner"
    assert merged["instructor"]["id"] == JUNHO


def test_other_instructor_starts_fresh() -> None:
    merged = carry_over(cond(instructor={"name": "김하나", "id": None}), JUNHO_WEEKEND, "김하나 강사 수업은?", None)
    assert merged["instructor"] == {"name": "김하나", "id": None}
    assert merged["weekdays"] == []


def test_all_academies_word_drops_previous_academy() -> None:
    previous = {**JUNHO_WEEKEND, "academy": {"name": "살사포인트 홍대", "id": HONGDAE}}
    merged = carry_over(cond(), previous, "모든 학원으로 넓혀 줘", None)
    assert merged["academy"] is None and merged["instructor"]["id"] == JUNHO


def test_fixed_instructor_used_when_question_names_no_one() -> None:
    merged = carry_over(cond(weekdays=["sat", "sun"]), None, "주말 수업 알려줘", JUNHO)
    assert merged["instructor"] == {"name": None, "id": JUNHO}


def test_open_only_flag_is_carried_over() -> None:
    merged = carry_over(cond(weekdays=["sat"]), {**JUNHO_WEEKEND, "recruitOpenOnly": True}, "토요일만", None)
    assert merged["recruitOpenOnly"] is True


# ---- 답 문장 검사(지어내기 금지) -----------------------------------------------------------------

FACTS = build_facts(JUNHO_WEEKEND, WEEKEND)


@pytest.mark.parametrize(
    "sentence",
    [
        "이준호 강사님의 주말 수업은 3개예요.",
        "토요일 11:00–12:30 「살사 주말 입문」은 「살사포인트 홍대」에서 열리고 110,000원이에요.",
        "일요일에는 「살사 온투 초중급」이 13:00에 시작해요.",
        "주말 수업은 세 개이고, 그중 두 개가 일요일이에요.",
        "「바차타 주말 초급」은 오후 4시에 시작해요.",
        "「바차타 주말 초급」은 남은 자리가 없어요.",  # 마감 카드 설명 — 「없다」 낱말이 있어도 결과와 맞는 말
    ],
)
def test_grounded_sentences_pass(sentence: str) -> None:
    assert sentence_is_grounded(sentence, FACTS)


@pytest.mark.parametrize(
    "sentence",
    [
        "「살사 주말 입문」은 99,000원이에요.",  # 결과에 없는 가격
        "수요일 저녁에도 수업이 있어요.",  # 결과에 없는 요일
        "「살사 마스터 클래스」도 추천해요.",  # 결과에 없는 수업명
        "박지훈 강사님 수업도 있어요.",  # 다른 강사 이름
        "토요일 15:00에도 열려요.",  # 결과에 없는 시각
        "Salsa class is open.",  # 한국어가 아님(FR-266)
        "주말 수업은 여섯 개예요.",  # 결과 수와 다른 수 낱말
        # 결과가 있는데 「없다」고 하는 문장(SX-5.8 실측: 6개를 찾고도 모델이 이렇게 썼다)
        "강사 이준호님의 수업은 검색 결과에 없습니다.",
        "조건에 맞는 수업을 찾지 못했어요.",
        "이준호 강사님의 주말 수업은 없어요.",
    ],
)
def test_sentences_outside_results_are_rejected(sentence: str) -> None:
    assert not sentence_is_grounded(sentence, FACTS)


def test_template_sentences_are_grounded_and_start_with_count() -> None:
    sentences = template_sentences(JUNHO_WEEKEND, WEEKEND)
    assert sentences[0] == "이준호 강사님의 주말 수업은 3개예요."
    assert 2 <= len(sentences) <= 4
    assert all(sentence_is_grounded(s, FACTS) for s in sentences)


class FakeWriter:
    model_name = "fake"

    def __init__(self, answer: Any) -> None:
        self.answer = answer
        self.prompts: list[str] = []

    async def complete_json(self, **kwargs: Any) -> str:
        self.prompts.append(kwargs["user_prompt"])
        if isinstance(self.answer, Exception):
            raise self.answer
        return json.dumps({"sentences": self.answer}, ensure_ascii=False)


@pytest.mark.anyio
async def test_write_details_drops_made_up_sentences_and_keeps_grounded() -> None:
    writer = FakeWriter(
        [
            "「살사 주말 입문」은 99,000원이에요.",
            "토요일 11:00에 「살사포인트 홍대」에서 「살사 주말 입문」이 열려요.",
            "수요일 저녁 수업도 있어요.",
        ]
    )
    written = await write_details(JUNHO_WEEKEND, WEEKEND, client=writer, timeout_seconds=5)
    assert written.used_model and written.dropped == 2
    assert written.sentences == ["토요일 11:00에 「살사포인트 홍대」에서 「살사 주말 입문」이 열려요."]
    # 모델에게는 질문 원문이 아니라 결과 값 목록만 간다(FR-270)
    assert "「살사 온투 초중급」 · 「라틴무브 성수」 · 일요일 13:00–14:30 · 135,000원" in writer.prompts[0]


@pytest.mark.anyio
async def test_write_details_falls_back_to_template_when_all_dropped_or_model_fails() -> None:
    bad = await write_details(JUNHO_WEEKEND, WEEKEND, client=FakeWriter(["수요일에도 있어요."]), timeout_seconds=5)
    assert not bad.used_model and bad.sentences == template_details(WEEKEND)
    failed = await write_details(JUNHO_WEEKEND, WEEKEND, client=FakeWriter(TimeoutError()), timeout_seconds=5)
    assert not failed.used_model and failed.sentences == template_details(WEEKEND)


def test_count_sentence_says_scope_and_result_count() -> None:
    assert count_sentence(JUNHO_WEEKEND, WEEKEND) == "이준호 강사님의 주말 수업은 3개예요."
    weekday_evening = cond(instructor={"name": "이준호", "id": JUNHO}, weekdays=["mon", "tue", "wed", "thu", "fri"], timeBand="evening")
    assert count_sentence(weekday_evening, WEEKEND[:2]) == "이준호 강사님의 평일 저녁 수업은 2개예요."


# ---- 질문 한 건의 이벤트 -------------------------------------------------------------------------


class FakeTools:
    def __init__(self, *, instructors: dict[str, Any] | None = None, cards: list[dict[str, Any]] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.instructors = instructors or {
            "resolution": "unique",
            "resolved": {"instructorId": JUNHO, "displayName": "이준호"},
            "candidates": [{"instructorId": JUNHO, "displayName": "이준호"}],
        }
        self.cards = WEEKEND if cards is None else cards

    async def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((name, arguments))
        if name == "find_instructors":
            return {"data": self.instructors, "sources": []}
        if name == "search_offerings":
            return {"data": self.cards, "sources": [{"kind": "offering", "id": c["offeringId"], "label": c["title"]} for c in self.cards]}
        raise AssertionError(name)


def deps_for(tools: FakeTools, conditions: dict[str, Any] | Exception, writer: Any = None) -> PlannerDeps:
    async def extract(_question: str) -> ConditionExtraction:
        if isinstance(conditions, Exception):
            raise conditions
        return ConditionExtraction(conditions=conditions, needs_more=False, model="fake", elapsed_ms=1)

    @asynccontextmanager
    async def opened():  # type: ignore[no-untyped-def]
        yield tools

    return PlannerDeps(extract=extract, open_tools=opened, writer=writer)


async def collect(request: PlannerRequest, deps: PlannerDeps) -> list[tuple[str, dict[str, Any]]]:
    return [event async for event in run_planner(request, deps)]


def req(message: str, previous: dict[str, Any] | None = None) -> PlannerRequest:
    return PlannerRequest(message=message, previous_conditions=previous, fixed_instructor_id=None, deadline_ms=25000)


@pytest.mark.anyio
async def test_weekend_question_streams_conditions_cards_then_sentences() -> None:
    tools = FakeTools()
    events = await collect(req("이준호 강사 주말 수업 전체 알려줘"), deps_for(tools, cond(instructor={"name": "이준호", "id": None}, weekdays=["sat", "sun"])))
    names = [name for name, _ in events]
    assert names[:3] == ["tier", "stage", "stage"]
    assert names[3:6] == ["conditions", "cards", "sources"]
    assert names[6:8] == ["text", "stage"] and names[-1] == "done"
    assert events[3][1]["instructor"] == {"name": "이준호", "id": JUNHO}
    assert [c["title"] for c in events[4][1]["items"]] == [c["title"] for c in WEEKEND]
    texts = [data["sentence"] for name, data in events if name == "text"]
    assert texts[0] == "이준호 강사님의 주말 수업은 3개예요."
    # 검색은 강사 id 와 요일로, 쓰기 도구는 한 번도 부르지 않는다(FR-214)
    assert tools.calls[1] == ("search_offerings", {"instructor": {"name": "이준호", "id": JUNHO}, "weekdays": ["sat", "sun"], "limit": 20})
    assert {name for name, _ in tools.calls} <= {"find_instructors", "find_academies", "search_offerings"}


@pytest.mark.anyio
async def test_open_only_question_drops_full_classes() -> None:
    events = await collect(req("이준호 강사 주말 모집 중인 수업"), deps_for(FakeTools(), cond(instructor={"name": "이준호", "id": None}, weekdays=["sat", "sun"])))
    cards = next(data for name, data in events if name == "cards")
    assert [c["title"] for c in cards["items"]] == ["살사 주말 입문", "살사 온투 초중급"]
    assert next(data for name, data in events if name == "conditions")["recruitOpenOnly"] is True


@pytest.mark.anyio
async def test_follow_up_uses_previous_id_without_name_lookup() -> None:
    tools = FakeTools(cards=WEEKEND[:1])
    events = await collect(req("그중 토요일만", JUNHO_WEEKEND), deps_for(tools, cond(weekdays=["sat"])))
    assert [name for name, _ in tools.calls] == ["search_offerings"]
    assert tools.calls[0][1]["weekdays"] == ["sat"]
    texts = [data["sentence"] for name, data in events if name == "text"]
    assert texts[0] == "이준호 강사님의 토요일 수업은 1개예요."


@pytest.mark.anyio
async def test_no_result_sends_empty_cards_and_fixed_sentence() -> None:
    events = await collect(req("이준호 강사 월요일 수업"), deps_for(FakeTools(cards=[]), cond(instructor={"name": "이준호", "id": None}, weekdays=["mon"])))
    assert ("cards", {"kind": "offering_cards", "items": []}) in events
    assert ("text", {"sentence": "조건에 맞는 수업을 찾지 못했어요."}) in events
    assert events[-1][0] == "done"


@pytest.mark.anyio
async def test_ambiguous_instructor_sends_candidates_without_offering_cards() -> None:
    tools = FakeTools(instructors={"resolution": "ambiguous", "resolved": None, "candidates": [{"instructorId": JUNHO}, {"instructorId": HONGDAE}]})
    events = await collect(req("김하나 강사 수업"), deps_for(tools, cond(instructor={"name": "김하나", "id": None})))
    kinds = [data["kind"] for name, data in events if name == "cards"]
    assert kinds == ["instructor_candidates"]
    assert [name for name, _ in tools.calls] == ["find_instructors"]


@pytest.mark.anyio
async def test_extraction_failure_asks_next_js_for_plain_search() -> None:
    events = await collect(req("아무 말"), deps_for(FakeTools(), ConditionExtractionFailedError("x")))
    assert events[-1] == ("error", {"code": "MODEL_UNAVAILABLE", "fallback": "plain_search"})


# ---- HTTP 경로 ---------------------------------------------------------------------------------


def runtime_with(tools: FakeTools, extract_answer: dict[str, Any]) -> ChatRuntime:
    class Extract:
        model_name = "fake"

        async def complete_json(self, **_kwargs: Any) -> str:
            return json.dumps(extract_answer, ensure_ascii=False)

    def factory(_token: str):  # type: ignore[no-untyped-def]
        @asynccontextmanager
        async def opened():  # type: ignore[no-untyped-def]
            yield tools

        return opened()

    return ChatRuntime(agent_api_token="t0ken", extract_client=Extract(), writer=None, tools_factory=factory)


def body(message: str, **context: Any) -> dict[str, Any]:
    ctx = {"kind": "planner", "academyId": None, "offeringId": None, "instructorId": None, **context}
    return {"runId": "run-1", "context": ctx, "message": message, "degraded": False, "deadlineMs": 25000, "agentSessionToken": "s"}


def test_chat_stream_route_checks_token_and_body_then_streams_sse() -> None:
    answer = {"instructorName": "이준호", "academyName": None, "weekdays": ["sat", "sun"], "timeBand": None, "genre": None, "level": None, "regionSido": None, "regionGu": None}
    app.dependency_overrides[get_chat_runtime] = lambda: runtime_with(FakeTools(), answer)
    try:
        client = TestClient(app)
        assert client.post("/v1/chat/stream", json=body("이준호 주말"), headers={"X-Agent-Token": "nope"}).status_code == 401
        bad = body("이준호 주말")
        bad["memberId"] = "x"
        assert client.post("/v1/chat/stream", json=bad, headers={"X-Agent-Token": "t0ken"}).status_code == 422
        response = client.post("/v1/chat/stream", json=body("이준호 강사 주말 수업 전체 알려줘"), headers={"X-Agent-Token": "t0ken"})
        assert response.status_code == 200 and response.headers["content-type"].startswith("text/event-stream")
        names = re.findall(r"^event: (\w+)$", response.text, flags=re.M)
        assert names[0] == "tier" and names[-1] == "done" and "cards" in names
        # 이어 묻기 — 앞 조건을 previousConditions 로 받는다
        follow = body("그중 토요일만", previousConditions={"instructor": {"name": "이준호", "id": JUNHO}, "weekdays": ["sat", "sun"]})
        assert client.post("/v1/chat/stream", json=follow, headers={"X-Agent-Token": "t0ken"}).status_code == 200
        inquiry = client.post("/v1/chat/stream", json=body("환불 돼요?", kind="inquiry"), headers={"X-Agent-Token": "t0ken"})
        assert "event: error" in inquiry.text and '"fallback": "human"' in inquiry.text
    finally:
        app.dependency_overrides.clear()


# ---- 진짜 모델 ---------------------------------------------------------------------------------


def _llm_up(base_url: str) -> bool:
    try:
        with urllib.request.urlopen(base_url.replace("/v1", "") + "/health", timeout=2) as response:
            return response.status == 200
    except OSError:
        return False


@pytest.mark.anyio
async def test_real_model_answer_uses_only_result_values() -> None:
    settings = load_settings()
    if not _llm_up(settings.llm_base_url):
        pytest.skip("kdance-llm 이 꺼져 있다")
    client = OpenAICompatTextClient(base_url=settings.llm_base_url, model_name=settings.llm_chat_model, timeout_seconds=30, max_tokens=400)
    written = await write_details(JUNHO_WEEKEND, WEEKEND, client=client, timeout_seconds=40)
    print("모델 문장:", written.sentences, "버림", written.dropped, "모델 사용", written.used_model)
    assert 1 <= len(written.sentences) <= 3
    for sentence in written.sentences:
        assert sentence_is_grounded(sentence, FACTS), sentence
        assert {int(n.replace(",", "")) for n in re.findall(r"\d[\d,]*", sentence)} <= set(FACTS.numbers)
