# CLAUDE-troubleshooting.md — 에러와 해결법

> **이 파일이 왜 있나.** claude-mem 은 해결 과정을 자동으로 쌓지만 이 PC 의 로컬
> 캐시다. 다시 만날 수 있는 에러의 해법은 여기(git)로 옮겨 PC·도구가 바뀌어도
> 남긴다. 옮기는 시점은 Phase 9.5(학습 주석 재구성·SCH 가이드 생성)다.
>
> **복제하지 않는다.** 원본이 다른 문서에 있으면 위치만 적는다.

## 적는 기준

- **적는다**: 원인 파악에 시간이 든 에러, 오진했다가 바로잡은 에러, 환경 탓이라
  코드만 봐서는 알 수 없는 에러.
- **적지 않는다**: 오타·import 누락처럼 에러 메시지만 봐도 바로 고치는 것.

## 항목 형식

```
## {증상 한 줄} ({YYYY-MM-DD})
- 증상: 실제 에러 메시지(원문 그대로)
- 원인: 확인된 원인. 추정이면 "추정"이라고 적는다
- 해결: 실행한 명령·바꾼 파일
- 오진: 처음에 잘못 짚은 방향이 있었다면 (다음 사람이 같은 길로 가지 않게)
- 근거: 이슈 링크 · 커밋 해시 · claude-mem 관찰 ID
```

---

## 원본이 다른 곳에 있는 항목 (색인)

| 증상 | 원본 위치 |
|---|---|
| mindpilot `open_ui` 가 `spawn ... ENOENT` 로 MCP 서버를 죽임 | `.claude/rules/core-rules.md` 「mindpilot-mcp 사용 절차」 |
| admin-web `npm run lint` 실패 (eslint-config-next 16 × eslint 9) | `CLAUDE.md` Architecture — 미해결, `next build` 로 대신 검증 |
| `npm install better-auth` 가 prisma 8 과 `ERESOLVE` | `.claude/rules/core-rules.md` 「버전 정책」 실측 함정 |
| Prisma 8 런타임 패키지를 `@prisma/client` 로 찾으면 "없음" | `.claude/rules/core-rules.md` 「버전 정책」 실측 함정 |

---

## claude-mem 설치가 EALLOWSCRIPTS 로 중단 (2026-09-23)

- 증상: `npx claude-mem install` 이 "Running npm install…" 단계에서
  `Installation Aborted: unknown-install-error`. 실제 에러는
  `~/.claude-mem/last-install-error.json` 에 있다:
  `npm error code EALLOWSCRIPTS` / `--allow-scripts is not allowed in project-scoped installs.`
- 원인: `~/.npmrc` 의 `allow-scripts=@anthropic-ai/claude-code` 가 npx 를 거치며
  `npm_config_*` 환경변수로 하위 `npm install` 에 넘어간다. npm 11.17 이상은 환경변수로
  들어온 allow-scripts 를 CLI 옵션으로 취급해 프로젝트 설치에서 거부한다.
  claude-mem 쪽 버그로 upstream 에 보고돼 있다(미해결).
- 해결: npx 대신 bun 으로 설치 프로그램을 실행한다. `~/.npmrc` 는 건드리지 않는다.
  ```
  ~/.bun/bin/bun x claude-mem@latest install --ide claude-code --provider claude --model claude-haiku-4-5-20251001 --runtime worker
  ```
  업데이트할 때도 같은 방식으로 한다.
- 오진: `NPM_CONFIG_USERCONFIG` 를 빈 파일로 돌려도 **해결되지 않았다.**
  npx 가 넘기는 환경변수 경로가 따로 남는다.
- 근거: https://github.com/thedotmack/claude-mem/issues/3697 (→ #3604 로 통합),
  npm 11.19.0 · node v24.21.0 환경
