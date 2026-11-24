// 품질 게이트 훅 테스트(S0-4.6(품질 게이트 훅 설치)).
// 무엇을 돌릴지 고르는 규칙(planChecks)과, 실패해도 막지 않고 경고만 내는 출력 규칙(buildHookOutput)을 본다.
// 실제 tsc·vitest 를 도는 끝까지의 실행은 증거 로그(_workspace/evidence/S0-4.6/)에서 확인한다 —
// 테스트 안에서 vitest 를 또 띄우면 느리고 서로 꼬인다.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildHookOutput, buildRecord, planChecks, tail, type CheckResult } from "../../scripts/quality-gate/plan.ts";

const adminWebDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hookScript = path.join(adminWebDir, "scripts", "quality-gate-hook.ts");

const passed = (name: CheckResult["name"]): CheckResult => ({ name, exitCode: 0, durationMs: 10, outputTail: "" });

describe("planChecks — 고친 파일에 따라 돌릴 검사를 고른다", () => {
  it("admin-web 의 .ts 파일이면 타입 검사와 관련 단위 테스트를 고른다", () => {
    const checks = planChecks(path.join(adminWebDir, "lib", "money.ts"), adminWebDir);
    expect(checks.map((check) => check.name)).toEqual(["tsc", "vitest-related"]);
    expect(checks[0]?.args).toEqual(["--noEmit"]);
    expect(checks[1]?.args).toEqual(["related", "--run", "--project", "unit", "--passWithNoTests", "lib/money.ts"]);
  });

  it(".tsx 파일도 대상이다", () => {
    const checks = planChecks(path.join(adminWebDir, "components", "AdminNav.tsx"), adminWebDir);
    expect(checks.map((check) => check.name)).toEqual(["tsc", "vitest-related"]);
  });

  it("lint 는 고르지 않는다(사용자 조건)", () => {
    const checks = planChecks(path.join(adminWebDir, "lib", "money.ts"), adminWebDir);
    expect(checks.some((check) => check.args.join(" ").includes("eslint"))).toBe(false);
  });

  it("admin-web/package.json 이면 npm audit(high 이상)만 고른다", () => {
    const checks = planChecks(path.join(adminWebDir, "package.json"), adminWebDir);
    expect(checks).toEqual([{ name: "npm-audit", command: "npm", args: ["audit", "--audit-level=high"] }]);
  });

  it("admin-web 밖·TS 가 아닌 파일·설치본·빈 경로는 아무것도 돌리지 않는다", () => {
    expect(planChecks(path.join(adminWebDir, "..", "mobile", "App.tsx"), adminWebDir)).toEqual([]);
    expect(planChecks(path.join(adminWebDir, "README.md"), adminWebDir)).toEqual([]);
    expect(planChecks(path.join(adminWebDir, "node_modules", "zod", "index.d.ts"), adminWebDir)).toEqual([]);
    expect(planChecks(path.join(adminWebDir, ".next", "types", "x.ts"), adminWebDir)).toEqual([]);
    expect(planChecks(path.join(adminWebDir, "node_modules", "zod", "package.json"), adminWebDir)).toEqual([]);
    expect(planChecks("", adminWebDir)).toEqual([]);
  });
});

describe("buildRecord · buildHookOutput — 기록하고 경고만 한다", () => {
  it("모두 exit 0 이면 ok=true 이고 경고를 내지 않는다", () => {
    const record = buildRecord({
      at: "2026-11-20T00:00:00.000Z",
      tool: "Edit",
      file: "admin-web/lib/money.ts",
      checks: [passed("tsc"), passed("vitest-related")],
    });
    expect(record.ok).toBe(true);
    expect(buildHookOutput(record, "/log")).toBeNull();
  });

  it("하나라도 실패하면 ok=false, 경고를 내되 block 결정은 넣지 않는다", () => {
    const record = buildRecord({
      at: "2026-11-20T00:00:00.000Z",
      tool: "Edit",
      file: "admin-web/lib/money.ts",
      checks: [{ name: "tsc", exitCode: 2, durationMs: 10, outputTail: "error TS2322" }, passed("vitest-related")],
    });
    expect(record.ok).toBe(false);
    const output = buildHookOutput(record, "/log/quality-gate.jsonl");
    expect(output).not.toBeNull();
    expect(output).not.toHaveProperty("decision");
    expect(String(output?.["systemMessage"])).toContain("tsc");
    expect(JSON.stringify(output)).toContain("error TS2322");
  });

  it("시간 초과·실행 불가(exitCode null)도 실패로 센다", () => {
    const record = buildRecord({
      at: "x",
      tool: "Write",
      file: "f.ts",
      checks: [{ name: "tsc", exitCode: null, durationMs: 1, outputTail: "" }],
    });
    expect(record.ok).toBe(false);
  });

  it("긴 출력은 끝부분만 남긴다", () => {
    expect(tail("abcdef", 3)).toBe("def");
    expect(tail("ab", 3)).toBe("ab");
  });
});

describe("훅 실행 파일 — 대상이 아니거나 입력이 깨져도 조용히 exit 0", () => {
  const logFile = path.join(mkdtempSync(path.join(os.tmpdir(), "kdance-qg-")), "quality-gate.jsonl");
  const runHook = (stdin: string) =>
    spawnSync(process.execPath, [hookScript], {
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, KDANCE_QUALITY_GATE_LOG: logFile },
    });

  it("문서 파일을 고친 입력이면 아무것도 돌리지 않고 기록도 남기지 않는다", () => {
    const run = runHook(JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/tmp/README.md" } }));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(existsSync(logFile)).toBe(false);
  });

  it("JSON 이 깨진 입력이어도 exit 0", () => {
    const run = runHook("{not json");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });
});
