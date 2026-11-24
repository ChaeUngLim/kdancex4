// S4-1.2(환불 요청 생성·철회) — 회원이 환불을 요청하고, 대표가 결정하기 전에는 철회하는 처리기.
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §2-1(서버 순서 표 · 철회) · §1-2(오류 코드) · §1-3(멱등)
//   데이터: refund_requests(S4-1.1, data-model §9-3) · spec FR-098b(환불 요청 경로) · M-06(상태 4종 + 철회)
//
// 요청 만들기 순서(한 트랜잭션):
//   1 같은 회원·같은 Idempotency-Key 요청이 있으면 그대로 200(재생)
//   2 예약 행 잠금 → 소유자(남의 예약 403) → 예약 confirmed · 주문 paid/partially_refunded(아니면 409)
//   3 같은 예약에 처리 전(접수·처리 중) 요청이 있으면 409 REFUND_REQUEST_OPEN(+ 그 요청 id)
//   4 상품 종류로 정규·이벤트형을 가른다 — 이벤트형 취소 신청은 아직 받지 않는다(아래 「이벤트형」)
//   5 계좌 결제분이면 이 주문의 쓰는(active) 환불 계좌가 있어야 한다(422 REFUND_ACCOUNT_REQUIRED)
//   6 답할 기한 = 접수 + 3영업일 → INSERT … ON CONFLICT DO NOTHING(동시에 두 번 와도 행은 하나) → 감사 1행
//
// 상태 전이는 모두 조건부 갱신이다 — `UPDATE … WHERE id = :id AND status = :from` 이 0행이면 누가 먼저 바꾼 것이다.
//
// 이번 Task 가 일부러 하지 않은 것(EVIDENCE.md 「추천안·사후 확인」):
//   - 이벤트형 취소 신청(§2-1 6-b) — 수수료 계산(S4-2.1)과 예약 취소·자리 반납이 함께 필요해 S4-2 가 이 경로에 붙인다.
//     그 전에는 409 REFUND_NOT_ALLOWED_STATE 로 막는다(회원이 금액 없는 요청을 만들어 두는 일을 막으려고).
//   - 대표·강사·회원 알림(§2-1 7단계) — 알림 kind 를 더하려면 마이그레이션이 필요하다. 같은 묶음의 기한 예고·재알림 kind 를
//     더하는 S4-1.8 에서 함께 더한다. 감사 기록은 여기서 남긴다.
import type {
  ClassKind,
  PaymentMethod,
  RefundRequestDecisionKind,
  RefundRequestKind,
  RefundRequestStatus,
} from "../../domain/constants";
import {
  isRefundRequestWithdrawable,
  needsRefundAccount,
  refundAnswerDueAt,
  refundRequestDisplayStatus,
  refundRequestKindFor,
} from "../../domain/refund-request";
import type { ServerDeps } from "../deps";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, parseJsonBody, readIdempotencyKey, withRoute } from "../http";
import {
  createRefundRequestSchema,
  refundRequestCreatedSchema,
  refundRequestIdSchema,
  refundRequestWithdrawnSchema,
  type CreateRefundRequest,
  type RefundRequestCreated,
  type RefundRequestWithdrawn,
} from "../schemas/refund-requests";
import { loadHolidayCalendar } from "./admin-holidays";
import type { Runner } from "./cancellation-queries";

export type RefundRequestDeps = GuardDeps & Pick<ServerDeps, "clock">;

/** 이 파일이 쓰는 계약 12 §1-2 의 오류 코드 */
export const REFUND_REQUEST_CODES = {
  notAllowedState: "REFUND_NOT_ALLOWED_STATE",
  open: "REFUND_REQUEST_OPEN",
  notWithdrawable: "REFUND_REQUEST_NOT_WITHDRAWABLE",
  accountRequired: "REFUND_ACCOUNT_REQUIRED",
} as const;

