// S4-1.2(환불 요청 생성·철회) — 회원 환불 요청 경로의 요청·응답 모양(zod).
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §2-1(`POST /api/refund-requests` · `POST …/{requestId}/withdraw`)
//
// 이 파일은 경계 검증과 모양만 맡는다. 금액을 계산하거나 DB 를 읽지 않는다.
// 응답 스키마는 테스트가 응답 본문을 parse 해 키 이름·타입을 1대1로 확인하는 데도 쓴다(strict — 모르는 키가 있으면 실패).
import { z } from "zod";

import { REFUND_REQUEST_KINDS, REFUND_REQUEST_REASON_KINDS, REFUND_REQUEST_STATUSES } from "../../domain/constants";

/** 글 칸 상한 — DB 의 ck_refund_requests_text_len(500자)과 같다. 여기서 먼저 막아 422 로 알려 준다 */
const TEXT_MAX = 500;

/**
 * 빈 글은 「안 적음」과 같다 — 앞뒤 공백을 지우고 비면 null 로 바꾼다.
 * 그래야 DB 에 빈 문자열과 NULL 이 섞이지 않는다.
 */
const optionalText = z
  .string()
  .trim()
  .max(TEXT_MAX, `${TEXT_MAX}자 이하로 적어 주세요`)
  .nullish()
  .transform((value) => (value === undefined || value === null || value === "" ? null : value));

/**
 * `POST /api/refund-requests` 본문. 정규 환불 요청은 앱 문의(M22)의 「환불 요청」 종류가 같은 본문으로 부른다(FR-098b).
 * refundAccountId 는 계좌로 결제한 주문(간편 계좌이체·가상계좌)에만 필요하다 — 필요한지는 서버가 결제수단을 보고 정한다.
 */
export const createRefundRequestSchema = z.strictObject({
  reservationId: z.uuid(),
  reasonKind: z.enum(REFUND_REQUEST_REASON_KINDS),
  reasonText: optionalText,
  desiredText: optionalText,
  refundAccountId: z.uuid().nullish().transform((value) => value ?? null),
});
export type CreateRefundRequest = z.output<typeof createRefundRequestSchema>;

/** 경로의 환불 요청 id */
export const refundRequestIdSchema = z.uuid();

/** 진행 단계 한 칸 — 회원 화면(C15B)의 「접수 → 처리 중 → 완료」 줄 */
const progressStepSchema = z.strictObject({
  step: z.enum(REFUND_REQUEST_STATUSES),
  at: z.iso.datetime(),
});

/** `POST /api/refund-requests` 응답(처음 201 · 같은 열쇠 재생 200 — 모양은 같다) */
export const refundRequestCreatedSchema = z.strictObject({
  requestId: z.uuid(),
  kind: z.enum(REFUND_REQUEST_KINDS),
  status: z.enum(REFUND_REQUEST_STATUSES),
  receivedAt: z.iso.datetime(),
  answerDueAt: z.iso.datetime(),
  // 저장 값 + 「처리 대기 중」(기한이 지났는데 아직 처리 전)
  displayStatus: z.enum([...REFUND_REQUEST_STATUSES, "pending_overdue"]),
  withdrawable: z.boolean(),
  progress: z.array(progressStepSchema),
});
export type RefundRequestCreated = z.output<typeof refundRequestCreatedSchema>;

/** `POST /api/refund-requests/{requestId}/withdraw` 응답 — 계약 그대로 상태 하나 */
export const refundRequestWithdrawnSchema = z.strictObject({
  status: z.literal("withdrawn"),
});
export type RefundRequestWithdrawn = z.output<typeof refundRequestWithdrawnSchema>;
