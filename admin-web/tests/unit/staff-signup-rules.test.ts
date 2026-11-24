// S1-1.8(대표 가입 API) — 직원 가입 순수 규칙(Q41(강사 가입 규칙) · 계약 07 §0). DB 없이 돈다.
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import {
  isAtLeastAge,
  isValidStaffUsername,
  maskPersonName,
  maskPhone,
  maskUsername,
  passwordProblem,
} from "@/lib/domain/staff-signup";

describe("직원 가입 규칙", () => {
  test("아이디는 영문 소문자·숫자 4~20자", () => {
    expect(["abcd", "latinhouse01", "a".repeat(20)].every(isValidStaffUsername)).toBe(true);
    expect(["abc", "a".repeat(21), "Latin01", "junho_latin", "한글아이디", "ab cd"].some(isValidStaffUsername)).toBe(false);
  });

  test("비밀번호는 8자 이상 · 영문·숫자·기호 모두 · 아이디와 다름", () => {
    expect(passwordProblem("Latin!2026x", "latinhouse01")).toBeNull();
    expect(passwordProblem("La!1", "x")).toContain("8자");
    expect(passwordProblem("Latin2026x", "x")).toContain("기호");
    expect(passwordProblem("!!!!2026", "x")).toContain("영문");
    expect(passwordProblem("Abc!1234", "abc!1234")).toContain("아이디");
    expect(passwordProblem(`A1!${"a".repeat(126)}`, "x")).toContain("128");
  });

  test("만 나이 — 생일 당일부터 한 살 늘어난다, 2월 29일생은 평년 2월 28일", () => {
    const today = Temporal.PlainDate.from("2026-11-20");
    expect(isAtLeastAge(Temporal.PlainDate.from("2007-11-20"), today, 19)).toBe(true);
    expect(isAtLeastAge(Temporal.PlainDate.from("2007-11-21"), today, 19)).toBe(false);
    expect(isAtLeastAge(Temporal.PlainDate.from("2004-02-29"), Temporal.PlainDate.from("2023-02-28"), 19)).toBe(true);
  });

  test("가리기 — 이름·전화·아이디", () => {
    expect(maskPersonName("김대표")).toBe("김*표");
    expect(maskPersonName("이준")).toBe("이*");
    expect(maskPersonName("남궁민수")).toBe("남**수");
    expect(maskPhone("01012345821")).toBe("010-****-5821");
    expect(maskUsername("latinhouse01")).toBe("lat***e01");
    expect(maskUsername("abcd")).toBe("ab**");
  });
});
