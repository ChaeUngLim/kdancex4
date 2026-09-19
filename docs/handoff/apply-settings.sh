#!/usr/bin/env bash
# kdance 설정을 이 머신에 그대로 얹는다.
#
# 언제 쓰나: 다른 PC 에서 clone 한 직후, 또는 계정을 바꾼 뒤 설정이 어긋났을 때.
# 무엇을 하나: 사용자 레벨 settings.json · 프로젝트 settings.local.json · MCP 서버 8종을 맞춘다.
#
#   bash docs/handoff/apply-settings.sh                  # 무엇이 바뀔지만 보여준다
#   bash docs/handoff/apply-settings.sh --apply          # 전부 적용한다 (다른 PC)
#   bash docs/handoff/apply-settings.sh --apply --settings-only
#                                                        # 전역 settings.json 만 (같은 PC)
#
# 같은 PC 라면 MCP·플러그인·규칙은 경로 기반이라 그대로 남는다. --settings-only 로 충분하다.
#
# Claude Code 를 종료한 상태에서 실행한다 — 실행 중이면 ~/.claude.json 을 덮어써 충돌할 수 있다.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HANDOFF="${REPO}/docs/handoff"
APPLY=0
ONLY_SETTINGS=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --settings-only) ONLY_SETTINGS=1 ;;
    *) echo "모르는 인자: $a" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { if [[ $APPLY -eq 1 ]]; then "$@"; else say "  [미리보기] $*"; fi; }

say "기준 저장소: ${REPO}"
[[ $APPLY -eq 1 ]] || say "미리보기입니다. 실제로 적용하려면 --apply 를 붙이세요."
say ""

# ── 1. 사용자 레벨 settings.json ────────────────────────────────────
say "1) ~/.claude/settings.json"
if [[ $APPLY -eq 1 ]]; then
  if [[ -f ~/.claude/settings.json ]]; then
    cp ~/.claude/settings.json ~/.claude/settings.json.bak-"$(date +%Y%m%d-%H%M%S)"
    say "  기존 파일을 .bak-<날짜> 로 백업했습니다"
  fi
  mkdir -p ~/.claude
  cp "${HANDOFF}/settings.global.json" ~/.claude/settings.json
  say "  적용 완료 — 플러그인 5종·마켓플레이스 5종·모델(opus)·autoMode 가 kdance 기준으로 맞춰졌습니다"
else
  say "  [미리보기] ${HANDOFF}/settings.global.json → ~/.claude/settings.json"
fi
say ""

if [[ $ONLY_SETTINGS -eq 1 ]]; then
  say "--settings-only — 여기까지입니다. 같은 PC 라면 나머지는 이미 맞춰져 있습니다."
  say "계정을 바꿨다면 /plugin 에서 claude.ai 동기화 스킬이 되살아났는지 확인하세요 (docs/claude-skills-checklist.md)."
  exit 0
fi

# ── 2. 프로젝트 settings.local.json ─────────────────────────────────
# 이 파일은 ~/.config/git/ignore 의 '**/.claude/settings.local.json' 규칙 때문에 git 에 올라가지 않는다.
# 그래서 사본을 docs/handoff/ 에 두고 여기서 되돌린다.
say "2) .claude/settings.local.json (스킬 on/off 18개)"
run cp "${HANDOFF}/settings.project.local.json" "${REPO}/.claude/settings.local.json"
say ""

# ── 3. MCP 서버 ─────────────────────────────────────────────────────
# chrome-devtools 는 ecc 플러그인이 들고 오므로 여기서 등록하지 않는다.
say "3) MCP 서버 8종"
if ! command -v claude >/dev/null 2>&1; then
  say "  claude CLI 를 찾지 못했습니다 — 설치 후 다시 실행하세요"
else
  run claude mcp add --scope user --transport http omniroute http://localhost:20128/api/mcp/stream
  run claude mcp add --scope user --transport http context7 https://mcp.context7.com/mcp
  run claude mcp add --scope user --transport http github https://api.githubcopilot.com/mcp
  run claude mcp add --scope user mindpilot -- npx @mindpilot/mcp@latest
  run claude mcp add --scope user --env MEMORY_FILE_PATH="${HOME}/.claude/external/mcp-memory/memory.json" \
      memory -- npx -y @modelcontextprotocol/server-memory
  run claude mcp add --scope user playwright -- npx -y @playwright/mcp@latest \
      --headless --browser chromium --isolated \
      --storage-state "${HOME}/.cache/kdance-playwright-auth/state.json"
  run claude mcp add --scope user agent-reach -- "${HOME}/.local/bin/uv" run \
      --directory "${HOME}/tools/Agent-Reach" --with 'mcp[cli]<2' \
      python -m agent_reach.integrations.mcp_server
  # 프로젝트 스코프 — kdance 디렉터리 안에서만 잡힌다
  run claude mcp add --scope project postgres-kdance -- npx -y \
      @modelcontextprotocol/server-postgres postgresql://kdance:kdance@localhost:5433/kdance
fi
say ""

# ── 3-1. ECC 규칙 42개 ──────────────────────────────────────────────
# 항상 로드되는 사용자 레벨 규칙이다. 없으면 코딩 기준이 통째로 빠진다.
# ecc 플러그인 캐시 안에 원본이 들어 있어서 저장소를 clone 할 필요가 없다.
say "3-1) ECC 규칙 (~/.claude/rules/ecc/)"
ECC_CACHE="$(ls -d "${HOME}"/.claude/plugins/cache/ecc/ecc/*/ 2>/dev/null | sort -V | tail -1 || true)"
if [[ -z "${ECC_CACHE}" || ! -d "${ECC_CACHE}rules" ]]; then
  say "  ecc 플러그인이 아직 없습니다 — /plugin 으로 ecc 를 먼저 설치한 뒤 이 스크립트를 다시 돌리세요"
else
  say "  출처: ${ECC_CACHE}rules"
  run mkdir -p "${HOME}/.claude/rules/ecc"
  for m in common python typescript react react-native web; do
    run cp -r "${ECC_CACHE}rules/${m}" "${HOME}/.claude/rules/ecc/"
  done
  run cp "${ECC_CACHE}rules/README.md" "${HOME}/.claude/rules/ecc/README.md"
fi
say ""

# ── 4. 부수 디렉터리 ────────────────────────────────────────────────
say "4) 부수 디렉터리"
run mkdir -p "${HOME}/.claude/external/mcp-memory" "${HOME}/.cache/kdance-playwright-auth"
run mkdir -p "${HOME}/.claude/skills/humanizer-kr"
run cp "${HANDOFF}/user-skills/humanizer-kr/SKILL.md" "${HOME}/.claude/skills/humanizer-kr/SKILL.md"
say ""

say "다음 순서 — 스크립트가 대신 못 하는 것"
say "  1. 플러그인:       Claude Code 에서 /plugin — ecc 를 깔아야 3-1 단계가 동작한다. 안 깔려 있었다면 설치 후 이 스크립트를 한 번 더 돌린다"
say "  2. 비밀값:         backend/.env · mobile/.env  (git 에 없다 — 따로 전달)"
say "  3. GitHub 인증:    gh auth login && gh auth setup-git"
say "  4. git 신원:       git config --global user.name ChaeUngLim && git config --global user.email brad213@naver.com"
say "  5. Claude Code 를 켠 뒤 /plugin 으로 플러그인 5종 설치 확인, /mcp 로 연결 9종 확인"
