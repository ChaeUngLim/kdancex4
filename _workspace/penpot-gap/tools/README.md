# Penpot 보드 도우미

- `pp.py` — Penpot MCP 서버(localhost:4401)에 직접 붙어 `execute_code` 를 돌린다. `python3 pp.py lib.js 보드.js`
- `lib.js` — 대표 관리자 웹 보드 공통 함수(SIDE·CARD·T·BTN·CHIP·TOG·RADIO·INPUT·BOARD·FIND)와 색 상수

쓰는 법
1. 서버 켜기: `~/.npm/_npx/f4739471492be2e8/node_modules/@penpot/mcp` 에서 `pnpm run start`(Node 24.21.0 bin 경로)
2. 사용자가 Penpot 탭에서 플러그인 Connect
3. `PENPOT_LOG=<서버 출력 파일> python3 pp.py lib.js w8_1.js`

주의
- 이 페이지는 도형 40개만 넘어도 한 호출이 30초를 넘긴다(1~2분). 한 호출은 도형 40개 이하로 나눈다.
- 시간 초과가 나도 재시도하지 않는다. 플러그인 줄에 쌓여 전부 막힌다.
- 결과는 HTML 로 묶지 않고 `penpot.viewport.zoomIntoView([보드])` 로 사용자 화면을 옮겨 보여 준다.
