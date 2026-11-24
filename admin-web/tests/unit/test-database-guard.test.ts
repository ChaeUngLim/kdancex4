// 테스트 DB 가드·실패 메시지 단위 테스트 — DB 없이 돈다.
import { describe, expect, test } from "vitest";

import { assertTestDatabaseName, describeCliFailure } from "../setup/test-database";

describe("assertTestDatabaseName(테스트 DB 이름 가드)", () => {
  test("DB 이름이 _test 로 끝나면 통과한다", () => {
    expect(() => assertTestDatabaseName("postgresql://u:p@localhost:5433/kdance_next_test")).not.toThrow();
  });

  test("개발 DB 이름이면 던진다", () => {
    expect(() => assertTestDatabaseName("postgresql://u:p@localhost:5433/kdance_next")).toThrow(/_test/);
  });

  test("해석할 수 없는 주소면 던진다", () => {
    expect(() => assertTestDatabaseName("not a url")).toThrow(/해석/);
  });

  test("오류 메시지에 비밀번호를 싣지 않는다", () => {
    try {
      assertTestDatabaseName("postgresql://u:secretpw@localhost:5433/kdance_next");
    } catch (e) {
      expect(String(e)).not.toContain("secretpw");
    }
  });
});

describe("describeCliFailure(CLI 실패 사유 붙이기)", () => {
  test("stderr·stdout 원문을 메시지에 붙인다", () => {
    const err = Object.assign(new Error("Command failed"), {
      status: 1,
      stderr: Buffer.from("Refusing: data loss on seat_pools"),
      stdout: Buffer.from(""),
    });
    const msg = describeCliFailure("prisma db update", err);
    expect(msg).toContain("prisma db update");
    expect(msg).toContain("Refusing: data loss on seat_pools");
    expect(msg).toContain("1");
  });

  test("Error 가 아닌 값도 문자열로 다룬다", () => {
    expect(describeCliFailure("x", "boom")).toContain("boom");
  });
});
