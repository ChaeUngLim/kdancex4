#!/usr/bin/env python3
"""랄프 루프용 Task 고르기 — roadmap-tasks.json 이 유일한 작업 목록 원본이다.

사용(저장소 루트에서):
  python3 _workspace/orchestration/ralph_next.py next          # 다음에 할 Task 하나를 JSON 으로. 없으면 NONE
  python3 _workspace/orchestration/ralph_next.py set <id> done
  python3 _workspace/orchestration/ralph_next.py set <id> blocked "<이유>"
  python3 _workspace/orchestration/ralph_next.py status        # 상태별 개수

왜 이렇게 했나: 랄프 루프는 매번 새 대화로 시작해서 앞 회차를 기억하지 못한다.
그래서 "무엇을 끝냈고 다음은 무엇인가"를 파일 하나(roadmap-tasks.json)에만 적고,
고르는 규칙을 이 스크립트 하나에 모아 회차마다 같은 답이 나오게 한다.
"""
import json
import sys
from collections import Counter
from pathlib import Path

ROADMAP = Path('_workspace/roadmap-tasks.json')
GROUP_SUFFIX = ' 전체'  # 선행 칸의 「S0-1 전체」는 그 슬라이스의 Task 묶음을 뜻한다
FINAL = {'done', 'blocked'}
STATUSES = {'todo', 'doing', 'done', 'blocked'}


def load():
    return json.loads(ROADMAP.read_text(encoding='utf-8'))


def save(data):
    ROADMAP.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def slice_key(task):
    # slice 값은 「S0-1(데이터 계약 …)」 모양이라 괄호 앞만 쓴다
    return task['slice'].split('(')[0].strip()


def dep_ok(dep, by_id, tasks):
    """선행 하나가 풀렸는지 본다.

    - 보통 선행(Task id): 그 Task 가 done 이어야 한다. blocked 면 계속 막힌다.
    - 묶음 선행(「X 전체」): 묶음 안의 Task 가 모두 done 이거나 blocked 면 풀린다.
      로드맵이 처음부터 막아 둔 Task(가짜 어댑터로 대신 가는 것) 때문에 뒤 전체가 서지 않게 하려는 것이다
      (워커·크리틱 스크립트와 같은 규칙, orchestration/README.md 「알아 둘 것」).
    """
    if dep.endswith(GROUP_SUFFIX):
        key = dep[: -len(GROUP_SUFFIX)]
        members = [t for t in tasks if slice_key(t) == key]
        return bool(members) and all(t['status'] in FINAL for t in members)
    task = by_id.get(dep)
    return task is not None and task['status'] == 'done'


def pick(data):
    tasks = data['tasks']
    doing = [t for t in tasks if t['status'] == 'doing']
    if doing:
        # 앞 회차가 도중에 끊긴 것 — 새 Task 를 고르지 않고 그것부터 마친다
        return doing[0]
    by_id = {t['id']: t for t in tasks}
    for t in tasks:  # 파일 순서가 곧 실행 순서다
        if t['status'] == 'todo' and all(dep_ok(d, by_id, tasks) for d in t['deps']):
            return t
    return None


def cmd_set(data, argv):
    tid, status = argv[2], argv[3]
    if status not in STATUSES:
        print(f'모르는 상태: {status}')
        return 2
    task = next((t for t in data['tasks'] if t['id'] == tid), None)
    if task is None:
        print(f'없는 Task: {tid}')
        return 2
    task['status'] = status
    if status == 'blocked':
        task['blocked_reason'] = argv[4] if len(argv) > 4 else '이유 미기재'
    save(data)
    print(f'{tid} → {status}')
    return 0


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    data = load()
    cmd = argv[1]
    if cmd == 'next':
        task = pick(data)
        if task is None:
            print('NONE')
            return 0
        if task['status'] == 'todo':
            task['status'] = 'doing'
            save(data)
        print(json.dumps(task, ensure_ascii=False, indent=2))
        return 0
    if cmd == 'set' and len(argv) >= 4:
        return cmd_set(data, argv)
    if cmd == 'status':
        print(dict(Counter(t['status'] for t in data['tasks'])))
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
