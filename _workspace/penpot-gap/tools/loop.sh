#!/bin/bash
# 사용: ./loop.sh <queue 파일>
# q.sh 를 돌리다가 플러그인이 끊겨 멈추면, 끊길 때 그리던 보드를 처음부터 다시 그리게 되돌리고,
# 서버 로그에 새 연결이 찍힐 때까지 기다렸다가 저절로 이어서 돌린다. 줄이 다 끝나면 멈춘다.
LOG=/tmp/claude-1000/-home-user-kdance/c58ade28-c960-4a4b-a1f0-b3cb811e2f26/tasks/bt4o07hn5.output
Q=$1
touch "$Q.done"   # 없으면 빈 파일로 — 없을 때 「다 끝남」으로 잘못 읽지 않게
while true; do
  # 끊길 때 그리던 보드: 아직 안 끝난 첫 줄의 보드 — 그 보드의 끝난 줄을 지워 _1.js 부터 다시 돌게 한다
  nxt=$(grep -vxFf "$Q.done" "$Q" | head -1)
  [ -z "$nxt" ] && { echo "QUEUE-DONE"; exit 0; }
  kind=$(echo "$nxt" | awk '{print $1}'); id=$(echo "$nxt" | awk '{print $2}' | sed -E 's/_[0-9]+\.js$//')
  grep -v -E "^$kind ${id}_[0-9]+\.js$" "$Q.done" > "$Q.done.tmp"; cp "$Q.done.tmp" "$Q.done"
  echo "[$(date +%H:%M)] 이어서: $kind $id 부터 · 끝남 $(wc -l < "$Q.done")/$(wc -l < "$Q")"
  ./q.sh "$Q" | tail -3
  [ -z "$(grep -vxFf "$Q.done" "$Q" | head -1)" ] && { echo "QUEUE-DONE"; exit 0; }
  echo "[$(date +%H:%M)] 멈춤 — 플러그인 다시 연결을 기다린다"
  # 마지막 연결 기록이 '끊김'인 동안 기다린다(최대 12시간)
  for i in $(seq 1 4320); do
    last=$(grep -E "WebSocket connection closed|New WebSocket connection established" "$LOG" | tail -1)
    echo "$last" | grep -q "established" && break
    sleep 10
  done
  sleep 5
done
