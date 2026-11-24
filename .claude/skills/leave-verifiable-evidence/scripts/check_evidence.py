#!/usr/bin/env python3
"""증거 폴더 검사기 (leave-verifiable-evidence 스킬).

무엇을 하나
  _workspace/evidence/<작업ID>/EVIDENCE.md 의 표에 적힌 파일이 전부 실제로 있고,
  쓸 만한지(스크린샷은 진짜 PNG 인지, 로그는 exit=0 으로 끝났는지) 확인한다.
  크리틱은 결과물을 보기 전에 이것부터 돌린다 — 증거가 없으면 내용을 볼 필요도 없다.

EVIDENCE.md 표 모양 (열 순서 고정)
  | 종류 | 장면·대상 | 파일 | 확인한 것 |
  | screen | 01 로그인 첫 화면 | screens/01-login.png | 버튼 2개·문구 일치 |
  | log | 타입 검사 | logs/tsc.log | exit 0 |
  | board | W2a 입점 신청 | boards/W2a.png | spec FR-251 문구 |
  종류: screen(브라우저 스크린샷) · board(디자인 보드 내보내기) · log(run_logged.sh 로그, exit=0 이어야 함)
        · log-fail(고치기 전 실패 기록 — 지우지 않고 남긴 로그, exit≠0 이어야 함)

사용: python3 check_evidence.py _workspace/evidence/S0-2
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
MIN_WIDTH = 320  # 이보다 좁으면 화면 전체가 아니라 조각을 찍은 것으로 본다
KINDS = {"screen", "board", "log", "log-fail"}
SELF_LOG = "logs/check-evidence.log"  # 워커가 이 검사기를 돌린 로그의 정해진 이름


def png_size(path: Path) -> tuple[int, int] | None:
    head = path.read_bytes()[:24]
    if not head.startswith(PNG_MAGIC):
        return None
    return struct.unpack(">II", head[16:24])  # IHDR 의 너비·높이


def check_row(base: Path, kind: str, rel: str, seen: str) -> str | None:
    """한 행을 검사해 문제가 있으면 그 설명을, 없으면 None 을 돌려준다."""
    if kind not in KINDS:
        return f"종류 '{kind}' 는 screen·board·log·log-fail 중 하나여야 한다"
    if not seen:
        return "「확인한 것」 칸이 비었다 — 찍기만 하고 안 본 증거는 증거가 아니다"
    # 증거 폴더 밖(절대 경로·../)은 읽지 않는다 — 밖의 파일 내용이 오류 메시지로 로그에 새어 나갈 수 있다
    f = (base / rel).resolve()
    if rel.startswith("/") or not f.is_relative_to(base.resolve()):
        return f"증거 폴더 밖을 가리킨다: {rel}"
    if not f.is_file() or f.stat().st_size == 0:
        return f"파일이 없거나 비었다: {rel}"
    if kind in {"screen", "board"}:
        size = png_size(f)
        if size is None:
            return f"PNG 가 아니다: {rel}"
        if size[0] < MIN_WIDTH:
            return f"너비 {size[0]}px — {MIN_WIDTH}px 보다 좁다: {rel}"
    if kind in {"log", "log-fail"}:
        lines = f.read_text(encoding="utf-8", errors="replace").strip().splitlines()
        last = lines[-1] if lines else ""
        if not last.startswith("exit="):
            return f"run_logged.sh 로 남긴 로그가 아니다(끝 줄 exit= 없음): {rel}"
        if kind == "log" and last != "exit=0":
            return f"명령이 실패했다({last}): {rel}"
        if kind == "log-fail" and last == "exit=0":
            return f"log-fail 인데 성공한 로그다 — 종류를 log 로 바꾼다: {rel}"
    return None


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    base = Path(sys.argv[1])
    manifest = base / "EVIDENCE.md"
    if not manifest.is_file():
        print(f"FAIL  {manifest} 가 없다")
        return 1

    rows, problems, kinds = 0, 0, set()
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if not line.strip().startswith("|"):
            continue
        cells = [c.strip().strip("`") for c in line.strip().strip("|").split("|")]
        # 머리줄(종류)·구분줄(---)은 건너뛴다
        if len(cells) < 4 or cells[0] == "종류" or set(cells[0]) <= set("-: "):
            continue
        # 이 검사기 자신의 로그는 검사하는 동안 아직 쓰이는 중이라(끝 줄 exit= 가 없다) 건너뛴다
        if cells[2] == SELF_LOG:
            print("skip  " + line.strip() + "  (검사기 자신의 로그)")
            continue
        rows += 1
        kinds.add(cells[0])
        problem = check_row(base, cells[0], cells[2], cells[3])
        print(("FAIL  " if problem else "ok    ") + line.strip())
        if problem:
            problems += 1
            print(f"      → {problem}")

    if rows == 0:
        problems += 1
        print("FAIL  증거 행이 하나도 없다")
    print(f"# check_evidence  {base}  행 {rows}개 · 문제 {problems}개 · 종류 {sorted(kinds)}")
    print(f"# 결과: {'FAIL' if problems else 'PASS'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
