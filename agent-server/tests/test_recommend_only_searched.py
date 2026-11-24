"""있는 수업만 추천 테스트 (SX-4.2(있는 수업만 추천)).

무엇을 보나
- 추천 카드는 검색 결과(`search_offerings`) 카드 안에서만 나온다 — 모델이 목록 밖 번호·겹친 번호를 내도 버린다(SC-011).
- 정원 마감·내 일정과 시간 겹침·중복·id 없음 카드는 모델 앞에서 규칙으로 뺀다(FR-038).
- 모든 추천에는 근거 문장과 출처가 붙고, 근거는 카드와 회원 취향이 실제로 맞는 것만 말한다(FR-040).
- 모델이 실패·지연하면 규칙 순서로 대신 고른다. 회원 질문 원문은 모델에게 가지 않는다(FR-270).
"""

from datetime import datetime
from typing import Any

import pytest

from app.planner.recommender import (
    BusySlot,
    MemberTaste,
    check_candidates,
    keep_only_searched,
    overlaps_busy,
    reason_for,
    recommend,
    taste_from_context,
)
from app.planner.text_client import TextModelError


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _card(offering_id: str, **fields: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "offeringId": offering_id,
        "classId": f"class-{offering_id}",
        "title": "바차타 커플반",
        "genre": "salsa_bachata",
        "isPrivateLesson": False,
        "academy": {"id": "acad-1", "name": "라틴하우스 강남"},
        "hall": "B홀",
        "pattern": [{"weekday": "thu", "startTime": "21:00", "endTime": "22:00"}],
        "firstSessionDate": "2026-12-03",
        "lastSessionDate": "2026-12-24",
        "sessionCount": 4,
        "level": "beginner",
        "pools": [{"seatKind": "male", "remaining": 2}],
        "priceAmount": 140000,
        "recruitStatus": "open",
        "waitlistAvailable": False,
        "action": {"type": "open_offering", "offeringId": offering_id},
    }
    base.update(fields)
    return base


TASTE = MemberTaste(genres=("salsa_bachata",), time_bands=("evening",), weekdays=("thu", "fri"), level="beginner")


class FakePicker:
    model_name = "fake"

    def __init__(self, answer: str | Exception) -> None:
        self._answer = answer
        self.prompts: list[str] = []

    async def complete_json(self, **kwargs: Any) -> str:
        self.prompts.append(kwargs["user_prompt"] + kwargs["system_prompt"])
        if isinstance(self._answer, Exception):
            raise self._answer
        return self._answer


@pytest.mark.anyio
async def test_model_numbers_outside_list_are_dropped() -> None:
    cards = [_card("o-1"), _card("o-2", title="살사 입문반")]
    client = FakePicker('{"picks": [7, 2, 2, 0, -1, 1]}')
    result = await recommend(cards, TASTE, {}, client=client, timeout_seconds=5)
    assert [i["offeringId"] for i in result.items] == ["o-2", "o-1"]
    # 7·0·-1(목록 밖) 셋, 겹친 2 하나
    assert result.dropped_unknown_picks == 4
    assert result.dropped_not_searched == 0
    assert {i["offeringId"] for i in result.items} <= result.searched_ids


@pytest.mark.anyio
async def test_model_never_sees_ids_or_member_question() -> None:
    cards = [_card("6f1c2b7e-0000-4000-8000-000000000001")]
    client = FakePicker('{"picks": [1]}')
    await recommend(cards, TASTE, {"genre": "salsa_bachata"}, client=client, timeout_seconds=5)
    assert "6f1c2b7e" not in client.prompts[0]


@pytest.mark.anyio
async def test_every_recommendation_has_reason_and_sources() -> None:
    cards = [_card("o-1"), _card("o-2", genre="swing", title="린디합 기초", pattern=[{"weekday": "sat", "startTime": "14:00", "endTime": "15:30"}], level="entry")]
    result = await recommend(cards, TASTE, {}, client=None, timeout_seconds=0)
    assert len(result.items) == 2
    for item in result.items:
        assert item["reason"].strip()
        assert item["reasonSources"]
    first = result.items[0]
    # 규칙 순서: 취향과 많이 맞는 o-1 이 먼저
    assert first["offeringId"] == "o-1"
    assert "관심 장르(살사/바차타)" in first["reason"]
    assert {"kind": "profile", "label": "가입 때 고른 관심 장르"} in first["reasonSources"]
    # 하나도 안 맞는 카드는 지어낸 취향 근거 대신 질문 조건·모집 상태를 근거로 쓴다
    assert "관심 장르" not in result.items[1]["reason"]
    assert result.items[1]["reasonSources"][0]["kind"] == "conditions"


def test_reason_mentions_only_true_matches() -> None:
    card = _card("o-1", level="advanced", pattern=[{"weekday": "sat", "startTime": "11:00", "endTime": "12:30"}])
    reason, sources = reason_for(card, TASTE, {})
    assert reason == "관심 장르(살사/바차타)에 맞아요."
    assert sources == [{"kind": "profile", "label": "가입 때 고른 관심 장르"}]


