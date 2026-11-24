#!/usr/bin/env python3
"""Workflow args 만들기 — roadmap-tasks.json 에서 마일스톤 하나의 남은 Task 를 실행 순서대로 뽑는다.

사용: python3 _workspace/orchestration/make_args.py M0  > /tmp/args.json
출력 {"tasks": [{id, m, s, d, r}]} 를 Workflow 의 args 로 그대로 넘긴다(문자열이 아니라 JSON 값으로).
done 은 빼고, blocked 는 이유와 함께 넣는다(스크립트가 건너뛰고 모아 둔다).
"""
import json, os, subprocess, sys
ms = sys.argv[1]
tasks = json.load(open('_workspace/roadmap-tasks.json', encoding='utf-8'))['tasks']
VD = '_workspace/orchestration/verdicts'

def verdict(tid):
    # 크리틱이 남긴 판정 파일 — 터미널이 꺼져 Workflow 결과를 잃어도 이것으로 이어받는다
    p = f'{VD}/{tid}.json'
    return json.load(open(p, encoding='utf-8')).get('verdict') if os.path.exists(p) else None

def evidence_pass(tid):
    # 증거 폴더가 있고 검사기가 PASS 면 크리틱부터 보게 표시한다(e)
    d = f'_workspace/evidence/{tid}'
    if not os.path.isdir(d): return False
    r = subprocess.run(['python3', '.claude/skills/leave-verifiable-evidence/scripts/check_evidence.py', d], capture_output=True, text=True)
    return r.returncode == 0 and 'PASS' in r.stdout.splitlines()[-1] if r.stdout else False

out, skipped = [], []
for t in tasks:
    if t['milestone'] != ms or t['status'] == 'done': continue
    if verdict(t['id']) == 'PASS': skipped.append(t['id']); continue   # 이미 크리틱 통과 — roadmap 갱신만 남음
    row = {'id': t['id'], 'm': t['milestone'], 's': t['status'], 'd': t['deps'], 'r': t['blocked_reason']}
    if t['status'] == 'todo' and evidence_pass(t['id']): row['e'] = True
    out.append(row)
if skipped: print('크리틱 PASS 판정 파일이 있어 뺀 Task(roadmap 을 done 으로 고칠 것):', ' '.join(skipped), file=sys.stderr)
print(json.dumps({'tasks': out}, ensure_ascii=False, separators=(',', ':')))