const DETAIL = {
  reservationNotFound: "예약을 찾을 수 없어요",
  requestNotFound: "환불 요청을 찾을 수 없어요",
  notMine: "본인의 예약만 환불을 요청할 수 있어요",
  notMyRequest: "본인의 환불 요청만 철회할 수 있어요",
  notAllowedState: "결제가 끝난 예약만 환불을 요청할 수 있어요",
  eventNotOpen: "이벤트형 수업의 취소 신청은 아직 받을 수 없어요",
  open: "이 예약에는 처리 중인 환불 요청이 이미 있어요",
  accountRequired: "계좌로 결제한 주문은 환불받을 계좌를 먼저 넣어 주세요",
  accountNotNeeded: "카드로 결제한 주문은 환불 계좌가 필요 없어요",
  notWithdrawable: "대표가 이미 처리했거나 철회할 수 없는 요청이에요",
} as const;

/** 환불을 요청할 수 있는 주문 상태 — 결제 완료, 또는 다른 원인으로 일부만 환불된 주문(D13: 원인이 다르면 각각 된다) */
const REQUESTABLE_ORDER_STATUSES = ["paid", "partially_refunded"];

// ---- 읽기 ------------------------------------------------------------------------------------

/** 응답을 만드는 데 필요한 요청 칸. 시각은 ISO 문자열(없으면 null) */
interface RequestRow {
  id: string;
  memberId: string;
  academyId: string;
  kind: RefundRequestKind;
  status: RefundRequestStatus;
  decisionKind: RefundRequestDecisionKind | null;
  receivedAt: string;
  answerDueAt: string;
  inProgressAt: string | null;
  decidedAt: string | null;
  completedAt: string | null;
  withdrawnAt: string | null;
}

const orNull = (value: string): string | null => (value === "" ? null : value);

/**
 * 요청 1행. `lock` 이면 그 행을 FOR UPDATE 로 잠근다(철회와 대표 결정이 같은 순간에 와도 차례로 처리된다).
 * raw 레인은 NULL 을 받지 못해 빈 칸은 COALESCE(…, '') 로 읽고 TS 에서 null 로 되돌린다(cancellation-queries 와 같은 방식).
 */
async function readRequest(runner: Runner, requestId: string, lock: boolean): Promise<RequestRow | null> {
  // raw 템플릿에 문자열을 끼우면 값 자리가 되므로 잠금 여부에 따라 같은 문장을 두 번 쓴다
  const base = runner.raw.sql`SELECT id, member_id, academy_id, kind, status, COALESCE(decision_kind, '') AS decision_kind,
                                     to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at,
                                     to_char(answer_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS answer_due_at,
                                     COALESCE(to_char(in_progress_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') AS in_progress_at,
                                     COALESCE(to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') AS decided_at,
                                     COALESCE(to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') AS completed_at,
                                     COALESCE(to_char(withdrawn_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') AS withdrawn_at
                              FROM refund_requests WHERE id = ${requestId}::uuid`;
  const locked = runner.raw.sql`SELECT id, member_id, academy_id, kind, status, COALESCE(decision_kind, '') AS decision_kind,
                                     to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at,
                                     to_char(answer_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS answer_due_at,
                                     COALESCE(to_char(in_progress_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') AS in_progress_at,
                                     COALESCE(to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') AS decided_at,
                                     COALESCE(to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') AS completed_at,
                                     COALESCE(to_char(withdrawn_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') AS withdrawn_at
                              FROM refund_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
  const [row] = await runner.query(
    (lock ? locked : base)
      .returnsRow({
        id: "pg/uuid@1",
        member_id: "pg/uuid@1",
        academy_id: "pg/uuid@1",
        kind: "pg/text@1",
        status: "pg/text@1",
        decision_kind: "pg/text@1",
        received_at: "pg/text@1",
        answer_due_at: "pg/text@1",
        in_progress_at: "pg/text@1",
        decided_at: "pg/text@1",
        completed_at: "pg/text@1",
        withdrawn_at: "pg/text@1",
      })
      .build(),
  );
  if (row === undefined) return null;
  return {
    id: row.id,
    memberId: row.member_id,
    academyId: row.academy_id,
    kind: row.kind as RefundRequestKind,
    status: row.status as RefundRequestStatus,
    decisionKind: orNull(row.decision_kind) as RefundRequestDecisionKind | null,
    receivedAt: row.received_at,
    answerDueAt: row.answer_due_at,
    inProgressAt: orNull(row.in_progress_at),
    decidedAt: orNull(row.decided_at),
    completedAt: orNull(row.completed_at),
    withdrawnAt: orNull(row.withdrawn_at),
  };
}

/** 같은 회원이 같은 열쇠로 이미 만든 요청 id(재생 판정) */
async function findRequestIdByKey(runner: Runner, memberId: string, key: string): Promise<string | null> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT id FROM refund_requests WHERE member_id = ${memberId}::uuid AND idempotency_key = ${key}`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  return row?.id ?? null;
}

