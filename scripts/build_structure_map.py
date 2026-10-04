#!/usr/bin/env python3
"""저장소 구조 지도 HTML 을 만든다 → docs/guide/structure-map.html

무엇을 하나
- 아래 TREE 에 적힌 폴더·파일(역할·성격·한 줄 설명)을 접었다 펼 수 있는 트리로 그린다
- 다섯 층(환경·명세·파이프라인·공구·설명) 그림, 소스 구조 정의, 문서 흐름, 원본 표를 같이 넣는다
- 적힌 경로가 실제로 있는지 검사하고(없으면 경고), git 이 추적하는데 트리에 빠진 파일을 알려 준다
  → 파일을 옮기거나 이름을 바꾸면 이 스크립트의 TREE 를 고치고 다시 돌린다

사용법:
    python3 scripts/build_structure_map.py          # HTML 생성 + 검사 결과 출력
    python3 scripts/build_structure_map.py --check  # 검사만 (파일을 쓰지 않는다)

표준 라이브러리만 쓴다. 글 내용(설명 문구)의 원본은 docs/structure-map.md 와 같다 — 둘이 어긋나면 md 를 먼저 고친다.
"""
from __future__ import annotations

import html
import subprocess
import sys
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "docs" / "guide" / "structure-map.html"
BASED_ON = "2026-10-01"

# 층(layer) — core-rules.md 의 4계층 + 설명 층
LAYERS = {
    "env": ("🧱", "환경", "어떤 규칙과 권한으로 일하나", "코드를 다루지 않는다", "#4fc3f7"),
    "spec": ("📐", "명세", "무엇을 왜 만드나", "코드를 보지 않는다", "#ffd54f"),
    "pipe": ("🏗", "파이프라인", "어떤 순서로 하나", "코드를 보되 고치지 않는다", "#81c784"),
    "tool": ("🛡", "공구", "어떻게 제대로 만드나", "코드를 고친다", "#ffb74d"),
    "expl": ("📖", "설명", "끝난 것과 판단을 어떻게 남기나", "결정하지 않는다", "#ce93d8"),
}

# 성격(kind) 배지
KINDS = {
    "원본": ("다른 파일이 참조하는 단일 진실 원천", "#ffd54f"),
    "파생": ("원본에서 만들어지거나 원본을 요약", "#9aa4b2"),
    "로컬": ("git 이 추적하지 않음", "#e57373"),
    "폐기예정": ("결정은 났지만 파일은 남아 있음", "#e57373"),
    "재생성": ("명령 한 번으로 다시 만들 수 있음", "#81c784"),
    "설치본": ("외부 도구가 깔아 둔 것 — 손으로 고치지 않음", "#9aa4b2"),
    "미추적": ("아직 git add 하지 않은 새 파일", "#ffb74d"),
}

# ── 트리 데이터 ─────────────────────────────────────────────────────────────
# 노드: (경로, 층, 성격 목록, 한 줄 설명, 자식 목록)   자식이 None 이면 파일이다.
# 경로는 저장소 루트 기준. 폴더는 끝에 / 를 붙인다. 뭉텅이로 적을 때는 glob(*) 을 쓰고 설명에 개수를 적는다.
def N(path, layer, kinds, desc, children=None):
    return {"path": path, "layer": layer, "kinds": kinds, "desc": desc, "children": children}


