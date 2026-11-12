#!/bin/bash
# 그림 검토 뒤 2차 고침 — 순서대로 한 줄씩
cd /home/user/kdance/_workspace/penpot-gap/tools
export PENPOT_LOG=/tmp/claude-1000/-home-user-kdance/c58ade28-c960-4a4b-a1f0-b3cb811e2f26/tasks/bt4o07hn5.output
./loop.sh boards/queue_fix2.txt | tail -2
run(){ echo "== $*"; python3 pp.py "$@" 2>&1 | tr '\n' ' ' | cut -c1-300; echo; }
clean(){ echo "const PREFIX='$1 ·';" > boards/_prefix.js; run lib.js boards/_prefix.js boards/_resume_clean.js; }
clean M9E; run lib.js boards/m9e_1.js; run lib.js boards/m9e_2.js; run lib.js boards/notice_m9e.js
clean I2D; run lib.js boards/i2_lib.js boards/i2d_1.js; run lib.js boards/i2_lib.js boards/i2d_2.js
clean I2E; run lib.js boards/i2_lib.js boards/i2e_1.js; run lib.js boards/i2_lib.js boards/i2e_2.js
run lib.js boards/cap_input.js
python3 tabfix.py | tail -25
python3 pp.py lib.js boards/_expect.js | cut -c1-400
python3 pp.py lib.js boards/_dump3.js > /home/user/.claude/jobs/ab16b08c/tmp/dump3.json
for i in C21A C5A I41 I42 O35 W30 I15 M9E I2D I2E; do ./exp.sh "$i ·" $i; done
