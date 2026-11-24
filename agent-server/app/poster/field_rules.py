"""포스터 읽기(SX-2(포스터 읽기·수업 초안))의 칸 규칙 — 어떤 칸이 있고, 각 칸에 어떤 값이 들어갈 수 있나.

처음 보는 사람용 요약
- 대표가 수업 포스터를 올리면 AI 가 수업 등록 양식의 칸(장르·제목·요일·시간·가격·정원 …)을 미리
  채운다(FR-073(포스터 자동 추출)). 칸 이름과 값 모양은 계약 16 §4-6 「칸 키」 그대로다.
- 이 파일은 칸마다 두 가지를 정한다.
  ① 모델에게 줄 **JSON 스키마 조각** — llama-server 가 이 모양 밖의 글자를 아예 못 내게 막는다
     (`response_format: json_schema`, 계약 16 §7-1).
  ② 모델 답을 한 번 더 거르는 **검증 함수** — 스키마를 통과해도 형식이 어긋나면(예: 끝 시간 25:00)
     값을 버리고 「못 읽음」(`None`)으로 둔다. 그러면 Next.js 가 그 칸에 「확인필요」를 붙인다(FR-075).
- 값 목록(장르·세부 장르·레벨·수업 구분)은 admin-web `lib/domain/constants.ts` 와 같은 글자를 쓴다.
  DB 에 들어갈 값이므로 한 글자라도 다르면 S2-2(수업 등록) 경로가 거부한다.
- 기간 칸 3개(개강일 `start_date` · 종료일 `end_date` · 회차 수 `session_count`)는 2026-11-24 에 더했다
  (SX-2.6, spec FR-073 하위 불릿). 기간이 없으면 수업을 게시할 수 없는데, 포스터에서 읽지 못하면
  검토 화면이 그 칸을 「확인필요」 빈 칸으로 보이고 채울 때까지 제출을 막는다.
"""

import re
from datetime import date
from collections.abc import Callable
from typing import Any

# 칸 키 — 계약 16 §4-6 의 순서 그대로(O2 화면의 칸 순서와 같다)
POSTER_FIELD_KEYS: tuple[str, ...] = (
    "genre",
    "genre_detail",
    "title",
    "weekday",
    "start_time",
    "end_time",
    "start_date",
    "end_date",
    "session_count",
    "room_name",
    "price_amount",
    "capacity_male",
    "capacity_female",
    "capacity_total",
    "instructor_name",
    "level",
    "class_kind",
)

# 값 목록 — admin-web lib/domain/constants.ts 의 GENRES · CLASS_SUB_GENRES · CLASS_TARGET_LEVELS · CLASS_KINDS
GENRES = ("dance_sport", "argentine_tango", "swing", "salsa_bachata")
SUB_GENRES = ("latin", "standard", "salsa", "bachata")
TARGET_LEVELS = ("entry", "beginner", "novice_intermediate", "intermediate", "advanced")
CLASS_KINDS = (
    "regular",
    "private_lesson",
    "basic",
    "lady_style",
    "one_day",
    "event",
    "party",
    "performance",
    "competition",
)
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

# 글자 칸의 최대 길이 — 포스터 문장을 통째로 칸에 넣는 일을 막는다
_TEXT_MAX = 80
# 「HH:MM」 24시간 표기(KST). 계약 16 §4-6
_TIME_PATTERN = r"^([01][0-9]|2[0-3]):[0-5][0-9]$"
_TIME_RE = re.compile(_TIME_PATTERN)
# 가격·정원의 위쪽 한계 — 자릿수를 잘못 읽은 값(예: 1800000000)을 「못 읽음」으로 돌린다
_PRICE_MAX = 10_000_000
_CAPACITY_MAX = 500
# 회차 수 상한 — admin-web recurring-schedule.ts 의 MAX_RECURRING_SESSIONS(계약 11 §4-1 「회차 수 1~200」)와 같은 수
_SESSION_MAX = 200
# 「YYYY-MM-DD」 날짜(KST 달력). 연도까지 적힌 날짜만 받는다 — 연도를 지어내면 엉뚱한 해에 수업이 잡힌다
_DATE_PATTERN = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
_DATE_RE = re.compile(_DATE_PATTERN)
# 받아 줄 연도 범위 — 「1926」 처럼 자릿수를 잘못 읽은 해를 「못 읽음」으로 돌린다
_YEAR_MIN = 2020
_YEAR_MAX = 2100


def _nullable(schema: dict[str, Any]) -> dict[str, Any]:
    """「값이 있으면 이 모양, 없으면 null」 스키마. 포스터에 없는 칸은 모델이 null 을 낸다."""
    return {"anyOf": [schema, {"type": "null"}]}


def _enum(values: tuple[str, ...]) -> dict[str, Any]:
    return _nullable({"type": "string", "enum": list(values)})


def _text() -> dict[str, Any]:
    return _nullable({"type": "string", "minLength": 1, "maxLength": _TEXT_MAX})


def _time() -> dict[str, Any]:
    return _nullable({"type": "string", "pattern": _TIME_PATTERN})


def _date() -> dict[str, Any]:
    return _nullable({"type": "string", "pattern": _DATE_PATTERN})


def _int(minimum: int, maximum: int) -> dict[str, Any]:
    return _nullable({"type": "integer", "minimum": minimum, "maximum": maximum})


