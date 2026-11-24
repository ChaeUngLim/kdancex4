// S4-1.4(대표 환불 입력) — 대표가 환불 요청을 열어 미리 채운 금액을 보고, 금액을 고쳐 승인하거나 근거를 골라 거절하는 처리기.
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §2-2(상세) · §2-3(decision) · §1-2(오류 코드) · §1-3(같은 결정 재생)
//   spec: FR-293(대표 환불 입력) · FR-294(중도 환불 계산 보조) · SC-010(환불 초과 0건)
//
// 경로 둘:
//   GET  /api/academies/{academyId}/refund-requests/{requestId}           — 상세(결제·계산 보조·미리 채움·근거 항목·환불 상한)
//   POST /api/academies/{academyId}/refund-requests/{requestId}/decision  — 승인(금액) · 거절(근거)
//
// 결정 순서(한 트랜잭션):
//   1 요청 행 잠금(회원 철회와 같은 순간에 와도 하나만 이긴다) → 경로 학원과 요청 학원이 같아야 한다(아니면 404)
//   2 이미 결정이 섰으면: 같은 결정이면 200 재생, 다른 결정이면 409 REFUND_ALREADY_DECIDED. 철회·끝난 요청도 409
//   3 주문 행 잠금 → 결제액·예매 수수료·이미 잡힌 환불 합을 DB 에서 **다시** 읽어 환불 상한을 계산한다
//     (화면이 보낸 상한을 믿지 않는다 — 계약 §2-3 「서버가 결제액과 다시 비교한다」)
//   4 lib/domain/refund-decision.ts 의 checkRefundDecision 으로 판정(근거 항목 · 상한 · 이벤트형 올리기만 · 환불 계좌)
//   5 조건부 갱신으로 결정을 적는다 → 감사 1행
//
// S4-1.5(수단별 환불 실행)가 붙인 것: 승인이 서면 같은 트랜잭션에서 환불 행(pending)을 만들고 주문 환불 합계를 올린다
//   (refund-execution.ts 의 startRequestRefund). 커밋 뒤 카드·간편결제는 PG 부분 취소를 부르고(executePgCancel),
//   계좌 결제분은 송금 대기로 남는다. 같은 승인을 다시 보내면(재생) 남은 pending 카드 환불을 같은 키로 다시 실행한다.
// 아직 하지 않은 것: 예약 취소·자리 반납·주문 상태 전이·알림 — S4-1.7(주문 상태 전이·감사·실패 기록·결과 알림).
import type { PaymentMethod, RefundRequestDecisionKind, RefundRequestKind, RefundRequestReasonKind, RefundRequestStatus } from "../../domain/constants";
import {
  buildRefundNoticeItems,
  checkRefundDecision,
  refundableAmountFor,
  refundDueState,
  type DecisionNoticeContent,
  type RefundNoticeItem,
} from "../../domain/refund-decision";
import { needsRefundAccount } from "../../domain/refund-request";
import { suggestRegularRefund } from "../../domain/refund-suggestion";
import type { ServerDeps } from "../deps";
import { createGuards, type GuardDeps, type StaffContext } from "../guards";
import { HttpError, parseJsonBody, readIdempotencyKey, withRoute } from "../http";
import {
  refundDecisionParamsSchema,
  refundDecisionRequestSchema,
  refundDecisionResponseSchema,
  refundRequestDetailSchema,
  type RefundDecisionRequest,
  type RefundDecisionResponse,
  type RefundRequestDetail,
} from "../schemas/refund-decisions";
import { EVENT_FEE_WINDOWS, REGULAR_REFUND_POINTS } from "../../domain/refund-templates";
import { z } from "zod";
import type { Runner } from "./cancellation-queries";
import { executePgCancel, readLatestRequestRefund, startRequestRefund, type RequestRefundRow } from "./refund-execution";

export type RefundDecisionDeps = GuardDeps & Pick<ServerDeps, "clock" | "paymentGateway">;

