// S0-6.4(.env.example 3곳과 이름 집합 테스트) — 수용 ④: `.env.example` 의 이름 집합과 스키마의 이름 집합이 같다.
//   플랜: _workspace/06_master-plan.md 「S0-6(환경 분리·비밀값 목록)」
//
// 왜 이 테스트가 필요한가: 스키마에 새 변수를 넣고 예시 파일을 안 고치면, 새 PC 에서 예시를 복사한 사람은
// 무엇을 채워야 하는지 모른 채 서버를 띄우다 시작 거부를 만난다. 반대로 예시에만 남은 옛 이름은
// 아무도 읽지 않는 값을 채우게 만든다. 두 방향 모두 여기서 잡는다.
//
// 세 곳의 「스키마」는 각각 이렇게 읽는다.
//   admin-web : lib/server/env.ts 의 serverEnvNames() — 서버가 시작할 때 검사하는 이름 전부
//   backend   : app/config.py 의 Settings 클래스 필드(pydantic-settings 는 필드 이름을 대문자 환경 변수로 읽는다)
//   mobile    : 소스가 읽는 process.env.EXPO_PUBLIC_* — Expo 는 이 접두 변수만 번들에 넣는다
//
// 그리고 예시 파일에는 **이름만** 적는다(값은 비운다). 비밀값이나 실제 접속 주소가 저장소에 들어가지 않게 하려는 것이다.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { serverEnvNames } from "../../lib/server/env";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const NAME_ONLY_LINE = /^([A-Z][A-Z0-9_]*)=$/;
// `# NAME=값` 처럼 주석 처리한 대입문 — 이름이 집합에서 숨어 버리므로 쓰지 않는다
const COMMENTED_ASSIGNMENT = /^#\s*[A-Z][A-Z0-9_]*\s*=/;

/** 예시 파일을 읽어 이름 목록을 돌려준다. 이름만 있는 줄(`NAME=`)이 아니면 그 줄을 문제로 모은다 */
function readExampleNames(relativePath: string): { names: string[]; badLines: string[] } {
  const text = readFileSync(join(REPO_ROOT, relativePath), "utf8");
  const names: string[] = [];
  const badLines: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "") return;
    if (line.startsWith("#")) {
      if (COMMENTED_ASSIGNMENT.test(line)) badLines.push(`${relativePath}:${index + 1} 주석 처리한 대입문`);
      return;
    }
    const match = NAME_ONLY_LINE.exec(line);
    // 값이 붙어 있으면 줄 번호만 알린다(값은 메시지에 싣지 않는다)
    if (match === null) badLines.push(`${relativePath}:${index + 1} 이름만 있는 줄이 아님`);
    else names.push(match[1]!);
  });
  return { names, badLines };
}

/** backend 스키마: Settings 클래스 본문의 `필드: 타입` 줄을 대문자 이름으로 */
function backendSchemaNames(): string[] {
  const source = readFileSync(join(REPO_ROOT, "backend/app/config.py"), "utf8");
  const classStart = source.indexOf("class Settings(BaseSettings):");
  expect(classStart).toBeGreaterThanOrEqual(0);
  const names: string[] = [];
  // 클래스 본문은 들여쓰기 된 줄이 이어지는 구간이다. 들여쓰기 없는 줄을 만나면 클래스가 끝난다
  for (const line of source.slice(classStart).split("\n").slice(1)) {
    if (line.trim() !== "" && !line.startsWith(" ")) break;
    const field = /^ {4}([a-z_][a-z0-9_]*)\s*:/.exec(line);
    if (field !== null) names.push(field[1]!.toUpperCase());
  }
  return names;
}

/** mobile 스키마: 소스(.ts/.tsx/.js)가 읽는 EXPO_PUBLIC_* 이름 */
function mobileSchemaNames(): string[] {
  const skip = new Set(["node_modules", ".expo", "dist", "web-build"]);
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        for (const m of readFileSync(path, "utf8").matchAll(/process\.env\.(EXPO_PUBLIC_[A-Z0-9_]+)/g)) {
          found.add(m[1]!);
        }
      }
    }
  };
  walk(join(REPO_ROOT, "mobile"));
  return [...found];
}

const sorted = (names: readonly string[]) => [...new Set(names)].sort();

// 세 곳을 같은 모양으로 검사한다: ① 이름만 적었다 ② 이름이 겹치지 않는다 ③ 스키마와 집합이 같다
const CASES = [
  { place: "admin-web", file: "admin-web/.env.example", schema: () => serverEnvNames() },
  { place: "backend", file: "backend/.env.example", schema: backendSchemaNames },
  { place: "mobile", file: "mobile/.env.example", schema: mobileSchemaNames },
] as const;

describe.each(CASES)("$place 의 .env.example", ({ file, schema }) => {
  test("값 없이 이름만 적었다", () => {
    expect(readExampleNames(file).badLines).toEqual([]);
  });

  test("같은 이름을 두 번 적지 않았다", () => {
    const { names } = readExampleNames(file);
    expect(names.length).toBe(new Set(names).size);
  });

  test("이름 집합이 스키마와 같다", () => {
    const schemaNames = sorted(schema());
    expect(schemaNames.length).toBeGreaterThan(0);
    expect(sorted(readExampleNames(file).names)).toEqual(schemaNames);
  });
});

describe("검사기 자체", () => {
  // 실패를 못 잡는 검사기는 검사기가 아니다 — 일부러 틀린 예시로 잡히는지 본다
  test("값이 붙은 줄과 주석 처리한 대입문을 잡는다", () => {
    expect(NAME_ONLY_LINE.test("DATABASE_URL=postgres://x")).toBe(false);
    expect(NAME_ONLY_LINE.test('BETTER_AUTH_SECRET=""')).toBe(false);
    expect(NAME_ONLY_LINE.test("DATABASE_URL=")).toBe(true);
    expect(COMMENTED_ASSIGNMENT.test("# RATE_LIMIT_IDENTITY_MAX=5")).toBe(true);
    expect(COMMENTED_ASSIGNMENT.test("# 비우면 기본값을 쓴다")).toBe(false);
  });

  test("backend 스키마를 Settings 필드에서 읽는다", () => {
    expect(backendSchemaNames()).toEqual(expect.arrayContaining(["DATABASE_URL", "REDIS_URL"]));
  });

  test("mobile 스키마를 소스에서 읽는다", () => {
    expect(mobileSchemaNames()).toContain("EXPO_PUBLIC_API_URL");
  });
});
