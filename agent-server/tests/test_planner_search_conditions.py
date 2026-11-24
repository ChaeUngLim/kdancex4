"""AI 검색 조건 추출 테스트 (SX-4.1(조건 추출)).

verify 의 `tests/test_sx_4_1.py` 는 Task 번호 이름이라 기능 이름으로 바꿨다.

무엇을 보나
- 회원이 말로 한 조건(장르·지역·시간대)이 S3-2 검색 조건 모양(계약 16 §5-1, 칸 11개)으로 바뀌는가.
- 지역은 「서울」「강남구」처럼 학원 표(`academies.region_sido`·`region_gu`)에 저장된 낱말 그대로 나와야
  검색이 맞는다. 그래서 「강남」「서울특별시」「홍대」 같은 말을 그 낱말로 맞추는 규칙을 본다.
- 앞부분은 가짜 모델로 거르기 규칙을, 끝 테스트는 **진짜 kdance-llm(Qwen)** 에 표본 문장을 보내 본다.
  모델 서버가 꺼져 있으면 끝 테스트만 건너뛴다(skip) — 완료 판정 때는 켜고 돌린다.
"""

import json
import urllib.request
from typing import Any

import pytest

from app.planner.condition_extractor import CONDITION_KEYS, extract_conditions
from app.planner.region_names import find_region, normalize_region
from app.planner.text_client import OpenAICompatTextClient
from app.settings import load_settings


@pytest.fixture
def anyio_backend() -> str:
    # 비동기 테스트는 asyncio 위에서만 돌린다(trio 는 쓰지 않는다)
    return "asyncio"


class FakeText:
    """정해 둔 답을 차례로 돌려주는 가짜 모델."""

    model_name = "fake-text"

    def __init__(self, answers: list[str]) -> None:
        self._answers = list(answers)
        self.calls: list[dict[str, Any]] = []

    async def complete_json(self, **kwargs: Any) -> str:
        self.calls.append(kwargs)
        return self._answers.pop(0)


def _answer(**fields: Any) -> str:
    base: dict[str, Any] = {
        "instructorName": None,
        "academyName": None,
        "weekdays": [],
        "timeBand": None,
        "genre": None,
        "level": None,
        "regionSido": None,
        "regionGu": None,
    }
    base.update(fields)
    return json.dumps(base, ensure_ascii=False)


def _expected(**fields: Any) -> dict[str, Any]:
    """계약 16 §5-1 모양의 기대값. 말하지 않은 칸은 비어 있다."""
    base: dict[str, Any] = {
        "instructor": None,
        "academy": None,
        "genre": None,
        "weekdays": [],
        "timeBand": None,
        "level": None,
        "regionSido": None,
        "regionGu": None,
        "maxPriceAmount": None,
        "dateFrom": None,
        "dateTo": None,
    }
    base.update(fields)
    return base


# --- 지역 낱말 맞추기(모델 없이) ---------------------------------------------------------------


def test_short_seoul_gu_becomes_full_gu_with_seoul() -> None:
    # 「강남」은 학원 표의 「강남구」로, 서울에만 있는 구라 시·도도 「서울」로 채운다
    assert find_region("강남에서 살사 수업") == ("서울", "강남구")
    assert find_region("마포구 스윙") == ("서울", "마포구")


def test_sido_long_names_become_stored_short_names() -> None:
    # 학원 표에는 「서울」처럼 짧은 이름으로 저장된다(시연 데이터·가입 화면 기본값과 같음)
    assert find_region("서울특별시 탱고 수업") == ("서울", None)
    assert find_region("경기도 수원시 바차타") == ("경기", "수원시")
    assert find_region("부산 해운대구 라틴 수업") == ("부산", "해운대구")


