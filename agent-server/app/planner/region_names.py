"""말로 한 지역 → 학원 표의 지역 낱말 (SX-4.1(조건 추출)).

처음 보는 사람용 요약
- 학원 표는 지역을 `region_sido`(예 「서울」)·`region_gu`(예 「강남구」) 두 칸에 **짧은 정식 이름**으로 둔다.
  수업 검색(S3-2 · `searchOfferingCards`)은 이 두 칸을 글자 그대로 비교한다.
- 그런데 회원은 「강남에서」「서울특별시」「홍대 근처」처럼 말한다. 그대로 넘기면 아무 수업도 안 나온다.
  그래서 이 파일이 말한 지역을 학원 표의 낱말로 맞춘다. **모델을 부르지 않는 표 찾기**다.

왜 표로 했나
- 지역 이름은 정해진 목록이라 모델이 짐작할 일이 아니다. 표로 하면 같은 말은 늘 같은 낱말이 된다.
- 표는 특별·광역시의 구·군과 경기도의 시·군까지 담았다. 그 밖의 도는 시·도만 알아본다(추천안 — 회원이
  늘면 표를 넓힌다). 표에 없는 「○○구·○○시」는 모델이 내고 질문에 그 글자가 있을 때만 받는다.
- 여러 도시에 같은 이름이 있는 구(중구·동구·강서구 …)는 시·도를 말하지 않으면 시·도를 비운다. 짐작으로 엉뚱한
  도시 수업을 내지 않기 위해서다.
- 짧게 부른 이름(「강남」→강남구)은 받되, 다른 뜻으로 흔한 낱말(「동작」=춤 동작, 「수영」, 「연수」, 「이천(원)」
  …)은 짧은 이름으로 받지 않는다. 춤 수업 질문에서 「동작」을 동작구로 읽으면 안 된다.
"""

import re
from dataclasses import dataclass

# 시·도 정식 이름(학원 표 값) → 회원이 쓰는 다른 이름들
SIDO_ALIASES: dict[str, tuple[str, ...]] = {
    "서울": ("서울특별시", "서울시", "서울"),
    "부산": ("부산광역시", "부산시", "부산"),
    "대구": ("대구광역시", "대구시", "대구"),
    "인천": ("인천광역시", "인천시", "인천"),
    "광주": ("광주광역시", "광주"),
    "대전": ("대전광역시", "대전시", "대전"),
    "울산": ("울산광역시", "울산시", "울산"),
    "세종": ("세종특별자치시", "세종시", "세종"),
    "경기": ("경기도", "경기"),
    "강원": ("강원특별자치도", "강원도", "강원"),
    "충북": ("충청북도", "충북"),
    "충남": ("충청남도", "충남"),
    "전북": ("전북특별자치도", "전라북도", "전북"),
    "전남": ("전라남도", "전남"),
    "경북": ("경상북도", "경북"),
    "경남": ("경상남도", "경남"),
    "제주": ("제주특별자치도", "제주도", "제주"),
}

# 시·도마다 구·군·시 정식 이름. 경기는 시·군이다
GU_BY_SIDO: dict[str, tuple[str, ...]] = {
    "서울": (
        "종로구", "중구", "용산구", "성동구", "광진구", "동대문구", "중랑구", "성북구", "강북구", "도봉구",
        "노원구", "은평구", "서대문구", "마포구", "양천구", "강서구", "구로구", "금천구", "영등포구", "동작구",
        "관악구", "서초구", "강남구", "송파구", "강동구",
    ),
    "부산": (
        "중구", "서구", "동구", "영도구", "부산진구", "동래구", "남구", "북구", "해운대구", "사하구",
        "금정구", "강서구", "연제구", "수영구", "사상구", "기장군",
    ),
    "대구": ("중구", "동구", "서구", "남구", "북구", "수성구", "달서구", "달성군", "군위군"),
    "인천": ("중구", "동구", "미추홀구", "연수구", "남동구", "부평구", "계양구", "서구", "강화군", "옹진군"),
    "광주": ("동구", "서구", "남구", "북구", "광산구"),
    "대전": ("동구", "중구", "서구", "유성구", "대덕구"),
    "울산": ("중구", "남구", "동구", "북구", "울주군"),
    "경기": (
        "수원시", "성남시", "고양시", "용인시", "부천시", "안산시", "안양시", "남양주시", "화성시", "평택시",
        "의정부시", "시흥시", "파주시", "김포시", "광명시", "광주시", "군포시", "하남시", "오산시", "이천시",
        "안성시", "의왕시", "양주시", "구리시", "포천시", "동두천시", "과천시", "여주시", "양평군", "가평군", "연천군",
    ),
}

# 짧은 이름으로 받지 않는 것 — 다른 뜻으로 흔하거나 시·도 이름과 겹친다
SHORT_NAME_BLOCKLIST = frozenset({"동작", "수영", "연수", "사상", "달성", "강화", "이천", "남동", "광주"})

