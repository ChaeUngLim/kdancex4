# 인수인계 — 다른 계정·다른 PC로 이어받기

이 프로젝트를 **다른 Claude Code 계정**이나 **다른 PC**에서 이어받을 때 필요한 것을 정리했다.

작성 2026-09-20 · 기준 커밋 `7d4843a`

---

## 1. 두 경우는 난이도가 다르다

| | 같은 PC, 계정만 교체 | 다른 PC |
|---|---|---|
| 필요한 일 | `/logout` → `/login` | 아래 2·3절 전부 |
| 대화 기록 | 그대로 (47개 세션) | 안 넘어감 |
| MCP·플러그인 설정 | 그대로 | 재설정 필요 |
| 프로젝트 파일 | 그대로 | `git clone` |

**같은 PC면 사실상 할 일이 없다.** 설정과 기록이 전부 경로 기반이라 계정과 무관하게 남는다. 이어서 쓰려면 `claude --continue`.

---

## 2. git 에 있는 것 — clone 하면 따라온다

```bash
git clone https://github.com/ChaeUngLim/kdancex4.git
cd kdancex4
```

| 무엇 | 위치 |
|------|------|
| 소스 코드 | `backend/` · `admin-web/` · `mobile/` · `infra/` |
| 정책·기획 문서 | `docs/*.md` |
| 사람이 읽는 가이드 | `docs/가이드/*.html` |
| 하네스 정의 | `.claude/skills/kdance-dev-harness/` · `.claude/agents/kdance-*.md` |
| 행동 규칙 | `.claude/rules/core-rules.md` |
| 스킬 on/off 판단 | `docs/claude-skills-checklist.md` |
| SCH 스케줄표 | `_workspace/kdance.html` |
| SCH별 왕초보 가이드 | `_workspace/guides/SCH-XX(기능명).html` |
| 하네스 작업 기록 14개 | `_workspace/01_`~`05_*.md` — `Q1~Q5`(요구사항 결정 근거)·`D1~D4`(설계 결정)의 **유일한 출처** |

---

## 3. git 에 없는 것 — 다른 PC면 직접 옮긴다

### 3-1. 반드시 필요한 것

| 무엇 | 위치 | 왜 필요한가 |
|------|------|------------|
| 로컬 환경 설정 | `.claude/settings.local.json` | 프로젝트별 권한·훅 |
| 백엔드 비밀값 | `backend/.env` | **절대 git 에 올리지 않는다.** 따로 전달한다 |

### 3-2. 재설정이 필요한 것

| 무엇 | 어떻게 |
|------|--------|
| MCP 서버 9종 | `~/.claude.json` 의 `mcpServers` 를 복사하거나 `claude mcp add` 로 재등록 |
| 플러그인 5종 | `/plugin` 에서 재설치 — `ecc` · `frontend-design` · `harness` · `humanize-korean` · `ui-ux-pro-max` |
| GitHub 인증 | `gh auth login` → `gh auth setup-git` |
| git 커밋 신원 | `git config --global user.email brad213@naver.com` |
| Docker 컨테이너 | Docker Desktop 실행만 하면 된다 (`restart=unless-stopped`) |
| auto memory | `~/.claude/projects/-home-user-kdance/memory/` |
| 대화 기록 47개 | `~/.claude/projects/-home-user-kdance/*.jsonl` |

### 3-3. 계정을 바꾸면 달라지는 것

| 무엇 | 영향 |
|------|------|
| claude.ai 동기화 스킬 | **새 계정 기준으로 다시 내려온다.** 껐던 것이 되살아날 수 있으니 `docs/claude-skills-checklist.md` 를 보고 다시 끈다 |
| 요금제·모델 접근 | Opus 권한이 없으면 `/model` 로 다시 고른다 |
| 사용량 한도 | 새 계정 기준으로 리셋된다 |

---

## 4. 이어받은 뒤 확인할 것

```bash
git log --oneline -5                  # 7d4843a 가 보이면 최신
git status                            # 깨끗해야 정상
docker ps                             # 컨테이너 4개가 healthy
curl -s localhost:20128/api/health    # OmniRoute 게이트웨이
```

Claude Code 안에서 `/mcp` 로 9종 연결을, `/plugin` 으로 플러그인 5종과 스킬 on/off 를 확인한다.

---

## 5. 지금 어디까지 왔나

### 끝난 것

- **백엔드 예약 취소·환불** — `SCH-01(기반 배선)`~`SCH-10(환불 정책 문서)` 완료. pytest 159 통과
- **문서 체계** — 표기 규칙·윤문 규칙·스킬 체크리스트
- **개발 환경** — OmniRoute 무료 모델 게이트웨이, `ai` 별칭(`scripts/claude-free.sh`)

### 막혀 있는 것

| | 무엇이 필요한가 |
|---|---|
| `SCH-11(마이그레이션 검증)` · `SCH-12(DB 통합 테스트 실행)` | Docker Desktop 기동 |
| `SCH-13(외부 계정·승인 절차)`~`SCH-20(딥링크 테스트)` | `O1~O4`(경계 구간 ~ 방식 A 재확인) 결정 |

### 다음 작업

- **admin-web 화면** — `frontend-design`(미적 방향) → `ui-ux-pro-max`(설계+구현) 순. 첫 작업 때 **순수 CSS 로 나오는지 검증**한다. `ui-styling` 하위 스킬은 Tailwind 고정이라 부르지 않는다
- **`harness` 플러그인 off** — `core-rules.md` 가 호출을 금지한 범용 메타스킬이다. 프로젝트 스킬 `kdance-dev-harness` 와 헷갈리지 않는다

---

## 6. 읽는 순서

1. `CLAUDE.md` — 프로젝트 개요·기술 스택·하네스 구성
2. `.claude/rules/core-rules.md` — 행동 규칙 전부 (언어·표기·윤문·Harness/ECC 역할 분리·Git)
3. `_workspace/kdance.html` — 브라우저로 연다. 전체 작업 현황판
4. `docs/가이드/harness-ecc-guide.html` — Harness/ECC 구조 그림
5. `docs/claude-skills-checklist.md` — 스킬을 언제 켜고 끌지

HTML 은 에디터가 아니라 브라우저로 연다.

```bash
explorer.exe "$(wslpath -w ~/kdance/_workspace/kdance.html)"
```
