"""고정 평가 세트 실행기 (계약 16 §8 · FR-276(고정 평가 세트)) — 지금은 `recommend` 묶음만 (SX-4.2(있는 수업만 추천)).

처음 보는 사람용 요약
- `eval/set.jsonl` 한 줄이 문항 하나다. `recommend` 문항은 「검색 API 가 돌려준 결과」를 `eval/fixtures/
  recommend_search_results.json` 에서 꺼내 추천기(`app.planner.recommender.recommend`)에 넣고, 나온 추천을 검사한다.
- 합격 기준(SC-011(없는 추천 0건)): 추천 카드의 `offeringId` 가 **그 문항의 검색 결과 안에 하나도 빠짐없이** 있어야 한다.
  그 밖에 근거 문장·출처가 붙었나(FR-040), 근거가 한국어만인가(FR-266), 빼야 할 수업(마감·시간 겹침)이 빠졌나(FR-038),
  `forbid.phrases` 가 없나, 개수가 `minItems`~`maxItems` 안인가를 본다. 한 문항이라도 어기면 종료 코드 1.
- 기본은 진짜 kdance-llm 으로 고르게 한다. `--dry-run` 은 모델 없이 규칙 순서로만 돌린다(모델 서버가 꺼져 있을 때 형식 점검용).
- 다른 묶음(t0~t3·search)은 SX-3.1(고정 평가 세트)이 문항과 검사를 더한다. 그 묶음을 고르면 아직 없다고 알리고 2 로 끝낸다.

실행: `cd agent-server && uv run python eval/run_eval.py --group recommend [--dry-run] [--report 경로.json]`
"""

import argparse
import asyncio
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

# `python eval/run_eval.py` 로 돌리면 eval/ 이 맨 앞 경로라 app 패키지를 못 찾는다 — 한 칸 위를 더한다
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.planner.recommender import recommend, taste_from_context  # noqa: E402
from app.planner.text_client import OpenAICompatTextClient, TextClient  # noqa: E402
from app.settings import load_settings  # noqa: E402

SET_PATH = ROOT / "eval" / "set.jsonl"
FIXTURE_PATH = ROOT / "eval" / "fixtures" / "recommend_search_results.json"
IMPLEMENTED_GROUPS = ("recommend",)
# 고르기 한 번에 줄 시간. 전체 25초(SC-041) 중 조건 뽑기·검색을 뺀 몫으로 잡았다(추천안 — 실측으로 고친다)
PICK_TIMEOUT_SECONDS = 12.0
# 한국어 문장에 있으면 안 되는 글자: 로마자·가나·한자(FR-266)
FOREIGN = re.compile(r"[A-Za-z぀-ヿ一-鿿]")


