// S4-1.5a(계좌 환불 송금 완료·반송 처리 API) — 대표의 「송금 완료」·「다시 입력 요청」 경로의 요청·응답 모양(zod).
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §2-5(`POST …/refund-transfers/{refundId}/complete` · `…/request-reinput`)
//
// 이 파일은 경계 검증과 모양만 맡는다. 상태 전이는 lib/server/services/refund-transfers.ts 가 한다.
// 응답 스키마는 테스트가 응답 본문을 parse 해 키 이름·타입을 1대1로 확인하는 데도 쓴다(strict — 모르는 키가 있으면 실패).
import { z } from "zod";

import { REFUND_REINPUT_REASONS } from "../../domain/constants";

/** 경로의 학원·환불 id */
export const refundTransferParamsSchema = z.strictObject({ academyId: z.uuid(), refundId: z.uuid() });

/**
 * `POST …/complete` 본문 `{ "nameChecked": true }`.
 * 체크를 안 했거나(false) 칸이 없으면 형식 오류가 아니라 422 NAME_CHECK_REQUIRED 로 따로 알린다 —
 * 화면이 「받는 사람 이름을 확인해 주세요」를 그 체크 칸 옆에 띄워야 하기 때문이다(W31·O48C).
 */
export const refundTransferCompleteRequestSchema = z.strictObject({ nameChecked: z.boolean().optional() });
export type RefundTransferCompleteRequest = z.output<typeof refundTransferCompleteRequestSchema>;

/** `POST …/complete` 200 — 이미 완료된 건을 다시 눌러도 같은 본문 */
export const refundTransferCompleteResponseSchema = z.strictObject({
  refundId: z.uuid(),
  status: z.literal("succeeded"),
  completedAt: z.string(),
});
export type RefundTransferCompleteResponse = z.output<typeof refundTransferCompleteResponseSchema>;

/** `POST …/request-reinput` 본문 — 받는 사람 이름이 다름(name_mismatch) · 송금 반송(returned) */
export const refundTransferReinputRequestSchema = z.strictObject({ reason: z.enum(REFUND_REINPUT_REASONS) });
export type RefundTransferReinputRequest = z.output<typeof refundTransferReinputRequestSchema>;

/**
 * `POST …/request-reinput` 200 — 계약은 본문 모양을 적지 않았다. 화면이 「회원에게 다시 입력을 요청했어요」와
 * 요청 시각을 보여 줄 수 있게 이 넷을 준다(추천안·사후 확인 2026-11-24). 같은 이유로 다시 누르면 같은 본문.
 */
export const refundTransferReinputResponseSchema = z.strictObject({
  refundId: z.uuid(),
  status: z.literal("failed"),
  reason: z.enum(REFUND_REINPUT_REASONS),
  reinputRequestedAt: z.string(),
});
export type RefundTransferReinputResponse = z.output<typeof refundTransferReinputResponseSchema>;
