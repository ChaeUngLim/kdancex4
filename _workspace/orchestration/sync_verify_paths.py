#!/usr/bin/env python3
"""완료(done)된 Task 의 verify 칸에 남은 자리표시 테스트 이름(tests/db/s1-2-3.db.test.ts 같은)을
실제로 만든 기능 이름 파일로 바꾼다.

왜: 플랜을 쓸 때는 파일 이름을 몰라 Task 번호로 자리만 잡아 뒀고, 워커는 기존 관례대로 기능 이름
(tests/db/academy-rooms.db.test.ts)으로 만든다. 그대로 두면 verify 명령을 다시 돌릴 때 파일이 없다.

찾는 법: 그 Task 의 증거(_workspace/evidence/<id>/EVIDENCE.md · logs/*)와 크리틱 판정(verdicts/<id>.json)에
적힌 tests/... 경로 중 실제로 있는 파일. 여럿이면 자리표시 이름이나 「대신」·「이름」이 적힌 줄의 것을 고른다.
자리표시가 DB 테스트(.db.test.ts)면 DB 테스트만, 단위면 단위만 남긴다. 못 찾으면 고치지 않고 목록에 남긴다.

쓰는 법(저장소 루트): python3 _workspace/orchestration/sync_verify_paths.py   → 바꾼 줄과 못 찾은 Task 를 출력
"""
import glob
import json
import os
import re

ROADMAP = "_workspace/roadmap-tasks.json"
PLACEHOLDER = re.compile(r"tests/[\w/\-\.]+\.test\.tsx?")
REAL = re.compile(r"tests/(?:db|unit|e2e|migrated)/[\w\-\.]+\.test\.tsx?")


def exists(path: str) -> bool:
    return os.path.exists(os.path.join("admin-web", path))


def evidence_texts(task_id: str) -> list[str]:
    files = glob.glob(f"_workspace/evidence/{task_id}/EVIDENCE.md")
    files += glob.glob(f"_workspace/evidence/{task_id}/logs/*")
    files += glob.glob(f"_workspace/orchestration/verdicts/{task_id}.json")
    texts = []
    for f in files:
        try:
            texts.append(open(f, errors="ignore").read())
        except OSError:
            continue
    return texts


def candidates(task_id: str, placeholder: str) -> list[str]:
    """증거에서 실제 테스트 파일 후보를 고른다 — 넓게 모은 뒤 좁힌다"""
    stem = os.path.basename(placeholder).split(".")[0]
    texts = evidence_texts(task_id)
    everything = {p for s in texts for p in REAL.findall(s) if exists(p)}
    # 여럿이면 「자리표시 이름 · 대신 · 이름」이 적힌 줄에서 고른다(워커가 이름을 바꾼 까닭을 적는 자리)
    if len(everything) > 1:
        noted = {
            p
            for s in texts
            for line in s.splitlines()
            if stem in line or "대신" in line or "이름" in line
            for p in REAL.findall(line)
            if exists(p) and stem not in p
        }
        if noted:
            everything = noted
    is_db = placeholder.endswith(".db.test.ts")
    kept = [p for p in everything if p.endswith(".db.test.ts") == is_db and "permission-matrix" not in p]
    return sorted(kept or everything)


def main() -> None:
    data = json.load(open(ROADMAP))
    changed, unresolved = [], []
    for task in data["tasks"]:
        if task["status"] != "done":
            continue
        verify = task.get("verify", "")
        for ph in set(PLACEHOLDER.findall(verify)):
            if exists(ph):
                continue
            found = candidates(task["id"], ph)
            if not found:
                unresolved.append(f"{task['id']}: {ph}")
                continue
            verify = verify.replace(ph, " ".join(found))
            changed.append(f"{task['id']}: {ph} -> {' '.join(found)}")
        task["verify"] = verify
    json.dump(data, open(ROADMAP, "w"), ensure_ascii=False, indent=2)
    print("\n".join(changed) or "바꾼 것 없음")
    if unresolved:
        print("못 찾음(손으로 확인):\n" + "\n".join(unresolved))


if __name__ == "__main__":
    main()
