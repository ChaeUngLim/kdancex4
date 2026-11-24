// S4-1.5a(계좌 환불 송금 완료·반송 처리 API) — 계좌 결제분 환불을 대표가 은행에서 직접 보낸 뒤 끝내는 처리기.
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §2-5(계좌 환불 송금) · §1-2(오류 코드) · §1-3(송금 완료 재생)
//   설계: _workspace/03_data-model.md §9-3(refunds 송금 완료·재입력 칸) · §9-6(알림·감사 값)
//   spec: FR-295(수단별 환불 실행) · FR-102(환불 1회 보장) · FR-103(환불 실패 기록)
//
// 왜 이런 처리가 따로 있나: 카드분은 PG 가 돈을 돌려주지만(S4-1.5), 계좌 결제분은 플랫폼이 돈을 보내지 않는다(D1).
// 대표가 은행 앱에서 회원 계좌로 보내고, 이체 화면의 「받는 사람 이름」이 예금주와 같은지 눈으로 대조한 뒤 이 버튼을 누른다.
// 그래서 여기는 포트(PG)를 부르지 않는다 — 돈은 이미 사람 손으로 움직였고, 서버는 그 사실을 한 번만 적는다.
//
// 경로 둘(웹 W31 · 앱 O48C 같은 경로·같은 판정):
//   POST /api/academies/{academyId}/refund-transfers/{refundId}/complete         — 「송금 완료」(이름 대조 체크 필수)
//   POST /api/academies/{academyId}/refund-transfers/{refundId}/request-reinput  — 「이름이 달라요 · 다시 입력 요청」(이름 다름 · 반송)
//
// 두 경로 모두 한 트랜잭션: 환불 행 잠금 → 학원 대조 → 상태 조건부 갱신(pending 에서만) → 요청·주문 합계 → refund_events → 회원 알림 → 감사.
// 두 번 눌러도 한 번만 적힌다: 이미 같은 결과로 끝났으면 200 같은 본문, 다른 결과로 끝났으면 409 TRANSFER_NOT_PENDING.
//
// 일부러 하지 않은 것(EVIDENCE.md 「추천안·사후 확인」): 주문 partially_refunded·refunded 전이 — 카드 경로와 함께 S4-1.7 이 한다.
// 새 계좌를 받아 다음 시도 행을 만드는 일은 회원 쪽 `POST /api/refund-requests/{id}/account`(계약 §2-1)의 몫이다.
import type { RefundReinputReason, RefundStatus } from "../../domain/constants";
import type { ServerDeps } from "../deps";
import { createGuards, type GuardDeps, type StaffContext } from "../guards";
import { HttpError, parseJsonBody, withRoute } from "../http";
import {
  refundTransferCompleteRequestSchema,
  refundTransferCompleteResponseSchema,
  refundTransferParamsSchema,
  refundTransferReinputRequestSchema,
  refundTransferReinputResponseSchema,
  type RefundTransferCompleteResponse,
  type RefundTransferReinputResponse,
} from "../schemas/refund-transfers";
import type { Runner } from "./cancellation-queries";

export type RefundTransferDeps = GuardDeps & Pick<ServerDeps, "clock">;

/** 이 파일이 쓰는 계약 12 §1-2 의 오류 코드 */
export const REFUND_TRANSFER_CODES = {
  notPending: "TRANSFER_NOT_PENDING",
  nameCheckRequired: "NAME_CHECK_REQUIRED",
} as const;

/** 재입력 이유 → refunds.failure_code(data-model §9-6) */
export const REINPUT_FAILURE_CODES: Readonly<Record<RefundReinputReason, string>> = {
  name_mismatch: "ACCOUNT_NAME_MISMATCH",
  returned: "TRANSFER_RETURNED",
};

/** refund_events.event_type(앱 상수, data-model §9-6) */
export const REFUND_TRANSFER_EVENTS = {
  completed: "transfer_completed",
  reinputRequested: "transfer_reinput_requested",
} as const;

const DETAIL = {
  notFound: "환불 건을 찾을 수 없어요",
  notPending: "송금 대기 중인 건이 아니에요",
  nameCheckRequired: "은행 이체 화면의 받는 사람 이름이 예금주와 같은지 확인해 주세요",
} as const;

