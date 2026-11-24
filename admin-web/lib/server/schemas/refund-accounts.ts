// S4-1.2a(환불 계좌 저장 API(본인 명의 확인)) — `POST /api/refund-accounts` 의 요청·응답 모양(zod).
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §2-1
//
// 이 파일은 경계 검증과 모양만 맡는다. 예금주 대조·암호화·DB 는 services/refund-accounts.ts 가 한다.
// 응답 스키마는 strict — 모르는 키(예: 실수로 넣은 계좌번호 원문)가 섞이면 parse 가 실패해 응답이 나가지 않는다.
import { z } from "zod";

import { ACCOUNT_NUMBER_PATTERN, normalizeAccountNumber } from "../../domain/payout-account";
import { bankNameOf, REFUND_HOLDER_NAME_MAX } from "../../domain/refund-account";

/**
 * 본문. 계좌번호는 사람이 넣은 하이픈·공백을 걷어 숫자 10~16자만 받는다(정산 계좌와 같은 규칙).
 * 예금주는 앞뒤 공백을 지운 1~100자 — DB 의 ck_refund_accounts_holder_name 과 같아 여기서 먼저 422 로 알려 준다.
 */
export const saveRefundAccountSchema = z.strictObject({
  orderId: z.uuid(),
  bankCode: z
    .string()
    .regex(/^[0-9]{3}$/, "은행 코드는 숫자 3자리예요")
    .refine((code) => bankNameOf(code) !== null, "고를 수 있는 은행이 아니에요"),
  accountNumber: z
    .string()
    .transform(normalizeAccountNumber)
    .refine((value) => ACCOUNT_NUMBER_PATTERN.test(value), "계좌번호는 숫자 10~16자리로 넣어 주세요"),
  holderName: z
    .string()
    .trim()
    .min(1, "예금주 이름을 넣어 주세요")
    .max(REFUND_HOLDER_NAME_MAX, `${REFUND_HOLDER_NAME_MAX}자 이하로 넣어 주세요`),
});
export type SaveRefundAccount = z.output<typeof saveRefundAccountSchema>;

/** 201 응답 — 가린 값만. holderMatchesIdentity 는 저장됐다면 늘 true(다르면 422 로 저장 자체가 안 된다) */
export const refundAccountSavedSchema = z.strictObject({
  refundAccountId: z.uuid(),
  accountMasked: z.string(),
  holderMatchesIdentity: z.literal(true),
});
export type RefundAccountSaved = z.output<typeof refundAccountSavedSchema>;
