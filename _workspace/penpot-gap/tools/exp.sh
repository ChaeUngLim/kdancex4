#!/bin/bash
# 사용: ./exp.sh '<보드 이름 앞부분>' <저장할 이름>  — 보드를 PNG 로 내보낸다(실패하면 한 번 더)
out=/home/user/kdance/docs/prototype/penpot/$2.png
for try in 1 2; do
  echo "const NAME='$1';" > boards/_name.js
  python3 pp.py lib.js boards/_name.js export.js > /tmp/kd_export.txt 2>&1
  python3 -c "
import json,base64,sys
d=json.loads(open('/tmp/kd_export.txt').read()); b=base64.b64decode(d['result']); assert b[:4]==b'\x89PNG'
open('$out','wb').write(b); print('ok $2',len(b))" 2>/dev/null && exit 0
done
echo "export failed $2: $(head -c 120 /tmp/kd_export.txt)"