/** 회원에게 보이는 알림 문구 — 재입력 이유마다 왜 다시 넣어야 하는지 한 줄로 */
const REINPUT_MESSAGE: Readonly<Record<RefundReinputReason, string>> = {
  name_mismatch: "받는 사람 이름이 예금주와 달라 보내지 못했어요. 본인 명의 계좌를 다시 입력해 주세요",
  returned: "보낸 환불금이 은행에서 되돌아왔어요. 계좌를 다시 입력해 주세요",
};

// ---- 읽기 ------------------------------------------------------------------------------------

/** 송금 처리에 필요한 환불 행 사실. raw 레인은 NULL 을 못 받아 빈 칸은 ''로 읽고 여기서 null 로 되돌린다 */
interface TransferFacts {
  refundId: string;
  academyId: string;
  orderId: string;
  memberId: string;
  requestId: string | null;
  executionKind: string | null;
  status: RefundStatus;
  amount: number;
  hasAccount: boolean;
  classTitle: string;
  transferCompletedAt: string | null;
  reinputReason: RefundReinputReason | null;
  reinputRequestedAt: string | null;
}

const orNull = (value: string): string | null => (value === "" ? null : value);

/**
 * 환불 행 하나를 잠그고(FOR UPDATE OF rf) 사실을 읽는다. 대표가 두 화면(웹·앱)에서 같은 순간에 눌러도 하나만 이긴다.
 * 학원은 주문 → 수업 회차 묶음 → 수업을 따라 찾는다 — 요청이 원인이 아닌 환불(휴강·일괄 취소)도 같은 길로 학원이 나온다.
 */