/** 같은 예약의 처리 전(접수·처리 중) 요청 id — uq_refund_requests_open 과 같은 조건 */
async function findOpenRequestId(runner: Runner, reservationId: string): Promise<string | null> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT id FROM refund_requests
                   WHERE reservation_id = ${reservationId}::uuid AND status IN ('received', 'in_progress')`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  return row?.id ?? null;
}

/** 요청을 만들 때 보는 예약·주문 사실 한 묶음 */
interface ReservationForRefund {
  id: string;
  orderId: string;
  memberId: string;
  academyId: string;
  reservationStatus: string;
  orderStatus: string;
  classKind: ClassKind;
  noticeVersionId: string;
  /** 결제 완료 원거래의 수단. 0원 주문처럼 원거래가 없으면 null */
  paymentMethod: PaymentMethod | null;
}

/**
 * 예약 행을 잠그고(FOR UPDATE OF r) 주문 스냅샷의 수업 구분·공지 판본·결제수단을 함께 읽는다.
 * 잠그는 이유: 같은 예약에 요청 두 건이 동시에 오면 하나는 여기서 기다리고, 풀린 뒤 3단계에서 먼저 만든 요청을 본다.
 */
async function readReservationForRefund(runner: Runner, reservationId: string): Promise<ReservationForRefund | null> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT r.id, r.order_id, r.member_id, r.status AS reservation_status, c.academy_id,
                          o.status AS order_status, o.class_kind, o.refund_notice_version_id,
                          COALESCE((SELECT p.method FROM payments p WHERE p.order_id = o.id AND p.status = 'paid'
                                     ORDER BY p.paid_at DESC NULLS LAST LIMIT 1), '') AS payment_method
                   FROM reservations r
                   JOIN orders o ON o.id = r.order_id
                   JOIN class_offerings off ON off.id = r.offering_id
                   JOIN classes c ON c.id = off.class_id
                   WHERE r.id = ${reservationId}::uuid
                   FOR UPDATE OF r`
      .returnsRow({
        id: "pg/uuid@1",
        order_id: "pg/uuid@1",
        member_id: "pg/uuid@1",
        reservation_status: "pg/text@1",
        academy_id: "pg/uuid@1",
        order_status: "pg/text@1",
        class_kind: "pg/text@1",
        refund_notice_version_id: "pg/uuid@1",
        payment_method: "pg/text@1",
      })
      .build(),
  );
  if (row === undefined) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    memberId: row.member_id,
    academyId: row.academy_id,
    reservationStatus: row.reservation_status,
    orderStatus: row.order_status,
    classKind: row.class_kind as ClassKind,
    noticeVersionId: row.refund_notice_version_id,
    paymentMethod: orNull(row.payment_method) as PaymentMethod | null,
  };
}

/** 이 주문·이 회원의 쓰는(active) 환불 계좌인가 */
async function isActiveRefundAccount(runner: Runner, accountId: string, orderId: string, memberId: string): Promise<boolean> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT id FROM refund_accounts
                   WHERE id = ${accountId}::uuid AND order_id = ${orderId}::uuid AND member_id = ${memberId}::uuid AND status = 'active'`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  return row !== undefined;
}

/** 감사 1행 — 회원이 한 일. 전후 값은 상태만(사유 글은 회원이 쓴 개인 사정이라 감사 칸에 복사하지 않는다) */
async function insertMemberAudit(
  runner: Runner,
  input: { memberId: string; academyId: string; action: string; requestId: string; before: unknown; after: unknown },
): Promise<void> {
  await runner.execute(
    runner.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_member_id, actor_role, academy_id, action, target_table, target_id, before, after)
                   VALUES (uuidv7(), 'member', ${input.memberId}::uuid, 'member', ${input.academyId}::uuid, ${input.action},
                           'refund_requests', ${input.requestId}::uuid, ${JSON.stringify(input.before)}::json, ${JSON.stringify(input.after)}::json)`
      .affectedCount()
      .build(),
  );
}

