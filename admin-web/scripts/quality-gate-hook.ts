// 품질 게이트 훅 실행 파일 — Claude Code 의 PostToolUse 훅이 부른다(S0-4.6(품질 게이트 훅 설치)).
//
// 연결: 저장소 루트 .claude/settings.json 의 hooks.PostToolUse(matcher "Edit|Write|MultiEdit")
//   node "$CLAUDE_PROJECT_DIR"/admin-web/scripts/quality-gate-hook.ts
//
// 하는 일
//   1. 표준 입력으로 받은 훅 JSON 에서 고친 파일 경로(tool_input.file_path)를 읽는다.
//   2. scripts/quality-gate/plan.ts 의 planChecks 로 돌릴 검사를 고른다(없으면 바로 끝).
//   3. 검사를 차례로 돌리고, 결과 한 줄을 기록 파일(JSON Lines)에 덧붙인다.
//   4. 실패가 있으면 경고 JSON 을 stdout 으로 낸다. 성공이든 실패든 exit 0 — 작업을 막지 않는다(사용자 조건).
//
// 기록 파일: 저장소 루트 .claude/hooks/logs/quality-gate.jsonl (git 에서 무시). KDANCE_QUALITY_GATE_LOG 로 바꿀 수 있다.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildHookOutput, buildRecord, planChecks, tail, type CheckResult } from "./quality-gate/plan.ts";

// 검사 하나가 이보다 오래 걸리면 끊는다. settings.json 의 훅 timeout(180초)보다 짧게 잡아 기록은 꼭 남긴다.
const CHECK_TIMEOUT_MS = 80_000;

const adminWebDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectDir = process.env["CLAUDE_PROJECT_DIR"] || path.resolve(adminWebDir, "..");
const logFile =
  process.env["KDANCE_QUALITY_GATE_LOG"] || path.join(projectDir, ".claude", "hooks", "logs", "quality-gate.jsonl");

/** 훅 입력 JSON 을 읽는다. 깨진 입력이면 빈 값 — 훅 때문에 작업이 멈추면 안 된다. */
function readHookInput(): { tool: string; file: string } {
  try {
    const raw = readFileSync(0, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { tool: "", file: "" };
    const record = parsed as { tool_name?: unknown; tool_input?: { file_path?: unknown } };
    return {
      tool: typeof record.tool_name === "string" ? record.tool_name : "",
      file: typeof record.tool_input?.file_path === "string" ? record.tool_input.file_path : "",
    };
  } catch {
    return { tool: "", file: "" };
  }
}

const input = readHookInput();
const checks = planChecks(input.file, adminWebDir);
if (checks.length === 0) process.exit(0);

// 검사를 차례로 돌린다. tsc 와 vitest 를 동시에 돌리면 노트북 CPU 를 다퉈 둘 다 느려진다.
const results: CheckResult[] = checks.map((check) => {
  const startedAt = Date.now();
  const run = spawnSync(check.command, check.args, {
    cwd: adminWebDir,
    encoding: "utf8",
    timeout: CHECK_TIMEOUT_MS,
    env: { ...process.env, FORCE_COLOR: "0", CI: "1" },
  });
  // 실행 자체가 안 됐거나(명령 없음) 시간 초과면 exitCode 가 null — 실패로 센다.
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ? `\n${String(run.error)}` : ""}`;
  return { name: check.name, exitCode: run.status, durationMs: Date.now() - startedAt, outputTail: tail(output) };
});

const record = buildRecord({
  at: new Date().toISOString(),
  tool: input.tool,
  file: path.relative(projectDir, path.resolve(adminWebDir, input.file)),
  checks: results,
});

try {
  mkdirSync(path.dirname(logFile), { recursive: true });
  appendFileSync(logFile, `${JSON.stringify(record)}\n`);
} catch (error) {
  // 기록을 못 남겨도 작업은 계속한다 — 대신 stderr 로 알린다.
  process.stderr.write(`품질 게이트 기록 실패: ${String(error)}\n`);
}

const output = buildHookOutput(record, logFile);
if (output) process.stdout.write(JSON.stringify(output));
process.exit(0);
