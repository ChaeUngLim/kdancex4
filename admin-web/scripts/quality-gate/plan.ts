// 품질 게이트 훅의 「무엇을 돌릴지·결과를 어떻게 남길지」를 정하는 순수 함수 모음(S0-4.6(품질 게이트 훅 설치)).
//
// 흐름: Claude Code 가 Edit/Write 로 파일을 고친다 → PostToolUse 훅이 scripts/quality-gate-hook.ts 를 부른다
//       → 이 파일의 planChecks 가 고친 파일을 보고 돌릴 검사를 고른다 → 훅이 검사를 돌리고 기록을 남긴다.
//
// 2026-11-20 사용자 승인 조건(경고만):
//   - admin-web 의 TS 파일이 바뀌면 타입 검사(tsc --noEmit)와 그 파일에 걸린 단위 테스트(vitest related)를 돌린다.
//   - admin-web/package.json 이 바뀌면 npm audit 로 high 이상 취약점을 본다.
//   - 실패해도 막지 않는다. 기록하고 경고만 한다. lint 는 넣지 않는다.
// 검사를 실제로 돌리는 부분(child_process)은 이 파일에 두지 않는다 — 여기 함수는 입력만 보고 답을 내므로 테스트가 쉽다.

import path from "node:path";

/** 훅이 돌릴 검사 하나. cwd 는 admin-web 폴더 기준으로 돈다. */
export type Check = {
  name: "tsc" | "vitest-related" | "npm-audit";
  command: string;
  args: string[];
};

/** 검사 하나를 돌린 결과. */
export type CheckResult = {
  name: Check["name"];
  exitCode: number | null;
  durationMs: number;
  /** 출력 끝부분만 남긴다 — 기록 파일이 끝없이 커지지 않게. */
  outputTail: string;
};

/** 기록 파일(JSON Lines)에 한 줄로 들어가는 실행 기록. */
export type HookRecord = {
  at: string;
  tool: string;
  file: string;
  checks: CheckResult[];
  ok: boolean;
};

// TS 로 보는 확장자. .d.ts 도 끝이 .ts 라 타입 검사 대상에 들어간다.
const TS_EXTENSIONS = [".ts", ".tsx"];
// 이 폴더 아래 파일은 우리가 쓴 코드가 아니다(설치본·빌드 산출물) — 검사하지 않는다.
const IGNORED_DIRS = ["node_modules", ".next"];
/** 기록 한 건에 남기는 출력 길이(글자). */
export const OUTPUT_TAIL_CHARS = 2000;

/**
 * 고친 파일 경로를 보고 돌릴 검사 목록을 고른다.
 * admin-web 밖이거나 대상이 아닌 파일이면 빈 배열 — 훅은 아무것도 안 하고 끝난다.
 */
export function planChecks(filePath: string, adminWebDir: string): Check[] {
  if (!filePath) return [];
  const relative = path.relative(adminWebDir, path.resolve(adminWebDir, filePath));
  // "../" 로 시작하면 admin-web 밖이다(mobile·backend·문서 등).
  if (relative.startsWith("..") || path.isAbsolute(relative)) return [];

  const parts = relative.split(path.sep);
  if (parts.some((part) => IGNORED_DIRS.includes(part))) return [];

  if (relative === "package.json") {
    // --audit-level=high: high·critical 이 있을 때만 exit 1 이 된다(low·moderate 는 통과).
    return [{ name: "npm-audit", command: "npm", args: ["audit", "--audit-level=high"] }];
  }

  if (!TS_EXTENSIONS.includes(path.extname(relative))) return [];

  return [
    // 타입 검사는 파일 하나만 볼 수 없다 — 한 파일을 바꾸면 그걸 import 하는 다른 파일이 깨질 수 있어서 전체를 본다.
    { name: "tsc", command: "./node_modules/.bin/tsc", args: ["--noEmit"] },
    // vitest related: 이 파일을 (직간접으로) import 하는 테스트만 고른다. DB 테스트는 빼고 unit 프로젝트만.
    // 걸린 테스트가 없으면 실패가 아니라 통과로 본다(--passWithNoTests).
    {
      name: "vitest-related",
      command: "./node_modules/.bin/vitest",
      args: ["related", "--run", "--project", "unit", "--passWithNoTests", relative],
    },
  ];
}

/** 출력이 길면 끝부분만 자른다. 오류 메시지는 보통 끝에 모여 있다. */
export function tail(text: string, max: number = OUTPUT_TAIL_CHARS): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

/** 검사 결과를 모아 기록 한 건을 만든다. 하나라도 exit 0 이 아니면 ok=false. */
export function buildRecord(input: { at: string; tool: string; file: string; checks: CheckResult[] }): HookRecord {
  return { ...input, ok: input.checks.every((check) => check.exitCode === 0) };
}

/**
 * 훅이 stdout 으로 내보낼 JSON 을 만든다. 실패가 있을 때만 경고를 낸다.
 *   systemMessage     : 사람에게 보이는 경고 한 줄
 *   additionalContext : 에이전트(Claude)에게 전달되는 설명 — 무엇이 깨졌는지 보고 고칠 수 있게
 * decision: "block" 은 넣지 않는다 — 사용자 조건이 「막지 않고 경고만」이다.
 */
export function buildHookOutput(record: HookRecord, logFile: string): Record<string, unknown> | null {
  if (record.ok) return null;
  const failed = record.checks.filter((check) => check.exitCode !== 0);
  const names = failed.map((check) => check.name).join(", ");
  const details = failed
    .map((check) => `[${check.name}] exit=${check.exitCode}\n${tail(check.outputTail, 800)}`)
    .join("\n\n");
  return {
    systemMessage: `품질 게이트 경고: ${record.file} 수정 뒤 ${names} 실패 (기록: ${logFile})`,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `품질 게이트(경고만, 막지 않음)에서 실패가 났다. 파일: ${record.file}\n${details}`,
    },
  };
}