def test_rule_check_removes_full_duplicate_conflict_and_missing_id() -> None:
    busy = MemberTaste(busy=(BusySlot(datetime.fromisoformat("2026-12-10T21:30:00+09:00"), datetime.fromisoformat("2026-12-10T22:30:00+09:00")),))
    cards = [
        _card("o-1"),  # 12-10(목) 21:00–22:00 와 겹침
        _card("o-2", pattern=[{"weekday": "fri", "startTime": "19:00", "endTime": "20:00"}]),
        _card("o-2"),
        _card("o-3", recruitStatus="full", pattern=[{"weekday": "mon", "startTime": "19:00", "endTime": "20:00"}]),
        _card("", title="id 없음"),
    ]
    checked = check_candidates(cards, busy)
    assert [c["offeringId"] for c in checked.kept] == ["o-2"]
    assert sorted(r.reason for r in checked.rejected) == ["duplicate", "full", "invalid_id", "time_conflict"]


def test_busy_outside_period_or_touching_edges_is_not_conflict() -> None:
    card = _card("o-1")
    before = BusySlot(datetime.fromisoformat("2026-11-26T21:00:00+09:00"), datetime.fromisoformat("2026-11-26T22:00:00+09:00"))
    touching = BusySlot(datetime.fromisoformat("2026-12-10T20:00:00+09:00"), datetime.fromisoformat("2026-12-10T21:00:00+09:00"))
    assert not overlaps_busy(card, (before,))
    assert not overlaps_busy(card, (touching,))


@pytest.mark.anyio
@pytest.mark.parametrize("answer", [TextModelError("down"), "not json", '{"picks": "1"}', '{"picks": [99]}'])
async def test_model_failure_falls_back_to_rule_order(answer: str | Exception) -> None:
    cards = [_card("o-1", genre="swing"), _card("o-2")]
    result = await recommend(cards, TASTE, {}, client=FakePicker(answer), timeout_seconds=5)
    assert not result.used_model
    assert [i["offeringId"] for i in result.items] == ["o-2", "o-1"]


@pytest.mark.anyio
async def test_empty_search_means_no_recommendation_and_no_model_call() -> None:
    client = FakePicker('{"picks": [1]}')
    result = await recommend([], TASTE, {}, client=client, timeout_seconds=5)
    assert result.items == []
    assert result.model_calls == 0
    assert client.prompts == []


def test_final_guard_drops_ids_not_in_search() -> None:
    kept, dropped = keep_only_searched([{"offeringId": "o-1"}, {"offeringId": "ghost"}], frozenset({"o-1"}))
    assert kept == [{"offeringId": "o-1"}]
    assert dropped == 1


def test_recommend_does_not_mutate_search_cards() -> None:
    card = _card("o-1")
    before = dict(card)
    import asyncio

    asyncio.run(recommend([card], TASTE, {}, client=None, timeout_seconds=0))
    assert card == before


def test_taste_from_context_filters_unknown_values() -> None:
    taste = taste_from_context(
        {
            "genres": ["salsa_bachata", "kpop"],
            "timeBands": ["evening", "midnight"],
            "weekdays": ["thu", "holiday"],
            "level": "god",
            "schedule": [{"startsAt": "2026-12-10T21:00:00+09:00", "endsAt": "2026-12-10T22:00:00+09:00"}, {"startsAt": "bad"}],
        }
    )
    assert taste.genres == ("salsa_bachata",)
    assert taste.time_bands == ("evening",)
    assert taste.weekdays == ("thu",)
    assert taste.level is None
    assert len(taste.busy) == 1


def test_eval_checker_catches_ghost_missing_reason_and_excluded() -> None:
    """평가 실행기의 검사가 실제로 실패를 잡는가 — 못 잡는 검사기는 검사기가 아니다."""
    import importlib.util
    from pathlib import Path

    spec = importlib.util.spec_from_file_location("run_eval", Path(__file__).resolve().parent.parent / "eval" / "run_eval.py")
    assert spec and spec.loader
    run_eval = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(run_eval)
    item = {"expect": {"language": "ko", "mustExclude": ["o-2"], "maxItems": 1}, "forbid": {"phrases": ["결제해 드"]}}
    search = [_card("o-1"), _card("o-2")]
    bad = [
        {"offeringId": "ghost", "reason": "좋아요.", "reasonSources": [{"kind": "profile", "label": "x"}]},
        {"offeringId": "o-2", "reason": "", "reasonSources": []},
        {"offeringId": "o-1", "reason": "Salsa 결제해 드릴게요", "reasonSources": []},
    ]
    problems = run_eval.check_recommend(item, search, bad)
    joined = " / ".join(problems)
    for expected in ("없는 수업 추천 1건", "근거 문장 없음", "근거 출처 없음", "한국어가 아닌", "금지 문구", "빼야 할 수업", "최대 1개"):
        assert expected in joined
    good = [{"offeringId": "o-1", "reason": "관심 장르(살사/바차타)에 맞아요.", "reasonSources": [{"kind": "profile", "label": "가입 때 고른 관심 장르"}]}]
    assert run_eval.check_recommend(item, search, good) == []