TREE = [
    N("CLAUDE.md", "env", ["원본"], "프로젝트 문맥 · 빌드·검증 명령 · 하네스 변경 이력. 규칙은 core-rules.md 에 둔다"),
    N("CLAUDE-decisions.md", "env", ["원본"], "설계 결정 ADR-001~005 (기억 장치 · 에이전트 서버 분리 · 스트림 번역 등)"),
    N("CLAUDE-troubleshooting.md", "env", ["원본"], "알려진 오류와 해결 — 디버깅할 때 먼저 본다"),
    N("README.md", "expl", [], "학습 진입점 — 처음 보는 사람이 읽는 순서"),
    N(".gitignore", "env", [], "무엇을 추적하지 않나 (Review.md · 그 그림 · graphify-out · 스크래치)"),
    N("skills-lock.json", "env", ["설치본"], "설치된 스킬 잠금"),
    N(".claude/", "env", [], "환경 + 파이프라인 — 규칙·에이전트·스킬·훅", [
        N(".claude/rules/core-rules.md", "env", ["원본"], "규칙 원본 — 언어 · 4계층 · 식별자 표기 · 버전 정책 · 진행 리뷰 · 커밋 문체"),
        N(".claude/settings.json", "env", [], "훅 2개(graphify) — 품질 게이트 훅은 아직 없다"),
        N(".claude/CLAUDE.md", "env", [], "graphify 스킬 트리거 한 줄"),
        N(".claude/agents/", "pipe", [], "에이전트 12개", [
            N(".claude/agents/kdance-*.md", "pipe", ["원본"], "Phase 1~9 담당 8개 — req-analyst · impl-planner · task-splitter · implementer · test-runner · bug-fixer · code-reviewer · completion-verifier"),
            N(".claude/agents/code-searcher.md", "pipe", [], "Phase 2(기존 코드 구조 확인) — 공용"),
            N(".claude/agents/memory-bank-synchronizer.md", "env", [], "CLAUDE-*.md 를 코드 현실과 맞춘다"),
            N(".claude/agents/ux-design-expert.md", "tool", [], "admin-web · mobile 화면 설계 보조"),
            N(".claude/agents/get-current-datetime.md", "env", [], "날짜 확인 전용"),
        ]),
        N(".claude/skills/", "pipe", [], "스킬 18개 — 쓰는 것과 안 쓰는 것이 섞여 있다", [
            N(".claude/skills/kdance-dev-harness/", "pipe", ["원본"], "Phase 1~9.5 오케스트레이터(SKILL.md) + 산출물 표준 3종(references/ — 학습 주석 · 사람용 가이드 · 에이전트용 md)"),
            N(".claude/skills/speckit-specify/", "spec", [], "spec-kit 중 유일하게 쓰는 것 — 기능 명세 생성"),
            N(".claude/skills/speckit-*/", "spec", ["폐기예정"], "나머지 9개(plan·tasks·implement·analyze·converge·clarify·checklist·constitution·taskstoissues) — 규칙상 사용 금지, 삭제 결정 대기"),
            N(".claude/skills/graphify/", "expl", ["설치본"], "지식 그래프 — 코드 질문 전에 `graphify query` 를 먼저 돌린다"),
            N(".claude/skills/diagram-this", "expl", ["설치본"], "`.agents/skills/diagram-this` 로 가는 심볼릭 링크 — Mermaid → HTML 뷰어"),
            N(".claude/skills/ai-image-creator/", "tool", ["설치본"], "OpenRouter 경유 이미지 생성 스킬 — 장르 카드는 이것 대신 docs/prototype/gen_genre_images.py 를 쓴다"),
            N(".claude/skills/session-metrics/", "env", ["설치본"], "세션 토큰·비용 집계 (+ audit-session-metrics · task-breakdown 보조 2종)"),
            N(".claude/skills/audit-session-metrics/", "env", ["설치본"], "session-metrics 결과 감사"),
            N(".claude/skills/task-breakdown/", "env", ["설치본"], "세션을 작업 단위로 묶어 본다"),
            N(".claude/skills/claude-docs-consultant/", "env", ["설치본"], "Claude Code 공식 문서 조회"),
        ]),
        N(".claude/commands/", "env", ["설치본"], "슬래시 명령 14개(+보안 테스트 예시 6) — anthropic · architecture · documentation · refactor · security 등 범용 템플릿"),
    ]),
    N(".agents/skills/diagram-this/", "expl", ["설치본"], "diagram-this 스킬 본체 (mermaid.min.js 3.5MB 포함)"),
    N(".specify/", "spec", ["설치본"], "spec-kit 설정 — memory/constitution.md 는 core-rules.md 를 가리키는 포인터, templates/ 는 Phase 3·4 산출물 규격의 출처"),
    N("specs/001-ai-dance-class-platform/", "spec", [], "요구사항 명세 — 제품 요구사항의 단일 진실 원천", [
        N("specs/001-ai-dance-class-platform/spec.md", "spec", ["원본"], "FR·US·SC · 변경 이력 · 미해결 질문 · FR 색인 (약 300KB)"),
        N("specs/001-ai-dance-class-platform/checklists/requirements.md", "spec", ["파생"], "명세 품질 체크리스트"),
        N("specs/001-ai-dance-class-platform/local-ai-capacity.md", "spec", [], "노트북 한 대의 AI 수용량 실측 — S0(베타) 규모 근거"),
    ]),
    N("docs/", "spec", [], "명세 + 설명 — 2026-10-01 재편: 성격별 7개 폴더", [
        N("docs/structure-map.md", "expl", ["원본"], "이 지도의 글 원본 — 계층 · 연관성 · 정합성 점검 · 재편 기록"),
        N("docs/policy/", "spec", [], "정책 원본 6종 — 값을 바꾸려면 여기서", [
            N("docs/policy/payment-method-policy.md", "spec", ["원본"], "결제 수단 · 환불 정책 (spec 과 짝)"),
            N("docs/policy/pricing-policy.md", "spec", ["원본"], "요금 · 대학생 램프 · 1+1 쿠폰"),
            N("docs/policy/distribution-policy.md", "spec", ["원본"], "Android 단일 배포 · 앱 이름 k-dancex4"),
            N("docs/policy/genre-taxonomy-policy.md", "spec", ["원본"], "장르 4종 분류 (댄스스포츠 · 탱고 · 스윙 · 살사·바차타)"),
            N("docs/policy/admin-input-policy.md", "spec", ["원본"], "포스터 업로드 → OCR → 검토 → 게시"),
            N("docs/policy/subscription-benefits.md", "spec", ["원본"], "멤버십 혜택"),
        ]),
        N("docs/legal/", "spec", [], "약관 3종 (법률 검토 전 초안) + 보관본", [
            N("docs/legal/terms-of-service.md", "spec", ["원본"], "회원 이용약관"),
            N("docs/legal/merchant-terms.md", "spec", ["원본"], "입점(학원·주최자) 약관"),
            N("docs/legal/privacy-policy.md", "spec", ["원본"], "개인정보 처리방침"),
            N("docs/legal/archive/terms-2026-09-25/", "spec", ["파생"], "약관 상세판 보관본 — 조문별 근거. 같은 내용의 .zip 은 미추적 중복(삭제 결정 대기)"),
        ]),
        N("docs/planning/", "spec", [], "서비스 정의 · 기획 · 분석", [
            N("docs/planning/kdancex4_service_definition_and_tech_stack.md", "spec", ["원본"], "서비스 정의 · 「11. 기술 스택 고정표」= 버전 값의 원본 (약 136KB)"),
            N("docs/planning/plan-summary.md", "spec", ["파생"], "기획 요약"),
            N("docs/planning/requirements-analysis.md", "spec", ["파생"], "FR 별 출처 분석"),
            N("docs/planning/role-split-analysis.md", "env", ["파생"], "4계층 역할 분리 근거 (core-rules 가 가리킨다)"),
        ]),
        N("docs/guide/", "expl", [], "사람이 읽는 HTML 가이드 11개 — GitHub 에서는 raw 로만 보이니 내려받아 연다", [
            N("docs/guide/structure-map.html", "expl", ["재생성"], "이 파일 — scripts/build_structure_map.py 가 만든다"),
            N("docs/guide/harness-ecc-guide.html", "expl", [], "Harness × ECC 왕초보 완벽분석가이드 — 개발 방식 전체 그림"),
            N("docs/guide/payment-system-guide-for-beginners.html", "expl", [], "결제 시스템 왕초보 설명"),
            N("docs/guide/reservation-refund-diagrams.html", "expl", [], "예약 취소 · 환불 흐름 그림"),
            N("docs/guide/kdance-screens-spec.html", "expl", [], "화면 명세 (09-14 기준)"),
            N("docs/guide/kdance-beta-infra.html", "expl", [], "베타 인프라 설명"),
            N("docs/guide/omniroute-setup.html", "expl", [], "OmniRoute 설정 — 무료 모델 폴백 구성의 원본"),
            N("docs/guide/omniroute-setup-visual-guide.html", "expl", [], "OmniRoute 그림 가이드 (이미지는 ../assets/omniroute-guide/)"),
            N("docs/guide/penpot-mcp-guide.html", "expl", [], "Penpot MCP 연결·사용법과 날짜별 이슈 일지 (문제 생길 때마다 이어 적는다)"),
            N("docs/guide/playwright-mcp-windows-chrome-guide-for-beginners.html", "expl", [], "Playwright MCP + Windows Chrome 연결 가이드"),
            N("docs/guide/social-dance-app-dev-guide.html", "expl", [], "초기 개발 가이드 (09-13, 일부 서술은 정책으로 대체됨)"),
            N("docs/guide/social-dance-academy-pitch.html", "expl", [], "초기 입점 설명회 피치 (HTML 판)"),
        ]),
        N("docs/agent/", "env", [], "에이전트가 읽는 문서 + 인수인계", [
            N("docs/agent/ai-coding-agent.html", "env", ["원본"], "스택 전체 개요 — 최신에서만 되는 것, 실측/미검증 표시. 버전 값은 고정표를 가리킨다"),
            N("docs/agent/handoff.md", "env", ["원본"], "다른 PC · 계정으로 옮기는 절차"),
            N("docs/agent/handoff/", "env", [], "설정 묶음 — apply-settings.sh · settings.global.json · settings.project.local.json · mcp-kdance.json · ecc-install-state.json · user-skills/"),
            N("docs/agent/claude-skills-checklist.md", "env", [], "스킬을 언제 켜고 끄나 (settings.local.json 의 skillOverrides 설명)"),
        ]),
        N("docs/deprecated/", "spec", ["폐기예정"], "09-25 결정으로 폐기된 설계 — 기록으로만 둔다", [
            N("docs/deprecated/payment-deeplink-reference.md", "spec", ["폐기예정"], "원클릭 송금 딥링크 A안 참고"),
            N("docs/deprecated/sch-payment-deeplink-implementation.md", "spec", ["폐기예정"], "딥링크 A안 구현 스케줄 (SCH-11~20 옛 번호)"),
        ]),
        N("docs/deck/", "expl", ["파생"], "발표 자료 pptx 2개 — scripts/build_*_pptx.py 가 만든다", [
            N("docs/deck/K-DanceX4_입점설명회_대표강사회원.pptx", "expl", ["재생성", "미추적"], "입점 설명회 22장 (09-30 기준) ← build_onboarding_pptx.py"),
            N("docs/deck/kdance_화면명세서.pptx", "expl", ["재생성"], "화면 명세 (09-14 기준, 장르 5종·옛 결제 규칙) ← build_screens_pptx.py"),
        ]),
        N("docs/prototype/", "expl", ["미추적"], "화면 프로토타입과 디자인 자산 (09-30 신설)", [
            N("docs/prototype/kdance-prototype.html", "expl", [], "클릭형 프로토타입 — 회원 11 · 강사 3 · 대표 콘솔 6 화면"),
            N("docs/prototype/kdance-screens-2026.html", "expl", [], "Figma 캡처용 화면 보드 — 토큰 시트 + 회원 11 · 강사 4 · 대표 4 (Figma 파일 fScpcgZSj4TeIf4v7rDhwi)"),
            N("docs/prototype/gen_genre_images.py", "tool", [], "장르 카드 생성기 — Cloudflare Workers AI FLUX.2 [dev] 기본, `--out-dir`·`--seed-offset` 로 후보 세트를 따로 뽑는다"),
            N("docs/prototype/build_compare.py", "tool", [], "현재 카드 vs 후보 카드 비교 페이지 생성기 → genre-compare.html"),
            N("docs/prototype/genre-compare.html", "expl", ["재생성"], "비교 페이지 (후보가 생기면 다시 만든다)"),
            N("docs/prototype/assets/genres/", "expl", [], "장르 카드 4장 + reference.jpg(참고 유화) · candidate/ 에 후보가 들어간다"),
        ]),
        N("docs/assets/", "expl", [], "그림 자산", [
            N("docs/assets/structure/", "expl", [], "구조 지도 그림 3장 .mmd + .png (s01 레이어 · s02 문서 연관 · s03 backend 의존)"),
            N("docs/assets/omniroute-guide/", "expl", [], "OmniRoute 가이드 이미지 43장"),
            N("docs/assets/review/", "expl", ["로컬"], "Review.md 의 그림 — 로컬 전용"),
        ]),
        N("docs/Review.md", "expl", ["로컬", "원본"], "진행 리뷰 — 일별 · SCH별. 푸시하지 않는다"),
    ]),
    N("_workspace/", "pipe", [], "파이프라인 산출물 — 인수인계에 필요한 것만 추적", [
        N("_workspace/SCH_kdance.html", "pipe", ["재생성", "원본"], "SCH 목록 · 순서 · 상태 — 번호와 기능명의 원본. build_sch_kdance.py 로 만든다"),
        N("_workspace/build_sch_kdance.py", "pipe", ["원본"], "SCH 데이터는 여기서 고친다"),
        N("_workspace/01_req-analyst_requirements.md", "pipe", [], "SCH-21 회차 Phase 1(요구사항 분석) 산출물"),
        N("_workspace/02_code-searcher_structure.md", "pipe", [], "SCH-21 회차 Phase 2(기존 코드 구조 확인) 산출물"),
        N("_workspace/guides/", "expl", ["파생"], "끝난 조각의 왕초보 가이드 SCH-01~07 + diagrams/ 그림 21장"),
    ]),
    N("backend/", "tool", ["폐기예정"], "FastAPI 1회차 슬라이스 (예약 취소·환불) — SCH-21(FastAPI→Next.js 전환)에서 교체 예정", [
        N("backend/app/main.py", "tool", [], "문 · 앱 조립 · CORS · /health"),
        N("backend/app/routers/", "tool", [], "문 · reservations.py(취소·미리보기) · admin_academies.py(환불 비율표 ⛔)"),
        N("backend/app/schemas/", "tool", [], "모양 · cancellation.py · academy.py ⛔ — 요청·응답 형태"),
        N("backend/app/services/", "tool", [], "판단 · cancellation.py(취소 11단계, 1,069줄) · refund_policy.py ⛔ · fee_policy.py(읽는 코드 없음)"),
        N("backend/app/adapters/", "tool", [], "경계 · PG · 알림 · 슬롯락 Protocol + Fake"),
        N("backend/app/deps.py", "tool", [], "경계 · 임시 인증(X-User-Id) · 어댑터 주입"),
        N("backend/app/models/", "tool", [], "데이터 · 테이블 7종 + base.py"),
        N("backend/app/db.py", "tool", [], "데이터 · 엔진 · 세션 · get_db (config.py ← .env)"),
        N("backend/app/config.py", "tool", [], "데이터 · .env 를 읽는 설정"),
        N("backend/app/__init__.py", "tool", [], "패키지 표시"),
        N("backend/alembic/", "tool", [], "데이터 · env.py + versions/0001_initial_domain.py (17문)"),
        N("backend/alembic.ini", "tool", [], "alembic 설정"),
        N("backend/tests/", "tool", [], "검증 · 8파일 186건 (requires_db 27건은 kdance_test DB 필요)"),
        N("backend/pyproject.toml", "tool", ["원본"], "의존성 — uv.lock 과 짝. 버전은 고정표가 따라간다"),
        N("backend/uv.lock", "tool", ["재생성"], "잠금 파일"),
        N("backend/.env.example", "tool", [], "환경 변수 예시 (실제 .env 는 로컬)"),
        N("backend/.python-version", "tool", [], "Python 3.12"),
        N("backend/README.md", "expl", [], "backend 실행법"),
    ]),
    N("admin-web/", "tool", [], "Next.js 16 대표 콘솔 — SCH-21 부터 제품 API 도 여기로", [
        N("admin-web/app/", "tool", [], "App Router — layout.tsx · page.tsx(대시보드) · refund-policy/page.tsx ⛔ · globals.css"),
        N("admin-web/components/", "tool", [], "AdminNav.tsx · RefundPolicySettings.tsx ⛔"),
        N("admin-web/lib/api-client.ts", "tool", [], "FastAPI 를 부르는 얇은 fetch 래퍼 (NEXT_PUBLIC_API_BASE_URL)"),
        N("admin-web/package.json", "tool", ["원본"], "prisma 8 · better-auth · ai · langgraph · MCP SDK 설치됨 — 아직 import 하는 소스 없음"),
        N("admin-web/package-lock.json", "tool", ["재생성"], "잠금 파일"),
        N("admin-web/AGENTS.md", "tool", ["설치본"], "Next.js 16 이 깔아 둔 에이전트용 문서 (CLAUDE.md 는 이것을 @참조)"),
        N("admin-web/CLAUDE.md", "tool", ["설치본"], "@AGENTS.md 한 줄"),
        N("admin-web/README.md", "expl", [], "admin-web 실행법"),
        N("admin-web/public/", "tool", [], "favicon.svg · icons.svg"),
        N("admin-web/eslint.config.mjs", "tool", ["폐기예정"], "FlatCompat 순환 참조로 lint 가 깨져 있다 — 검증은 next build 로"),
        N("admin-web/tsconfig.json", "tool", [], "TS 6.0.3 설정"),
        N("admin-web/postcss.config.mjs", "tool", [], "PostCSS"),
        N("admin-web/next-env.d.ts", "tool", ["설치본"], "Next.js 가 만드는 타입 선언"),
        N("admin-web/.env.example", "tool", [], "NEXT_PUBLIC_API_BASE_URL 예시 (실제는 .env.local)"),
        N("admin-web/.gitignore", "tool", ["설치본"], "Next.js 기본"),
    ]),
    N("mobile/", "tool", [], "Expo 58 회원 앱", [
        N("mobile/App.tsx", "tool", [], "데모 화면 하나 — FastAPI 옛 취소 흐름을 부른다 (SCH-32·33 에서 다시 만든다)"),
        N("mobile/index.ts", "tool", [], "진입점 — App 등록"),
        N("mobile/app.json", "tool", ["원본"], "Expo 설정 · 패키지 com.kdancex3"),
        N("mobile/package.json", "tool", ["원본"], "expo 58.0.0-preview.6 · react-native 0.88.0-rc.1"),
        N("mobile/package-lock.json", "tool", ["재생성"], "잠금 파일"),
        N("mobile/AGENTS.md", "tool", ["설치본"], "Expo 가 깔아 둔 에이전트용 문서 (CLAUDE.md 는 이것을 @참조)"),
        N("mobile/CLAUDE.md", "tool", ["설치본"], "@AGENTS.md 한 줄"),
        N("mobile/.claude/settings.json", "tool", ["설치본"], "Expo 가 깔아 둔 프로젝트 설정"),
        N("mobile/assets/", "tool", [], "아이콘 · 스플래시 6장"),
        N("mobile/tsconfig.json", "tool", [], "TS 설정"),
        N("mobile/.env.example", "tool", [], "API 주소 예시"),
        N("mobile/.gitignore", "tool", ["설치본"], "Expo 기본"),
        N("mobile/LICENSE", "tool", ["설치본"], "템플릿 라이선스"),
    ]),
    N("infra/", "tool", [], "로컬 인프라", [
        N("infra/docker-compose.yml", "tool", ["원본"], "kdance-db(pgvector 0.8.6-pg18, 5433) · kdance-redis(6380) · kdance-llm(llama-server 11436) · ollama(멈춤)"),
        N("infra/ai-bench/", "tool", [], "동시 N명 첫 글자 · 완료 시간 측정 스크립트 2개"),
        N("infra/.env.example", "tool", [], "compose 환경 변수 예시"),
    ]),
    N("scripts/", "tool", [], "저장소 전체에 걸친 스크립트 (2026-10-01 pptx 생성기 3개를 docs/ 에서 옮김)", [
        N("scripts/build_structure_map.py", "expl", ["원본"], "이 지도 HTML 생성기"),
        N("scripts/build_onboarding_pptx.py", "expl", [], "입점 설명회 pptx → docs/deck/ (uv run --with python-pptx)"),
        N("scripts/build_screens_pptx.py", "expl", [], "화면 명세 pptx → docs/deck/ (09-14 기준)"),
        N("scripts/build_pitch_pptx.py", "expl", ["폐기예정"], "옛 입점 설명회 pptx (09-14 기준) — build_onboarding 이 대체"),
        N("scripts/claude-free.sh", "env", [], "OmniRoute 무료 체인으로 Claude Code 실행"),
    ]),
    N("graphify-out/", "expl", ["로컬", "재생성"], "지식 그래프 — `graphify update .` 로 다시 만든다"),
]