def load_items(group: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for number, line in enumerate(SET_PATH.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        item = json.loads(line)
        if not isinstance(item, dict) or "id" not in item or "group" not in item:
            raise ValueError(f"set.jsonl {number}번째 줄 모양이 틀렸다")
        if item["group"] == group:
            items.append(item)
    return items


def check_recommend(item: dict[str, Any], search: list[dict[str, Any]], result_items: list[dict[str, Any]]) -> list[str]:
    """문항 하나의 추천 결과를 검사한다. 어긴 것을 사람 말로 돌려준다(빈 목록이면 합격)."""
    problems: list[str] = []
    expect = item.get("expect") or {}
    forbid = item.get("forbid") or {}
    allowed = {card["offeringId"] for card in search}
    ids = [r.get("offeringId") for r in result_items]
    ghosts = [i for i in ids if i not in allowed]
    if ghosts:
        problems.append(f"검색 결과에 없는 수업 추천 {len(ghosts)}건")
    if len(set(ids)) != len(ids):
        problems.append("같은 수업을 두 번 추천")
    for r in result_items:
        reason = r.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            problems.append(f"{r.get('offeringId')}: 근거 문장 없음")
            continue
        if not r.get("reasonSources"):
            problems.append(f"{r.get('offeringId')}: 근거 출처 없음")
        if expect.get("language") == "ko" and FOREIGN.search(reason):
            problems.append(f"{r.get('offeringId')}: 근거에 한국어가 아닌 글자")
        for phrase in forbid.get("phrases") or []:
            if phrase in reason:
                problems.append(f"{r.get('offeringId')}: 금지 문구 「{phrase}」")
    for excluded in expect.get("mustExclude") or []:
        if excluded in ids:
            problems.append(f"빼야 할 수업 {excluded} 이 추천됨")
    if "minItems" in expect and len(ids) < int(expect["minItems"]):
        problems.append(f"추천 {len(ids)}개 < 최소 {expect['minItems']}개")
    if "maxItems" in expect and len(ids) > int(expect["maxItems"]):
        problems.append(f"추천 {len(ids)}개 > 최대 {expect['maxItems']}개")
    return problems


async def run_recommend(items: list[dict[str, Any]], client: TextClient | None) -> list[dict[str, Any]]:
    fixtures: dict[str, list[dict[str, Any]]] = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    rows: list[dict[str, Any]] = []
    for item in items:
        context = item.get("context") or {}
        search = fixtures[context["searchFixture"]]
        started = time.monotonic()
        result = await recommend(
            search,
            taste_from_context(context.get("memberTaste")),
            context.get("conditions") or {},
            client=client,
            timeout_seconds=PICK_TIMEOUT_SECONDS if client else 0,
        )
        problems = check_recommend(item, search, result.items)
        rows.append(
            {
                "id": item["id"],
                "passed": not problems,
                "problems": problems,
                "searched": len(search),
                "recommended": [{"offeringId": r["offeringId"], "title": r["title"], "reason": r["reason"]} for r in result.items],
                "notInSearch": sum(1 for r in result.items if r["offeringId"] not in {c["offeringId"] for c in search}),
                "rejected": [{"offeringId": r.offering_id, "reason": r.reason} for r in result.rejected],
                "droppedUnknownPicks": result.dropped_unknown_picks,
                "usedModel": result.used_model,
                "modelCalls": result.model_calls,
                "elapsedMs": int((time.monotonic() - started) * 1000),
            }
        )
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="kdance 고정 평가 세트 실행")
    parser.add_argument("--group", required=True, choices=("t0", "t1", "t2", "t3", "recommend", "search"))
    parser.add_argument("--dry-run", action="store_true", help="모델 없이 규칙 순서로만 돌린다")
    parser.add_argument("--report", type=Path, help="문항별 결과 JSON 을 쓸 경로")
    args = parser.parse_args()
    if args.group not in IMPLEMENTED_GROUPS:
        print(f"묶음 {args.group} 은 아직 없다 — SX-3.1(고정 평가 세트)이 더한다")
        return 2
    items = load_items(args.group)
    if not items:
        print(f"set.jsonl 에 {args.group} 문항이 없다")
        return 2
    client: TextClient | None = None
    if not args.dry_run:
        settings = load_settings()
        client = OpenAICompatTextClient(base_url=settings.llm_base_url, model_name=settings.llm_chat_model, max_tokens=100)
    rows = asyncio.run(run_recommend(items, client))
    for row in rows:
        mark = "PASS" if row["passed"] else "FAIL"
        picked = " | ".join(f"{r['title']} — {r['reason']}" for r in row["recommended"]) or "(추천 없음)"
        print(f"[{mark}] {row['id']} model={row['usedModel']} {row['elapsedMs']}ms 뺌={len(row['rejected'])} 버린번호={row['droppedUnknownPicks']} → {picked}")
        for problem in row["problems"]:
            print(f"    - {problem}")
    ghosts = sum(row["notInSearch"] for row in rows)
    failed = sum(1 for row in rows if not row["passed"])
    with_reason = sum(len(row["recommended"]) for row in rows)
    print(f"요약: 문항 {len(rows)}개 · 실패 {failed}개 · 추천 {with_reason}건(모두 근거 검사) · 없는 수업 추천 {ghosts}건 · 모델 사용 {sum(1 for r in rows if r['usedModel'])}문항")
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    return 1 if failed or ghosts else 0


if __name__ == "__main__":
    sys.exit(main())
