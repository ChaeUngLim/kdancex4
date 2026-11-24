// S3-1.2(가짜 본인확인·가입 API) — 회원 닉네임 규칙(계약 01 §3 「닉네임」 표 · FR-019a(회원 닉네임 표시)).
// DB 제약 ck_members_nickname 의 길이와 상수 NICKNAME_MIN·NICKNAME_MAX 가 같은지도 본다 — 한쪽만 바꾸면 여기서 깨진다.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  NICKNAME_MAX,
  NICKNAME_MIN,
  containsBlockedWord,
  nicknameShapeProblem,
  normalizeNickname,
} from "@/lib/domain/member-nickname";

describe("회원 닉네임 규칙", () => {
  test("정리: 앞뒤 공백을 자르고 가운데 연속 공백은 한 칸", () => {
    expect(normalizeNickname("  서연   댄서\t ")).toBe("서연 댄서");
  });

  test("길이는 글자 수로 2~12자", () => {
    expect(nicknameShapeProblem("서")).not.toBeNull();
    expect(nicknameShapeProblem("서연")).toBeNull();
    expect(nicknameShapeProblem("가".repeat(12))).toBeNull();
    expect(nicknameShapeProblem("가".repeat(13))).not.toBeNull();
  });

  test("한글·영문·숫자·공백·_·. 만", () => {
    expect(nicknameShapeProblem("Salsa_luv.01")).toBeNull();
    expect(nicknameShapeProblem("서연!")).not.toBeNull();
    expect(nicknameShapeProblem("ㅋㅋㅋ")).not.toBeNull(); // 자모만은 안 된다
    expect(nicknameShapeProblem("서연😀")).not.toBeNull();
  });

  test("금칙어는 부분 일치·대소문자·띄어 쓰기 우회까지 잡고, 평범한 이름은 통과", () => {
    expect(containsBlockedWord("운영자")).toBe(true);
    expect(containsBlockedWord("KDance팬")).toBe(true);
    expect(containsBlockedWord("관 리 자")).toBe(true);
    expect(containsBlockedWord("ad.min")).toBe(true);
    expect(containsBlockedWord("서연")).toBe(false);
    expect(containsBlockedWord("탱고 사랑")).toBe(false);
  });

  test("DB 제약 ck_members_nickname 과 상수 길이가 같다", () => {
    const prisma = readFileSync(join(__dirname, "../../prisma/contract.prisma"), "utf8");
    expect(prisma).toContain(`char_length(nickname) BETWEEN ${NICKNAME_MIN} AND ${NICKNAME_MAX}`);
  });
});
