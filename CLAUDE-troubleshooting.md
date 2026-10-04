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

## 로컬 SDXL 생성이 장당 15~35분으로 느리다 — WSL VRAM 넘침 (2026-10-03)

**증상**: `nvidia-smi` 사용률 100% 인데 전력이 25W 안팎(계산할 때는 80~115W). VRAM 7.8/8.2GB. 오류 없이 돌아가지만 Animagine 1127초·Illustrious 1176초.
**원인**: 요청 피크가 9.0GB 로 8GB 를 넘어 WSL 이 넘친 몫을 시스템 RAM 으로 보낸다. 그 구간이 수십 배 느리다. 상주 6.6GB 중 글 인코더 둘(1.52GB)이 그림 그리는 동안 놀면서 자리만 차지한 것이 결정적.
**해결**: `local-sd/server.py` 가 프롬프트 벡터를 뽑은 뒤 글 인코더를 CPU 로 내린다(기본값). 1단계 디코드에도 VAE 타일링(기본값). 피크 9.0 → 6.7GB, Animagine 67초·Illustrious 62초. 인코더 내리기는 결과가 픽셀까지 같고, 타일링은 평균 밝기차 1.9~2.9/255 로 눈으로 구분 불가.
**안 되는 것**: 어텐션 슬라이싱(더 느리고 피크 그대로), 서버 재시작(한 장 안의 피크는 못 줄임), 2단계 배율 축소(해상도 손해).
**확인법**: 서버 로그 `[txt2img] ... 피크 X GB` 가 7.5 이하인지. Windows 쪽 사진 뷰어·브라우저가 VRAM 을 나눠 쓰므로 생성 중엔 큰 그림 창을 닫는다.
**기록**: `docs/Review.md` 2026-10-03 ⑬, `docs/guide/lora-stage-c-guide.html` 「시간·VRAM 실측」.

## 로컬 SD 서버가 LoRA 적재에서 `IndexError: list index out of range` (2026-10-03)

**증상**: 특정 LoRA 만 올리면 HTTP 500. traceback 은 `load_lora_into_text_encoder` → `get_peft_kwargs`.
**원인**: 그 LoRA 가 글 인코더 가중치(`lora_te1_*`/`lora_te2_*`)를 포함하고 diffusers 0.40 이 그 키를 처리하다 실패한다. UNet 만 담은 LoRA(cowboy-bebop-illustrious-v2)는 멀쩡.
**해결**: `local-sd/server.py` `apply_loras()` 가 safetensors 를 직접 읽어 `lora_te*`·`text_encoder*` 키를 빼고 UNet 부분만 `load_lora_weights(dict)` 로 올린다. 로그에 건너뛴 키 수를 찍는다.
**확인법**: 서버 로그 `[lora] <파일>: 글 인코더 키 N개 건너뜀`.

## Penpot MCP(`npx -y @penpot/mcp`)가 설치 단계에서 `ERR_PNPM_IGNORED_BUILDS` 로 멈춤 (2026-10-03)

**원인**: pnpm 10 이상은 esbuild·sharp 의 빌드 스크립트를 기본 차단한다. 패키지의 `pnpm-workspace.yaml` 에 `allowBuilds` 자리가 자리표시자로 비어 있다.
**해결**: npx 캐시의 패키지 폴더(`~/.npm/_npx/*/node_modules/@penpot/mcp`)에서 `corepack pnpm install --dangerously-allow-all-builds` 한 번, 이후 `corepack pnpm run bootstrap` 으로 서버 둘(4400 플러그인·4401 MCP)을 띄운다. 새 버전을 받으면 다시 해야 한다.
**연결**: Claude 는 `claude mcp add penpot -s user -t http http://localhost:4401/mcp`. 브라우저 Penpot → 파일 열기 → Plugins → `http://localhost:4400/manifest.json` 로드 → "Connect to MCP server". 크롬의 로컬 네트워크 접근 팝업은 허용. 플러그인 창을 닫으면 연결이 끊긴다.
