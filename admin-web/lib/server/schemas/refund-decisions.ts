// S4-1.4(대표 환불 입력) — 대표의 환불 요청 상세·결정 경로의 요청·응답 모양(zod).
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §2-2(`GET …/refund-requests/{requestId}`) · §2-3(`POST …/decision`)
//
// 이 파일은 경계 검증과 모양만 맡는다. 금액 비교·근거 항목 판정은 lib/domain/refund-decision.ts 가 한다.
// 응답 스키마는 테스트가 응답 본문을 parse 해 키 이름·타입을 1대1로 확인하는 데도 쓴다(strict — 모르는 키가 있으면 실패).
import { z } from "zod";

import { PAYMENT_METHODS, REFUND_EXECUTION_KINDS, REFUND_REQUEST_DECISION_KINDS, REFUND_REQUEST_KINDS, REFUND_REQUEST_REASON_KINDS, REFUND_REQUEST_STATUSES, REFUND_STATUSES } from "../../domain/constants";
import { REGULAR_REFUND_POINTS } from "../../domain/refund-templates";

/** 대표 한마디 상한 — DB 의 ck_refund_requests_text_len(decision_note 500자)과 같다 */
const NOTE_MAX = 500;

/** 원 단위 금액 — 정수·0 이상만(FR-100(환불 정수 연산), 부동소수 금지) */
const won = z.number().int("금액은 원 단위 정수로 넣어 주세요").min(0, "금액은 0원 이상이어야 해요");

/**
 * 근거 공지 항목 코드. 비어 오면 null 로 바꿔 두고, 「없음」은 서버가 422 NOTICE_ITEM_REQUIRED 로 따로 알린다
 * (형식 오류 VALIDATION_FAILED 와 구별해야 화면이 「근거 항목을 골라 주세요」를 띄운다).
 */
const noticeItemCode = z
  .string()
  .trim()
  .max(100)
  .nullish()
  .transform((value) => (value === undefined || value === null || value === "" ? null : value));

/** 대표 한마디(회원에게 보인다). 빈 글은 「안 적음」 */
const memberMessage = z
  .string()
  .trim()
  .max(NOTE_MAX, `${NOTE_MAX}자 이하로 적어 주세요`)
  .nullish()
  .transform((value) => (value === undefined || value === null || value === "" ? null : value));

/**
 * `POST …/decision` 본문 — 승인(금액 필수)과 거절(금액 없음) 둘 중 하나.
 * 승인 금액이 비어 있으면 「입력하지 않은 항목」이라 처리로 넘어가지 않는다(422 VALIDATION_FAILED, FR-293).
 */
export const refundDecisionRequestSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("approve"), amount: won, noticeItemCode, memberMessage }),
  z.strictObject({ decision: z.literal("reject"), noticeItemCode, memberMessage }),
]);
export type RefundDecisionRequest = z.output<typeof refundDecisionRequestSchema>;

/** 경로의 학원·요청 id */
export const refundDecisionParamsSchema = z.strictObject({ academyId: z.uuid(), requestId: z.uuid() });

const noticeItemSchema = z.strictObject({
  code: z.string(),
  label: z.string(),
  percent: z.number().int().min(0).max(100).nullable(),
});

/** 정규 계산 보조(FR-294) — S4-1.3 `suggestRegularRefund` 결과 + 설명 문구 */
const assistSchema = z.strictObject({
  sessionsTotal: z.number().int().min(1),
  sessionsElapsed: z.number().int().min(0),
  remainingSessions: z.number().int().min(0),
  perSessionAmount: won,
  appliedPoint: z.enum(REGULAR_REFUND_POINTS),
  appliedPercent: z.number().int().min(0).max(100),
  suggestedAmount: won,
  explain: z.string(),
});

/** 이벤트형 계산값(신청 때 저장한 값을 그대로 보여 준다 — 계산은 S4-2.1) */
const eventCancelSchema = z.strictObject({
  window: z.string().nullable(),
  feeBp: z.number().int().min(0).max(10000).nullable(),
  feeAmount: won.nullable(),
  computedAmount: won.nullable(),
  canRaiseOnly: z.literal(true),
});

/** 이미 선 결정 — 결정 전이면 null(추천안·사후 확인 2026-11-24: 계약 예시에 없는 칸) */
const decisionSchema = z.strictObject({
  kind: z.enum(REFUND_REQUEST_DECISION_KINDS),
  amount: won.nullable(),
  noticeItemCode: z.string().nullable(),
  memberMessage: z.string().nullable(),
  decidedAt: z.iso.datetime(),
});

/** `GET /api/academies/{academyId}/refund-requests/{requestId}` 응답(계약 §2-2) */
export const refundRequestDetailSchema = z.strictObject({
  requestId: z.uuid(),
  kind: z.enum(REFUND_REQUEST_KINDS),
  status: z.enum(REFUND_REQUEST_STATUSES),
  member: z.strictObject({ nickname: z.string() }),
  classTitle: z.string(),
  paidAmount: won,
  paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
  receivedAt: z.iso.datetime(),
  answerDueAt: z.iso.datetime(),
  dueState: z.enum(["ok", "due_soon", "overdue"]),
  reason: z.strictObject({ kind: z.enum(REFUND_REQUEST_REASON_KINDS), text: z.string().nullable(), desired: z.string().nullable() }),
  noticeItems: z.array(noticeItemSchema),
  assist: assistSchema.nullable(),
  eventCancel: eventCancelSchema.nullable(),
  maxAmount: won,
  refundableAmount: won,
  notice: z.strictObject({ version: z.number().int().min(1), processingBusinessDays: z.number().int().min(1).nullable() }),
  refundAccount: z.strictObject({ accountMasked: z.string().nullable() }),
  decision: decisionSchema.nullable(),
});
export type RefundRequestDetail = z.output<typeof refundRequestDetailSchema>;

/**
 * `POST …/decision` 응답(계약 §2-3). refund 는 실행 결과(S4-1.5) — 카드는 PG 부분 취소 뒤 succeeded·failed, 계좌분은 pending(송금 대기).
 * 거절·0원 승인은 null. orderStatus 는 지금 주문 상태다 — partially_refunded·refunded 전이는 S4-1.7 이 붙인다(추천안·사후 확인 2026-11-24).
 */
export const refundDecisionResponseSchema = z.strictObject({
  requestId: z.uuid(),
  status: z.enum(REFUND_REQUEST_STATUSES),
  decisionKind: z.enum(REFUND_REQUEST_DECISION_KINDS),
  decidedAmount: won.nullable(),
  noticeItemCode: z.string(),
  refund: z
    .strictObject({ refundId: z.uuid(), executionKind: z.enum(REFUND_EXECUTION_KINDS), status: z.enum(REFUND_STATUSES), refundedAmount: won })
    .nullable(),
  orderStatus: z.string(),
});
export type RefundDecisionResponse = z.output<typeof refundDecisionResponseSchema>;
