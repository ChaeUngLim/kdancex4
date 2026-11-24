---
name: leave-verifiable-evidence
description: 작업을 끝냈다고 말하기 전에 다른 사람이 다시 확인할 수 있는 증거(장면별 스크린샷, 타입 검사·계약 린터·테스트 로그)를 _workspace/evidence/<작업ID>/ 에 남긴다. 화면(admin-web·mobile·Penpot 보드·가이드 HTML)을 바꿨거나, API·스키마·의존성·spec·규칙을 바꿨거나, 워커·크리틱 방식으로 완료 판정을 할 때 쓴다. "증거 남겨", "검증 가능하게", "스크린샷 저장", "계약 대조", "완료 판정" 같은 요청에도 쓴다.
---

# leave-verifiable-evidence — 증거를 남기고 나서 끝났다고 말한다

## 검증 규칙 — 자주 하는 작업 순서

순서는 2026-09-01 이후 커밋 145개에서 바뀐 파일 수로 셌다(2026-11-19). 한 작업이 여러 종류에 걸치면 해당하는 규칙을 **모두** 지킨다.

| # | 작업 | 바뀐 파일 수 | 남길 증거 | 통과 조건 |
|---|---|---|---|---|
| 1 | **디자인 보드**(Penpot) | 984 | 바꾼 **보드마다** PNG 내보내기 `boards/<보드ID>.png` · spec 반영 grep 로그 | 보드 수 = PNG 수. 요구사항이 바뀐 보드는 spec 의 FR 문장이 grep 로그에 보인다 |
| 2 | **규칙·스킬**(`CLAUDE.md`·`.claude/rules`·`.claude/skills`) | 229 | 고친 줄 grep 로그 · 스킬이면 frontmatter(`name`·`description`) 로그 · 스크립트가 있으면 실행 로그 | 새 문장이 파일에 있다. 스크립트는 통과 사례와 실패 사례를 둘 다 한 번씩 돌린 로그가 있다 |
| 3 | **요구사항·설계 문서**(spec·PRD·플랜·계약·약관) | 약 180 | 핵심 문구를 spec·PRD·플랜 세 곳에서 센 grep 로그 · 변경 이력 행 grep 로그 | 걸리는 문서마다 1건 이상. 변경 이력에 오늘 날짜 행이 있다 |
| 4 | **가이드·설명 HTML**(`docs/guide`·SCH 가이드) | 약 130 | HTML 파서 로그 · **절마다** 브라우저 스크린샷 | 파서 exit 0. 다이어그램이 그림으로 그려졌다(코드 글자 그대로 보이면 실패) |
| 5 | **의존성·설정**(`package.json`·버전·환경 변수) | 약 100 | `npm ls <패키지>` 로그 · build 로그 · 전체 테스트 로그 | 버전이 고정표와 같다. 테스트 수가 `CLAUDE.md`「Build, Test & Verify」 기대값 이상 |
| 6 | **API**(admin-web Route Handler·backend) | 약 80 | **타입 검사 로그** · **계약 린터 로그** · 그 Task 의 테스트 로그 | 셋 다 exit 0. DB 테스트는 skip 0 |
| 7 | **화면 코드**(admin-web·mobile) | 약 20 | **장면마다** 브라우저 스크린샷 · build·tsc 로그 | 계획한 장면 수 = PNG 수. 스크린샷을 직접 열어 보고 「확인한 것」을 적었다 |

> 수치는 대략 센 값이다. 비율이 크게 바뀌면(예: M1 구현이 시작돼 6·7번이 늘면) 다시 세서 순서를 고친다.
> 셈법: `git log --since=2026-09-01 --name-only --format=` 결과를 경로 앞부분으로 묶었다.

**화면과 API 는 예외 없이 지킨다.** 화면은 무조건 브라우저로 장면마다 찍고, API 는 무조건 타입 검사와 계약 린터 로그를 남긴다. build 가 통과했다는 것만으로 화면이 맞다고 하지 않는다.

---

## 증거 폴더

```
_workspace/evidence/<작업ID>/          예: _workspace/evidence/S0-2-T3/
├── EVIDENCE.md                        증거 목록(아래 표). 크리틱이 이것부터 읽는다
├── screens/NN-장면.png                브라우저 스크린샷 (7번·4번)
├── boards/<보드ID>.png                Penpot 내보내기 (1번)
└── logs/<무엇>.log                    run_logged.sh 로 남긴 명령 로그
```

`EVIDENCE.md` 는 이 표 하나만 있으면 된다(열 순서 고정 — 검사기가 읽는다).

