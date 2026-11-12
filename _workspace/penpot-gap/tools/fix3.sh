#!/bin/bash
cd /home/user/kdance/_workspace/penpot-gap/tools
export PENPOT_LOG=/tmp/claude-1000/-home-user-kdance/c58ade28-c960-4a4b-a1f0-b3cb811e2f26/tasks/bt4o07hn5.output
./loop.sh boards/queue_fix3.txt | tail -5
python3 pp.py lib.js boards/fix_hand3.js | tr '\n' ' '; echo
python3 tabfix.py | grep -o '"[A-Z0-9a-z]*", "→[^"]*"'
python3 pp.py lib.js boards/_expect.js | tr '\n' ' '; echo
for i in I29 C25A W4a W4b O21B; do ./exp.sh "$i ·" $i; done
