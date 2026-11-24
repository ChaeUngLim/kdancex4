"""AI 플래너 질문 한 건 처리 — 조건 뽑기 → 이름 정하기 → 수업 검색 → 답 문장 (SX-5.8(말로 찾기 실동작·챗봇 대화형 AI 답변)).

처음 보는 사람용 요약
- `POST /v1/chat/stream`(계약 16 §3-2)이 이 함수를 부르고, 여기서 나온 이벤트를 SSE 로 Next.js 에 흘린다.
  Next.js 는 그것을 앱이 읽는 AI SDK 스트림으로 번역한다(ADR-005).
- 순서(이벤트 이름은 계약 §3-2 그대로):
    tier(T2) · stage(conditions) → 모델로 조건 뽑기(SX-5.2) → 앞 질문 조건 이어받기(follow_up)
    → stage(candidates) → `find_instructors`·`find_academies` 로 이름을 사람·학원 하나로 정하기(SX-5.1)
    → `search_offerings` 로 게시 수업 찾기(SX-5.3) → conditions · cards · sources
    → stage(writing) → 답 문장 2~4개(answer_writer, 결과 값만) → done
- 데이터는 MCP 읽기 도구로만 본다. 쓰기 도구는 없다(FR-214(AI 쓰기 금지)). 수업은 검색 결과 그대로 카드로 나가고,
  문장은 그 결과에 있는 값만 쓴다(FR-039).
- 첫 두 이벤트는 모델을 부르기 전에 바로 낸다 — Next.js 는 1.5초 안에 첫 이벤트가 없으면 일반 검색으로 바꾼다(SX-5.5).
"""

import asyncio
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from typing import Any, Protocol

from app.planner.answer_writer import count_sentence, write_details
from app.planner.condition_extractor import (
    CONDITION_KEYS,
    ConditionExtraction,
    ConditionExtractionFailedError,
    has_any_condition,
)
from app.planner.follow_up import carry_over
from app.planner.text_client import TextClient

Event = tuple[str, dict[str, Any]]

# 고정 문구 — 모델이 쓰지 않는다(FR-210)
NEED_MORE = "어떤 강사나 요일, 장르로 찾을지 조금 더 알려 주세요."
NO_RESULT = "조건에 맞는 수업을 찾지 못했어요."
SEARCH_LIMIT = 20
# 「모집 중」만 보라는 말(규칙, 모델 없음). 「진행 중」「수업 중인」은 거르지 않는다 — 검색 결과가 이미 지금 열려 있는
# 게시 수업뿐이라 마감된 수업도 「진행 중」이기 때문이다
OPEN_ONLY_WORDS = ("모집중", "신청가능", "자리있는", "자리가있는", "자리남은", "마감안된", "신청할수있는")
# 답 문장 쓰기에 남겨 둘 최소 시간. 남은 시간이 이보다 적으면 모델을 부르지 않고 틀 문장을 쓴다
MIN_WRITING_SECONDS = 2.0
# Next.js 의 전체 기한보다 조금 일찍 끝내도록 남기는 여유
DEADLINE_MARGIN_SECONDS = 1.5
# 조건 뽑기에 쓸 수 있는 가장 긴 시간. 뒤에 검색·답 쓰기 몫(약 4초)은 남긴다 — 넘기면 Next.js 가 일반 검색으로 대신 답한다
MAX_EXTRACT_SECONDS = 15.0
RESERVED_AFTER_EXTRACT_SECONDS = 4.0


class PlannerTools(Protocol):
    """읽기 도구 한 번 부르기. 결과는 계약 §6 모양 `{data, sources}` 사전."""

    async def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]: ...


class ToolCallFailedError(Exception):
    """도구가 오류(`isError`)를 돌려줬다. 코드만 담는다."""


@dataclass(frozen=True)
class PlannerRequest:
    message: str
    previous_conditions: dict[str, Any] | None
    fixed_instructor_id: str | None
    deadline_ms: int