```markdown
| 종류 | 장면·대상 | 파일 | 확인한 것 |
|---|---|---|---|
| screen | 01 로그인 첫 화면 | screens/01-login.png | 「인증 앱 코드로」 버튼, 문구 FR-303 과 같음 |
| screen | 02 코드 틀림 | screens/02-login-wrong.png | 빨간 안내 「코드가 맞지 않아요」 |
| log | 타입 검사 | logs/tsc.log | exit 0 |
| log | 계약 린터(07) | logs/contract-lint.log | 오류 0, 07 경로 전부 구현 |
| board | W2a 입점 신청 | boards/W2a.png | 1+1 체크 칸 |
```

- 종류는 `screen`·`board`·`log`·`log-fail` 넷이다. `log` 는 exit 0 이어야 하고, `log-fail` 은 고치기 전 실패를 기록으로 남긴 로그라 exit 0 이 아니어야 한다.
- **「확인한 것」 칸을 비우지 않는다.** 찍기만 하고 안 본 스크린샷은 증거가 아니다 — 에이전트가 PNG 를 Read 로 직접 열어 본 뒤 무엇을 봤는지 적는다.
- 작업ID 는 로드맵의 Task 번호를 쓴다. 증거 폴더는 git 에서 추적한다(크리틱과 다음 세션이 같은 파일을 봐야 한다).

## 도구 세 개 (`scripts/`)

| 스크립트 | 하는 일 |
|---|---|
| `run_logged.sh <로그> <폴더> <명령…>` | 명령을 돌리고 시각·폴더·명령·git 커밋·출력 전체를 로그로 남긴다. 끝 줄은 `exit=<코드>` |
| `api_contract_lint.py [--contract 파일.md]` | 계약(`_workspace/03_contracts/*.md`) ↔ 구현(`admin-web/app/api/**/route.ts`) 1대1 대조 |
| `check_evidence.py <증거 폴더>` | `EVIDENCE.md` 의 파일이 전부 있는지, PNG 가 진짜이고 너비 320px 이상인지, 로그가 `exit=0` 으로 끝났는지 본다 |

경로가 길어서 아래에서는 `S`·`E` 로 줄여 쓴다(저장소 루트에서 실행). 프로젝트에 사본이 있으면 그것을, 없으면 전역 사본을 쓴다:

```bash
S=.claude/skills/leave-verifiable-evidence/scripts; [ -d "$S" ] || S=~/.claude/skills/leave-verifiable-evidence/scripts
E=_workspace/evidence/<작업ID>
```

계약 린터의 기본 폴더는 kdance 구조(`_workspace/03_contracts`, `admin-web/app/api`)다. 다른 프로젝트는 `--contracts <계약 폴더> --web <Next.js 앱 폴더>` 로 준다. 폴더가 없으면 exit 2 로 멈춘다.

---

## 화면 — 장면별 스크린샷 (규칙 7·4)

1. **장면 목록부터 정한다.** 화면 하나가 아니라 **사람이 보는 상태 하나 = 장면 하나**다. 첫 화면 · 입력 중 · 성공 · 오류 · 빈 목록 · 로딩 · 권한 없음 · 모달 열림처럼 그 Task 가 만든 상태를 전부 적는다. spec 수용 기준(Given/When/Then)이 있으면 시나리오 하나가 장면 하나 이상이다.
2. 띄운다 — admin-web `cd admin-web && npm run dev`, mobile `cd mobile && npx expo start --web`.
3. 찍는다 — Playwright MCP 로 장면마다:
   - `mcp__playwright__browser_navigate` → 그 상태를 만드는 조작(`browser_click`·`browser_type`·`browser_fill_form`)
   - `mcp__playwright__browser_take_screenshot` 에 `filename: "<E 절대 경로>/screens/NN-장면.png"`, 화면 전체가 필요하면 `fullPage: true`
   - 크기: 관리자 웹 1440×900, 모바일 390×844(`browser_resize`)
4. 찍은 PNG 를 **Read 로 열어 직접 본다.** 의도와 다르면 고치고 다시 찍는다. 본 내용을 「확인한 것」에 적는다.
5. 가이드 HTML(규칙 4)은 `file://` 로 열어 절마다 찍는다. 다이어그램이 그려졌는지 본다.

## API — 타입 검사 + 계약 린터 (규칙 6)

```bash
$S/run_logged.sh $E/logs/tsc.log admin-web ./node_modules/.bin/tsc --noEmit
$S/run_logged.sh $E/logs/contract-lint.log . python3 $S/api_contract_lint.py --contract 07-owner-onboarding.md
$S/run_logged.sh $E/logs/test.log admin-web npm run test:db -- tests/db/<그 Task 의 파일>
```

`npx` 대신 `./node_modules/.bin/` 을 쓴다(이 PC 의 npm 은 `npx` 에서 EALLOWSCRIPTS 를 낸다).

계약 린터가 보는 것:

