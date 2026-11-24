#!/usr/bin/env python3
"""API 계약 ↔ 구현 1대1 린터 (leave-verifiable-evidence 스킬).

무엇을 하나
  계약 문서(_workspace/03_contracts/*.md)에 적힌 `METHOD /api/...` 와
  실제 구현(admin-web/app/api/**/route.ts 가 export 하는 GET·POST 등)을 맞대 본다.
  어긋나면 한 줄씩 로그로 내고, 하나라도 있으면 종료 코드 1 을 돌려준다.

왜 이렇게 했나
  타입 검사(tsc)는 "코드끼리 맞는가" 만 본다. "계약에 적은 경로가 정말 있나",
  "계약에 없는 경로가 몰래 생기지 않았나" 는 아무도 안 본다. 그 빈자리를 메운다.

검사 세 가지
  MISSING      계약에는 있는데 구현이 없다 (--contract 로 고른 범위만 실패로 친다)
  UNDOCUMENTED 구현은 있는데 어느 계약에도 없다 (항상 실패)
  NO_SCHEMA    본문을 받는 POST·PUT·PATCH 가 런타임 스키마 검사(zod parse/safeParse)를
               route 파일이나 그 파일이 바로 import 하는 모듈 안에서 하지 않는다

표준 라이브러리만 쓴다. 사용 예:
  python3 api_contract_lint.py                         # 전체 — MISSING 은 경고로만
  python3 api_contract_lint.py --contract 07-owner-onboarding.md
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


def repo_root() -> Path:
    """지금 폴더가 속한 git 저장소의 맨 위. 스킬이 전역(~/.claude/skills)에 있어도 맞게 잡힌다."""
    out = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    return Path(out.stdout.strip()) if out.returncode == 0 else Path.cwd()


# 기본값은 kdance 구조다. 다른 프로젝트는 --contracts·--web 으로 바꾼다
ROOT = repo_root()
CONTRACT_DIR = ROOT / "_workspace" / "03_contracts"
WEB_DIR = ROOT / "admin-web"
API_DIR = WEB_DIR / "app" / "api"

BODY_METHODS = {"POST", "PUT", "PATCH"}

# 계약 문서 안의 표기 두 가지를 모두 잡는다.
#   `GET /api/files/{fileId}`
#   `GET` · `POST /api/academies/{academyId}/rooms`   ← 메서드 여럿이 경로 하나를 같이 쓴다
CONTRACT_RE = re.compile(
    r"((?:`?(?:GET|POST|PUT|PATCH|DELETE)`?\s*[·,/]\s*)*)`?(GET|POST|PUT|PATCH|DELETE)\s+(/api/[^`\s|]*)"
)
SCHEMA_RE = re.compile(r"\.(?:safeParse|parse|parseAsync|safeParseAsync)\(|\bz\.object\(")


def normalize(path: str) -> str:
    """경로를 비교용 모양으로 바꾼다. 매개변수 이름은 무시한다({id}·[id] → {})."""
    path = path.split("?", 1)[0].rstrip("/.,;:)")
    path = re.sub(r"\{[^}]*\}", "{}", path)          # 계약: {academyId}, {임의 id}
    path = re.sub(r"\[\.\.\.[^\]]+\]", "{*}", path)  # 구현: [...all] (모두 받기)
    path = re.sub(r"\[[^\]]+\]", "{}", path)         # 구현: [academyId]
    return path or "/"


def read_contracts(files: list[Path]) -> dict[tuple[str, str], str]:
    """계약 파일들에서 (메서드, 경로) → 처음 나온 파일:줄 을 모은다."""
    found: dict[tuple[str, str], str] = {}
    for f in files:
        for no, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            for m in CONTRACT_RE.finditer(line):
                extra = re.findall(r"GET|POST|PUT|PATCH|DELETE", m.group(1) or "")
                for method in [*extra, m.group(2)]:
                    found.setdefault((method, normalize(m.group(3))), f"{f.name}:{no}")
    return found


def route_path(route_file: Path) -> str:
    rel = route_file.parent.relative_to(API_DIR)
    # (그룹) 폴더는 주소에 나타나지 않는다(Next.js App Router 규칙)
    parts = [p for p in rel.parts if not (p.startswith("(") and p.endswith(")"))]
    return normalize("/api/" + "/".join(parts) if parts else "/api")


def exported_methods(src: str) -> set[str]:
    """route.ts 가 내보내는 HTTP 메서드. 네 가지 export 모양을 다 본다."""
    names: set[str] = set()
    names |= set(re.findall(r"export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b", src))
    names |= set(re.findall(r"export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\b", src))
    for group in re.findall(r"export\s+const\s*\{([^}]*)\}", src):  # export const { GET, POST } = …
        names |= set(re.findall(r"\b(GET|POST|PUT|PATCH|DELETE)\b", group))
    for group in re.findall(r"export\s*\{([^}]*)\}", src):          # export { h as GET }
        names |= set(re.findall(r"as\s+(GET|POST|PUT|PATCH|DELETE)\b", group))
    return names


def resolve_import(spec: str, here: Path) -> Path | None:
    if spec.startswith("@/"):
        base = WEB_DIR / spec[2:]
    elif spec.startswith("."):
        base = (here.parent / spec).resolve()
    else:
        return None  # 바깥 패키지는 보지 않는다
    for cand in (base, base.with_suffix(".ts"), base.with_suffix(".tsx"), base / "index.ts"):
        if cand.is_file():
            return cand
    return None


def has_schema_check(route_file: Path, src: str) -> bool:
    """route 파일 또는 그 파일이 바로 import 하는 모듈(한 단계)에 zod 검사가 있나."""
    if SCHEMA_RE.search(src):
        return True
    for spec in re.findall(r"from\s+[\"']([^\"']+)[\"']", src):
        target = resolve_import(spec, route_file)
        if target and SCHEMA_RE.search(target.read_text(encoding="utf-8")):
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--contract", action="append", default=[],
                    help="이번 작업의 계약 파일 이름. 여기 적힌 경로가 없으면 MISSING 으로 실패한다(여러 번 줄 수 있음)")
    ap.add_argument("--contracts", help="계약 문서 폴더(기본: <저장소>/_workspace/03_contracts)")
    ap.add_argument("--web", help="Next.js 앱 폴더(기본: <저장소>/admin-web). API 는 그 안의 app/api")
    args = ap.parse_args()

    global CONTRACT_DIR, WEB_DIR, API_DIR
    if args.contracts:
        CONTRACT_DIR = Path(args.contracts).resolve()
    if args.web:
        WEB_DIR = Path(args.web).resolve()
        API_DIR = WEB_DIR / "app" / "api"
    if not CONTRACT_DIR.is_dir() or not API_DIR.is_dir():
        print(f"# api_contract_lint  계약 폴더 {CONTRACT_DIR} 또는 API 폴더 {API_DIR} 가 없다 — --contracts·--web 으로 지정한다")
        print("# 결과: FAIL")
        return 2

    contracts = read_contracts(sorted(CONTRACT_DIR.glob("*.md")))
    scoped = read_contracts([CONTRACT_DIR / c for c in args.contract]) if args.contract else {}

    impl: dict[tuple[str, str], str] = {}
    errors: list[str] = []
    for rf in sorted(API_DIR.rglob("route.ts")):
        src = rf.read_text(encoding="utf-8")
        path = route_path(rf)
        rel = rf.relative_to(ROOT)
        for method in sorted(exported_methods(src)):
            impl[(method, path)] = str(rel)
            # 모두 받기 경로(Better Auth 의 /api/auth/[...all])는 라이브러리 소유라 대조에서 뺀다
            if "{*}" in path:
                continue
            if (method, path) not in contracts:
                errors.append(f"UNDOCUMENTED {method} {path}  ({rel}) — 어느 계약에도 없다")
            if method in BODY_METHODS and not has_schema_check(rf, src):
                errors.append(f"NO_SCHEMA    {method} {path}  ({rel}) — zod parse/safeParse 가 없다")

    # 계약에만 있는 경로: 이번 작업 범위(--contract)면 실패, 아니면 아직 안 만든 것이라 경고
    warnings: list[str] = []
    for key, where in sorted(contracts.items()):
        if key in impl:
            continue
        line = f"MISSING      {key[0]} {key[1]}  (계약 {where}) — 구현이 없다"
        (errors if key in scoped else warnings).append(line)

    matched = sum(1 for k in impl if k in contracts)
    print(f"# api_contract_lint  계약 {len(contracts)}개 · 구현 {len(impl)}개 · 1대1 맞음 {matched}개")
    print(f"# 범위: {', '.join(args.contract) if args.contract else '전체(MISSING 은 경고)'}")
    for e in errors:
        print("ERROR ", e)
    for w in warnings:
        print("WARN  ", w)
    print(f"# 결과: {'FAIL' if errors else 'PASS'}  (오류 {len(errors)} · 경고 {len(warnings)})")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