async function lockTransfer(runner: Runner, refundId: string): Promise<TransferFacts | null> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT rf.id, c.academy_id, rf.order_id, o.member_id, COALESCE(rf.refund_request_id::text, '') AS request_id,
                          COALESCE(rf.execution_kind, '') AS execution_kind, rf.status, rf.requested_amount,
                          (rf.refund_account_id IS NOT NULL) AS has_account, c.title AS class_title,
                          COALESCE(to_char(rf.transfer_completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') AS transfer_completed_at,
                          COALESCE(rf.reinput_reason, '') AS reinput_reason,
                          COALESCE(to_char(rf.reinput_requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') AS reinput_requested_at
                     FROM refunds rf
                     JOIN orders o ON o.id = rf.order_id
                     JOIN class_offerings off ON off.id = o.offering_id
                     JOIN classes c ON c.id = off.class_id
                    WHERE rf.id = ${refundId}::uuid
                    FOR UPDATE OF rf`
      .returnsRow({
        id: "pg/uuid@1",
        academy_id: "pg/uuid@1",
        order_id: "pg/uuid@1",
        member_id: "pg/uuid@1",
        request_id: "pg/text@1",
        execution_kind: "pg/text@1",
        status: "pg/text@1",
        requested_amount: "pg/int4@1",
        has_account: "pg/bool@1",
        class_title: "pg/text@1",
        transfer_completed_at: "pg/text@1",
        reinput_reason: "pg/text@1",
        reinput_requested_at: "pg/text@1",
      })
      .build(),
  );
  if (row === undefined) return null;
  return {
    refundId: row.id,
    academyId: row.academy_id,
    orderId: row.order_id,
    memberId: row.member_id,
    requestId: orNull(row.request_id),
    executionKind: orNull(row.execution_kind),
    status: row.status as RefundStatus,
    amount: row.requested_amount,
    hasAccount: row.has_account,
    classTitle: row.class_title,
    transferCompletedAt: orNull(row.transfer_completed_at),
    reinputReason: orNull(row.reinput_reason) as RefundReinputReason | null,
    reinputRequestedAt: orNull(row.reinput_requested_at),
  };
}

/** 잠근 뒤 학원까지 맞는지 본다. 남의 학원 환불은 없는 건과 같다(404) */
async function lockOwnTransfer(tx: Runner, academyId: string, refundId: string): Promise<TransferFacts> {
  const facts = await lockTransfer(tx, refundId);
  if (facts === null || facts.academyId !== academyId) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  return facts;
}

/**
 * 송금 대기(지금 처리할 수 있는) 건인가 — 계좌분 + pending + 보낼 계좌가 있음.
 * 카드분(PG 가 처리)이나 계좌를 아직 못 받은 건(awaiting_account)은 이 버튼의 대상이 아니다.
 */
function isTransferPending(facts: TransferFacts): boolean {
  return facts.executionKind === "owner_bank_transfer" && facts.status === "pending" && facts.hasAccount;
}

// ---- 쓰기 도우미 ---------------------------------------------------------------------------------

async function recordEvent(tx: Runner, refundId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO refund_events (id, refund_id, event_type, payload)
               VALUES (uuidv7(), ${refundId}::uuid, ${eventType}, ${JSON.stringify(payload)}::jsonb)`
      .affectedCount()
      .build(),
  );
}

/**
 * 회원 알림 1행. 열쇠 `refund:<refundId>:<what>` 로 같은 시도에는 한 번만 쓴다(ON CONFLICT DO NOTHING).
 * order_id 칸은 비운다 — 주문당 같은 종류 1건 유니크(uq_notifications_kind_order_recipient)에 걸리면
 * 재입력 → 새 계좌 → 또 반송처럼 한 주문에서 두 번째 알림이 조용히 사라지기 때문이다. 주문은 payload 로 준다.
 */
async function notifyMember(
  tx: Runner,
  facts: TransferFacts,
  kind: "refund_completed" | "refund_account_reinput",
  dedupeKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, dedupe_key, payload)
               VALUES (uuidv7(), ${facts.memberId}::uuid, ${facts.academyId}::uuid, ${kind}, ${dedupeKey}, ${JSON.stringify(payload)}::jsonb)
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

async function audit(tx: Runner, staffAccountId: string, facts: TransferFacts, action: string, after: Record<string, unknown>): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, before, after)
               VALUES (uuidv7(), 'staff', ${staffAccountId}::uuid, 'owner', ${facts.academyId}::uuid, ${action}, 'refunds', ${facts.refundId}::uuid,
                       ${JSON.stringify({ status: facts.status })}::json, ${JSON.stringify(after)}::json)`
      .affectedCount()
      .build(),
  );
}

// ---- 송금 완료 ---------------------------------------------------------------------------------

export interface TransferActionInput {
  academyId: string;
  refundId: string;
  staffAccountId: string;
}

/**
 * 「송금 완료」. 이름 대조 체크가 없으면 422 NAME_CHECK_REQUIRED — 대표가 확인하지 않은 송금을 완료로 적지 않는다.
 * pending → succeeded(조건부) · 송금 완료 시각·누른 사람 · 요청 completed · 이벤트 · 회원 알림 refund_completed · 감사.
 */
export async function completeRefundTransfer(
  deps: RefundTransferDeps,
  input: TransferActionInput & { nameChecked: boolean },
): Promise<RefundTransferCompleteResponse> {
  if (!input.nameChecked) {
    throw HttpError.unprocessable(REFUND_TRANSFER_CODES.nameCheckRequired, DETAIL.nameCheckRequired, {
      fields: [{ path: "nameChecked", message: DETAIL.nameCheckRequired }],
    });
  }
  const now = deps.clock().toString();

  return deps.db.transaction(async (tx) => {
    const facts = await lockOwnTransfer(tx, input.academyId, input.refundId);

    // 이미 송금 완료된 계좌분이면 두 번째 누름 — 같은 본문으로 돌려주고 아무것도 더 적지 않는다(W31 「같은 건은 한 번만 완료돼요」)
    if (facts.executionKind === "owner_bank_transfer" && facts.status === "succeeded" && facts.transferCompletedAt !== null) {
      return { refundId: facts.refundId, status: "succeeded", completedAt: facts.transferCompletedAt };
    }
    if (!isTransferPending(facts)) throw HttpError.conflict(REFUND_TRANSFER_CODES.notPending, DETAIL.notPending);

    // 조건부 갱신 — 잠금 뒤라 평소엔 1행. 돌려준 금액 = 승인한 금액 전부(계좌 송금은 나눠 보내지 않는다)
    const changed = await tx.execute(
      tx.raw.sql`UPDATE refunds
                    SET status = 'succeeded', refunded_amount = requested_amount,
                        transfer_completed_at = ${now}::timestamptz,
                        transfer_completed_by_staff_account_id = ${input.staffAccountId}::uuid,
                        updated_at = ${now}::timestamptz
                  WHERE id = ${facts.refundId}::uuid AND status = 'pending' AND execution_kind = 'owner_bank_transfer'`
        .affectedCount()
        .build(),
    );
    if (changed.affectedRows !== 1) throw HttpError.conflict(REFUND_TRANSFER_CODES.notPending, DETAIL.notPending);

    // 요청이 원인이면 그 요청을 끝낸다 — 계좌분 요청은 송금 완료 전까지 completed 가 아니다(계약 §8 수용 ②)
    if (facts.requestId !== null) {
      await tx.execute(
        tx.raw.sql`UPDATE refund_requests SET status = 'completed', completed_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
                    WHERE id = ${facts.requestId}::uuid AND status = 'in_progress'`
          .affectedCount()
          .build(),
      );
    }

    await recordEvent(tx, facts.refundId, REFUND_TRANSFER_EVENTS.completed, {
      amount: facts.amount,
      name_checked: true,
      completed_by_staff_account_id: input.staffAccountId,
    });
    await notifyMember(tx, facts, "refund_completed", `refund:${facts.refundId}:completed`, {
      title: "환불금을 보냈어요",
      offeringTitle: facts.classTitle,
      amount: facts.amount,
      refundId: facts.refundId,
      requestId: facts.requestId,
      orderId: facts.orderId,
    });
    await audit(tx, input.staffAccountId, facts, "refund.transfer_completed", { status: "succeeded", amount: facts.amount, nameChecked: true });

    return { refundId: facts.refundId, status: "succeeded", completedAt: Temporal.Instant.from(now).toString({ fractionalSecondDigits: 3 }) };
  });
}

// ---- 다시 입력 요청 -------------------------------------------------------------------------------

/**
 * 「이름이 달라요 · 다시 입력 요청」(또는 송금 반송). 이 시도를 failed 로 닫고 회원에게 계좌를 다시 받는다.
 * pending → failed(조건부, failure_code) · reinput 칸 · 주문 환불 합계 되돌림 · 이벤트 · 회원 알림 refund_account_reinput · 감사.
 * 요청은 처리 중(in_progress)으로 남는다 — 새 계좌가 오면 다음 시도(attempt_no + 1)로 다시 송금 대기에 오른다(FR-103).
 */
export async function requestRefundAccountReinput(
  deps: RefundTransferDeps,
  input: TransferActionInput & { reason: RefundReinputReason },
): Promise<RefundTransferReinputResponse> {
  const now = deps.clock().toString();

  return deps.db.transaction(async (tx) => {
    const facts = await lockOwnTransfer(tx, input.academyId, input.refundId);

    // 같은 이유로 이미 닫았으면 두 번째 누름 — 같은 본문(알림도 한 번뿐). 다른 이유로 닫혔거나 완료된 건은 409
    if (facts.status === "failed" && facts.reinputReason !== null && facts.reinputRequestedAt !== null) {
      if (facts.reinputReason === input.reason) {
        return { refundId: facts.refundId, status: "failed", reason: facts.reinputReason, reinputRequestedAt: facts.reinputRequestedAt };
      }
      throw HttpError.conflict(REFUND_TRANSFER_CODES.notPending, DETAIL.notPending);
    }
    if (!isTransferPending(facts)) throw HttpError.conflict(REFUND_TRANSFER_CODES.notPending, DETAIL.notPending);

    const failureCode = REINPUT_FAILURE_CODES[input.reason];
    const changed = await tx.execute(
      tx.raw.sql`UPDATE refunds
                    SET status = 'failed', refunded_amount = 0, failure_code = ${failureCode},
                        failure_message = ${REINPUT_MESSAGE[input.reason]},
                        reinput_requested_at = ${now}::timestamptz, reinput_reason = ${input.reason},
                        updated_at = ${now}::timestamptz
                  WHERE id = ${facts.refundId}::uuid AND status = 'pending' AND execution_kind = 'owner_bank_transfer'`
        .affectedCount()
        .build(),
    );
    if (changed.affectedRows !== 1) throw HttpError.conflict(REFUND_TRANSFER_CODES.notPending, DETAIL.notPending);

    // 승인 때 올린 주문 환불 합계를 되돌린다 — 이 시도로는 돈이 나가지 않았다. 다음 시도가 다시 올린다(계약 §1-3)
    await tx.execute(
      tx.raw.sql`UPDATE orders SET refunded_total_amount = refunded_total_amount - ${facts.amount}, updated_at = ${now}::timestamptz
                  WHERE id = ${facts.orderId}::uuid AND refunded_total_amount >= ${facts.amount}`
        .affectedCount()
        .build(),
    );

    await recordEvent(tx, facts.refundId, REFUND_TRANSFER_EVENTS.reinputRequested, {
      reason: input.reason,
      failure_code: failureCode,
      requested_by_staff_account_id: input.staffAccountId,
    });
    // 알림을 누르면 앱이 환불 계좌 입력(C9A)으로 간다 — requestId 로 §2-1 `POST /api/refund-requests/{requestId}/account` 를 부른다
    await notifyMember(tx, facts, "refund_account_reinput", `refund:${facts.refundId}:reinput`, {
      title: "계좌를 다시 입력해 주세요",
      message: REINPUT_MESSAGE[input.reason],
      reason: input.reason,
      offeringTitle: facts.classTitle,
      amount: facts.amount,
      refundId: facts.refundId,
      requestId: facts.requestId,
      orderId: facts.orderId,
    });
    await audit(tx, input.staffAccountId, facts, "refund.reinput_requested", { status: "failed", reason: input.reason, failureCode });

    return {
      refundId: facts.refundId,
      status: "failed",
      reason: input.reason,
      reinputRequestedAt: Temporal.Instant.from(now).toString({ fractionalSecondDigits: 3 }),
    };
  });
}

// ---- 라우트 ----------------------------------------------------------------------------------

type Params = { params: Promise<{ academyId: string; refundId: string }> };

/**
 * 경로 id 검사 + 대표 가드. 앱은 Bearer(2단계 인증을 묻지 않음), 관리자 웹은 쿠키(2단계 인증 필수) — 같은 경로·같은 판정(계약 §1-1).
 * 위임 강사·강사는 owner 권한이 없어 403 이다(FR-081a). id 모양이 틀리면 없는 건과 같게 404.
 */
async function requireOwner(
  guards: ReturnType<typeof createGuards>,
  request: Request,
  context: Params,
): Promise<{ owner: StaffContext; academyId: string; refundId: string }> {
  const params = refundTransferParamsSchema.safeParse(await context.params);
  if (!params.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  const bearer = (request.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer ");
  const owner = await guards.requireStaff("owner", { academyId: params.data.academyId, surface: bearer ? "app" : "web", headers: request.headers });
  return { owner, ...params.data };
}

/** `POST …/refund-transfers/{refundId}/complete` — 앱은 승인 버튼 → 확인 팝업(O48B) 뒤에 부른다. 같은 건 두 번은 200 같은 본문 */
export function createRefundTransferCompleteRoute(deps: RefundTransferDeps) {
  const guards = createGuards(deps);
  return withRoute<Params>(async (request, context) => {
    const { owner, academyId, refundId } = await requireOwner(guards, request, context);
    const body = await parseJsonBody(request, refundTransferCompleteRequestSchema);
    const outcome = await completeRefundTransfer(deps, {
      academyId,
      refundId,
      staffAccountId: owner.staffAccountId,
      nameChecked: body.nameChecked === true,
    });
    return Response.json(refundTransferCompleteResponseSchema.parse(outcome));
  });
}

/** `POST …/refund-transfers/{refundId}/request-reinput` — 본문 `{ reason: "name_mismatch" | "returned" }` */
export function createRefundTransferReinputRoute(deps: RefundTransferDeps) {
  const guards = createGuards(deps);
  return withRoute<Params>(async (request, context) => {
    const { owner, academyId, refundId } = await requireOwner(guards, request, context);
    const body = await parseJsonBody(request, refundTransferReinputRequestSchema);
    const outcome = await requestRefundAccountReinput(deps, { academyId, refundId, staffAccountId: owner.staffAccountId, reason: body.reason });
    return Response.json(refundTransferReinputResponseSchema.parse(outcome));
  });
}