# ── 소스 구조 정의 ───────────────────────────────────────────────────────────
SOURCE_LAYERS = [
    ("문", "요청이 들어오는 곳", "main.py · routers/", "HTTP 를 받아 모양으로 바꾸고 판단에 넘긴다. 업무 규칙을 쓰지 않는다", "#4fc3f7"),
    ("모양", "요청·응답의 형태", "schemas/", "Pydantic 모델. 검증은 여기서 끝낸다", "#ce93d8"),
    ("판단", "업무 규칙", "services/", "취소 11단계 같은 순서와 조건. DB 와 바깥 세상은 경계를 통해서만 만진다", "#ffd54f"),
    ("경계", "바깥 세상과의 접점", "adapters/ · deps.py", "PG · 알림 · 슬롯락의 Protocol + Fake. 인증 · 주입도 여기", "#ffb74d"),
    ("데이터", "저장", "models/ · db.py · alembic/", "테이블과 세션. 판단을 넣지 않는다", "#81c784"),
    ("검증", "테스트", "tests/", "층마다 짝이 있다 — 판단 50 · 경계 33 · 모양 39 · 전 층 DB 27", "#9aa4b2"),
]

PLACEMENT_RULES = [
    ("새 API 하나", "backend/app/routers/ 에 문 → schemas/ 에 모양 → services/ 에 판단 → 필요하면 adapters/ 에 경계 → tests/ 에 짝. SCH-21 이후에는 admin-web/app/api/ 와 server actions 로 같은 구분을 옮긴다"),
    ("정책 값(수수료·환불 비율·장르)", "docs/policy/*.md 가 원본. 코드에는 상수로 옮기고 주석에 정책 파일 경로를 적는다(backend/app/adapters/*.py 가 그 예)"),
    ("버전", "docs/planning/…tech_stack.md 「11. 기술 스택 고정표」만 고친다. CLAUDE.md · ai-coding-agent.html 은 값을 복제하지 않고 표를 가리킨다"),
    ("사람이 읽는 설명", "docs/guide/*.html. SCH 단위 가이드는 _workspace/guides/"),
    ("에이전트가 읽는 설명", "docs/agent/. SCH 단위는 _workspace/guides/SCH-XX(기능명).md"),
    ("일회성 생성 스크립트", "scripts/. 산출물은 docs/deck/ 같은 결과 폴더에, 스크립트는 결과 폴더에 두지 않는다"),
    ("화면 프로토타입 · 디자인 자산", "docs/prototype/. 이미지 생성기와 비교 페이지도 여기(디자인 작업에 묶여 있어서)"),
    ("규칙 · 권한 · 훅", ".claude/rules/core-rules.md · .claude/settings.json. CLAUDE.md 에는 문맥만"),
]

