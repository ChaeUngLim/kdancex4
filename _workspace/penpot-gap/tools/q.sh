#!/bin/bash
# 이어 하기 되는 실행 줄. 사용: ./q.sh <queue 파일>
# queue 파일 한 줄: "<member|page|owner|web> <스크립트>" 또는 "export <보드 이름 앞부분> <저장 이름>"
# 끝낸 줄은 <queue>.done 에 적어 다시 실행하지 않는다. 플러그인이 끊기면 그 자리에서 멈춘다.
export PENPOT_LOG=/tmp/claude-1000/-home-user-kdance/c58ade28-c960-4a4b-a1f0-b3cb811e2f26/tasks/bt4o07hn5.output
Q=$1; D=$Q.done; touch "$D"
while IFS= read -r line; do
  [ -z "$line" ] && continue
  grep -qxF -- "$line" "$D" && continue
  set -- $line; kind=$1
  if [ "$kind" = export ]; then
    name=$(echo "$line" | sed -E 's/^export (.*) ([^ ]+)$/\1/'); save=$(echo "$line" | sed -E 's/^export (.*) ([^ ]+)$/\2/')
    out=$(./exp.sh "$name" "$save" 2>&1 | tr '\n' ' ')
  else
    case $kind in member) libs="lib.js boards/member_lib.js";; page) libs="lib.js boards/page_lib.js";; owner) libs="lib.js boards/owner_lib.js";; web) libs="lib.js boards/web_lib.js";; *) echo "모르는 종류: $line"; continue;; esac
    # 보드의 첫 스크립트(_1.js)는 실행 전에 같은 ID 의 보드를 지운다 — 끊겨서 반만 그려진 보드가 겹치지 않게
    if echo "$2" | grep -qE '_1\.js$'; then id=$(echo "$2" | sed -E 's/_1\.js$//' | tr 'a-z' 'A-Z'); echo "const PREFIX='$id ·';" > boards/_prefix.js; python3 pp.py lib.js boards/_prefix.js boards/_resume_clean.js >/dev/null 2>&1; fi
    out=$(python3 pp.py $libs boards/$2 2>&1 | tr '\n' ' ' | cut -c1-200)
  fi
  echo "$line → $out"
  if echo "$out" | grep -q "No Penpot plugin\|Connection refused\|timeout-unknown"; then echo "STOPPED: 플러그인 연결 확인 필요 — 이 줄부터 다시"; exit 2; fi
  if echo "$out" | grep -qi "Tool execution failed\|SyntaxError\|ReferenceError\|TypeError\|export failed"; then echo "$line" >> "$Q.failed"; fi
  echo "$line" >> "$D"
done < "$Q"
echo QUEUE-DONE
