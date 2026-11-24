#!/usr/bin/env bash
# 명령 하나를 실행하고, 그 출력 전체를 증거 로그로 남긴다 (leave-verifiable-evidence 스킬).
#
# 왜 필요한가: "테스트 통과했어요" 는 말일 뿐이다. 언제·어디서·무슨 명령을 돌려
# 어떤 출력과 종료 코드가 나왔는지 파일로 남아야 다른 사람(크리틱)이 다시 볼 수 있다.
#
# 사용: run_logged.sh <로그 파일> <작업 폴더> <명령...>
#   예) run_logged.sh _workspace/evidence/S0-2/logs/tsc.log admin-web ./node_modules/.bin/tsc --noEmit
# 로그 맨 끝 줄은 언제나 `exit=<코드>` 다. check_evidence.py 가 이 줄을 읽는다.
set -u
log="$1"; workdir="$2"; shift 2
mkdir -p "$(dirname "$log")"
{
  echo "# when: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "# cwd:  $workdir"
  echo "# cmd:  $*"
  echo "# git:  $(git -C "$workdir" rev-parse --short HEAD 2>/dev/null) (작업 트리 변경 $(git -C "$workdir" status --porcelain 2>/dev/null | wc -l)건)"
  echo "----"
} > "$log"
# 출력은 화면과 로그 양쪽에 남긴다. 종료 코드는 파이프 앞쪽(명령 자체)의 것을 쓴다
( cd "$workdir" && "$@" ) 2>&1 | tee -a "$log"
code=${PIPESTATUS[0]}
echo "exit=$code" >> "$log"
exit "$code"