SOURCE_OF_TRUTH = [
    ("요구사항 FR·US·SC 와 공식 짧은 이름", "specs/…/spec.md", "SCH_kdance.html · 약관 · Review · 가이드 · 정의서"),
    ("버전", "정의서 「11. 기술 스택 고정표」", "CLAUDE.md · ai-coding-agent.html · 에이전트 md"),
    ("실제 설치본", "package.json · pyproject.toml · docker-compose.yml", "실측 뒤 고정표를 고친다 — 표가 설치본을 따라간다"),
    ("규칙", ".claude/rules/core-rules.md", "CLAUDE.md · 하네스 스킬 · 에이전트 · constitution.md(포인터)"),
    ("설계 결정", "CLAUDE-decisions.md (ADR)", "정의서 · Review · 스케줄표"),
    ("SCH 번호·기능명·상태", "_workspace/SCH_kdance.html (← build_sch_kdance.py)", "Review 2부 · 가이드 · 소스 학습 주석"),
    ("결제·환불 정책", "docs/policy/payment-method-policy.md + spec", "약관 · 가이드 · 스케줄표"),
    ("저장소 구조", "docs/structure-map.md + scripts/build_structure_map.py", "README · 이 HTML"),
    ("진행 판단과 막힌 것", "docs/Review.md (로컬)", "— (읽기만)"),
]

