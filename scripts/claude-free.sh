#!/usr/bin/env bash
# Claude Code를 OmniRoute 무료 모델 체인(Free-fallback)에 연결해서 실행한다.
#
# 왜 스크립트인가: ANTHROPIC_* 환경변수는 이미 실행 중인 프로세스에 소급 적용되지 않는다.
# 따라서 무료 체인은 "새로 띄우는 claude"에만 걸 수 있고, 매번 3줄을 치는 대신 이 스크립트로 띄운다.
#
# 사용법:
#   scripts/claude-free.sh              # 무료 체인으로 Claude Code 실행
#   scripts/claude-free.sh --continue   # claude에 넘길 인자는 그대로 전달됨
#
# 환경변수로 덮어쓰기:
#   OMNIROUTE_URL    게이트웨이 주소 (기본 http://localhost:20128)
#   OMNIROUTE_COMBO  사용할 콤보/모델 이름 (기본 Free-fallback)

set -euo pipefail

GATEWAY="${OMNIROUTE_URL:-http://localhost:20128}"
COMBO="${OMNIROUTE_COMBO:-Free-fallback}"
CLAUDE_JSON="${HOME}/.claude.json"

# 게이트웨이가 죽어 있으면 Claude Code의 모든 요청이 실패하므로 먼저 막는다.
if ! curl -sf -m 5 "${GATEWAY}/api/health" >/dev/null 2>&1; then
  echo "✗ OmniRoute 게이트웨이(${GATEWAY})가 응답하지 않습니다." >&2
  echo "  1) Docker Desktop이 실행 중인지 확인" >&2
  echo "  2) docker start omniroute" >&2
  echo "  3) 다시 이 스크립트 실행" >&2
  exit 1
fi

# 키는 리포에 두지 않고 실행 시점에 ~/.claude.json 에서 읽는다.
KEY="$(python3 - "$CLAUDE_JSON" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        cfg = json.load(f)
    auth = cfg["mcpServers"]["omniroute"]["headers"]["Authorization"]
    print(auth.replace("Bearer ", "").strip())
except Exception:
    print("")
PY
)"

if [ -z "$KEY" ]; then
  echo "✗ ~/.claude.json 에서 OmniRoute API 키를 찾지 못했습니다." >&2
  echo "  mcpServers.omniroute.headers.Authorization 항목을 확인하세요." >&2
  exit 1
fi

echo "→ OmniRoute ${GATEWAY} · 모델 ${COMBO}"
echo "  체인: claude-sonnet-4.5(Kiro) → qwen3.8-27b(Groq) → gemini-3.8-flash → codestral(Mistral)"
echo

exec env \
  ANTHROPIC_BASE_URL="${GATEWAY}" \
  ANTHROPIC_API_KEY="${KEY}" \
  ANTHROPIC_MODEL="${COMBO}" \
  claude "$@"