/** 이 파일이 쓰는 계약 12 §1-2 의 오류 코드 */
export const REFUND_DECISION_CODES = {
  alreadyDecided: "REFUND_ALREADY_DECIDED",
  exceedsPaid: "REFUND_EXCEEDS_PAID",
  noticeItemRequired: "NOTICE_ITEM_REQUIRED",
  eventNotRejectable: "EVENT_REFUND_NOT_REJECTABLE",
  belowComputed: "REFUND_BELOW_COMPUTED",
  accountRequired: "REFUND_ACCOUNT_REQUIRED",
} as const;

const DETAIL = {
  notFound: "환불 요청을 찾을 수 없어요",
  alreadyDecided: "이미 처리했거나 회원이 철회한 요청이에요",
  exceedsPaid: "결제 금액보다 많이 돌려줄 수 없어요",
  noticeItemRequired: "근거가 되는 환불·취소 공지 항목을 골라 주세요",
  eventNotRejectable: "이벤트형 취소는 거절할 수 없어요 — 금액을 올리는 조정만 돼요",
  belowComputed: "이벤트형 환불은 계산된 금액보다 낮게 넣을 수 없어요",
  accountRequired: "회원이 환불받을 계좌를 아직 넣지 않았어요",
} as const;

// ---- 읽기 ------------------------------------------------------------------------------------

/** 상세·결정에 필요한 사실 한 묶음. raw 레인은 NULL 을 못 받아 빈 칸은 ''·-1 로 읽고 여기서 null 로 되돌린다 */
interface RequestFacts {
  id: string;
  academyId: string;
  orderId: string;
  kind: RefundRequestKind;
  status: RefundRequestStatus;
  decisionKind: RefundRequestDecisionKind | null;
  decidedAmount: number | null;
  noticeItemCode: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  reasonKind: RefundRequestReasonKind;
  reasonText: string | null;
  desiredText: string | null;
  receivedAt: string;
  answerDueAt: string;
  memberNickname: string;
  classTitle: string;
  totalAmount: number;
  bookingFeeAmount: number;
  orderStatus: string;
  sessionCount: number;
  sessionsElapsed: number;
  noticeVersion: number;
  noticeContent: unknown;
  paymentMethod: PaymentMethod | null;
  accountMasked: string | null;
  /** 이 요청에 걸린 계좌가 지금도 쓰는(active) 계좌인가 */
  accountActive: boolean;
  /** 이 주문에 이미 잡힌 환불 합(이 요청 제외) */
  alreadyRefunded: number;
  suggestedAmount: number | null;
  cancelFeeBp: number | null;
  cancelFeeAmount: number | null;
  feeWindow: string | null;
}

const orNull = (value: string): string | null => (value === "" ? null : value);
const intOrNull = (value: number): number | null => (value < 0 ? null : value);

/**
 * 요청 하나의 사실을 한 번에 읽는다.
 * - 진행한 회차 = 요청을 받은 시각 이전에 끝난(취소·폐강 아닌) 회차 수. 받은 시각 기준이라 대표가 늦게 열어도 미리 채움값이 바뀌지 않는다.
 * - 이미 잡힌 환불 = 실패하지 않은 환불 행 금액 합 + 승인됐지만 아직 실행 전인 다른 요청의 금액(같은 주문, 이 요청 제외).
 */
