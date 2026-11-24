// S1-1.7(파일 내려받기 권한) — 판정 함수 canDownloadFile 과 Content-Disposition 머리말을 DB 없이 확인한다.
//   DB·세션까지 붙인 확인은 tests/db/file-download.db.test.ts 가 한다.
import { describe, expect, test } from "vitest";

import { canDownloadFile, contentDisposition, type FileAccessFacts } from "../../lib/server/services/file-download";

const base: FileAccessFacts = {
  staffAccountId: "me",
  roles: [],
  ownedAcademyIds: [],
  uploaderAccountId: "someone",
  attachedAcademyIds: ["academy-a"],
};

describe("canDownloadFile — 올린 사람 · 붙은 학원의 대표 · 운영자만", () => {
  test.each<[string, Partial<FileAccessFacts>, boolean]>([
    ["아무 관계 없는 직원은 거부", {}, false],
    ["운영자는 허용", { roles: ["admin"] }, true],
    ["올린 사람은 허용", { uploaderAccountId: "me" }, true],
    ["붙은 학원의 대표는 허용", { ownedAcademyIds: ["academy-a"] }, true],
    ["다른 학원의 대표는 거부", { ownedAcademyIds: ["academy-b"] }, false],
    ["강사 역할만으로는 거부", { roles: ["instructor"] }, false],
    ["어디에도 안 붙은 파일은 대표라도 거부", { ownedAcademyIds: ["academy-a"], attachedAcademyIds: [] }, false],
  ])("%s", (_name, override, expected) => {
    expect(canDownloadFile({ ...base, ...override })).toBe(expected);
  });
});

describe("contentDisposition — 올린 이름이 머리말을 깨지 못한다", () => {
  test("한글 이름은 ASCII 칸에서 _ 로, filename* 에서 퍼센트 인코딩으로", () => {
    expect(contentDisposition("증빙.pdf")).toBe(`attachment; filename="__.pdf"; filename*=UTF-8''${encodeURIComponent("증빙.pdf")}`);
  });
  test("따옴표·역슬래시·줄바꿈은 ASCII 칸에 그대로 들어가지 않는다", () => {
    const header = contentDisposition('a"b\\c\r\nSet-Cookie: x.pdf');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.startsWith('attachment; filename="a_b_c__Set-Cookie: x.pdf"; filename*=UTF-8\'\'')).toBe(true);
  });
});