// ---- 응답 ------------------------------------------------------------------------------------

/**
 * 요청 행 → 응답. 진행 단계는 찍힌 시각만 차례로 늘어놓는다: 접수 → (처리 중) → 완료·거절·철회 중 하나.
 * displayStatus·withdrawable 은 저장하지 않는 계산값이라 응답을 만들 때마다 지금 시각으로 다시 낸다.
 */
function toCreatedOutcome(row: RequestRow, now: Temporal.Instant): RefundRequestCreated {
  const progress: RefundRequestCreated["progress"] = [{ step: "received", at: row.receivedAt }];
  if (row.inProgressAt !== null) progress.push({ step: "in_progress", at: row.inProgressAt });
  if (row.status === "completed" && row.completedAt !== null) progress.push({ step: "completed", at: row.completedAt });
  if (row.status === "rejected" && row.decidedAt !== null) progress.push({ step: "rejected", at: row.decidedAt });
  if (row.status === "withdrawn" && row.withdrawnAt !== null) progress.push({ step: "withdrawn", at: row.withdrawnAt });
  return {
    requestId: row.id,
    kind: row.kind,
    status: row.status,
    receivedAt: row.receivedAt,
    answerDueAt: row.answerDueAt,
    displayStatus: refundRequestDisplayStatus({ status: row.status, answerDueAt: Temporal.Instant.from(row.answerDueAt) }, now),
    withdrawable: isRefundRequestWithdrawable(row),
    progress,
  };
}

// ---- 요청 만들기 -------------------------------------------------------------------------------

export interface CreateRefundRequestInput {
  memberId: string;
  idempotencyKey: string;
  body: CreateRefundRequest;
}

/** 결과와 함께 「새로 만들었나(201)·재생인가(200)」를 돌려준다 */
export interface CreateRefundRequestResult {
  created: boolean;
  outcome: RefundRequestCreated;
}

