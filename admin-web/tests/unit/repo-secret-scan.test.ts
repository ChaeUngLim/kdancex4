// S0-6.6(저장소 전체 비밀값 검사) — 수용 ⑤: 저장소 전체 비밀값 검사 0건. SC-024(소스 자격 증명 0건).
//   플랜: _workspace/06_master-plan.md 「S0-6(환경 분리·비밀값 목록)」
//   도구: gitleaks 8.21.2(로컬에서 도는 무료 도구, 2026-11-20 사용자 결정) · 설정: 저장소 루트 .gitleaks.toml
//
// 「저장소 전체」를 두 겹으로 본다.
//   ① git 이력 — 지금까지의 모든 커밋. 한 번 커밋된 비밀값은 파일에서 지워도 이력에 남기 때문이다.
//   ② 지금 작업 폴더 — 아직 커밋하지 않았지만 다음 커밋에 들어갈 파일(.gitignore 가 빼는 .env·.next 등은 제외).
// 둘 다 0건이어야 통과한다. 검사 결과는 `--redact` 로 받아 값이 테스트 출력에 찍히지 않게 한다.
import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CONFIG = path.join(REPO_ROOT, ".gitleaks.toml");
const GITLEAKS = process.env.GITLEAKS_BIN ?? "gitleaks";
// 사용자가 고른 버전. 다른 버전이면 기본 규칙이 달라져 「0건」의 뜻이 바뀌므로 먼저 멈춘다
const PINNED_VERSION = "8.21.2";
const SCAN_TIMEOUT_MS = 180_000;

type Finding = { RuleID: string; File: string; StartLine: number; Commit: string };

const gitleaksFound = spawnSync(GITLEAKS, ["version"], { encoding: "utf8" }).status === 0;
const workDirs: string[] = [];

/** 빈 임시 폴더를 만든다(테스트가 끝나면 지운다) */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  workDirs.push(dir);
  return dir;
}

/**
 * gitleaks 를 돌리고 발견 목록을 돌려준다.
 * 보고서는 JSON 파일로 받는다 — 표준 출력은 로그용이라 형식이 바뀔 수 있다.
 * 발견이 있으면 gitleaks 는 exit 1 을 낸다. 그 밖의 코드(설정 오류 등)는 검사가 안 된 것이니 실패로 본다.
 */
function runGitleaks(mode: "git" | "dir", target: string, cwd: string): Finding[] {
  const report = path.join(makeTempDir("kdance-gitleaks-report-"), "report.json");
  const result = spawnSync(
    GITLEAKS,
    [mode, "--no-banner", "--redact", "--config", CONFIG, "--report-format", "json", "--report-path", report, target],
    { cwd, encoding: "utf8", timeout: SCAN_TIMEOUT_MS },
  );
  expect([0, 1], `gitleaks ${mode} 가 검사를 마치지 못했다: ${result.stderr}`).toContain(result.status);
  return JSON.parse(readFileSync(report, "utf8")) as Finding[];
}

/** 발견을 「규칙 파일:줄 커밋」 한 줄로 — 실패 메시지에 값 없이 위치만 보이게 한다 */
function describeFindings(findings: Finding[]): string[] {
  return findings.map((f) => `${f.RuleID} ${f.File}:${f.StartLine}${f.Commit ? ` ${f.Commit.slice(0, 7)}` : ""}`);
}

/**
 * 다음 커밋에 들어갈 파일(추적 중 + 아직 추적 안 했지만 무시 대상이 아닌 파일)을 임시 폴더로 복사한다.
 * 왜 복사하나: gitleaks dir 은 .gitignore 를 모른다. 저장소 폴더를 바로 훑으면 node_modules·.next·.env 까지
 * 읽어 1분 넘게 걸리고, 저장소에 들어가지 않는 파일까지 「발견」으로 센다. 복사본은 3초 안에 끝난다.
 * 지운 파일(목록엔 있지만 디스크엔 없음)과 심볼릭 링크(git 에는 경로 글자만 들어간다)는 건너뛴다.
 */