@dataclass(frozen=True)
class PlannerDeps:
    extract: Callable[[str], Awaitable[ConditionExtraction]]
    open_tools: Callable[[], AbstractAsyncContextManager[PlannerTools]]
    writer: TextClient | None
    clock: Callable[[], float] = time.monotonic


def _text(sentence: str) -> Event:
    return ("text", {"sentence": sentence})


def _done(started: float, now: float, model_calls: int, tool_calls: int, fallback_used: bool) -> Event:
    total = int((now - started) * 1000)
    return (
        "done",
        {
            "metrics": {
                "tier": "T2",
                "waitMs": 0,
                "totalMs": total,
                "modelCalls": model_calls,
                "toolCalls": tool_calls,
                "degraded": False,
                "fallbackUsed": fallback_used,
            }
        },
    )


async def _resolve_names(tools: PlannerTools, conditions: dict[str, Any]) -> tuple[dict[str, Any], list[Event], int, bool]:
    """이름만 있는 강사·학원을 id 로 정한다. (새 조건, 먼저 낼 이벤트, 도구 호출 수, 여기서 답을 끝내야 하나)."""
    events: list[Event] = []
    calls = 0
    result = dict(conditions)
    academy = result.get("academy")
    # 학원 먼저 — 강사 이름 찾기에 학원 이름을 같이 넘겨 동명이인을 좁힌다
    if isinstance(academy, dict) and academy.get("name") and not academy.get("id"):
        found = await tools.call("find_academies", {"name": academy["name"], "limit": 5})
        calls += 1
        data = found.get("data") or {}
        resolved = data.get("resolved")
        if data.get("resolution") == "unique" and isinstance(resolved, dict):
            result["academy"] = {"name": resolved.get("name"), "id": resolved.get("academyId")}
        else:
            # 하나로 못 정하면 학원 조건을 빼고 찾는다 — 짐작해서 한 곳을 고르지 않는다
            reason = "같은 이름의 학원이 여러 곳이라" if data.get("resolution") == "ambiguous" else "그 이름의 학원을 찾지 못해"
            events.append(_text(f"{reason} 학원 조건은 빼고 찾았어요."))
            result["academy"] = None
    instructor = result.get("instructor")
    if isinstance(instructor, dict) and instructor.get("name") and not instructor.get("id"):
        query: dict[str, Any] = {"name": instructor["name"], "limit": 5}
        if isinstance(academy, dict) and academy.get("name"):
            query["academyName"] = academy["name"]
        found = await tools.call("find_instructors", query)
        calls += 1
        data = found.get("data") or {}
        resolved = data.get("resolved")
        if data.get("resolution") == "unique" and isinstance(resolved, dict):
            result["instructor"] = {"name": resolved.get("displayName"), "id": resolved.get("instructorId")}
        elif data.get("resolution") == "ambiguous":
            candidates = [c for c in data.get("candidates", []) if isinstance(c, dict)]
            events.extend(
                [
                    ("conditions", result),
                    ("cards", {"kind": "instructor_candidates", "items": candidates}),
                    _text(f"{instructor['name']} 강사님이 {len(candidates)}분 있어요. 어느 분인지 골라 주세요."),
                ]
            )
            return result, events, calls, True
        else:
            events.extend([("conditions", result), _text(f"{instructor['name']} 강사님을 찾지 못했어요. 이름을 다시 확인해 주세요.")])
            return result, events, calls, True
    return result, events, calls, False


def _has_search_condition(conditions: dict[str, Any]) -> bool:
    """계약 열한 칸 중 하나라도 있나. 「모집 중」만으로는 검색하지 않는다(search_offerings 가 거부한다)."""
    return has_any_condition({key: conditions.get(key) for key in CONDITION_KEYS})


def says_open_only(question: str) -> bool:
    compact = re.sub(r"\s+", "", question)
    return any(word in compact for word in OPEN_ONLY_WORDS)


