// S1-1.10(입점 신청 초안 저장·조회 API) — 정산 계좌번호를 다루는 순수 규칙(DB·암호화 없음).
//   계약 07 §2: 응답에는 계좌번호를 `"accountMasked": "110-***-***521"` 처럼 가린 값으로만 돌려준다.
//   data-model §7-3: 끝 4자리(`payout_account_last4`)는 따로 저장한다(CHECK `^[0-9]{4}$`).

import type { PayoutAccountStatus, PayoutVerificationStatus } from "./constants";

/** 계좌번호 글자 모양 — 숫자만, 은행마다 길이가 달라 10~16자로 넉넉히 받는다 */
export const ACCOUNT_NUMBER_PATTERN = /^[0-9]{10,16}$/;

/** 사람이 넣은 하이픈·공백을 걷어 숫자만 남긴다(「110-000-000521」 → 「110000000521」) */
export function normalizeAccountNumber(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

/** 끝 4자리 — 화면·감사 기록에 남겨도 되는 유일한 부분 */
export function accountLast4(accountNumber: string): string {
  return accountNumber.slice(-4);
}

/**
 * 가린 계좌번호. 앞 3자리(은행 지점 구분처럼 보이는 부분)와 끝 3자리만 보이고 가운데는 별표다.
 * 계약 예시 그대로: 「110000000521」 → 「110-***-***521」.
 * 가운데 자리 수를 드러내지 않으려고 별표 개수는 길이와 상관없이 고정한다.
 */
export function maskAccountNumber(accountNumber: string): string {
  return `${accountNumber.slice(0, 3)}-***-***${accountNumber.slice(-3)}`;
}

// ── S1-1.22(예금주 확인 상태와 지급 금지 판정) ──
//   R15(무료 확인 수단 부재) 확정: 예금주 확인은 운영자가 통장 사본의 이름을 눈으로 대조하는 수동 확인뿐이다.
//   그래서 「확인이 끝나지 않은 계좌로는 돈을 보내지 않는다」를 코드 한 곳에서 판정한다.
//   대표 계좌(academy_payout_accounts)와 강사 계좌(instructor_payout_accounts, S5-2)가 같은 함수를 쓴다(data-model §10-5).
//   운영자가 확인·반려하는 경로는 S7-4.8b(예금주 확인 처리 API(P10), 계약 13 §10-2)가 만든다.

/** 판정에 필요한 칸만 — 두 계좌 표가 같은 칸 이름(status·verification_status)을 쓴다 */
export type PayoutAccountForPayability = {
  readonly status: PayoutAccountStatus;
  readonly verificationStatus: PayoutVerificationStatus;
};

/** 지급을 못 하는 사유 — 계약 13 §5-1 의 지급 보류 `account_unverified`(계좌 없음·확인 전) */
export type PayoutAccountHoldReason = "account_unverified";

/**
 * 이 계좌로 돈을 보내도 되나?
 * 쓰는 계좌(active)이고 예금주 확인이 끝난(verified) 경우에만 true 다.
 * 사본 올리기 전(awaiting_proof)·운영자 대조 대기(pending)·반려(rejected)·바뀐 옛 계좌(replaced)·계좌 없음은 전부 false.
 * 「모르는 상태면 막는다」 쪽으로 짰다 — 값 집합에 상태가 늘어나도 verified 가 아니면 지급되지 않는다.
 */
export function isPayableAccount(account: PayoutAccountForPayability | null | undefined): boolean {
  if (!account) return false;
  return account.status === "active" && account.verificationStatus === "verified";
}

/**
 * 지급 계산(S5-3)이 항목을 만들 때 쓴다 — 보낼 수 없으면 지급 보류 사유를, 보낼 수 있으면 null 을 돌려준다.
 * 사유가 나오면 그 몫은 승인 대상에서 빠지고 보류로 쌓였다가, 확인 뒤 다음 묶음에 합쳐진다(13 §10-2).
 */
export function payoutAccountHoldReason(
  account: PayoutAccountForPayability | null | undefined,
): PayoutAccountHoldReason | null {
  return isPayableAccount(account) ? null : "account_unverified";
}