def test_neighborhood_alias_maps_to_gu() -> None:
    # 「홍대」「신촌」처럼 동네 이름으로 말해도 그 구로 찾는다(추천안 — 자주 쓰는 동네만)
    assert find_region("홍대 근처 바차타") == ("서울", "마포구")
    assert find_region("신촌 스윙") == ("서울", "서대문구")


def test_gu_shared_by_many_cities_keeps_sido_empty() -> None:
    # 「중구」는 서울·부산·대구 … 에 다 있다. 시·도를 말하지 않았으면 짐작하지 않는다
    assert find_region("중구 살사") == (None, "중구")
    assert find_region("서울 중구 살사") == ("서울", "중구")


def test_no_region_word_gives_nothing() -> None:
    assert find_region("주말 오전 탱고 수업") == (None, None)


def test_model_region_must_be_in_question() -> None:
    # 모델이 질문에 없는 지역을 내면 버린다(지어낸 조건 막기 — FR-039)
    assert normalize_region("서울", "강남구", "주말 탱고 수업") == (None, None)
    assert normalize_region("서울특별시", "강남", "강남 탱고 수업") == ("서울", "강남구")


# --- 조건 추출 노드(가짜 모델) ------------------------------------------------------------------


@pytest.mark.anyio
async def test_genre_region_time_become_search_conditions() -> None:
    client = FakeText([_answer(genre="salsa_bachata", regionSido="서울", regionGu="강남", weekdays=["mon", "tue", "wed", "thu", "fri"], timeBand="evening")])
    result = await extract_conditions("강남에서 평일 저녁 살사 수업 찾아줘", client=client)
    assert tuple(result.conditions.keys()) == CONDITION_KEYS
    assert result.conditions == _expected(
        genre="salsa_bachata",
        regionSido="서울",
        regionGu="강남구",
        weekdays=["mon", "tue", "wed", "thu", "fri"],
        timeBand="evening",
    )
    assert result.needs_more is False


@pytest.mark.anyio
async def test_region_is_found_even_if_model_misses_it() -> None:
    # 모델이 지역 칸을 비워도 질문에 지역 낱말이 있으면 규칙으로 채운다
    client = FakeText([_answer(genre="swing")])
    result = await extract_conditions("마포구 스윙 수업", client=client)
    assert result.conditions["regionSido"] == "서울"
    assert result.conditions["regionGu"] == "마포구"


@pytest.mark.anyio
async def test_region_word_inside_academy_name_is_not_a_region() -> None:
    # 「라틴하우스 강남」의 「강남」은 학원 이름이다. 지역으로 받으면 다른 구의 지점 수업이 빠진다
    client = FakeText([_answer(instructorName="이준호", academyName="라틴하우스 강남", regionSido="서울", regionGu="강남구")])
    result = await extract_conditions("이준호 강사님의 라틴하우스 강남 수업 정보 모두 알려줘", client=client)
    assert result.conditions["academy"] == {"name": "라틴하우스 강남", "id": None}
    assert result.conditions["regionSido"] is None
    assert result.conditions["regionGu"] is None


@pytest.mark.anyio
async def test_region_only_question_is_enough_to_search() -> None:
    # 지역만 말해도 조건이 하나 있으니 검색한다(「더 알려 주세요」가 아니다)
    client = FakeText([_answer()])
    result = await extract_conditions("서울 수업 알려줘", client=client)
    assert result.conditions["regionSido"] == "서울"
    assert result.needs_more is False


@pytest.mark.anyio
async def test_budget_and_dates_stay_empty() -> None:
    # 이 Task 는 장르·지역·시간대까지다. 예산·날짜 칸은 자리만 두고 비워 둔다
    client = FakeText([_answer(genre="swing")])
    result = await extract_conditions("10만원 이하 다음 주 스윙 수업", client=client)
    assert result.conditions["maxPriceAmount"] is None
    assert result.conditions["dateFrom"] is None
    assert result.conditions["dateTo"] is None


