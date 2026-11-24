# kdance 랄프 루프 프롬프트

> 이 파일은 `_workspace/orchestration/ralph.sh` 가 회차마다 새 대화로 넣는다. 한 회차에 **Task 하나만** 끝낸다.
> 작업 목록 원본은 `_workspace/roadmap-tasks.json` 하나뿐이다. 이 파일에 Task 를 적지 않는다.

## 0. 시작 전에

- 워커·크리틱 Workflow(`_workspace/orchestration/worker-critic-milestone.js`)가 돌고 있으면 이 루프를 돌리지 않는다. 둘이 같은 `roadmap-tasks.json` 을 고친다.
- DB 가 필요한 Task 는 `docker ps` 로 `kdance-db`·`kdance-redis` 가 healthy 인지 먼저 본다. 꺼져 있으면 그 Task 를 `blocked "Docker Desktop 꺼짐"` 으로 두고 회차를 끝낸다 — 켜는 것은 사람이 한다.

## 1. Task 받기

```bash
python3 _workspace/orchestration/ralph_next.py next
```

- `NONE` 이 나오면 할 일이 없다. `RALPH_DONE` 한 줄만 출력하고 끝낸다.
- 나온 Task 의 `goal`·`method`·`verify`·`contract`·`endpoints`·`note` 를 읽는다. status 가 이미 `doing` 이면 앞 회차가 끊긴 것이니 `_workspace/evidence/<id>/` 에 남은 것부터 본다.

## 2. 근거 읽기 (코드 쓰기 전에)

| 무엇 | 어디 |
|---|---|
| 요구사항(무엇·왜) | `specs/001-ai-dance-class-platform/spec.md` — Task 가 가리키는 FR 과 그 아래 「화면」 문단 |
| 화면(보드 글자·클릭 흐름) | `_workspace/evidence/penpot-doc-sync-2026-11-20/penpot_boards_2026-11-20.json` 에서 화면 문단의 보드 ID 로 찾는다. Penpot 을 직접 열지 않는다 |
| 순서·범위 | `_workspace/06_master-plan.md` 의 해당 슬라이스 |
| 데이터·API | `_workspace/03_data-model.md`, `_workspace/03_contracts/` (Task 의 `contract` 칸) |
| 버전 | `docs/planning/tech/tech-stack.md` 「11. 기술 스택 고정표」, `docs/agent/ai-coding-agent.html` |

문서끼리 어긋나면 spec 변경 이력의 날짜가 더 늦은 쪽을 따르고, 어긋난 사실을 증거 파일에 적는다. 날짜로 못 가리면 그 Task 를 `blocked "사람 결정: <무엇>"` 으로 두고 끝낸다.

## 3. 구현

- 테스트를 먼저 쓰고(실패 확인) 구현한다.
- 프로젝트 규칙(`CLAUDE.md`·`.claude/rules/core-rules.md`)을 따른다: `useEffect` 금지, 핵심 코드에 쉬운 한국어 주석, 버전은 추정하지 않는다.
- Task 범위 밖 파일을 고치지 않는다. 다른 Task 의 일을 미리 하지 않는다.
- 외부 API 는 무료 구간만 쓴다. 결제(PG)·본인확인은 가짜 어댑터로 간다.

## 4. 확인 (완료의 유일한 기준)

1. Task 의 `verify` 에 적힌 명령을 **그대로** 실행한다. 설명문뿐이면 그 설명을 확인하는 명령을 직접 정해 실행하고, 무엇을 돌렸는지 증거에 적는다.
2. 증거는 `leave-verifiable-evidence` 스킬 방식으로 `_workspace/evidence/<id>/` 에 남긴다. 명령은 `.claude/skills/leave-verifiable-evidence/scripts/run_logged.sh` 로 돌린다. 화면을 바꿨으면 Playwright 스크린샷을 남긴다.
3. API 를 바꿨으면 `python3 .claude/skills/leave-verifiable-evidence/scripts/api_contract_lint.py` 를 돌린다.
4. `python3 .claude/skills/leave-verifiable-evidence/scripts/check_evidence.py _workspace/evidence/<id>` 가 PASS 여야 한다.
5. 바뀐 영역의 기본 검증도 돌린다: admin-web `npm run build`·`npm test`, mobile `npx tsc --noEmit`, backend `uv run pytest -q` (CLAUDE.md 「Build, Test & Verify」 표).

증거 로그의 숫자나 exit 줄을 손으로 고치지 않는다.

## 5. 끝내기

- 통과: `python3 _workspace/orchestration/ralph_next.py set <id> done`
- 같은 Task 를 이 회차에서 세 번 고쳐도 확인이 안 되면: `set <id> blocked "<실패 요약 · 증거 경로>"`
- 사람 결정·외부 계약·키가 필요하면: `set <id> blocked "사람 결정: <무엇>"`
- 마지막 줄에 `RALPH_TASK <id> <done|blocked>` 를 출력한다.

## 하지 않는 것

- 커밋·푸시하지 않는다. `git reset --hard`·`git clean`·`push --force` 를 쓰지 않는다.
- `roadmap-tasks.json` 을 손으로 고치지 않는다. 상태는 `ralph_next.py` 로만 바꾼다.
- 테스트를 통과시키려고 테스트를 지우거나 약하게 만들지 않는다.
- Penpot·spec 을 고치지 않는다. 고칠 곳을 찾으면 증거 파일의 「문서 메모」 절에 적는다.
