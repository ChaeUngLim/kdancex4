"""에이전트가 쓸 수 있는 MCP 읽기 도구 목록 (SX-1.2(MCP 읽기 도구)).

처음 보는 사람용 요약
- 에이전트 서버는 DB 에 붙지 않는다. 데이터는 Next.js 가 연 MCP 도구 서버
  (`POST /api/internal/mcp`)에 「이 도구 불러 줘」라고 해서만 받는다(ADR-004).
- 이 파일이 그 도구들의 **허용 목록**이다. 계약 `_workspace/03_contracts/16-ai-agent.md` §6 표와
  이름·입력이 1대1 로 같아야 하고, 전부 읽기다 — 쓰기 도구는 0개(FR-214(AI 쓰기 금지)).
- 입력 모양은 pydantic 모델로 적었다. Next.js 쪽은 같은 모양을 zod 로 적는다(계약 16 §6).
  신원(누구의 데이터인가)은 입력에 없다 — 토큰으로만 온다. 그래서 모든 모델이 모르는 칸을
  거부한다(`extra="forbid"`). `memberId` 를 끼워 넣어 남의 데이터를 달라는 시도를 여기서 먼저 막는다.

새 도구를 더하려면: 계약 §6 표에 먼저 적고, 여기 `READ_TOOLS` 에 같은 이름으로 더한다.
쓰기 도구(예약·취소·환불·결제·게시)는 계약이 금지하므로 더하지 않는다.
"""

from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class _ToolInput(BaseModel):
    """모든 도구 입력의 공통 바탕 — 모르는 칸은 거부하고, 만든 뒤엔 바꾸지 않는다."""

    model_config = ConfigDict(extra="forbid", frozen=True)


# 주문 상태 6종(데이터 모델 §4.1 orders.status, FR-298(주문 상태 6종))
OrderStatus = Literal["pending", "paid", "expired", "cancelled", "partially_refunded", "refunded"]
Weekday = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


class GetMyReservationsInput(_ToolInput):
    scope: Literal["upcoming", "past", "all"]
    limit: int = Field(ge=1, le=20)


class GetMyOrdersInput(_ToolInput):
    status: OrderStatus | None = None
    limit: int = Field(ge=1, le=20)


class GetMyScheduleInput(_ToolInput):
    # KST 날짜. 31일 이내 제한은 도구 서버가 판정한다(기간 계산 기준이 서버 쪽이라서).
    from_: date = Field(alias="from")
    to: date


class GetRefundPreviewInput(_ToolInput):
    reservationId: UUID


class GetMyWaitlistInput(_ToolInput):
    offeringId: UUID | None = None


class _NameRef(_ToolInput):
    name: str | None = None
    id: UUID | None = None


class _TimeRange(_ToolInput):
    from_: str = Field(alias="from", pattern=r"^\d{2}:\d{2}$")
    to: str = Field(pattern=r"^\d{2}:\d{2}$")


class SearchOfferingsInput(_ToolInput):
    """계약 16 §5-1 검색 조건 + limit. 비워 둔 칸은 null."""

    instructor: _NameRef | None = None
    academy: _NameRef | None = None
    genre: str | None = None
    weekdays: list[Weekday] | None = None
    timeBand: Literal["morning", "afternoon", "evening"] | _TimeRange | None = None
    level: str | None = None
    regionSido: str | None = None
    regionGu: str | None = None
    maxPriceAmount: int | None = Field(default=None, ge=0)
    dateFrom: date | None = None
    dateTo: date | None = None
    limit: int = Field(ge=1, le=20)


class FindInstructorsInput(_ToolInput):
    name: str = Field(min_length=1)
    academyName: str | None = None
    limit: int = Field(ge=1, le=5)


class FindAcademiesInput(_ToolInput):
    name: str = Field(min_length=1)
    limit: int = Field(ge=1, le=5)


class GetOfferingDetailInput(_ToolInput):
    offeringId: UUID


class GetAcademyInfoInput(_ToolInput):
    academyId: UUID


class GetPolicyTextInput(_ToolInput):
    kind: Literal["terms", "privacy", "refund_notice", "membership_plan"]
    academyId: UUID | None = None


class SearchKnowledgeInput(_ToolInput):
    # 질의 벡터는 에이전트 서버가 임베딩 호출로 만든다 — 도구 서버는 모델을 부르지 않는다(계약 16 §6).
    queryEmbedding: list[float] = Field(min_length=1)
    academyId: UUID | None = None
    topK: int = Field(ge=1, le=20)


@dataclass(frozen=True)
class ReadToolSpec:
    """도구 하나의 정의: 이름 · 설명 · 입력 모양 · 테스트용 예시 입력."""

    name: str
    description: str
    input_model: type[_ToolInput]
    example_input: dict[str, Any] = field(default_factory=dict)


_UUID = "00000000-0000-4000-8000-000000000001"

# 계약 16 §6 「도구 목록」 표와 같은 순서·같은 이름. 전부 읽기다.
READ_TOOLS: tuple[ReadToolSpec, ...] = (
    ReadToolSpec(
        "get_my_reservations",
        "내 예약 목록(다가오는·지난·전체)",
        GetMyReservationsInput,
        {"scope": "upcoming", "limit": 5},
    ),
    ReadToolSpec("get_my_orders", "내 주문 목록", GetMyOrdersInput, {"limit": 5}),
    ReadToolSpec(
        "get_my_schedule",
        "내 수업 일정(KST, 31일 이내) — 일정 충돌 검사 재료",
        GetMyScheduleInput,
        {"from": "2026-12-01", "to": "2026-12-31"},
    ),
    ReadToolSpec(
        "get_refund_preview",
        "취소하면 돌려받을 금액 미리보기(취소 미리보기와 같은 계산)",
        GetRefundPreviewInput,
        {"reservationId": _UUID},
    ),
    ReadToolSpec("get_my_waitlist", "내 대기 순번", GetMyWaitlistInput, {}),
    ReadToolSpec(
        "search_offerings",
        "공개된 수업 검색(승인·입점·판매 중만)",
        SearchOfferingsInput,
        {"weekdays": ["sat"], "timeBand": "morning", "limit": 10},
    ),
    ReadToolSpec(
        "find_instructors",
        "강사 이름으로 후보 찾기(같은 이름이 여럿이면 ambiguous)",
        FindInstructorsInput,
        {"name": "이준호", "limit": 5},
    ),
    ReadToolSpec("find_academies", "학원 이름으로 후보 찾기", FindAcademiesInput, {"name": "라틴하우스", "limit": 5}),
    ReadToolSpec("get_offering_detail", "수업 상세의 읽기 부분", GetOfferingDetailInput, {"offeringId": _UUID}),
    ReadToolSpec("get_academy_info", "학원 정보·공지·휴무", GetAcademyInfoInput, {"academyId": _UUID}),
    ReadToolSpec("get_policy_text", "약관·환불 정책·요금제 현재 판본 본문", GetPolicyTextInput, {"kind": "terms"}),
    ReadToolSpec(
        "search_knowledge",
        "승인된 지식(active)에서 비슷한 질문 찾기",
        SearchKnowledgeInput,
        {"queryEmbedding": [0.1, 0.2], "topK": 3},
    ),
)

READ_TOOL_NAMES: frozenset[str] = frozenset(spec.name for spec in READ_TOOLS)
READ_TOOLS_BY_NAME: dict[str, ReadToolSpec] = {spec.name: spec for spec in READ_TOOLS}