export async function createRefundRequest(deps: RefundRequestDeps, input: CreateRefundRequestInput): Promise<CreateRefundRequestResult> {
  const now = deps.clock();
  const { body } = input;

  return deps.db.transaction(async (tx) => {
    /** 이미 있는 요청을 다시 읽어 재생 응답으로 돌려준다 */
    const replay = async (requestId: string): Promise<CreateRefundRequestResult> => {
      const row = await readRequest(tx, requestId, false);
      if (row === null) throw new Error(`재생할 환불 요청을 다시 읽지 못했다: ${requestId}`);
      return { created: false, outcome: toCreatedOutcome(row, now) };
    };

    // 1 재생 — 상태 검사보다 먼저. 처음 요청 뒤 예약이 바뀌었어도 같은 열쇠는 처음 결과(그 요청의 지금 상태)를 돌려준다
    const replayId = await findRequestIdByKey(tx, input.memberId, input.idempotencyKey);
    if (replayId !== null) return replay(replayId);

    // 2 예약 잠금 → 소유자 → 상태. 없는 예약(404)과 남의 예약(403)을 나눈다(계약 §1-1 「404 로 숨기지 않는다」)
    const reservation = await readReservationForRefund(tx, body.reservationId);
    if (reservation === null) throw new HttpError("NOT_FOUND", DETAIL.reservationNotFound);
    if (reservation.memberId !== input.memberId) throw new HttpError("FORBIDDEN", DETAIL.notMine);
    if (reservation.reservationStatus !== "confirmed" || !REQUESTABLE_ORDER_STATUSES.includes(reservation.orderStatus)) {
      throw HttpError.conflict(REFUND_REQUEST_CODES.notAllowedState, DETAIL.notAllowedState);
    }

    // 3 처리 전 요청은 예약당 하나 — 앱이 그 요청 화면으로 보내도록 id 를 함께 준다
    const openId = await findOpenRequestId(tx, reservation.id);
    if (openId !== null) throw HttpError.conflict(REFUND_REQUEST_CODES.open, DETAIL.open, { requestId: openId });

    // 4 종류. 이벤트형은 수수료 계산·예약 취소와 같이 가야 해서 S4-2 전까지 막는다(파일 머리 주석)
    const kind = refundRequestKindFor(reservation.classKind);
    if (kind === "event") throw HttpError.conflict(REFUND_REQUEST_CODES.notAllowedState, DETAIL.eventNotOpen);

    // 5 계좌 결제분은 환불받을 계좌가 있어야 한다(대표가 그 계좌로 직접 보낸다 — FR-295). 카드분에는 계좌 칸이 없다
    const accountNeeded = reservation.paymentMethod !== null && needsRefundAccount(reservation.paymentMethod);
    if (accountNeeded) {
      const ok = body.refundAccountId !== null && (await isActiveRefundAccount(tx, body.refundAccountId, reservation.orderId, input.memberId));
      if (!ok) throw HttpError.unprocessable(REFUND_REQUEST_CODES.accountRequired, DETAIL.accountRequired);
    } else if (body.refundAccountId !== null) {
      throw new HttpError("VALIDATION_FAILED", DETAIL.accountNotNeeded, {
        fields: [{ path: "refundAccountId", message: DETAIL.accountNotNeeded }],
      });
    }

    // 6 답할 기한 = 접수 + 3영업일(같은 시각). 공휴일은 holidays 표 하나만 본다(S0-4.8)
    const answerDueAt = refundAnswerDueAt(now, await loadHolidayCalendar(tx));
    const inserted = await tx.query(
      tx.raw.sql`INSERT INTO refund_requests (id, order_id, reservation_id, academy_id, member_id, kind, status, reason_kind,
                                              reason_text, desired_text, refund_account_id, notice_version_id,
                                              received_at, answer_due_at, idempotency_key, created_at, updated_at)
                 VALUES (uuidv7(), ${reservation.orderId}::uuid, ${reservation.id}::uuid, ${reservation.academyId}::uuid,
                         ${input.memberId}::uuid, ${kind}, 'received', ${body.reasonKind},
                         NULLIF(${body.reasonText ?? ""}, ''), NULLIF(${body.desiredText ?? ""}, ''),
                         NULLIF(${accountNeeded ? (body.refundAccountId ?? "") : ""}, '')::uuid, ${reservation.noticeVersionId}::uuid,
                         ${now.toString()}::timestamptz, ${answerDueAt.toString()}::timestamptz, ${input.idempotencyKey},
                         ${now.toString()}::timestamptz, ${now.toString()}::timestamptz)
                 ON CONFLICT DO NOTHING
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    const [row] = inserted;
    if (row === undefined) {
      // 유니크(같은 열쇠 · 예약당 처리 전 1건)에 걸렸다 — 잠금이 있어 평소엔 1·3단계에서 걸러지고, 여기는 마지막 방어선
      const winner = await findRequestIdByKey(tx, input.memberId, input.idempotencyKey);
      if (winner !== null) return replay(winner);
      const open = await findOpenRequestId(tx, reservation.id);
      throw HttpError.conflict(REFUND_REQUEST_CODES.open, DETAIL.open, open === null ? {} : { requestId: open });
    }

    await insertMemberAudit(tx, {
      memberId: input.memberId,
      academyId: reservation.academyId,
      action: "refund_request.created",
      requestId: row.id,
      before: null,
      after: { kind, status: "received", reservationId: reservation.id, answerDueAt: answerDueAt.toString() },
    });

    const created = await readRequest(tx, row.id, false);
    if (created === null) throw new Error(`방금 만든 환불 요청을 읽지 못했다: ${row.id}`);
    return { created: true, outcome: toCreatedOutcome(created, now) };
  });
}

// ---- 철회 ------------------------------------------------------------------------------------

/**
 * 철회. 된다 = 정규 · 대표 결정 전 · 접수/처리 중(isRefundRequestWithdrawable). 예약은 그대로 남는다.
 * 이미 철회한 요청을 다시 철회하면 200 같은 본문(두 번 눌러도 한 번). 결정이 선 뒤·이벤트형은 409.
 */
export async function withdrawRefundRequest(
  deps: RefundRequestDeps,
  input: { memberId: string; requestId: string },
): Promise<RefundRequestWithdrawn> {
  const now = deps.clock();
  return deps.db.transaction(async (tx) => {
    // 잠금 — 대표의 승인(S4-1.4)이 같은 순간에 와도 둘 중 하나만 이긴다
    const row = await readRequest(tx, input.requestId, true);
    if (row === null) throw new HttpError("NOT_FOUND", DETAIL.requestNotFound);
    if (row.memberId !== input.memberId) throw new HttpError("FORBIDDEN", DETAIL.notMyRequest);
    if (row.status === "withdrawn") return { status: "withdrawn" };
    if (!isRefundRequestWithdrawable(row)) {
      throw HttpError.conflict(REFUND_REQUEST_CODES.notWithdrawable, DETAIL.notWithdrawable);
    }

    // 조건부 전이 — 읽은 상태 그대로이고 결정이 아직 없을 때만 바뀐다
    const changed = await tx.execute(
      tx.raw.sql`UPDATE refund_requests
                 SET status = 'withdrawn', withdrawn_at = ${now.toString()}::timestamptz, updated_at = ${now.toString()}::timestamptz
                 WHERE id = ${row.id}::uuid AND status = ${row.status} AND decision_kind IS NULL AND kind = 'regular'`
        .affectedCount()
        .build(),
    );
    if (changed.affectedRows !== 1) throw HttpError.conflict(REFUND_REQUEST_CODES.notWithdrawable, DETAIL.notWithdrawable);

    await insertMemberAudit(tx, {
      memberId: input.memberId,
      academyId: row.academyId,
      action: "refund_request.withdrawn",
      requestId: row.id,
      before: { status: row.status },
      after: { status: "withdrawn", withdrawnAt: now.toString() },
    });
    return { status: "withdrawn" };
  });
}

// ---- 라우트 ----------------------------------------------------------------------------------

type RequestIdParams = { params: Promise<{ requestId: string }> };

/** `POST /api/refund-requests` — 처음 201, 같은 열쇠 재생 200 */
export function createRefundRequestRoute(deps: RefundRequestDeps) {
  const guards = createGuards(deps);
  return withRoute<unknown>(async (request) => {
    const member = await guards.requireMember(request);
    const idempotencyKey = readIdempotencyKey(request, { required: true });
    const body = await parseJsonBody(request, createRefundRequestSchema);
    const result = await createRefundRequest(deps, { memberId: member.memberId, idempotencyKey, body });
    // 내보내기 전에 계약 모양을 한 번 더 확인한다 — 칸을 빠뜨린 응답이 앱으로 나가지 않게
    return Response.json(refundRequestCreatedSchema.parse(result.outcome), { status: result.created ? 201 : 200 });
  });
}

/** `POST /api/refund-requests/{requestId}/withdraw` — 본문 없음 */
export function createWithdrawRefundRequestRoute(deps: RefundRequestDeps) {
  const guards = createGuards(deps);
  return withRoute<RequestIdParams>(async (request, context) => {
    const member = await guards.requireMember(request);
    // 경로의 요청 id. 모양이 틀리면 없는 요청과 같게 404(DB 형 변환 오류 500 을 막는다)
    const param = refundRequestIdSchema.safeParse((await context.params).requestId);
    if (!param.success) throw new HttpError("NOT_FOUND", DETAIL.requestNotFound);
    const outcome = await withdrawRefundRequest(deps, { memberId: member.memberId, requestId: param.data });
    return Response.json(refundRequestWithdrawnSchema.parse(outcome));
  });
}
