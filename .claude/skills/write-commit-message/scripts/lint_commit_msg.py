#!/usr/bin/env python3
"""커밋 메시지 검사기 (write-commit-message 스킬).

무엇을 하나
  cbea.ms/git-commit 의 일곱 규칙을 한국어 커밋에 맞춰 옮긴 검사를 한다.
  어긋나면 한 줄씩 알려 주고 종료 코드 1 을 돌려준다.
  --fix 를 주면 본문만 72칸(한글은 한 글자 2칸)에서 줄을 나눠 파일을 고쳐 쓴다.

왜 칸으로 세나
  git log 를 보는 터미널은 글자 수가 아니라 화면 칸으로 자른다. 한글은 한 글자가
  두 칸이라, 영어 기준 72자를 그대로 쓰면 한글 본문은 화면 밖으로 넘친다.

사용
  python3 lint_commit_msg.py msg.txt          # 검사만
  python3 lint_commit_msg.py --fix msg.txt    # 본문 줄바꿈 후 다시 검사
  git log -1 --format=%B | python3 lint_commit_msg.py -   # 방금 한 커밋 검사
"""
from __future__ import annotations

import argparse
import re
import sys
import unicodedata

TYPES = ("feat", "fix", "docs", "refactor", "test", "chore", "perf", "ci")
SUBJECT_RE = re.compile(rf"^({'|'.join(TYPES)})\(beta\): (\S.*)$")
SUBJECT_SOFT = 50   # cbea 규칙 2 — 제목 메시지는 50자 안쪽을 목표로 한다
SUBJECT_HARD = 72   # 넘으면 GitHub 가 제목을 잘라 보인다
BODY_WIDTH = 72     # cbea 규칙 6 — 본문은 72칸에서 줄을 나눈다
HANGUL_RE = re.compile(r"[가-힣]")
# 명령형 대신 쓰면 안 되는 끝맺음(보고·명사형). 「~한다」로 고친다
BAD_ENDINGS = ("했다", "했음", "함", "됨", "완료", "수정", "추가", "변경", "개선")


def width(text: str) -> int:
    """터미널에서 차지하는 칸 수. 한글·한자 같은 넓은 글자는 2칸."""
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def wrap(line: str, limit: int = BODY_WIDTH) -> list[str]:
    """한 줄을 낱말(띄어쓰기) 단위로 limit 칸 안쪽에 나눈다. 목록 기호 뒤는 들여 쓴다."""
    if width(line) <= limit or line.startswith(("    ", "\t", "```", "|")):
        return [line]  # 짧은 줄 · 코드 · 표는 건드리지 않는다
    bullet = re.match(r"^(\s*(?:[-*]|\d+\.)\s+)", line)
    indent = " " * len(bullet.group(1)) if bullet else ""
    out, cur = [], ""
    for word in line.split(" "):
        trial = f"{cur} {word}" if cur else word
        if cur and width(trial) > limit:
            out.append(cur)
            cur = indent + word
        else:
            cur = trial
    out.append(cur)
    return out


def check(msg: str) -> list[str]:
    lines = msg.rstrip("\n").split("\n")
    errs: list[str] = []
    subject = lines[0]
    m = SUBJECT_RE.match(subject)
    if not m:
        errs.append(f"제목 형식: `<종류>(beta): <메시지>` 여야 한다. 종류는 {', '.join(TYPES)} — 지금: {subject!r}")
    else:
        text = m.group(2)
        if not HANGUL_RE.search(text):
            errs.append("제목 메시지가 한국어가 아니다 (규칙: 메시지는 무조건 한국어)")
        if len(text) > SUBJECT_SOFT:
            errs.append(f"제목 메시지 {len(text)}자 — {SUBJECT_SOFT}자 안쪽으로 줄인다 (cbea 규칙 2)")
        if text.endswith((".", "。")):
            errs.append("제목 끝에 마침표를 찍지 않는다 (cbea 규칙 4)")
        if text.rstrip(".。").endswith(BAD_ENDINGS) or not text.rstrip(".。").endswith("다"):
            errs.append("제목은 「이 커밋을 적용하면 ___」에 들어맞게 「~한다」로 끝낸다 (cbea 규칙 5)")
    if len(subject) > SUBJECT_HARD:
        errs.append(f"제목 줄 전체 {len(subject)}자 — {SUBJECT_HARD}자를 넘으면 GitHub 가 자른다")
    if len(lines) > 1:
        if lines[1].strip():
            errs.append("제목과 본문 사이에 빈 줄 하나를 둔다 (cbea 규칙 1)")
        body = [l for l in lines[2:] if not l.startswith("#")]
        if body and not HANGUL_RE.search("\n".join(body)):
            errs.append("본문이 한국어가 아니다")
        for no, l in enumerate(lines[2:], 3):
            if width(l) > BODY_WIDTH and not l.startswith(("    ", "\t", "|", "http")) and " " in l.strip():
                errs.append(f"{no}번째 줄 {width(l)}칸 — {BODY_WIDTH}칸에서 줄을 나눈다 (cbea 규칙 6, --fix 로 고친다)")
    return errs


def fix(msg: str) -> str:
    lines = msg.rstrip("\n").split("\n")
    out = [*lines[:2]]
    for l in lines[2:]:
        out.extend(wrap(l))
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="커밋 메시지 파일. - 이면 표준 입력")
    ap.add_argument("--fix", action="store_true", help="본문을 72칸에서 줄바꿈해 파일을 고쳐 쓴다")
    args = ap.parse_args()
    msg = sys.stdin.read() if args.file == "-" else open(args.file, encoding="utf-8").read()
    if args.fix and args.file != "-":
        msg = fix(msg)
        with open(args.file, "w", encoding="utf-8") as f:
            f.write(msg)
    errs = check(msg)
    for e in errs:
        print("ERROR ", e)
    print(f"# lint_commit_msg  결과: {'FAIL' if errs else 'PASS'}  (문제 {len(errs)})")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
