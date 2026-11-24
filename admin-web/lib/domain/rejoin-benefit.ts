// S3-1.6(재가입 혜택 차단) — 「이 사람이 처음 가입한 사람인가」를 본인확인 CI 해시로 판정하는 순수 함수.
//   DB·시계·네트워크를 모른다. 신규 혜택을 주는 곳(S6-1(혜택·쿠폰))이 혜택을 주기 직전에 부른다.
//   근거: FR-010(재가입 혜택 차단) — 탈퇴 후 재가입한 사람은 1회성 혜택을 다시 받지 못한다.
//         data-model §12 `withdrawn_identities`(탈퇴해도 CI 해시만 남겨 두는 표, S7-3(탈퇴·보존) 이 채운다).
//
// 왜 회원 id 가 아니라 CI 해시로 보나:
//   탈퇴하면 회원 행은 익명화되고(identity_ci_hash 를 비운다) 다시 가입하면 새 회원 id 가 생긴다.
//   회원 id 로 세면 재가입한 사람이 「처음 온 사람」으로 보인다. 사람마다 하나뿐인 값은 본인확인 CI 이고,
//   탈퇴 뒤에도 남는 것은 그 해시(withdrawn_identities.ci_hash)뿐이라 이 값으로 본다.
//
// 왜 탈퇴 기록만 보면 되나:
//   살아 있는 회원 사이에서는 같은 CI 가 둘일 수 없다(uq_members_identity_ci_hash — S3-1.2(가짜 본인확인·가입 API)).
//   그래서 「같은 CI 의 두 번째 가입」은 탈퇴 뒤 재가입일 때만 생기고, 그 흔적은 탈퇴 기록에만 있다.
//
// 보존 기한이 지난 기록을 지우는 일은 S7-3 의 정리 작업이 맡는다. 이 함수는 받은 기록을 그대로 믿는다.

/** 탈퇴 기록 한 줄에서 판정에 쓰는 칸 — withdrawn_identities.ci_hash */
export interface WithdrawnIdentityRecord {
  readonly ciHash: string;
}

/** 판정 결과. 신규가 아니면 왜 아닌지를 함께 돌려줘 화면·감사 기록이 같은 말을 쓰게 한다 */
export type NewcomerJudgement =
  | { readonly isNewcomer: true; readonly reason: "first_signup" }
  | { readonly isNewcomer: false; readonly reason: "rejoined_after_withdrawal" };

/**
 * 본인확인 CI 해시 하나가 「신규 가입자」인가.
 *   - 같은 해시의 탈퇴 기록이 하나라도 있으면 재가입 → 신규 아님(몇 번째 가입이든 같다)
 *   - 없으면 처음 가입 → 신규
 * 해시는 글자 그대로 비교한다. 해시는 본인확인 어댑터가 늘 같은 형식으로 만들기 때문에,
 * 여기서 대소문자·공백을 맞춰 비교하면 오히려 다른 사람을 막을 위험이 생긴다.
 * 해시가 비어 있으면 판정하지 않고 오류를 낸다 — 본인확인이 안 된 계정에 「신규」 혜택을 주면 안 된다.
 */
export function judgeNewcomerByIdentity(
  ciHash: string,
  withdrawnRecords: readonly WithdrawnIdentityRecord[],
): NewcomerJudgement {
  if (ciHash.trim() === "") {
    throw new Error("judgeNewcomerByIdentity: CI 해시가 비어 있다 — 본인확인 없는 계정은 판정하지 않는다");
  }
  // 같은 사람(같은 CI)이 예전에 탈퇴한 적이 있는지만 본다
  const rejoined = withdrawnRecords.some((record) => record.ciHash === ciHash);
  return rejoined
    ? { isNewcomer: false, reason: "rejoined_after_withdrawal" }
    : { isNewcomer: true, reason: "first_signup" };
}
