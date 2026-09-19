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
# 사전 준비: Docker Desktop만 켜져 있으면 된다.
# omniroute 컨테이너는 restart=unless-stopped 정책이라 Docker가 뜰 때 함께 올라온다
# — "docker start omniroute"를 따로 칠 필요가 없다(직접 멈춰둔 경우만 예외).
#
# 환경변수로 덮어쓰기:
#   OMNIROUTE_URL    게이트웨이 주소 (기본 http://localhost:20128)
#   OMNIROUTE_COMBO  사용할 콤보/모델 이름 (기본 Free-fallback)

set -euo pipefail

GATEWAY="${OMNIROUTE_URL:-http://localhost:20128}"
COMBO="${OMNIROUTE_COMBO:-Free-fallback}"
CLAUDE_JSON="${HOME}/.claude.json"

# 게이트웨이가 죽어 있으면 Claude Code의 모든 요청이 실패한다.
# 요청을 보내고 나서 실패하면 원인이 게이트웨이인지 알기 어려우므로, 여기서 먼저 막는다.
if ! curl -sf -m 5 "${GATEWAY}/api/health" >/dev/null 2>&1; then
  echo "✗ OmniRoute 게이트웨이(${GATEWAY})가 응답하지 않습니다." >&2
  echo "" >&2
  echo "  거의 항상 Docker Desktop이 꺼져 있어서입니다. 켜기만 하면 됩니다." >&2
  echo "" >&2
  echo "  [왜 켜기만 하면 되나]" >&2
  echo "  omniroute는 Docker '컨테이너'로 돌아갑니다 — 프로그램 하나를 상자에 담아" >&2
  echo "  격리해서 돌리는 방식입니다. 이 상자에는 restart=unless-stopped 라는" >&2
  echo "  옵션이 걸려 있습니다. 풀어 쓰면 \"내가 직접 멈춘 게 아니라면 알아서 다시" >&2
  echo "  켜라\"는 뜻입니다. 그래서 Docker Desktop이 뜨는 순간 omniroute도 같이" >&2
  echo "  올라옵니다. 별도로 켜는 명령을 칠 필요가 없습니다." >&2
  echo "" >&2
  echo "  [할 일]" >&2
  echo "  1) Docker Desktop 실행" >&2
  echo "  2) 작업표시줄 고래 아이콘이 초록색이 될 때까지 기다리기 (보통 30~90초)" >&2
  echo "  3) 이 스크립트 다시 실행" >&2
  echo "" >&2
  echo "  [그래도 안 되면]" >&2
  echo "  예전에 직접 멈춰둔 경우입니다. unless-stopped는 사람이 손으로 멈춘 상자는" >&2
  echo "  일부러 안 켭니다(그게 옵션 이름의 'unless-stopped' 부분입니다)." >&2
  echo "    docker start omniroute   # 이때만 수동으로 켠다" >&2
  echo "    docker ps                # omniroute가 healthy 로 뜨는지 확인" >&2
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