REORG_LOG = [
    ("docs/policy/", "정책 6종", "docs/*.md 25개가 한 층에 섞여 있어 읽는 사람이 헤맸다 — 성격별로 나눴다"),
    ("docs/legal/", "약관 3종 + archive/", "약관은 법률 검토가 따로 붙는 문서라 분리"),
    ("docs/planning/", "서비스 정의 · 기획 · 분석 4종", "버전 원본(고정표)이 여기 있다"),
    ("docs/guide/", "HTML 가이드 11개 (옛 docs/가이드/ + docs/*.html)", "한글 폴더명을 ASCII 로 — 도구와 링크가 안전하다"),
    ("docs/agent/", "ai-coding-agent.html · handoff · 스킬 체크리스트", "에이전트와 인수인계용"),
    ("docs/deprecated/", "딥링크 A안 문서 2종", "09-25 폐기 결정, 기록으로만"),
    ("docs/deck/", "pptx 2개", "발표 자료는 생성 스크립트와 떼어 놓는다"),
    ("scripts/", "build_*_pptx.py 3개", "문서 폴더에 실행 스크립트가 있던 것을 옮김. 출력 경로는 docs/deck/ 로 고정"),
]

PENDING = [
    ("A", "infra/docker-compose.yml 의 redis:alpine 부동 태그", "컨테이너 재생성이 따라와서 사용자 확인 뒤 고정"),
    ("B", "backend·admin-web 의 환불 비율표 코드(⛔) 와 테스트 67건", "SCH-21 이 '옮기지 않는다' 로 처리 — 그 전에 지우면 SCH-01~07 가이드와 어긋난다"),
    ("D", "docs/legal/archive/terms-2026-09-25.zip (미추적 중복)", "같은 내용이 폴더로 추적 중 — 삭제 권장, 사용자 확인 대기"),
    ("E", ".claude/skills/speckit-* 9개", "규칙상 사용 금지인데 설치돼 있다 — 삭제 또는 SKILL.md 머리에 금지 표시"),
    ("H", "mobile/App.tsx 의 옛 취소 흐름", "SCH-32·33 에서 다시 만든다"),
    ("I", ".specify/extensions.yml 부재", "spec-kit 기본 동작(없으면 건너뜀). E 와 함께 정리"),
    ("J", "docs/assets/structure/s01-repo-layers.png", "mmd 는 새 경로로 고쳤지만 PNG 는 재렌더 전(mmdc 미설치) — 그림 속 폴더명이 옛것"),
]


# ── 검사 ────────────────────────────────────────────────────────────────────
def iter_nodes(nodes):
    for n in nodes:
        yield n
        if n["children"]:
            yield from iter_nodes(n["children"])


def check() -> list[str]:
    problems = []
    for n in iter_nodes(TREE):
        p = n["path"]
        if "*" in p:
            if not list(REPO.glob(p.rstrip("/"))):
                problems.append(f"glob 에 맞는 파일 없음: {p}")
            continue
        if not (REPO / p).exists():
            problems.append(f"없는 경로: {p}")
    # git 이 추적하는데 트리에 안 보이는 파일 (앞머리로 덮이는지 본다)
    covered = []
    for n in iter_nodes(TREE):
        p = n["path"].rstrip("/")
        covered.append(p.split("*")[0] if "*" in p else p)
    out = subprocess.run(["git", "ls-files", "-z"], cwd=REPO, capture_output=True, text=True).stdout
    missing = [f for f in out.split("\0") if f and not any(f == c or f.startswith(c.rstrip("/") + "/") or f.startswith(c) for c in covered)]
    if missing:
        problems.append(f"트리에 없는 추적 파일 {len(missing)}개: " + ", ".join(missing[:12]) + (" …" if len(missing) > 12 else ""))
    return problems


