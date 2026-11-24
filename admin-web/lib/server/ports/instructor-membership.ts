// S6-3.4(강사 레벨 조절과 평가 레벨 숨김) — 「이 강사가 지금 강사 멤버십을 쓰는가」를 묻는 포트.
//   계약: _workspace/03_contracts/14-membership-benefits.md §2(강사 멤버십 — 끝나면 403 INSTRUCTOR_MEMBERSHIP_REQUIRED) · §6(레벨 조절)
//   요구: spec FR-169d(강사 레벨 등급 조절) ② — 레벨 올리기는 **멤버십 강사만**(2026-11-24 사용자 결정, 받는 회원은 멤버십 무관)
//
// 왜 포트로 두나: 강사 멤버십 표(S6-1.2)와 가입·체험(S6-1.4)이 아직 없다. 레벨 조절 경로는 「멤버십이냐 아니냐」만 알면 되므로
//   그 한 가지 질문을 인터페이스로 떼어 두고, 지금은 가짜(fakes/fake-instructor-membership.ts)를 쓴다.
//   S6-1 이 생기면 「memberships 표에서 trial·active·retrying·cancel_scheduled 인가」를 읽는 구현으로 **이 포트의 구현만** 바꾼다.
//   경로·서비스 코드는 그대로다.
export interface InstructorMembershipPort {
  /**
   * 그 강사 계정(staff_accounts.id)이 지금 강사 멤버십 기능을 쓸 수 있으면 true.
   * 멤버십이 끝났으면(expired·ended) false — 데이터는 지우지 않고 기능만 잠근다(계약 14 §2).
   */
  isInstructorMember(staffAccountId: string): Promise<boolean>;
}
