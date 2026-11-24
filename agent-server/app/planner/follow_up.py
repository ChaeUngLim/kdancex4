"""이어 묻기 — 앞 질문 조건을 이어받아 좁힌다 (SX-5.8(말로 찾기 실동작·챗봇 대화형 AI 답변)).

처음 보는 사람용 요약
- 「이준호 강사 주말 수업 알려줘」 다음에 「그중 토요일만」이라고 물으면, 두 번째 질문에는 강사 이름이 없다.
  그래서 앞 답의 조건(강사 이준호, 토·일)을 받아 와 새로 말한 칸(토요일)만 바꾼다 → 강사 이준호 · 토요일.
- 앞 조건은 **앱 화면이 들고 있다가** 요청의 `context.previousConditions` 로 보낸다. 서버는 대화를 저장하지 않는다
  (2026-11-24 사용자 지시 「대화 맥락은 이 화면 안에서만, 서버 저장 없음」).
- 규칙은 셋이다.
  1) 새 질문이 **다른 강사**를 말하면 새 대화처럼 앞 조건을 버린다(「김하나 강사 수업은?」).
  2) 그 밖에는 새 질문이 채운 칸은 새 값, 비운 칸은 앞 값을 쓴다.
  3) 「모든 학원」「전체 학원」처럼 학원을 풀라는 말이 있으면 앞 학원을 이어받지 않는다.
- 강사 프로필(M15)에서 연 화면은 `context.instructorId` 로 강사가 정해져 있다. 새 질문에 강사 이름이 없으면 그 강사로 찾는다.
"""

import re
from typing import Any

from app.planner.condition_extractor import CONDITION_KEYS

# §5-1 열한 칸 밖에 이 Task 가 더한 칸 — 「모집 중」만 보기(검색 입력이 아니라 결과 거르기에 쓴다)
EXTRA_KEYS: tuple[str, ...] = ("recruitOpenOnly",)
# 학원 조건을 푸는 말(띄어쓰기를 지운 모양으로 찾는다)
_ALL_ACADEMY_WORDS = ("모든학원", "전체학원", "학원전체", "다른학원", "여러학원", "학원상관없이", "아무학원")


def _empty(value: Any) -> bool:
    return value is None or value == []


def _same_name(a: Any, b: Any) -> bool:
    return isinstance(a, dict) and isinstance(b, dict) and bool(a.get("name")) and a.get("name") == b.get("name")


def carry_over(
    new: dict[str, Any], previous: dict[str, Any] | None, question: str, fixed_instructor_id: str | None
) -> dict[str, Any]:
    """새 조건 + 앞 조건(+ 정해진 강사) → 이번에 찾을 조건. 입력 사전은 고치지 않고 새 사전을 돌려준다."""
    keys = (*CONDITION_KEYS, *EXTRA_KEYS)
    merged = {key: new.get(key) for key in keys}
    prev = previous or {}
    new_instructor = new.get("instructor")
    prev_instructor = prev.get("instructor")
    # 1) 다른 강사를 말했으면 앞 조건을 쓰지 않는다
    switched = new_instructor is not None and prev_instructor is not None and not _same_name(new_instructor, prev_instructor)
    if not switched:
        for key in keys:
            if _empty(merged[key]) and not _empty(prev.get(key)):
                merged[key] = prev[key]
        # 같은 강사 이름이면 앞에서 정한 id 를 그대로 쓴다(이름 찾기를 다시 하지 않게)
        if _same_name(new_instructor, prev_instructor) and isinstance(prev_instructor, dict):
            merged["instructor"] = {"name": prev_instructor.get("name"), "id": prev_instructor.get("id")}
    # 3) 학원을 풀라는 말
    if any(word in re.sub(r"\s+", "", question) for word in _ALL_ACADEMY_WORDS):
        merged["academy"] = None
    # 정해진 강사(M15 입구·M10G 선택): 새 질문이 다른 강사 이름을 말하지 않았으면 그 강사
    if fixed_instructor_id is not None and new_instructor is None:
        current = merged.get("instructor")
        name = current.get("name") if isinstance(current, dict) and current.get("id") == fixed_instructor_id else None
        merged["instructor"] = {"name": name, "id": fixed_instructor_id}
    return merged
