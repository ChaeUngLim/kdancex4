#!/usr/bin/env bash
# kdance 랄프 루프 — PROMPT.md 를 새 대화로 넣어 Task 를 하나씩 끝낸다.
# 사용(저장소 루트): bash _workspace/orchestration/ralph.sh [최대 회차, 기본 20]
# 권한 방식 같은 claude 옵션은 CLAUDE_ARGS 로 넘긴다(예: CLAUDE_ARGS="--model sonnet").
# 회차 기록은 _workspace/orchestration/ralph-logs/ 에 남는다.
set -euo pipefail

MAX_ROUNDS="${1:-20}"
LOG_DIR="_workspace/orchestration/ralph-logs"
mkdir -p "$LOG_DIR"

for round in $(seq 1 "$MAX_ROUNDS"); do
  # 남은 Task 가 없으면 claude 를 부르지 않고 끝낸다(헛도는 회차 비용을 막는다)
  if python3 - <<'EOF'
import sys
sys.path.insert(0, '_workspace/orchestration')
from ralph_next import load, pick
sys.exit(0 if pick(load()) is None else 1)
EOF
  then
    echo "남은 Task 없음 — 멈춤"
    break
  fi

  log="$LOG_DIR/round-$(date +%Y%m%d-%H%M%S).log"
  echo "== 회차 $round → $log"
  # shellcheck disable=SC2086
  claude -p ${CLAUDE_ARGS:-} < PROMPT.md | tee "$log"

  if grep -q '^RALPH_DONE' "$log"; then
    break
  fi
done

python3 _workspace/orchestration/ralph_next.py status