function copyRepoFiles(): string {
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(listed.status, listed.stderr).toBe(0);
  const files = listed.stdout.split("\0").filter((p) => p !== "");
  expect(files.length).toBeGreaterThan(0);

  const copyRoot = makeTempDir("kdance-gitleaks-tree-");
  for (const relativePath of files) {
    const source = path.join(REPO_ROOT, relativePath);
    let isRegularFile = false;
    try {
      isRegularFile = lstatSync(source).isFile();
    } catch {
      continue; // 작업 폴더에서 지운 파일
    }
    if (!isRegularFile) continue;
    const destination = path.join(copyRoot, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  return copyRoot;
}

afterAll(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!gitleaksFound)("저장소 전체 비밀값 검사(gitleaks)", () => {
  test(`gitleaks 가 고정한 버전 ${PINNED_VERSION} 이다`, () => {
    const version = spawnSync(GITLEAKS, ["version"], { encoding: "utf8" }).stdout.trim();
    expect(version).toBe(PINNED_VERSION);
  });

  test("git 이력 전체에서 비밀값 0건", { timeout: SCAN_TIMEOUT_MS }, () => {
    const findings = runGitleaks("git", ".", REPO_ROOT);
    expect(describeFindings(findings)).toEqual([]);
  });

  test("다음 커밋에 들어갈 작업 폴더 파일에서 비밀값 0건", { timeout: SCAN_TIMEOUT_MS }, () => {
    const copyRoot = copyRepoFiles();
    // 복사본 안에서 "." 을 훑어야 보고서 경로가 저장소 기준(admin-web/...)이 되어 허용 목록의 경로와 맞는다
    const findings = runGitleaks("dir", ".", copyRoot);
    expect(describeFindings(findings)).toEqual([]);
  });

  // ── 검사기 자체 확인: 「0건」이 규칙이 꺼져서 나온 것이 아님을 보인다 ──
  // 가짜 토큰은 실행할 때 만들어 소스에 값이 남지 않게 한다(이 파일 자체가 검사 대상이다)
  const fakeGithubToken = () => `ghp_${"aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF2hJ4"}`;
  const fakeAwsKey = () => ["AKIA", "Q3EGRTWZ", "N7X4K2LP"].join("");

  test("같은 설정으로 가짜 GitHub 토큰·AWS 키를 심으면 잡는다", { timeout: SCAN_TIMEOUT_MS }, () => {
    const dir = makeTempDir("kdance-gitleaks-plant-");
    writeFileSync(path.join(dir, "config.json"), `{"token": "${fakeGithubToken()}"}\n`);
    writeFileSync(path.join(dir, "deploy.env"), `AWS_ACCESS_KEY_ID=${fakeAwsKey()}\n`);
    const rules = runGitleaks("dir", ".", dir).map((f) => f.RuleID).sort();
    expect(rules).toEqual(["aws-access-token", "github-pat"]);
  });

  test("허용 목록은 그 커밋에서만 통한다 — 같은 경로라도 커밋이 아니면 잡는다", { timeout: SCAN_TIMEOUT_MS }, () => {
    const dir = makeTempDir("kdance-gitleaks-allow-");
    mkdirSync(path.join(dir, "docs", "handoff"), { recursive: true });
    writeFileSync(path.join(dir, "docs", "handoff", "mcp-kdance.json"), `{"Authorization": "Bearer ${fakeGithubToken()}"}\n`);
    const findings = runGitleaks("dir", ".", dir);
    expect(describeFindings(findings)).toEqual(["github-pat docs/handoff/mcp-kdance.json:1"]);
  });

  test("가짜 테스트 서명값 허용은 그 값만 — 같은 파일에 다른 값이 오면 잡는다", { timeout: SCAN_TIMEOUT_MS }, () => {
    const dir = makeTempDir("kdance-gitleaks-value-");
    mkdirSync(path.join(dir, "admin-web", "tests", "db"), { recursive: true });
    const otherValue = ["Zx81", "Qw72", "Lp93", "Mn04", "Rt65", "Yu36"].join("");
    writeFileSync(path.join(dir, "admin-web", "tests", "db", "staff-me.db.test.ts"), `const SECRET = "${otherValue}";\n`);
    const rules = runGitleaks("dir", ".", dir).map((f) => f.RuleID);
    expect(rules).toEqual(["generic-api-key"]);
  });
});