# ── HTML ────────────────────────────────────────────────────────────────────
def esc(s: str) -> str:
    return html.escape(s, quote=True)


def badge_layer(layer):
    icon, name, _, _, color = LAYERS[layer]
    return f'<span class="lb" style="--c:{color}" title="{esc(name)}">{icon} {esc(name)}</span>'


def badge_kind(k):
    desc, color = KINDS[k]
    return f'<span class="kb" style="--c:{color}" title="{esc(desc)}">{esc(k)}</span>'


def render_node(n, depth=0) -> str:
    name = n["path"].rstrip("/").split("/")[-1] + ("/" if n["path"].endswith("/") else "")
    kinds = "".join(badge_kind(k) for k in n["kinds"])
    text = f'<span class="name">{esc(name)}</span>{badge_layer(n["layer"])}{kinds}<span class="desc">{esc(n["desc"])}</span>'
    search = esc((n["path"] + " " + n["desc"]).lower())
    if n["children"]:
        kids = "".join(render_node(c, depth + 1) for c in n["children"])
        opened = " open" if depth < 1 else ""
        return f'<details class="dir" data-s="{search}"{opened}><summary>📁 {text}</summary><div class="kids">{kids}</div></details>'
    icon = "🔗" if n["path"].endswith("diagram-this") else ("📁" if n["path"].endswith("/") else "📄")
    return f'<div class="file" data-s="{search}">{icon} {text}</div>'


def count_layers():
    counts = {k: 0 for k in LAYERS}
    for n in iter_nodes(TREE):
        counts[n["layer"]] += 1
    return counts


def build_html() -> str:
    tree_html = "".join(render_node(n) for n in TREE)
    layer_cards = "".join(
        f'<div class="layer" style="--c:{c}"><div class="ic">{i}</div><h3>{esc(nm)}</h3><p class="q">{esc(q)}</p><p class="code">{esc(code)}</p></div>'
        + ('<div class="arrow">→</div>' if k != "expl" else "")
        for k, (i, nm, q, code, c) in LAYERS.items()
    )
    layer_rows = {
        "env": "CLAUDE.md · .claude/rules · .claude/settings.json · CLAUDE-decisions.md · docs/agent/",
        "spec": "specs/…/spec.md · docs/policy · docs/legal · docs/planning",
        "pipe": ".claude/skills/kdance-dev-harness · .claude/agents/kdance-*.md · _workspace/SCH_kdance.html",
        "tool": "backend/ · admin-web/ · mobile/ · infra/ · scripts/",
        "expl": "docs/guide · docs/Review.md · _workspace/guides · graphify-out/",
    }
    layer_table = "".join(
        f"<tr><td>{badge_layer(k)}</td><td>{esc(LAYERS[k][2])}</td><td><code>{esc(layer_rows[k])}</code></td><td>{esc(LAYERS[k][3])}</td></tr>"
        for k in LAYERS
    )
    src_layers = "".join(
        f'<div class="sl" style="--c:{c}"><div class="sl-h"><b>{esc(nm)}</b><span>{esc(role)}</span></div><code>{esc(files)}</code><p>{esc(d)}</p></div>'
        for nm, role, files, d, c in SOURCE_LAYERS
    )
    placement = "".join(f"<tr><td>{esc(a)}</td><td>{esc(b)}</td></tr>" for a, b in PLACEMENT_RULES)
    sot = "".join(f"<tr><td>{esc(a)}</td><td><code>{esc(b)}</code></td><td>{esc(c)}</td></tr>" for a, b, c in SOURCE_OF_TRUTH)
    reorg = "".join(f"<tr><td><code>{esc(a)}</code></td><td>{esc(b)}</td><td>{esc(c)}</td></tr>" for a, b, c in REORG_LOG)
    pending = "".join(f"<tr><td>{esc(a)}</td><td>{esc(b)}</td><td>{esc(c)}</td></tr>" for a, b, c in PENDING)
    kinds_legend = "".join(f'<div>{badge_kind(k)} <span class="dim">{esc(d)}</span></div>' for k, (d, _) in KINDS.items())
    counts = count_layers()
    count_chips = " · ".join(f"{LAYERS[k][0]} {LAYERS[k][1]} {v}" for k, v in counts.items())

    return f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>kdance 저장소 구조 지도</title>
