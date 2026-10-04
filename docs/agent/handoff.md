# 인수인계 — kdance 를 다른 계정·다른 PC 에서 이어받기

이 프로젝트를 **다른 Claude Code 계정**이나 **다른 PC** 에서 그대로 이어받는 데 필요한 것을 전부 적었다.

작성 2026-09-20 · 기준 커밋 `0e18dea`

---

## 1. 빠른 경로

```bash
git clone https://github.com/ChaeUngLim/kdancex4.git
cd kdancex4
bash docs/agent/handoff/apply-settings.sh            # 무엇이 바뀔지 먼저 본다
bash docs/agent/handoff/apply-settings.sh --apply    # 실제로 적용한다
```

스크립트가 사용자 레벨 `settings.json`, 프로젝트 스킬 on/off, MCP 서버 8종, ECC 규칙, `humanizer-kr` 스킬을 한 번에 맞춘다. 9종 중 8종만 등록하는 이유는 나머지 하나(`chrome-devtools`)를 ecc 플러그인이 들고 오기 때문이다. **Claude Code 를 끈 상태에서 돌린다** — 켜둔 채로 돌리면 `~/.claude.json` 을 서로 덮어쓴다.

스크립트가 못 하는 네 가지는 3-1 절에 있다.

---

## 2. 두 경우는 난이도가 다르다

| | 같은 PC, 계정만 교체 | 다른 PC |
|---|---|---|
| 필요한 일 | `/logout` → `/login` | 1절 + 3절 |
| 대화 기록 | 그대로 (48개 세션) | 안 넘어감 |
| MCP·플러그인 설정 | 그대로 | 재설정 |
| 프로젝트 파일 | 그대로 | `git clone` |

**같은 PC 면 사실상 할 일이 없다.** 설정과 기록이 전부 경로 기반이라 계정과 무관하게 남는다. 이어서 쓰려면 `claude --continue`.

---

## 3. 무엇이 어디에 있나

### git 이 실어 나르는 것 — clone 하면 따라온다

| 무엇 | 위치 |
|------|------|
| 소스 코드 | `backend/` · `admin-web/` · `mobile/` · `infra/` |
| 정책·기획 문서 | `docs/*.md` |
| 사람이 읽는 가이드 | `docs/guide/*.html` |
| 하네스 정의 | `.claude/skills/kdance-dev-harness/` · `.claude/agents/kdance-*.md` |
| 행동 규칙 | `.claude/rules/core-rules.md` |
| 프로젝트 훅 | `.claude/settings.json` — graphify `hook-guard` 2개 |
| 프로젝트 스킬 8종 | `.claude/skills/` — graphify · diagram-this · session-metrics 등 |
| 커맨드 17개 | `.claude/commands/` |
| 스킬 on/off 판단 근거 | `docs/agent/claude-skills-checklist.md` |
| **설정 스냅샷** | `docs/agent/handoff/` — 아래 3-2 절 |
| SCH 스케줄표 | `_workspace/SCH_kdance.html` |
| SCH 가이드 7개 | `_workspace/guides/SCH-01(기반 배선)`~`SCH-07(통합 테스트 작성).html` |
| 하네스 작업 기록 14개 | `_workspace/01_`~`05_*.md` — `Q1~Q5`(요구사항 결정 근거)·`D1~D4`(설계 결정)의 **유일한 출처** |

### 3-1. 스크립트가 대신 못 하는 것

| 무엇 | 어떻게 |
|------|--------|
| **ECC 규칙 42개** | `~/.claude/rules/ecc/` — 항상 로드되는 사용자 레벨 규칙이라 없으면 코딩 기준이 통째로 빠진다. `git clone https://github.com/affaan-m/everything-claude-code.git` 후 `rules/install.sh python typescript react react-native web` |
| **비밀값** | `backend/.env` · `mobile/.env` — git 에 없다. 따로 전달한다 |
| GitHub 인증 | `gh auth login` → `gh auth setup-git` |
| git 신원 | `git config --global user.name ChaeUngLim` · `user.email brad213@naver.com` |
| Docker | Docker Desktop 을 켜면 끝이다. 컨테이너가 `restart=unless-stopped` 라 같이 올라온다 |
| auto memory | `~/.claude/projects/-home-user-kdance/memory/` — 파일 2개 |
| 대화 기록 48개 | `~/.claude/projects/-home-user-kdance/*.jsonl` |