def _search_input(conditions: dict[str, Any]) -> dict[str, Any]:
    """조건 → `search_offerings` 입력. 빈 배열은 빼고, 이름 칸은 id 와 함께 넘긴다. 계약 열한 칸 밖(모집 중 거르기)은 뺀다."""
    payload: dict[str, Any] = {
        key: value for key, value in conditions.items() if key in CONDITION_KEYS and value not in (None, [])
    }
    payload["limit"] = SEARCH_LIMIT
    return payload


async def run_planner(request: PlannerRequest, deps: PlannerDeps) -> AsyncIterator[Event]:
    """질문 한 건의 이벤트를 차례로 낸다. 실패는 `error` 이벤트로 닫는다(그 뒤 `done` 없음)."""
    started = deps.clock()
    deadline = started + request.deadline_ms / 1000 - DEADLINE_MARGIN_SECONDS
    yield ("tier", {"tier": "T2"})
    yield ("stage", {"name": "conditions"})

    extract_budget = min(MAX_EXTRACT_SECONDS, deadline - deps.clock() - RESERVED_AFTER_EXTRACT_SECONDS)
    try:
        extraction = await asyncio.wait_for(deps.extract(request.message), timeout=max(extract_budget, 0.1))
    except (ConditionExtractionFailedError, TimeoutError):
        # 모델이 조건을 못 뽑았다 — Next.js 가 일반 검색으로 대신 답한다(SX-5.5)
        yield ("error", {"code": "MODEL_UNAVAILABLE", "fallback": "plain_search"})
        return
    extracted = {**extraction.conditions, "recruitOpenOnly": True if says_open_only(request.message) else None}
    conditions = carry_over(extracted, request.previous_conditions, request.message, request.fixed_instructor_id)
    model_calls = 1
    if not _has_search_condition(conditions):
        yield _text(NEED_MORE)
        yield _done(started, deps.clock(), model_calls, 0, False)
        return

    yield ("stage", {"name": "candidates"})
    async with deps.open_tools() as tools:
        conditions, early, tool_calls, stop = await _resolve_names(tools, conditions)
        for event in early:
            yield event
        if stop:
            yield _done(started, deps.clock(), model_calls, tool_calls, False)
            return
        if not _has_search_condition(conditions):
            yield _text(NEED_MORE)
            yield _done(started, deps.clock(), model_calls, tool_calls, False)
            return
        found = await tools.call("search_offerings", _search_input(conditions))
        tool_calls += 1
    cards = [c for c in found.get("data") or [] if isinstance(c, dict)]
    if conditions.get("recruitOpenOnly"):
        # 「모집 중」 — 다 찬 수업(full)은 뺀다. 마감 임박(closing_soon)은 아직 신청할 수 있어 남긴다
        cards = [c for c in cards if c.get("recruitStatus") != "full"]
    kept_ids = {c.get("offeringId") or c.get("classId") for c in cards}
    sources = [s for s in found.get("sources") or [] if isinstance(s, dict) and s.get("id") in kept_ids]

    yield ("conditions", conditions)
    # 0건이어도 빈 카드 목록을 낸다 — Next.js 가 이것을 보고 결과 없음 버튼(SX-5.4)을 붙인다
    yield ("cards", {"kind": "offering_cards", "items": cards})
    if not cards:
        yield _text(NO_RESULT)
        yield _done(started, deps.clock(), model_calls, tool_calls, False)
        return
    yield ("sources", {"items": sources})

    # 첫 문장(몇 개 찾았나)은 고정 틀이라 바로 낸다 — 모델을 기다리는 동안에도 답이 흘러나오게
    yield _text(count_sentence(conditions, cards))
    yield ("stage", {"name": "writing"})
    remaining = deadline - deps.clock()
    written = await write_details(
        conditions,
        cards,
        client=deps.writer if remaining >= MIN_WRITING_SECONDS else None,
        timeout_seconds=remaining,
    )
    for sentence in written.sentences:
        yield _text(sentence)
    yield _done(started, deps.clock(), model_calls + written.model_calls, tool_calls, not written.used_model)