async function readFacts(runner: Runner, requestId: string): Promise<RequestFacts | null> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT rr.id, rr.academy_id, rr.order_id, rr.kind, rr.status,
                          COALESCE(rr.decision_kind, '') AS decision_kind, COALESCE(rr.decided_amount, -1) AS decided_amount,
                          COALESCE(rr.notice_item_code, '') AS notice_item_code, COALESCE(rr.decision_note, '') AS decision_note,
                          COALESCE(to_char(rr.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') AS decided_at,
                          rr.reason_kind, COALESCE(rr.reason_text, '') AS reason_text, COALESCE(rr.desired_text, '') AS desired_text,
                          to_char(rr.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at,
                          to_char(rr.answer_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS answer_due_at,
                          COALESCE(m.nickname, '') AS nickname, c.title AS class_title,
                          o.total_amount, o.booking_fee_amount, o.status AS order_status, o.session_count,
                          (SELECT count(*)::int FROM class_sessions s
                            WHERE s.offering_id = o.offering_id AND s.status = 'scheduled' AND s.ends_at <= rr.received_at) AS sessions_elapsed,
                          nv.version AS notice_version, nv.content::text AS notice_content,
                          COALESCE((SELECT p.method FROM payments p WHERE p.order_id = o.id AND p.status = 'paid'
                                     ORDER BY p.paid_at DESC NULLS LAST LIMIT 1), '') AS payment_method,
                          COALESCE(ra.account_masked, '') AS account_masked, COALESCE(ra.status = 'active', false) AS account_active,
                          (COALESCE((SELECT sum(rf.requested_amount) FROM refunds rf JOIN payments p2 ON p2.id = rf.payment_id
                                      WHERE p2.order_id = o.id AND rf.status <> 'failed'), 0)
                           + COALESCE((SELECT sum(other.decided_amount) FROM refund_requests other
                                        WHERE other.order_id = o.id AND other.id <> rr.id AND other.status = 'in_progress'
                                          AND other.decision_kind IN ('approved', 'auto')
                                          -- 실행 행이 살아 있는 승인은 위 refunds 합에 이미 들어 있다(S4-1.5) — 두 번 세지 않는다
                                          AND NOT EXISTS (SELECT 1 FROM refunds done WHERE done.basis_kind = 'request'
                                                            AND done.basis_id = other.id AND done.status <> 'failed')), 0))::int AS already_refunded,
                          COALESCE(rr.suggested_amount, -1) AS suggested_amount, COALESCE(rr.cancel_fee_bp, -1) AS cancel_fee_bp,
                          COALESCE(rr.cancel_fee_amount, -1) AS cancel_fee_amount, COALESCE(rr.fee_window, '') AS fee_window
                     FROM refund_requests rr
                     JOIN orders o ON o.id = rr.order_id
                     JOIN members m ON m.id = rr.member_id
                     JOIN class_offerings off ON off.id = o.offering_id
                     JOIN classes c ON c.id = off.class_id
                     JOIN refund_notice_versions nv ON nv.id = rr.notice_version_id
                     LEFT JOIN refund_accounts ra ON ra.id = rr.refund_account_id
                    WHERE rr.id = ${requestId}::uuid`
      .returnsRow({
        id: "pg/uuid@1",
        academy_id: "pg/uuid@1",
        order_id: "pg/uuid@1",
        kind: "pg/text@1",
        status: "pg/text@1",
        decision_kind: "pg/text@1",
        decided_amount: "pg/int4@1",
        notice_item_code: "pg/text@1",
        decision_note: "pg/text@1",
        decided_at: "pg/text@1",
        reason_kind: "pg/text@1",
        reason_text: "pg/text@1",
        desired_text: "pg/text@1",
        received_at: "pg/text@1",
        answer_due_at: "pg/text@1",
        nickname: "pg/text@1",
        class_title: "pg/text@1",
        total_amount: "pg/int4@1",
        booking_fee_amount: "pg/int4@1",
        order_status: "pg/text@1",
        session_count: "pg/int4@1",
        sessions_elapsed: "pg/int4@1",
        notice_version: "pg/int4@1",
        notice_content: "pg/text@1",
        payment_method: "pg/text@1",
        account_masked: "pg/text@1",
        account_active: "pg/bool@1",
        already_refunded: "pg/int4@1",
        suggested_amount: "pg/int4@1",
        cancel_fee_bp: "pg/int4@1",
        cancel_fee_amount: "pg/int4@1",
        fee_window: "pg/text@1",
      })
      .build(),
  );
  if (row === undefined) return null;
  return {
    id: row.id,
    academyId: row.academy_id,
    orderId: row.order_id,
    kind: row.kind as RefundRequestKind,
    status: row.status as RefundRequestStatus,
    decisionKind: orNull(row.decision_kind) as RefundRequestDecisionKind | null,
    decidedAmount: intOrNull(row.decided_amount),
    noticeItemCode: orNull(row.notice_item_code),
    decisionNote: orNull(row.decision_note),
    decidedAt: orNull(row.decided_at),
    reasonKind: row.reason_kind as RefundRequestReasonKind,
    reasonText: orNull(row.reason_text),
    desiredText: orNull(row.desired_text),
    receivedAt: row.received_at,
    answerDueAt: row.answer_due_at,
    memberNickname: row.nickname,
    classTitle: row.class_title,
    totalAmount: row.total_amount,
    bookingFeeAmount: row.booking_fee_amount,
    orderStatus: row.order_status,
    sessionCount: row.session_count,
    // 회차가 늘어난 이상한 경우에도 총 회차를 넘지 않게 자른다(계산 함수가 RangeError 를 내지 않게)
    sessionsElapsed: Math.min(row.sessions_elapsed, row.session_count),
    noticeVersion: row.notice_version,
    noticeContent: JSON.parse(row.notice_content) as unknown,
    paymentMethod: orNull(row.payment_method) as PaymentMethod | null,
    accountMasked: orNull(row.account_masked),
    accountActive: row.account_active,
    alreadyRefunded: row.already_refunded,
    suggestedAmount: intOrNull(row.suggested_amount),
    cancelFeeBp: intOrNull(row.cancel_fee_bp),
    cancelFeeAmount: intOrNull(row.cancel_fee_amount),
    feeWindow: orNull(row.fee_window),
  };
}

/** 같은 순간의 철회·다른 결정과 순서를 맞추려고 요청 행과 주문 행을 이 순서로 잠근다(철회도 요청 행부터 잠근다) */
async function lockRequestAndOrder(runner: Runner, requestId: string): Promise<boolean> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT order_id FROM refund_requests WHERE id = ${requestId}::uuid FOR UPDATE`.returnsRow({ order_id: "pg/uuid@1" }).build(),
  );
  if (row === undefined) return false;
  await runner.query(runner.raw.sql`SELECT id FROM orders WHERE id = ${row.order_id}::uuid FOR UPDATE`.returnsRow({ id: "pg/uuid@1" }).build());
  return true;
}

// ---- 계산 ------------------------------------------------------------------------------------

// 근거 항목을 뽑을 때 쓰는 「읽기용」 공지 모양. 저장 검사(refund-notice-publish.ts)보다 느슨하게 받는다 —
// 시점이 넷 다 없거나 연락처 모양이 다른 옛 판본(저장 검사가 생기기 전 행)이어도, 그 판본에 **적혀 있는** 항목으로는
// 대표가 근거를 고를 수 있어야 요청이 기한 안에 처리된다(추천안·사후 확인 2026-11-24). 모르는 칸은 무시한다.
const percentValue = z.number().int().min(0).max(100);
const readRegularNoticeSchema = z.object({
  tiers: z.array(z.object({ point: z.enum(REGULAR_REFUND_POINTS), percent: percentValue })).min(1),
  nonRefundableCases: z.string().trim().min(1),
  processingBusinessDays: z.number().int().min(1).optional(),
});
const readEventNoticeSchema = z.object({
  // 구간 이름이 지금 값 집합 밖인 줄(옛 이름)은 고를 수 없으니 버리고 나머지만 쓴다
  feeTiers: z.array(z.object({ window: z.string(), percent: percentValue })),
  nonRefundableCases: z.string().trim().min(1),
  processingBusinessDays: z.number().int().min(1).optional(),
});
const isEventWindow = (value: string): value is (typeof EVENT_FEE_WINDOWS)[number] => (EVENT_FEE_WINDOWS as readonly string[]).includes(value);

/** 공지 판본 내용 → 근거 항목 계산 입력. 읽을 수 있는 항목이 하나도 없으면 null — 근거를 고를 수 없다 */
function decisionNoticeContent(kind: RefundRequestKind, content: unknown): (DecisionNoticeContent & { processingBusinessDays: number | null }) | null {
  if (kind === "regular") {
    const parsed = readRegularNoticeSchema.safeParse(content);
    if (!parsed.success) return null;
    const { tiers, nonRefundableCases, processingBusinessDays } = parsed.data;
    return { kind: "regular", tiers, nonRefundableCases, processingBusinessDays: processingBusinessDays ?? null };
  }
  const parsed = readEventNoticeSchema.safeParse(content);
  if (!parsed.success) return null;
  const { feeTiers, nonRefundableCases, processingBusinessDays } = parsed.data;
  const known = feeTiers.flatMap((t) => (isEventWindow(t.window) ? [{ window: t.window, percent: t.percent }] : []));
  return { kind: "event", feeTiers: known, nonRefundableCases, processingBusinessDays: processingBusinessDays ?? null };
}

/** 미리 채움 계산. 그 시점의 % 가 판본에 없으면(옛 판본) 계산 함수가 RangeError 를 내므로 미리 채움 없이(null) 둔다 */
function trySuggest(input: Parameters<typeof suggestRegularRefund>[0]): ReturnType<typeof suggestRegularRefund> | null {
  try {
    return suggestRegularRefund(input);
  } catch (error: unknown) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** 사실 → 근거 항목 · 환불 상한 · 계산 보조. 상세와 결정이 같은 함수를 써서 두 화면의 숫자가 갈리지 않는다 */
function derive(facts: RequestFacts) {
  const notice = decisionNoticeContent(facts.kind, facts.noticeContent);
  const noticeItems: readonly RefundNoticeItem[] = notice === null ? [] : buildRefundNoticeItems(notice);
  const refundableAmount = refundableAmountFor({
    totalAmount: facts.totalAmount,
    bookingFeeAmount: facts.bookingFeeAmount,
    alreadyRefundedAmount: facts.alreadyRefunded,
  });
  // 정규 계산 보조(FR-294) — 공지 % 로 미리 채운 금액. 대표가 고칠 출발점일 뿐이다
  let assist: RefundRequestDetail["assist"] = null;
  const s =
    notice !== null && notice.kind === "regular"
      ? trySuggest({
          paidAmount: facts.totalAmount,
          sessionsTotal: facts.sessionCount,
          sessionsElapsed: facts.sessionsElapsed,
          notice: { tiers: notice.tiers },
        })
      : null;
  if (s !== null) {
    // 미리 채움값도 상한을 넘지 않게 한다 — 앞서 다른 원인으로 일부 환불된 주문이면 남은 금액까지만 채운다
    const suggestedAmount = Math.min(s.suggestedAmount, refundableAmount);
    assist = {
      sessionsTotal: facts.sessionCount,
      sessionsElapsed: facts.sessionsElapsed,
      remainingSessions: s.remainingSessions,
      perSessionAmount: s.perSessionAmount,
      appliedPoint: s.point,
      appliedPercent: s.percent,
      suggestedAmount,
      explain: `${facts.totalAmount.toLocaleString("ko-KR")}원 × ${s.percent}% — 학원이 공지한 환불 규정으로 미리 채웠어요`,
    };
  }
  return { notice, noticeItems, refundableAmount, assist };
}

/** 계좌 결제분인데 쓰는 환불 계좌가 없으면 승인할 수 없다. 카드분은 계좌가 필요 없다 */
function refundAccountReady(facts: RequestFacts): boolean {
  if (facts.paymentMethod === null || !needsRefundAccount(facts.paymentMethod)) return true;
  return facts.accountActive;
}

// ---- 상세 ------------------------------------------------------------------------------------

/** 사실 → 상세 응답(계약 §2-2). 연락처·계좌 전체는 넣지 않는다 — 계좌는 가린 값만 */
function toDetail(facts: RequestFacts, now: Temporal.Instant): RefundRequestDetail {
  const { notice, noticeItems, refundableAmount, assist } = derive(facts);
  const open = facts.status === "received" || facts.status === "in_progress";
  return {
    requestId: facts.id,
    kind: facts.kind,
    status: facts.status,
    member: { nickname: facts.memberNickname },
    classTitle: `${facts.classTitle} · ${facts.sessionCount}회`,
    paidAmount: facts.totalAmount,
    paymentMethod: facts.paymentMethod,
    receivedAt: facts.receivedAt,
    answerDueAt: facts.answerDueAt,
    dueState: refundDueState({ open, answerDueAt: Temporal.Instant.from(facts.answerDueAt) }, now),
    reason: { kind: facts.reasonKind, text: facts.reasonText, desired: facts.desiredText },
    noticeItems: [...noticeItems],
    assist,
    eventCancel:
      facts.kind === "event"
        ? { window: facts.feeWindow, feeBp: facts.cancelFeeBp, feeAmount: facts.cancelFeeAmount, computedAmount: facts.suggestedAmount, canRaiseOnly: true }
        : null,
    maxAmount: facts.totalAmount - facts.bookingFeeAmount,
    refundableAmount,
    notice: { version: facts.noticeVersion, processingBusinessDays: notice?.processingBusinessDays ?? null },
    refundAccount: { accountMasked: facts.accountMasked },
    decision:
      facts.decisionKind !== null && facts.decidedAt !== null
        ? {
            kind: facts.decisionKind,
            amount: facts.decidedAmount,
            noticeItemCode: facts.noticeItemCode,
            memberMessage: facts.decisionNote,
            decidedAt: facts.decidedAt,
          }
        : null,
  };
}

export async function getRefundRequestDetail(
  deps: RefundDecisionDeps,
  input: { academyId: string; requestId: string },
): Promise<RefundRequestDetail> {
  const facts = await readFacts(deps.db, input.requestId);
  // 다른 학원의 요청을 이 학원 경로로 부르면 없는 요청과 같다(경로 학원 = 요청 학원)
  if (facts === null || facts.academyId !== input.academyId) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  return toDetail(facts, deps.clock());
}

// ---- 결정 ------------------------------------------------------------------------------------

/** 결정 행 + 실행 행 → 응답. 거절·0원 승인은 실행 행이 없어 refund 가 null 이다 */
function toDecisionResponse(facts: RequestFacts, refund: RequestRefundRow | null = null): RefundDecisionResponse {
  if (facts.decisionKind === null || facts.noticeItemCode === null) throw new Error(`결정이 없는 요청으로 응답을 만들려 했다: ${facts.id}`);
  return {
    requestId: facts.id,
    status: facts.status,
    decisionKind: facts.decisionKind,
    decidedAmount: facts.decidedAmount,
    noticeItemCode: facts.noticeItemCode,
    refund:
      refund === null
        ? null
        : { refundId: refund.refundId, executionKind: refund.executionKind, status: refund.status, refundedAmount: refund.refundedAmount },
    orderStatus: facts.orderStatus,
  };
}

/** 판정 실패 → 계약 §1-2 의 HTTP 오류 */
function decisionError(check: Exclude<ReturnType<typeof checkRefundDecision>, { ok: true }>): HttpError {
  switch (check.code) {
    case "NOTICE_ITEM_REQUIRED":
      return HttpError.unprocessable(REFUND_DECISION_CODES.noticeItemRequired, DETAIL.noticeItemRequired, {
        fields: [{ path: "noticeItemCode", message: DETAIL.noticeItemRequired }],
      });
    case "REFUND_EXCEEDS_PAID":
      return HttpError.conflict(REFUND_DECISION_CODES.exceedsPaid, DETAIL.exceedsPaid, { refundableAmount: check.refundableAmount });
    case "EVENT_REFUND_NOT_REJECTABLE":
      return HttpError.conflict(REFUND_DECISION_CODES.eventNotRejectable, DETAIL.eventNotRejectable);
    case "REFUND_BELOW_COMPUTED":
      return HttpError.unprocessable(REFUND_DECISION_CODES.belowComputed, DETAIL.belowComputed, { computedAmount: check.computedAmount });
    case "REFUND_ACCOUNT_REQUIRED":
      return HttpError.unprocessable(REFUND_DECISION_CODES.accountRequired, DETAIL.accountRequired);
  }
}

export interface DecideRefundRequestInput {
  academyId: string;
  requestId: string;
  staffAccountId: string;
  body: RefundDecisionRequest;
}

export async function decideRefundRequest(deps: RefundDecisionDeps, input: DecideRefundRequestInput): Promise<RefundDecisionResponse> {
  const now = deps.clock();
  const { body } = input;
  const wantedKind: RefundRequestDecisionKind = body.decision === "approve" ? "approved" : "rejected";

  // 결정(+ 승인이면 환불 행 pending)을 한 트랜잭션으로 적는다. 커밋 뒤에 카드 환불을 실행하고 응답을 다시 읽는다
  const requestId = await deps.db.transaction(async (tx) => {
    // 1 잠금 → 사실 읽기 → 학원 대조
    if (!(await lockRequestAndOrder(tx, input.requestId))) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const facts = await readFacts(tx, input.requestId);
    if (facts === null || facts.academyId !== input.academyId) throw new HttpError("NOT_FOUND", DETAIL.notFound);

    // 2 이미 결정이 섰나 — 같은 결정의 재생은 200(상태가 아니라 결정 종류로 비교, 계약 §1-3), 아니면 409
    if (facts.decisionKind !== null) {
      if (facts.decisionKind === wantedKind) return facts.id;
      throw HttpError.conflict(REFUND_DECISION_CODES.alreadyDecided, DETAIL.alreadyDecided);
    }
    if (facts.status !== "received" && facts.status !== "in_progress") {
      throw HttpError.conflict(REFUND_DECISION_CODES.alreadyDecided, DETAIL.alreadyDecided);
    }

    // 3·4 서버가 다시 계산한 상한·근거 항목으로 판정한다
    const { noticeItems, refundableAmount, assist } = derive(facts);
    const check = checkRefundDecision(
      body.decision === "approve"
        ? { decision: "approve", amount: body.amount, noticeItemCode: body.noticeItemCode }
        : { decision: "reject", noticeItemCode: body.noticeItemCode },
      {
        kind: facts.kind,
        noticeItems,
        refundableAmount,
        eventComputedAmount: facts.kind === "event" ? facts.suggestedAmount : null,
        refundAccountReady: refundAccountReady(facts),
      },
    );
    if (!check.ok) throw decisionError(check);

    // 5 결정 기록(정규는 그때 보여 준 미리 채움값도 남겨 대표가 얼마나 고쳤는지 나중에 볼 수 있게 한다). 승인은 처리 중으로 두고(실행은 S4-1.5), 거절은 바로 끝(rejected).
    //   조건부 갱신 — 잠금 뒤라 평소엔 1행이고, 0행이면 누가 먼저 바꾼 것이다
    const amount = body.decision === "approve" ? body.amount : null;
    const nextStatus: RefundRequestStatus = body.decision === "approve" ? "in_progress" : "rejected";
    const changed = await tx.execute(
      tx.raw.sql`UPDATE refund_requests
                    SET status = ${nextStatus}, decision_kind = ${wantedKind},
                        decided_amount = NULLIF(${amount ?? -1}, -1), notice_item_code = ${body.noticeItemCode ?? ""},
                        decision_note = NULLIF(${body.memberMessage ?? ""}, ''),
                        suggested_amount = COALESCE(suggested_amount, NULLIF(${assist?.suggestedAmount ?? -1}, -1)),
                        decided_by_staff_account_id = ${input.staffAccountId}::uuid,
                        decided_at = ${now.toString()}::timestamptz,
                        in_progress_at = COALESCE(in_progress_at, ${now.toString()}::timestamptz),
                        updated_at = ${now.toString()}::timestamptz
                  WHERE id = ${facts.id}::uuid AND status = ${facts.status} AND decision_kind IS NULL`
        .affectedCount()
        .build(),
    );
    if (changed.affectedRows !== 1) throw HttpError.conflict(REFUND_DECISION_CODES.alreadyDecided, DETAIL.alreadyDecided);

    // 감사 1행 — 누가 얼마를 어떤 근거로 정했나(FR-101(환불 감사 기록)). 대표 한마디 글은 요청 행에만 둔다
    await tx.execute(
      tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, before, after)
                 VALUES (uuidv7(), 'staff', ${input.staffAccountId}::uuid, 'owner', ${facts.academyId}::uuid,
                         ${body.decision === "approve" ? "refund_request.approved" : "refund_request.rejected"},
                         'refund_requests', ${facts.id}::uuid,
                         ${JSON.stringify({ status: facts.status, decisionKind: null })}::json,
                         ${JSON.stringify({ status: nextStatus, decisionKind: wantedKind, amount, noticeItemCode: body.noticeItemCode, refundableAmount })}::json)`
        .affectedCount()
        .build(),
    );

    // 6 승인이면 환불 실행을 시작한다(S4-1.5) — 환불 행 pending + 주문 환불 합계 조건부 증가. 넘치면 409 로 승인까지 롤백
    if (body.decision === "approve") {
      await startRequestRefund(tx, {
        requestId: facts.id,
        amount: body.amount,
        staffAccountId: input.staffAccountId,
        processingBusinessDays: derive(facts).notice?.processingBusinessDays ?? null,
        now,
      });
    }
    return facts.id;
  });

  // 7 커밋 뒤 — 카드·간편결제 환불은 PG 부분 취소(트랜잭션 밖에서 한 번, 계약 §1-3). 재생이어도 pending 이면 같은 키로 다시 부른다
  const latest = await readLatestRequestRefund(deps.db, requestId);
  const refund = latest === null ? null : await executePgCancel(deps, latest);
  const decided = await readFacts(deps.db, requestId);
  if (decided === null) throw new Error(`방금 결정한 환불 요청을 읽지 못했다: ${requestId}`);
  return toDecisionResponse(decided, refund);
}

// ---- 라우트 ----------------------------------------------------------------------------------

type Params = { params: Promise<{ academyId: string; requestId: string }> };

/**
 * 경로 id 검사 + 대표 가드. 앱은 Bearer(2단계 인증을 묻지 않음), 관리자 웹은 쿠키(2단계 인증 필수) — 같은 경로·같은 판정(계약 §1-1).
 * 위임 강사·강사는 owner 권한이 없어 403 이다(FR-081a). id 모양이 틀리면 없는 요청과 같게 404.
 */
async function requireOwner(
  guards: ReturnType<typeof createGuards>,
  request: Request,
  context: Params,
): Promise<{ owner: StaffContext; academyId: string; requestId: string }> {
  const params = refundDecisionParamsSchema.safeParse(await context.params);
  if (!params.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  const bearer = (request.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer ");
  const owner = await guards.requireStaff("owner", { academyId: params.data.academyId, surface: bearer ? "app" : "web", headers: request.headers });
  return { owner, ...params.data };
}

/** `GET …/refund-requests/{requestId}` — 읽기만 한다(상태를 바꾸지 않는다, 계약 열린 점 ④) */
export function createRefundRequestDetailRoute(deps: RefundDecisionDeps) {
  const guards = createGuards(deps);
  return withRoute<Params>(async (request, context) => {
    const { academyId, requestId } = await requireOwner(guards, request, context);
    const detail = await getRefundRequestDetail(deps, { academyId, requestId });
    return Response.json(refundRequestDetailSchema.parse(detail));
  });
}

/** `POST …/refund-requests/{requestId}/decision` — 헤더 Idempotency-Key 필수. 같은 결정 재생은 200 같은 본문 */
export function createRefundDecisionRoute(deps: RefundDecisionDeps) {
  const guards = createGuards(deps);
  return withRoute<Params>(async (request, context) => {
    const { owner, academyId, requestId } = await requireOwner(guards, request, context);
    // 열쇠는 필수로만 받는다 — 같은 결정을 두 번 보내도 결정 종류 비교로 한 번만 적히므로 열쇠를 따로 저장하지 않는다
    readIdempotencyKey(request, { required: true });
    const body = await parseJsonBody(request, refundDecisionRequestSchema);
    const outcome = await decideRefundRequest(deps, { academyId, requestId, staffAccountId: owner.staffAccountId, body });
    return Response.json(refundDecisionResponseSchema.parse(outcome));
  });
}
