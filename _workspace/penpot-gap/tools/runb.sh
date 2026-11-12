#!/bin/bash
# 사용: ./runb.sh <member|page> <보드 스크립트...>  — 파일을 순서대로 하나씩 실행한다
export PENPOT_LOG=/tmp/claude-1000/-home-user-kdance/c58ade28-c960-4a4b-a1f0-b3cb811e2f26/tasks/bt4o07hn5.output
kind=$1; shift
libs="lib.js boards/member_lib.js"; [ "$kind" = page ] && libs="lib.js boards/page_lib.js"
for f in "$@"; do out=$(python3 pp.py $libs boards/$f 2>&1 | tr '\n' ' ' | cut -c1-160); echo "$f → $out"; done
