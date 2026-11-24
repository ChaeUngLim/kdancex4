// S3-1.6(재가입 혜택 차단) — CI 기준 「신규 가입자인가」 판정 순수 함수. DB 없이 돈다.
//   verify: 같은 CI 의 두 번째 가입은 신규 아님(FR-010(재가입 혜택 차단))
// 이름: verify 의 tests/unit/s3-1-6.test.ts 는 Task 번호 이름이라 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { describe, expect, test } from "vitest";

import { judgeNewcomerByIdentity } from "@/lib/domain/rejoin-benefit";

const CI_A = "ci-hash-aaaa";
const CI_B = "ci-hash-bbbb";

describe("재가입 혜택 차단 — CI 기준 신규 가입자 판정(FR-010)", () => {
  test("처음 가입한 CI 는 신규 — 탈퇴 기록이 하나도 없다", () => {
    expect(judgeNewcomerByIdentity(CI_A, [])).toEqual({ isNewcomer: true, reason: "first_signup" });
  });

  test("같은 CI 의 두 번째 가입(탈퇴 뒤 재가입)은 신규 아님", () => {
    const withdrawn = [{ ciHash: CI_A }];
    expect(judgeNewcomerByIdentity(CI_A, withdrawn)).toEqual({
      isNewcomer: false,
      reason: "rejoined_after_withdrawal",
    });
  });

  test("다른 사람(다른 CI)의 탈퇴 기록은 판정에 영향이 없다", () => {
    expect(judgeNewcomerByIdentity(CI_B, [{ ciHash: CI_A }])).toEqual({ isNewcomer: true, reason: "first_signup" });
  });

  test("여러 번 탈퇴·재가입해도 계속 신규 아님(세 번째 가입)", () => {
    const withdrawn = [{ ciHash: CI_A }, { ciHash: CI_B }, { ciHash: CI_A }];
    expect(judgeNewcomerByIdentity(CI_A, withdrawn).isNewcomer).toBe(false);
  });

  test("해시는 글자 그대로 비교한다 — 대소문자가 다르면 다른 값", () => {
    // 해시 값은 한 함수(본인확인 어댑터)가 늘 같은 형식으로 만든다. 여기서 바꿔 맞추면 다른 사람을 막을 수 있다
    expect(judgeNewcomerByIdentity("CI-HASH-AAAA", [{ ciHash: CI_A }]).isNewcomer).toBe(true);
  });

  test("CI 해시가 비어 있으면 판정하지 않고 오류 — 본인확인 없는 회원에게 혜택을 주지 않는다", () => {
    expect(() => judgeNewcomerByIdentity("", [])).toThrow();
    expect(() => judgeNewcomerByIdentity("   ", [])).toThrow();
  });

  test("입력 목록을 바꾸지 않는다", () => {
    const withdrawn = Object.freeze([Object.freeze({ ciHash: CI_A })]);
    expect(() => judgeNewcomerByIdentity(CI_A, withdrawn)).not.toThrow();
  });
});