<style>
  :root {{ --bg:#0f1115; --card:#161a21; --line:#262b35; --text:#e8eaed; --dim:#9aa4b2; --code:#0b0d11; --a:#4fc3f7; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; padding:0 16px 80px; background:var(--bg); color:var(--text); line-height:1.65;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Pretendard","Apple SD Gothic Neo","Malgun Gothic",sans-serif; }}
  .wrap {{ max-width:1100px; margin:0 auto; }}
  header {{ padding:44px 0 20px; border-bottom:1px solid var(--line); margin-bottom:28px; }}
  h1 {{ font-size:1.8rem; margin:0 0 6px; }} .sub {{ color:var(--dim); margin:0 0 6px; }}
  nav {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 20px; margin-bottom:36px; }}
  nav a {{ color:var(--a); text-decoration:none; margin-right:18px; white-space:nowrap; }} nav a:hover {{ text-decoration:underline; }}
  section {{ margin-bottom:56px; scroll-margin-top:16px; }}
  h2 {{ font-size:1.4rem; border-left:4px solid var(--a); padding-left:12px; margin:0 0 16px; }}
  h3 {{ font-size:1.1rem; color:var(--a); margin:24px 0 8px; }}
  p {{ margin:0 0 12px; }} .dim {{ color:var(--dim); }}
  code {{ background:var(--code); border:1px solid var(--line); border-radius:4px; padding:1px 6px; font-size:.88em;
          font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace; }}
  table {{ width:100%; border-collapse:collapse; margin:14px 0; font-size:.92rem; }}
  th,td {{ border:1px solid var(--line); padding:9px 12px; text-align:left; vertical-align:top; }}
  th {{ background:var(--card); color:var(--a); }} tr:nth-child(even) td {{ background:rgba(255,255,255,.02); }}
  .callout {{ background:var(--card); border:1px solid var(--line); border-left:4px solid var(--a); border-radius:8px; padding:14px 18px; margin:16px 0; }}
  /* 다섯 층 */
  .layers {{ display:flex; align-items:stretch; gap:8px; flex-wrap:wrap; margin:18px 0; }}
  .layer {{ flex:1 1 170px; background:var(--card); border:1px solid var(--line); border-top:4px solid var(--c); border-radius:12px; padding:14px; }}
  .layer .ic {{ font-size:1.6rem; }} .layer h3 {{ margin:4px 0 6px; color:var(--c); }} .layer .q {{ font-weight:700; margin:0 0 6px; }}
  .layer .code {{ color:var(--dim); font-size:.88rem; margin:0; }}
  .arrow {{ align-self:center; color:var(--dim); font-size:1.4rem; }}
  /* 배지 */
  .lb,.kb {{ display:inline-block; font-size:.72rem; border-radius:999px; padding:1px 8px; margin-left:6px; vertical-align:middle; white-space:nowrap; }}
  .lb {{ border:1px solid var(--c); color:var(--c); }}
  .kb {{ background:color-mix(in srgb,var(--c) 18%,transparent); color:var(--c); border:1px solid color-mix(in srgb,var(--c) 40%,transparent); }}
  /* 트리 */
  .toolbar {{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin:10px 0 14px; }}
  .toolbar input {{ flex:1 1 240px; background:var(--code); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 12px; font-size:.95rem; }}
  .toolbar button {{ background:var(--card); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 12px; cursor:pointer; }}
  .toolbar button:hover {{ border-color:var(--a); }}
  .tree {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 16px; font-size:.93rem; }}
  details.dir {{ margin:2px 0; }} details.dir > summary {{ cursor:pointer; list-style:none; padding:5px 6px; border-radius:6px; }}
  details.dir > summary::-webkit-details-marker {{ display:none; }}
  details.dir > summary:hover, .file:hover {{ background:rgba(255,255,255,.04); }}
  details.dir > summary::before {{ content:"▸"; display:inline-block; width:14px; color:var(--dim); transition:transform .15s; }}
  details.dir[open] > summary::before {{ transform:rotate(90deg); }}
  .kids {{ margin-left:18px; border-left:1px dashed var(--line); padding-left:10px; }}
  .file {{ padding:4px 6px 4px 20px; border-radius:6px; }}
  .name {{ font-weight:700; font-family:"SFMono-Regular",Consolas,Menlo,monospace; font-size:.92em; }}
  .desc {{ color:var(--dim); margin-left:10px; }}
  .hide {{ display:none !important; }}
  .legend {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:4px 20px; font-size:.88rem; margin:10px 0 0; }}
  /* 소스 층 */
  .slayers {{ display:flex; flex-direction:column; gap:6px; margin:14px 0; }}
  .sl {{ background:var(--card); border:1px solid var(--line); border-left:5px solid var(--c); border-radius:10px; padding:10px 14px; display:grid; grid-template-columns:150px 230px 1fr; gap:12px; align-items:center; }}
  .sl .sl-h b {{ color:var(--c); font-size:1.05rem; display:block; }} .sl .sl-h span {{ color:var(--dim); font-size:.85rem; }}
  .sl p {{ margin:0; font-size:.9rem; }}
  @media (max-width:720px) {{ .sl {{ grid-template-columns:1fr; }} .arrow {{ display:none; }} }}
  /* 흐름 */
  .flow {{ display:flex; flex-wrap:wrap; gap:6px; align-items:stretch; margin:12px 0; }}
  .flow .st {{ background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 14px; flex:1 1 150px; }}
  .flow .st b {{ display:block; color:var(--a); }} .flow .st code {{ font-size:.8em; }}
  footer {{ color:var(--dim); font-size:.88rem; border-top:1px solid var(--line); padding-top:16px; }}
</style>
</head>
<body><div class="wrap">
<header>
  <h1>kdance 저장소 구조 지도</h1>
  <p class="sub">기준일 {esc(BASED_ON)} · 폴더와 파일마다 무엇인지, 어느 층에 속하는지, 원본인지 파생인지를 한 화면에서 본다. 글 원본은 <code>docs/structure-map.md</code>, 이 페이지는 <code>scripts/build_structure_map.py</code> 가 만든다.</p>
  <p class="sub">트리 항목 {count_chips}</p>
</header>
<nav>
  <a href="#s1">1 다섯 층</a><a href="#s2">2 전체 트리</a><a href="#s3">3 소스 구조 정의</a><a href="#s4">4 문서가 코드가 되는 흐름</a><a href="#s5">5 원본은 어디</a><a href="#s6">6 2026-10-01 재편 기록</a>
</nav>

<section id="s1">
  <h2>1. 다섯 층으로 본 저장소</h2>
  <p>이 저장소는 코드보다 문서와 규칙이 많다. 폴더 이름이 아니라 <b>역할</b>로 나누면 다섯 층이 된다. 앞의 넷은 <code>core-rules.md</code> 의 4계층(환경·명세·파이프라인·공구)이고, 다섯째는 사람과 에이전트가 읽기만 하는 설명 층이다. 애매하면 「코드를 보는가」로 가른다.</p>
  <div class="layers">{layer_cards}</div>
  <table><thead><tr><th>층</th><th>핵심 질문</th><th>대표 위치</th><th>코드를</th></tr></thead><tbody>{layer_table}</tbody></table>
</section>

<section id="s2">
  <h2>2. 전체 트리 — 폴더와 파일마다 한 줄</h2>
  <p>폴더를 눌러 펼친다. 검색창에 파일명이나 설명의 일부를 넣으면 맞는 줄만 남는다. 배지는 층(테두리)과 성격(채움)이다.</p>
  <div class="legend">{kinds_legend}</div>
  <div class="toolbar"><input id="q" type="search" placeholder="검색 — 예: policy, 환불, SCH, pptx"><button id="exp">모두 펼치기</button><button id="col">모두 접기</button></div>
  <div class="tree" id="tree">{tree_html}</div>
  <p class="dim" style="margin-top:10px">로컬 전용이라 저장소에 없는 것: <code>docs/Review.md</code> 와 <code>docs/assets/review/</code>, <code>.diagrams/</code>, <code>graphify-out/</code>, <code>.playwright-mcp/</code>, <code>_workspace/00_input/</code>, 각 패키지의 <code>node_modules/</code>·<code>.venv/</code>·<code>.env</code>.</p>