# 칸별 값 스키마(모델이 낼 수 있는 모양)
FIELD_VALUE_SCHEMAS: dict[str, dict[str, Any]] = {
    "genre": _enum(GENRES),
    "genre_detail": _enum(SUB_GENRES),
    "title": _text(),
    "weekday": _nullable(
        {"type": "array", "items": {"type": "string", "enum": list(WEEKDAYS)}, "minItems": 1, "maxItems": 7}
    ),
    "start_time": _time(),
    "end_time": _time(),
    "start_date": _date(),
    "end_date": _date(),
    "session_count": _int(1, _SESSION_MAX),
    "room_name": _text(),
    "price_amount": _int(0, _PRICE_MAX),
    "capacity_male": _int(1, _CAPACITY_MAX),
    "capacity_female": _int(1, _CAPACITY_MAX),
    "capacity_total": _int(1, _CAPACITY_MAX),
    "instructor_name": _text(),
    "level": _enum(TARGET_LEVELS),
    "class_kind": _enum(CLASS_KINDS),
}

# 모델에게 칸 뜻을 알려 주는 한 줄 설명(프롬프트에 넣는다). 한글 이름 → 값 대응을 적어 둔다
FIELD_HINTS: dict[str, str] = {
    "genre": "장르. 댄스스포츠=dance_sport, 아르헨티나 탱고=argentine_tango, 스윙=swing, 살사·바차타=salsa_bachata",
    "genre_detail": "세부 장르. 라틴=latin, 스탠다드=standard, 살사=salsa, 바차타=bachata",
    "title": "수업 제목(포스터에 크게 적힌 이름 그대로)",
    "weekday": "수업 요일 배열. 월=mon 화=tue 수=wed 목=thu 금=fri 토=sat 일=sun",
    "start_time": "시작 시각 HH:MM(24시간). 오후 7시=19:00",
    "end_time": "끝 시각 HH:MM(24시간)",
    "start_date": "개강일(첫 수업 날짜) YYYY-MM-DD. 포스터에 연도까지 적혀 있을 때만, 연도가 없으면 null",
    "end_date": "종료일(마지막 수업 날짜) YYYY-MM-DD. 포스터에 연도까지 적혀 있을 때만, 연도가 없으면 null",
    "session_count": "총 회차 수(정수). 「4주」「8회」처럼 적혀 있을 때. 4주 과정이고 주 1회면 4",
    "room_name": "장소·홀 이름",
    "price_amount": "수강료(원, 쉼표 없는 정수). 180,000원=180000",
    "capacity_male": "남자 정원(명, 정수)",
    "capacity_female": "여자 정원(명, 정수)",
    "capacity_total": "전체 정원(명, 정수). 포스터에 전체 정원이 따로 적혀 있을 때만",
    "instructor_name": "강사 이름",
    "level": "대상 레벨. 입문=entry, 초급=beginner, 초중급=novice_intermediate, 중급=intermediate, 고급=advanced",
    "class_kind": "수업 구분. 정규=regular, 개인 레슨=private_lesson, 베이직=basic, 레이디 스타일=lady_style, "
    "원데이=one_day, 이벤트=event, 파티=party, 공연=performance, 대회=competition",
}


def _check_enum(values: tuple[str, ...]) -> Callable[[Any], Any]:
    def check(value: Any) -> Any:
        return value if isinstance(value, str) and value in values else None

    return check


def _check_text(value: Any) -> Any:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text if 0 < len(text) <= _TEXT_MAX else None


def _check_time(value: Any) -> Any:
    return value if isinstance(value, str) and _TIME_RE.match(value) else None


def _check_date(value: Any) -> Any:
    """「YYYY-MM-DD」 이고 달력에 있는 날(2월 30일 같은 날은 버린다)이며 연도가 범위 안이면 그대로."""
    if not isinstance(value, str) or not _DATE_RE.match(value):
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    return value if _YEAR_MIN <= parsed.year <= _YEAR_MAX else None


def _check_int(minimum: int, maximum: int) -> Callable[[Any], Any]:
    def check(value: Any) -> Any:
        # bool 은 int 의 하위 타입이라 True 가 1 로 통과하지 않게 따로 막는다
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        return value if minimum <= value <= maximum else None

    return check


def _check_weekdays(value: Any) -> Any:
    if not isinstance(value, list) or not value:
        return None
    if not all(isinstance(day, str) and day in WEEKDAYS for day in value):
        return None
    # 같은 요일이 두 번 오면 한 번만, 순서는 월→일로 맞춘다(화면 표시 순서)
    return [day for day in WEEKDAYS if day in value]


_CHECKERS: dict[str, Callable[[Any], Any]] = {
    "genre": _check_enum(GENRES),
    "genre_detail": _check_enum(SUB_GENRES),
    "title": _check_text,
    "weekday": _check_weekdays,
    "start_time": _check_time,
    "end_time": _check_time,
    "start_date": _check_date,
    "end_date": _check_date,
    "session_count": _check_int(1, _SESSION_MAX),
    "room_name": _check_text,
    "price_amount": _check_int(0, _PRICE_MAX),
    "capacity_male": _check_int(1, _CAPACITY_MAX),
    "capacity_female": _check_int(1, _CAPACITY_MAX),
    "capacity_total": _check_int(1, _CAPACITY_MAX),
    "instructor_name": _check_text,
    "level": _check_enum(TARGET_LEVELS),
    "class_kind": _check_enum(CLASS_KINDS),
}


def normalize_field_value(key: str, value: Any) -> Any:
    """칸 하나의 값을 칸 규칙으로 거른다. 규칙에 맞으면 다듬은 값, 아니면 None(「못 읽음」).

    None 이 된 칸은 신뢰도도 None 으로 두어 Next.js 가 「확인필요」를 붙이게 한다(FR-075).
    """
    if value is None:
        return None
    return _CHECKERS[key](value)