# 자주 쓰는 동네 이름 → (시·도, 구). 추천안 — 춤 학원이 모인 동네 위주로 시작한다
NEIGHBORHOODS: dict[str, tuple[str, str]] = {
    "홍대": ("서울", "마포구"),
    "합정": ("서울", "마포구"),
    "망원": ("서울", "마포구"),
    "연남": ("서울", "마포구"),
    "신촌": ("서울", "서대문구"),
    "건대": ("서울", "광진구"),
    "성수": ("서울", "성동구"),
    "잠실": ("서울", "송파구"),
    "강남역": ("서울", "강남구"),
    "압구정": ("서울", "강남구"),
    "역삼": ("서울", "강남구"),
    "선릉": ("서울", "강남구"),
    "이태원": ("서울", "용산구"),
    "여의도": ("서울", "영등포구"),
    "종각": ("서울", "종로구"),
    "혜화": ("서울", "종로구"),
    "대학로": ("서울", "종로구"),
    "서면": ("부산", "부산진구"),
}

GU_SUFFIXES = ("구", "군", "시")


@dataclass(frozen=True)
class _Place:
    """찾는 말 하나가 가리키는 곳. `sidos` 가 둘 이상이면 시·도를 짐작하지 않는다."""

    gu: str | None
    sidos: tuple[str, ...]


def _build_place_index() -> dict[str, _Place]:
    """찾는 말(정식 구 이름·짧은 이름·동네 이름) → 그 곳. 표에서 한 번만 만든다."""
    sidos_by_gu: dict[str, list[str]] = {}
    for sido, gus in GU_BY_SIDO.items():
        for gu in gus:
            sidos_by_gu.setdefault(gu, []).append(sido)
    index: dict[str, _Place] = {gu: _Place(gu, tuple(sidos)) for gu, sidos in sidos_by_gu.items()}
    sido_words = {word for words in SIDO_ALIASES.values() for word in words}
    for gu, sidos in sidos_by_gu.items():
        short = gu[:-1]
        # 「중구」→「중」처럼 한 글자가 되는 것, 막은 낱말, 시·도 이름과 같은 것은 짧은 이름으로 받지 않는다
        if len(short) >= 2 and short not in SHORT_NAME_BLOCKLIST and short not in sido_words and short not in index:
            index[short] = _Place(gu, tuple(sidos))
    for word, (sido, gu) in NEIGHBORHOODS.items():
        index[word] = _Place(gu, (sido,))
    return index


_PLACES = _build_place_index()
_SIDO_BY_WORD = {word: sido for sido, words in SIDO_ALIASES.items() for word in words}


def _alternation(words: list[str]) -> re.Pattern[str]:
    # 긴 말부터 맞춘다 — 「강남구」 안의 「남구」, 「서울특별시」 안의 「서울」을 먼저 잡지 않게
    return re.compile("|".join(re.escape(word) for word in sorted(words, key=len, reverse=True)))


_PLACE_PATTERN = _alternation(list(_PLACES))
_SIDO_PATTERN = _alternation(list(_SIDO_BY_WORD))


def _compact(text: str) -> str:
    return re.sub(r"\s+", "", text)


def _infer_sido(place: _Place | None) -> str | None:
    # 한 시·도에만 있는 구라야 시·도를 채운다(「강남구」→서울). 「중구」처럼 여럿이면 비운다
    if place is not None and len(place.sidos) == 1:
        return place.sidos[0]
    return None


def find_region(text: str) -> tuple[str | None, str | None]:
    """글에서 지역 낱말을 찾아 (시·도, 구) 로 돌려준다. 여러 곳을 말하면 앞의 것 하나만 쓴다.

    구를 먼저 찾고 그 글자를 지운 뒤 시·도를 찾는다 — 「광주시」(경기)의 「광주」를 광주광역시로 읽지 않게.
    """
    place: _Place | None = None
    rest = text
    match = _PLACE_PATTERN.search(text)
    if match:
        place = _PLACES[match.group(0)]
        rest = text[: match.start()] + " " + text[match.end() :]
    sido_match = _SIDO_PATTERN.search(rest)
    sido = _SIDO_BY_WORD[sido_match.group(0)] if sido_match else _infer_sido(place)
    return sido, (place.gu if place else None)


def normalize_region(raw_sido: object, raw_gu: object, question: str) -> tuple[str | None, str | None]:
    """모델이 낸 지역을 학원 표 낱말로 맞춘다. 질문 글자에 없는 지역은 버린다(지어낸 조건 막기 — FR-039)."""
    asked = _compact(question)
    gu: str | None = None
    place: _Place | None = None
    if isinstance(raw_gu, str) and raw_gu.strip() and _compact(raw_gu) in asked:
        word = _compact(raw_gu)
        place = _PLACES.get(word)
        if place is not None:
            gu = place.gu
        elif word.endswith(GU_SUFFIXES) and len(word) >= 3 and word not in _SIDO_BY_WORD:
            # 표에 없는 구·시(경기 밖의 도시 등)는 질문에 적힌 글자 그대로 받는다
            gu = word
    sido: str | None = None
    if isinstance(raw_sido, str) and raw_sido.strip() and _compact(raw_sido) in asked:
        sido = _SIDO_BY_WORD.get(_compact(raw_sido))
    return (sido or _infer_sido(place)), gu


def merge_region(scanned: tuple[str | None, str | None], modeled: tuple[str | None, str | None]) -> tuple[str | None, str | None]:
    """표로 찾은 값을 먼저 쓰고, 빈 칸만 모델 값으로 채운다. 표 찾기는 같은 말에 늘 같은 답이라서다."""
    sido = scanned[0] or modeled[0]
    gu = scanned[1] or modeled[1]
    if sido is None and gu is not None:
        sido = _infer_sido(_PLACES.get(gu))
    return sido, gu