@pytest.mark.anyio
async def test_genre_word_is_used_when_model_leaves_genre_empty() -> None:
    # 모델이 장르를 비워도 이름 밖에 한 장르 낱말만 있으면 그 장르로 본다(실측: 「라틴 댄스」를 비웠다)
    client = FakeText([_answer(regionSido="부산", regionGu="해운대구")])
    result = await extract_conditions("부산 해운대구 라틴 댄스 수업 추천해줘", client=client)
    assert result.conditions["genre"] == "dance_sport"

    # 두 장르를 같이 말하면 하나로 짐작하지 않는다
    mixed = FakeText([_answer()])
    both = await extract_conditions("살사랑 탱고 수업 다 보여줘", client=mixed)
    assert both.conditions["genre"] is None

    # 학원 이름 속 장르 낱말은 대비 규칙에서도 세지 않는다
    named = FakeText([_answer(academyName="라틴하우스 강남")])
    by_name = await extract_conditions("라틴하우스 강남 수업 알려줘", client=named)
    assert by_name.conditions["genre"] is None


def test_model_is_asked_for_region_fields() -> None:
    # 모델 답의 JSON 스키마에 지역 두 칸이 들어 있다
    from app.planner.condition_extractor import SYSTEM_PROMPT, build_response_schema

    schema = build_response_schema()
    assert {"regionSido", "regionGu"} <= set(schema["required"])
    assert "지역" in SYSTEM_PROMPT


# --- 진짜 모델(kdance-llm) 로 표본 문장 ---------------------------------------------------------


def _llm_up() -> bool:
    base = load_settings().llm_base_url.rstrip("/").removesuffix("/v1")
    try:
        with urllib.request.urlopen(base + "/health", timeout=3) as response:
            return bool(response.status == 200)
    except OSError:
        return False


WEEKDAYS_ONLY = ["mon", "tue", "wed", "thu", "fri"]
WEEKEND = ["sat", "sun"]

SAMPLES = [
    # (질문, 기대 조건 — 계약 16 §5-1 모양)
    (
        "강남에서 평일 저녁 살사 수업 찾아줘",
        _expected(genre="salsa_bachata", regionSido="서울", regionGu="강남구", weekdays=WEEKDAYS_ONLY, timeBand="evening"),
    ),
    (
        "마포구 주말 오후 스윙 수업 있어?",
        _expected(genre="swing", regionSido="서울", regionGu="마포구", weekdays=WEEKEND, timeBand="afternoon"),
    ),
    (
        "서울에서 저녁 7시부터 9시 사이 탱고 수업 알려줘",
        _expected(genre="argentine_tango", regionSido="서울", timeBand={"from": "19:00", "to": "21:00"}),
    ),
    (
        "홍대 근처 오전 바차타 수업 있나요",
        _expected(genre="salsa_bachata", regionSido="서울", regionGu="마포구", timeBand="morning"),
    ),
    (
        "부산 해운대구 라틴 댄스 수업 추천해줘",
        _expected(genre="dance_sport", regionSido="부산", regionGu="해운대구"),
    ),
]


@pytest.mark.anyio
@pytest.mark.skipif(not _llm_up(), reason="kdance-llm(11436) 이 꺼져 있다")
@pytest.mark.parametrize(
    ("question", "expected"),
    SAMPLES,
    ids=["gangnam-weekday-evening-salsa", "mapo-weekend-afternoon-swing", "seoul-19-21-tango", "hongdae-morning-bachata", "busan-latin"],
)
async def test_real_model_extracts_genre_region_time(question: str, expected: dict[str, Any]) -> None:
    settings = load_settings()
    client = OpenAICompatTextClient(base_url=settings.llm_base_url, model_name=settings.llm_chat_model)
    result = await extract_conditions(question, client=client)
    print(json.dumps({"question": question, "conditions": result.conditions, "elapsedMs": result.elapsed_ms}, ensure_ascii=False))
    assert result.conditions == expected
    assert result.needs_more is False
