# 워커·크리틱 반복 — 다음 세션 인계 (2026-11-19 19:05 멈춤)

사용자 지시(2026-11-19): 메인은 오케스트레이터만 한다. **워커 = Opus 5.5**(2026-11-21 사용자 결정 「항상 Opus」 — 이전: Sonnet 5.5), **크리틱 = Opus 5.5 medium**. 크리틱이 통과시켜야 다음 Task 로 간다. 같은 Task 가 3번 반려되면 막힘으로 모은다. 플랜 끝(M0 → M1 … M8 → MX)까지 멈추지 않는다. 사람 결정이나 외부 계약이 필요한 Task 와 그 뒤 Task 는 건너뛰고, 다 끝난 뒤 한꺼번에 묻는다. 완료 규칙은 `leave-verifiable-evidence` 스킬이다. 커밋하지 않는다.

## 어디까지 했나

| 구분 | 내용 |
|---|---|
| R0 로드맵 | 원자 Task 470개, 크리틱 3차에 통과. 원본은 `_workspace/roadmap-tasks.json`, 사람이 읽는 판은 `docs/guide/kdance-implementation-roadmap.html` |
| M0 통과 | S0-1.2 · S0-2.0 · S0-2.1 (각 1회에 PASS, 증거 `_workspace/evidence/<id>/`) |
| 중단 | **S0-2.2** — 워커는 끝냈지만 크리틱 판정 전에 멈췄다. 파일은 남아 있다. 다음 실행에서 이 Task 부터 다시 한다 |
| 키 | 공공데이터포털 키 2개 준비(S0-4.9·S1-1.25 완료). S0-4.11 은 막힘에서 풀었다 |
| 상태 수 | done 13 · todo 439 · blocked 18 |

## 지금 멈춘 곳 (2026-11-23 11:00)

- M2(강사) 55/55 완료(Workflow wf_99d9f06f-6b7, 9명, 막힘 0). M2-END.2 가 `calendar_color_index` 칸 목록·권한 행렬 16경로·private-lesson-rules 401 순서를 고쳤다. admin-web 전체 테스트 1931 passed
- **M3(회원) 57개 실행 중** — Workflow wf_3b9e8f75-9eb. M3-END.4 는 처음부터 막힘(U5 backend 삭제 시점 승인)
- 마지막에 물을 것에 더함: PRODUCT_CLOSED 오류 코드를 계약 11 §10-1 에 적을지(S2-4.10) · 수강권 목록 awaitingPayment.until 은 M3 주문 만료가 생기면 채운다 · S2-3.13 목록 item 의 계약 밖 status 칸

## 이전 멈춘 곳 (2026-11-22 00:50, 사용자 「여기까지」)

- M0 57/57 · M1(대표) 76/76 · **M2(강사) 50/55** — 남은 것: S2-3.13(소속 해제 요청 목록·거절·취소 API, 워커 도중 멈춤 — 증거 폴더가 반쯤 있어 다음 실행이 이어 함) · S2-4.10(개인 레슨 상품·모집 시간·수강권 목록 API) · M2-END.1~3
- **이어 하기**: `python3 _workspace/orchestration/make_args.py M2` → Workflow(scriptPath 그대로, args JSON 값) → 끝나면 verdict 있는 Task done 반영 → `sync_verify_paths.py` → M3(회원) 시작
- M2 끝에서 확인할 것: `tests/db/instructor-affiliation-tables.db.test.ts` ① 칸 목록에 `calendar_color_index` 가 반영됐는지(M2-END.2 가 안 고쳤으면 직접 고친다)
- 마지막에 한꺼번에 물을 것: 강사 앱 화면 일부가 갈색 테마·녹색 「승인됨」 배지(딥 플럼 규칙과 다름, S2-1.10 크리틱) · schedule-check `suggestions` 를 겹칠 때만 낼지(S2-2.8c 크리틱) · 홀 목록 권한을 웹 요청이면 class_manage 로 보는 면별 판정을 계약 §3-4 에 적을지(S2-2.8a) · 처음부터 막힌 17개
- 2026-11-22 워커 지시문에 「승인된 구현이니 대화의 진행 현황 질문에 멈추지 않는다」 한 줄을 넣었다 — 실행 중 사용자가 현황을 묻자 워커 5명이 구현을 거부한 일이 있었다

## 내일 이어 하는 법 (메인 에이전트가 한다)

1. 저장소 루트에서 args 를 만든다: `python3 _workspace/orchestration/make_args.py M0`
2. Workflow 를 `scriptPath: /home/user/kdance/_workspace/orchestration/worker-critic-milestone.js` 로 부른다. `args` 에는 1번 출력을 **JSON 값 그대로** 넣는다. 문자열로 넣으면 안 된다 — 2026-11-19 에 자리표시 문자열을 넘겨 글자 하나하나를 Task 로 처리한 적이 있다.
3. 끝나면 결과(`done`·`blocked`)를 보고 `roadmap-tasks.json` 의 status 를 고친다. 이어서 `python3 _workspace/orchestration/sync_verify_paths.py` 를 돌려 verify 칸의 자리표시 테스트 이름(`tests/db/s1-2-3.db.test.ts` 같은)을 워커가 실제로 만든 기능 이름 파일로 바꾼다(2026-11-21, 못 찾은 것은 출력을 보고 손으로). 그다음 M1 로 1~2번을 되풀이한다. Workflow 1회 에이전트 상한이 1000개라 마일스톤 단위로 나눠 돈다.
4. 전부 끝나면 막힌 Task 목록을 사용자에게 한 번에 묻는다.

## 알아 둘 것

- 스크립트 규칙: 선행 칸의 「X 전체」·「Mn 완료」는 묶음으로 읽는다. 로드맵이 **처음부터** 막힘으로 둔 Task 는 직접 선행으로 건 Task 만 막고, 묶음 선행으로는 번지지 않는다(가짜 어댑터로 계속 간다).
- Blast Radius 확인 창: 2026-11-20 플러그인을 통째로 껐다(`~/.claude/settings.json` 에서 false). auto mode 중 확인 창이 떠서 반복이 멈췄기 때문이다. 이제 git reset --hard·git clean·push --force 는 훅이 막아 주지 않으니 오케스트레이터가 먼저 사용자에게 묻는다.
- 워커가 Playwright MCP 를 못 쓰면 `~/.cache/ms-playwright/chromium-1247` 헤드리스로 스크린샷을 찍는다(R0 때 그렇게 했다).
- 공공데이터포털 키 원문이 채팅에 노출됐다. 정식 운영 전에 재발급한다(파일 `~/.config/kdance/public-data.env`).

## 2026-11-24 저녁 사용자 결정 — 정산은 크리틱을 묶지 않는다

- 환불(S4)·정산 원장·지급(S5)·결제 Task 는 지금처럼 **Task 마다 크리틱**이 통과시켜야 다음으로 간다. 묶음 검사는 하지 않는다(「정산은 중요하니까 묶어서 하지마」).
- 화면·문구 Task 의 묶음 검사는 정하지 않았다 — 사용자가 따로 하라고 할 때까지 전체를 기존 규칙 그대로 돌린다.
