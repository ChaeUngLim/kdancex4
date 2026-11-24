// S2-4.5a(개인 레슨 수강생 이름 표시 규칙) — 강사 화면에 수강생 이름을 보일지 정하는 순수 함수
//   수용: 마스터 플랜 S2-4 수용 ④ 「개인 레슨은 결제 대기여도 강사에게 수강생 이름이 보인다」(2026-11-19)
//   계약: 11-instructor.md §10-3(nameVisible) · 18-after-payment-views.md §1-2 「결제 대기」 행
//   spec: Q20(강사 명단 표시 범위)
//
// 규칙 표:
//   수업 구분          결제 상태    멤버십   → 보이는 것
//   1:1 개인 레슨      완료·대기    켜짐     → name        (상대가 정해져 있어 강사가 알아야 한다)
//   1:1 개인 레슨      완료·대기    끝남     → hidden      (시간·횟수만 남는다, I10)
//   단체 수업(그 밖 8종) 완료       —        → name        (닉네임 — FR-019a)
//   단체 수업(그 밖 8종) 대기       —        → count_only  (이름 없이 「결제 대기 N명」 숫자로만)
//
// 멤버십 판정은 S6-1(강사 멤버십)이 준다. 그 전에는 값을 넘기지 않으면 켜진 것으로 본다(계약 11 §10-3).
// 단체 수업 명단에 멤버십을 거는 규칙은 계약에 없어서 여기서 만들지 않았다.
import type { ClassKind } from "./constants";

/** 강사가 보는 수강생 한 사람의 결제 상태 — 확정(paid·partially_refunded)이면 paid, 결제 전이면 awaiting_payment */
export type StudentPaymentState = "paid" | "awaiting_payment";

/**
 * 강사 화면에 보일 모양
 * - name: 닉네임을 보인다
 * - count_only: 이름 없이 인원 수에만 더한다(단체 수업 결제 대기)
 * - hidden: 이름을 숨기고 시간·횟수만 보인다(개인 레슨, 멤버십 끝남)
 */
export type StudentNameDisplay = "name" | "count_only" | "hidden";

export interface StudentNameDisplayInput {
  /** 수업 구분(`classes.class_kind`) — `private_lesson` 만 1:1 개인 레슨이다 */
  readonly classKind: ClassKind;
  readonly paymentState: StudentPaymentState;
  /** 강사 멤버십이 살아 있나. 안 주면 true(S6-1 전에는 항상 보인다) */
  readonly instructorMembershipActive?: boolean;
}

/** 수강생 한 사람을 강사 화면에 어떤 모양으로 보일지 정한다 */
export function decideStudentNameDisplay(input: StudentNameDisplayInput): StudentNameDisplay {
  // 1:1 개인 레슨: 결제 대기여도 이름을 보인다. 숫자 규칙은 단체 수업 명단에만 있다(2026-11-19 사용자 결정)
  if (input.classKind === "private_lesson") {
    const membershipActive = input.instructorMembershipActive ?? true;
    return membershipActive ? "name" : "hidden";
  }

  // 단체 수업: 결제 전인 사람은 이름을 내리지 않고 「결제 대기 N명」 숫자에만 넣는다(Q20)
  return input.paymentState === "awaiting_payment" ? "count_only" : "name";
}