</section>

<section id="s3">
  <h2>3. 소스 구조 정의 — 코드는 어떤 층으로 쌓이나</h2>
  <p>backend 의 한 요청은 위에서 아래로 흐른다. 각 층은 바로 아래 층만 부른다(<code>schemas</code> 가 <code>services</code> 를 읽는 한 방향 예외가 하나 있고, 순환은 없다). SCH-21(FastAPI→Next.js 전환) 뒤에도 <b>이 여섯 구분은 그대로 가져간다</b> — 폴더 이름만 Next.js 식(<code>app/api/</code> · server actions · <code>lib/</code> · <code>prisma/</code>)으로 바뀐다.</p>
  <div class="slayers">{src_layers}</div>
  <h3>admin-web · mobile · infra 는 어떻게 나뉘나</h3>
  <table><thead><tr><th>패키지</th><th>지금</th><th>어디로 가나</th></tr></thead><tbody>
    <tr><td><code>admin-web/</code></td><td><code>app/</code>(라우트·레이아웃) · <code>components/</code>(화면 조각) · <code>lib/</code>(API 호출). 환불 비율표 화면은 ⛔ 폐기 예정</td><td>SCH-21 부터 제품 API 가 여기로 온다 — <code>app/api/</code>(문) · server actions(판단) · <code>prisma/</code>(데이터) · <code>lib/</code>(경계). DB 를 쓰는 곳은 Next.js 하나(ADR-004)</td></tr>
    <tr><td><code>mobile/</code></td><td><code>App.tsx</code> 데모 하나 — 화면·API 호출이 한 파일</td><td>SCH-32·33 에서 화면(<code>app/</code>) · 상태 · API 클라이언트로 나눈다. 모델은 부르지 않고 Next.js API 만 부른다</td></tr>
    <tr><td><code>infra/</code></td><td><code>docker-compose.yml</code> 하나에 DB · Redis · llama-server · ollama</td><td>운영 전환 때 임베딩·리랭커(vLLM)가 추가된다. 포트와 컨테이너 이름은 CLAUDE.md 가 가리킨다</td></tr>
    <tr><td>AI 에이전트 서버</td><td>아직 없음</td><td>Python(FastAPI + LangGraph) 별도 프로세스. DB 는 MCP 도구로 읽기만(ADR-004)</td></tr>
  </tbody></table>
  <h3>새 파일은 어디에 두나</h3>
  <table><thead><tr><th>무엇을 만들 때</th><th>어디에 · 어떻게</th></tr></thead><tbody>{placement}</tbody></table>
</section>

<section id="s4">
  <h2>4. 문서가 코드가 되는 흐름</h2>
  <div class="flow">
    <div class="st"><b>① 명세</b><code>specs/…/spec.md</code><br>무엇을 왜 — 코드를 안 본다</div>
    <div class="st"><b>② Phase 1~4</b><code>_workspace/01_~04_*.md</code><br>슬라이스 절단 · 코드 조사 · 구현 계획 · Task</div>
    <div class="st"><b>③ SCH</b><code>_workspace/SCH_kdance.html</code><br>번호 · 기능명 · 상태의 원본</div>
    <div class="st"><b>④ 코드</b><code>backend/ admin-web/ mobile/</code><br>공구(ECC)가 고친다 · 테스트와 짝</div>
    <div class="st"><b>⑤ 설명</b><code>_workspace/guides/ · docs/Review.md</code><br>학습 주석 · 가이드 · 그날의 판단</div>
  </div>
  <div class="callout">반대 방향은 버전에만 있다 — 설치본(<code>package.json</code> 등)을 실측하고 고정표를 고친 뒤, 문서가 그 표를 가리킨다.</div>
</section>

<section id="s5">
  <h2>5. 원본은 어디 — 같은 값을 두 곳에 적지 않는다</h2>
  <table><thead><tr><th>값</th><th>원본 (여기서만 고친다)</th><th>참조하는 곳</th></tr></thead><tbody>{sot}</tbody></table>
</section>

<section id="s6">
  <h2>6. 2026-10-01 재편 기록</h2>
  <p><code>docs/</code> 25개 파일이 한 층에 있던 것을 성격별 7개 폴더로 나누고, 저장소 안의 경로 참조 272곳을 함께 고쳤다(파일 이동은 <code>git mv</code> 라 이력이 이어진다).</p>
  <table><thead><tr><th>새 폴더</th><th>무엇이 들어갔나</th><th>왜</th></tr></thead><tbody>{reorg}</tbody></table>
  <h3>아직 결정이 남은 것</h3>
  <table><thead><tr><th>#</th><th>어디</th><th>왜 그대로 두었나 · 제안</th></tr></thead><tbody>{pending}</tbody></table>
</section>

<footer>
  다시 만들기: <code>python3 scripts/build_structure_map.py</code> — 트리에 적힌 경로가 실제로 있는지, 추적 파일이 트리에서 빠졌는지 같이 검사한다. 파일을 옮기면 <code>docs/structure-map.md</code> 2절 트리와 이 스크립트의 <code>TREE</code> 를 같이 고친다. 생성일 {date.today().isoformat()}.
</footer>
</div>
<script>
  const q = document.getElementById('q'), tree = document.getElementById('tree');
  const dirs = [...tree.querySelectorAll('details.dir')], rows = [...tree.querySelectorAll('[data-s]')];
  document.getElementById('exp').onclick = () => dirs.forEach(d => d.open = true);
  document.getElementById('col').onclick = () => dirs.forEach(d => d.open = false);
  q.addEventListener('input', () => {{
    const v = q.value.trim().toLowerCase();
    if (!v) {{ rows.forEach(r => r.classList.remove('hide')); return; }}
    rows.forEach(r => r.classList.add('hide'));
    rows.forEach(r => {{
      if (r.dataset.s.includes(v)) {{
        r.classList.remove('hide');
        let p = r.parentElement;
        while (p && p !== tree) {{ if (p.tagName === 'DETAILS') {{ p.classList.remove('hide'); p.open = true; }} p = p.parentElement; }}
        r.querySelectorAll('[data-s]').forEach(c => c.classList.remove('hide'));
      }}
    }});
  }});
</script>
</body></html>
"""


def main() -> int:
    problems = check()
    for p in problems:
        print("경고:", p, file=sys.stderr)
    if "--check" in sys.argv:
        return 1 if problems else 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(build_html(), encoding="utf-8")
    print(f"→ {OUT.relative_to(REPO)} ({OUT.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