### 3-2. `docs/agent/handoff/` 에 들어 있는 것

| 파일 | 쓰임 |
|------|------|
| `apply-settings.sh` | 아래 넷을 한 번에 얹는 스크립트 |
| `settings.global.json` | 사용자 레벨 `~/.claude/settings.json` 목표 상태 |
| `settings.project.local.json` | 스킬 on/off 18개 — 전역 gitignore 가 원본을 막아서 사본을 둔다 |
| `mcp-kdance.json` | MCP 서버 9종 정의 (비밀값 없음) |
| `ecc-install-state.json` | ECC 를 어느 버전·어느 모듈로 깔았는지 (2.2.1 / `rules-core`) |
| `user-skills/humanizer-kr/` | 사용자 레벨 윤문 스킬 |

`.claude/settings.local.json` 은 `~/.config/git/ignore` 의 `**/.claude/settings.local.json` 규칙 때문에 git 에 올라가지 않는다. 다른 PC 에는 그 전역 규칙이 없을 수 있으니, clone 직후 `git status` 에 이 파일이 보이면 커밋하지 말고 그대로 둔다.

---

## 4. 설정 전수 목록

### MCP 9종

| 이름 | 방식 | 스코프 | 비고 |
|------|------|--------|------|
| `omniroute` | http `localhost:20128` | 사용자 | 무료 모델 게이트웨이 |
| `context7` | http | 사용자 | 라이브러리 공식 문서 |
| `github` | http | 사용자 | 인증은 OAuth |
| `mindpilot` | stdio npx | 사용자 | 구조도 — Electron 미설치 버그가 있다. `core-rules.md` 참고 |
| `memory` | stdio npx | 사용자 | `~/.claude/external/mcp-memory/memory.json` |
| `playwright` | stdio npx | 사용자 | headless chromium, 세션 `~/.cache/kdance-playwright-auth/` |
| `agent-reach` | stdio uv | 사용자 | `~/tools/Agent-Reach` 가 있어야 뜬다 |
| `postgres-kdance` | stdio npx | **프로젝트** | `postgresql://kdance:kdance@localhost:5433/kdance` |
| `chrome-devtools` | stdio npx | 플러그인 | ecc 가 들고 온다. 직접 등록하지 않는다 |

### 플러그인 6종

전역 5종은 `~/.claude/settings.json` 의 `enabledPlugins` 에 있다 — `ecc` · `frontend-design` · `harness` · `ui-ux-pro-max` · `humanize-korean`. 여기에 **`mobile/.claude/settings.json` 이 `expo` 를 하나 더 켠다**. `mobile/` 안에서 작업할 때만 붙는다.

`harness` 는 범용 메타스킬이라 프로젝트 하네스인 `kdance-dev-harness` 와 겹친다. `core-rules.md` 가 호출을 금지하니 꺼도 된다.

### 규칙 3층

| 층 | 위치 | git |
|---|---|---|
| 사용자 규칙 | `~/.claude/rules/ecc/` 42개 (common·python·typescript·react·react-native·web) | 밖 |
| 프로젝트 규칙 | `.claude/rules/core-rules.md` | 안 |
| 프로젝트 맥락 | `CLAUDE.md` · `.claude/CLAUDE.md` | 안 |

### 훅

프로젝트 훅은 `.claude/settings.json` 에 있는 graphify `hook-guard` 둘이다. `graphify` CLI 가 깔려 있어야 동작한다. 나머지 훅(GateGuard 등)은 ecc 플러그인이 들고 오므로 플러그인만 깔면 따라온다.

### 버전

| | |
|---|---|
| Claude Code | 2.1.278 |
| Node | v24.20.0 |
| Python | backend 3.12 (uv 0.12.10) |
| Docker | 29.6.2 |
| gh | 2.63.2 |
| graphify | 0.9.61 |

### 컨테이너 4개

