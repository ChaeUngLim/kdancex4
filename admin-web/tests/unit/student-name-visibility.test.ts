// S2-4.5a(개인 레슨 수강생 이름 표시 규칙) — 강사에게 수강생 이름을 보이나, 숫자만 보이나 단위 테스트
//   수용: 마스터 플랜 S2-4 수용 ④ 「개인 레슨은 결제 대기여도 강사에게 수강생 이름이 보인다
//         (단체 수업 명단의 「결제 대기 N명」 숫자 규칙은 적용하지 않는다, 2026-11-19)」
//   계약: 11-instructor.md §10-3(nameVisible) · Phase 6 단위 「개인 레슨 수강생 이름 표시 규칙(결제 대기도 이름, 멤버십 끝나면 숨김)」
//         18-after-payment-views.md §1-2 「결제 대기」 행
//   spec: Q20(강사 명단 표시 범위) · FR-005(역할별 데이터 범위)
// (verify 의 Task 번호 이름 tests/unit/s2-4-5a.test.ts 를 기능 이름으로 바꿨다)
import { describe, expect, test } from "vitest";

import { CLASS_KINDS } from "../../lib/domain/constants";
import { decideStudentNameDisplay } from "../../lib/domain/student-name-visibility";

describe("decideStudentNameDisplay — 1:1 개인 레슨", () => {
  test("결제 대기여도 이름을 보인다(2026-11-19 예외)", () => {
    expect(decideStudentNameDisplay({ classKind: "private_lesson", paymentState: "awaiting_payment" })).toBe("name");
  });

  test("결제 완료면 이름을 보인다", () => {
    expect(decideStudentNameDisplay({ classKind: "private_lesson", paymentState: "paid" })).toBe("name");
  });

  test("강사 멤버십이 끝나면 결제 상태와 상관없이 숨긴다(시간·횟수만 남는다, 계약 11 §10-3)", () => {
    for (const paymentState of ["paid", "awaiting_payment"] as const) {
      expect(
        decideStudentNameDisplay({ classKind: "private_lesson", paymentState, instructorMembershipActive: false }),
      ).toBe("hidden");
    }
  });

  test("멤버십 값을 안 주면 켜진 것으로 본다(S6-1 전에는 항상 보인다)", () => {
    expect(
      decideStudentNameDisplay({ classKind: "private_lesson", paymentState: "awaiting_payment", instructorMembershipActive: true }),
    ).toBe("name");
  });
});

describe("decideStudentNameDisplay — 단체 수업 명단", () => {
  // 개인 레슨을 뺀 수업 구분 8종이 전부 단체 수업 규칙을 따른다
  const groupKinds = CLASS_KINDS.filter((kind) => kind !== "private_lesson");

  test("수업 구분 9종 중 개인 레슨만 예외다", () => {
    expect(groupKinds).toHaveLength(CLASS_KINDS.length - 1);
  });

  test.each(groupKinds)("%s — 결제 대기는 이름 없이 숫자만(「결제 대기 N명」)", (classKind) => {
    expect(decideStudentNameDisplay({ classKind, paymentState: "awaiting_payment" })).toBe("count_only");
  });

  test.each(groupKinds)("%s — 결제 완료는 이름을 보인다", (classKind) => {
    expect(decideStudentNameDisplay({ classKind, paymentState: "paid" })).toBe("name");
  });

  test("단체 수업 결제 대기는 멤버십이 켜져 있어도 숫자만이다", () => {
    expect(
      decideStudentNameDisplay({ classKind: "regular", paymentState: "awaiting_payment", instructorMembershipActive: true }),
    ).toBe("count_only");
  });
});