| 코드 | 뜻 | 실패로 치나 |
|---|---|---|
| `MISSING` | 계약에 있는데 구현이 없다 | `--contract` 로 고른 계약이면 실패, 나머지는 경고(아직 안 만든 슬라이스) |
| `UNDOCUMENTED` | 구현했는데 어느 계약에도 없다 | 항상 실패 — 계약을 먼저 고친다 |
| `NO_SCHEMA` | POST·PUT·PATCH 가 zod `parse`/`safeParse` 를 route 파일이나 그 파일이 바로 import 하는 모듈에서 하지 않는다 | 항상 실패 |

- 경로 매개변수 이름은 무시한다(`{academyId}` = `[id]`). Better Auth 의 `/api/auth/[...all]` 은 대조에서 뺀다.
- **필드 단위 1대1(요청·응답 키 이름과 타입)은 린터가 보지 않는다.** 그 Task 의 계약 테스트(응답 본문을 zod 스키마로 parse 하는 테스트)가 맡는다. 계약 문서의 「Phase 6(테스트) 목록」이 그 목록이다.
- backend(FastAPI)를 고쳤으면 `$S/run_logged.sh $E/logs/pytest.log backend uv run pytest -q` 를 남긴다.

## 디자인 보드 — 보드별 PNG (규칙 1)

- 바꾼 보드마다 `execute_code` 안에서 `board.export({type:'png', scale:1})` 로 내보내 `boards/<보드ID>.png` 에 저장한다. `export_shape` 도구는 30초 제한에 자주 걸린다. 이미 있는 도우미는 `_workspace/penpot-gap/tools/`(`exp.sh`·`pp.py`)에 있다.
- 요구사항이 바뀐 보드는 spec 반영 확인 로그를 남긴다:
  `$S/run_logged.sh $E/logs/spec-sync.log . grep -n "<바뀐 문구>" specs/001-ai-dance-class-platform/spec.md docs/planning/prd-kdancex4.md _workspace/06_master-plan.md`

## 문서·규칙·의존성 (규칙 2·3·5)

- **grep 로그를 남긴다.** "고쳤다"가 아니라 그 문장이 그 파일 몇째 줄에 있는지가 증거다. 없어야 할 옛 문구는 `bash -c '! grep -q "옛 문구" 파일'` 처럼 감싸서, 없을 때 exit 0 이 되게 남긴다.
- 스크립트를 만들었으면 통과 사례와 실패 사례를 한 번씩 돌린 로그를 둘 다 남긴다 — 실패를 못 잡는 검사기는 검사기가 아니다.
- 의존성은 `npm ls <패키지>` 와 build·전체 테스트 로그를 남기고, 테스트 수를 `CLAUDE.md` 기대값과 견준다.

---

## 끝낼 때 — 워커와 크리틱

**워커**(만드는 쪽)
1. 위 규칙대로 증거를 남긴다.
2. `$S/run_logged.sh $E/logs/check-evidence.log . python3 $S/check_evidence.py $E` → `# 결과: PASS` 가 나와야 보고한다. 이 로그도 `EVIDENCE.md` 에 넣는다(검사기는 이 이름의 행을 자기 자신으로 보고 건너뛴다 — 크리틱은 1번에서 어차피 다시 돌린다).
3. 보고에는 증거 폴더 경로와 `EVIDENCE.md` 표를 그대로 붙인다.

**크리틱**(판정하는 쪽) — 워커의 말을 믿지 않고 이 순서로 본다
1. `python3 $S/check_evidence.py $E` 를 **직접** 다시 돌린다. FAIL 이면 내용을 볼 것도 없이 반려한다.
2. 로그 머리의 `# git:`·`# when:` 이 이번 작업 뒤인지 본다(옛 로그 재활용 금지).
3. 핵심 명령 하나 이상(타입 검사·계약 린터·그 Task 의 테스트)을 직접 다시 돌려 같은 결과인지 본다.
4. 스크린샷을 Read 로 열어 「확인한 것」이 사실인지, 장면이 빠지지 않았는지(계획한 장면 수 = PNG 수) 본다.
5. Task 의 **목표·검증 방식**(로드맵 표)을 하나씩 대조해 통과·반려를 정한다. 반려하면 무엇이 빠졌는지 한 줄씩 적는다.

## 하지 않는 것

- 증거 없이 "통과했다", "화면 확인했다"고 쓰지 않는다.
- 스크린샷을 scratchpad 나 `/tmp` 에 두지 않는다 — 세션이 끝나면 사라져 크리틱이 못 본다.
- 실패 로그를 지우고 다시 돌려 성공 로그만 남기지 않는다. 실패 로그는 `logs/<무엇>-1-fail.log` 로 이름을 바꿔 종류 `log-fail` 로 표에 남기고, 고친 뒤 다시 돌린 로그를 `log` 로 둔다.
- 비밀값(`.env` 내용·토큰·계좌번호 원문)이 로그나 스크린샷에 찍히지 않게 한다. 찍혔으면 그 파일을 지우고 가려서 다시 남긴다.