| 이름 | 포트 | 출처 |
|------|------|------|
| `kdance-db` (pgvector pg18) | 5433 | `infra/docker-compose.yml` |
| `kdance-redis` | 6380 | `infra/docker-compose.yml` |
| `omniroute` | 20128 | compose 밖 — 수동 생성 |
| `ollama` | 11434 | compose 밖 — 수동 생성 |

뒤의 둘은 compose 파일에 없다. 다른 PC 에서는 직접 띄워야 한다.

---

## 5. 이어받은 뒤 확인

```bash
git log --oneline -3                  # 0e18dea 가 보이면 최신
git status                            # 깨끗해야 정상
docker ps                             # 컨테이너 4개
curl -s localhost:20128/api/health    # OmniRoute
cd backend && uv run pytest -q        # 159개 통과
```

Claude Code 안에서 `/mcp` 로 9종 연결을, `/plugin` 으로 플러그인과 스킬 on/off 를 본다.

---

## 6. 지금 어디까지 왔나

### 끝난 것

- **백엔드 예약 취소·환불** — `SCH-01(기반 배선)`~`SCH-10(환불 정책 문서)`. pytest 159 통과
- **문서 체계** — 표기 규칙·윤문 규칙·스킬 체크리스트
- **개발 환경** — OmniRoute 무료 모델 게이트웨이, `ai` 별칭(`~/.bashrc` 125행 → `scripts/claude-free.sh`)

### 막혀 있는 것

| | 무엇이 필요한가 |
|---|---|
| ~~`SCH-13(외부 계정·승인 절차)`~`SCH-20(딥링크 테스트)`~~ | **폐기(2026-09-25)** — 딥링크를 없애고 모든 결제를 PG 로 통일(spec FR-110(PG 단일 결제 경로)) |

`SCH-11(마이그레이션 검증)`·`SCH-12(DB 통합 테스트 실행)` 는 Docker 가 없어서 막혀 있었는데 지금은 컨테이너가 떠 있다. 바로 돌려볼 수 있다.

### 다음 작업

- **admin-web 화면** — `frontend-design`(미적 방향) → `ui-ux-pro-max`(설계·구현) 순. 첫 작업에서 **순수 CSS 로 나오는지 검증**한다. `ui-styling` 하위 스킬은 Tailwind 고정이라 부르지 않는다

---

## 7. 손봐야 할 것

| | 무엇 | 왜 |
|---|---|---|
| 1 | `mobile/.env` 14KB · 키 57개 | 대부분 **종료된 다른 프로젝트**의 키다. NVIDIA·TAVILY·EXA·OPENROUTER 등 살아 있는 키가 섞여 있으니 회수하고 kdance 에 필요한 것만 남긴다 |
| 2 | `~/.claude/settings.json` | 아직 종료된 프로젝트 기준으로 적혀 있다. `apply-settings.sh --apply` 가 교체한다 |
| 3 | ~~`_workspace/mobydick-v2-schedule.html` 49KB · `.gitignore` 34행~~ | 종료된 프로젝트 잔재 — 파일은 이미 없었고 `.gitignore` 줄은 2026-10-01 에 지웠다(완료) |
| 4 | `admin-web` 의 `npm run lint` | eslint-config-next 16 × eslint 9 순환 설정 버그. 당분간 `next build` 로 타입 검사한다 |
| 5 | `SCH-08`~`SCH-10` 가이드 | `_workspace/guides/` 에 01~07 만 있다 |

---

## 8. 읽는 순서

1. `CLAUDE.md` — 개요·스택·하네스 구성
2. `.claude/rules/core-rules.md` — 행동 규칙 전부 (언어·표기·윤문·Harness/ECC 역할 분리·Git)
3. `_workspace/SCH_kdance.html` — 전체 작업 현황판
4. `docs/guide/harness-ecc-guide.html` — Harness/ECC 구조 그림
5. `docs/agent/claude-skills-checklist.md` — 스킬을 언제 켜고 끌지

HTML 은 에디터가 아니라 브라우저로 연다.

```bash
explorer.exe "$(wslpath -w ~/kdance/_workspace/SCH_kdance.html)"
```
