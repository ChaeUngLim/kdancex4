// S4-1.5a(계좌 환불 송금 완료·반송 처리 API) — 계좌 결제분 환불을 대표가 은행에서 보낸 뒤 「송금 완료」로 끝내고,
// 받는 사람 이름이 다르거나 반송되면 「다시 입력 요청」으로 회원에게 계좌를 다시 받는지 실제 PostgreSQL 에서 본다.
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §2-5(계좌 환불 송금) · §1-2(오류 코드) · §1-3(송금 완료 재생)
//   (로드맵 verify 의 파일 이름 `tests/db/s4-1-5a.db.test.ts` 를 기능 이름 `refund-transfer.db.test.ts` 로 바꿨다)
//
// 확인하는 것:
//   ① 이름 대조 체크 없이 누르면 422 NAME_CHECK_REQUIRED 이고 아무것도 바뀌지 않는다
//   ② 송금 완료 → 환불 succeeded · 송금 완료 기록 1행(시각·누른 사람) · 요청 completed · 이벤트 · 회원 알림 refund_completed 1건 · 감사 1행 · PG 호출 0
//      두 번 눌러도 200 같은 본문, 기록은 그대로 1행씩(FR-102)
//   ③ 이름 다름 → 환불 failed(ACCOUNT_NAME_MISMATCH) · 합계 되돌림 · 요청 처리 중 · 회원 알림 refund_account_reinput 1건 · 감사 1행
//      같은 이유 재생은 200 같은 본문(알림 1건 그대로), 다른 이유·송금 완료는 409 TRANSFER_NOT_PENDING
//   ④ 송금 반송 → failed(TRANSFER_RETURNED)
//   ⑤ 송금 대기가 아닌 건(카드분) 409 · 남의 학원 환불 404 · 다른 학원 대표 403
//   ⑥ DB 마지막 방어선 — 계좌분은 송금 완료 기록 없이 succeeded 가 될 수 없다(ck_refunds_transfer_account)
// 다른 DB 테스트와 표를 함께 쓰므로 테스트마다 truncateAll 로 비운다(DB 테스트는 flock 으로 하나씩 돈다).
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "../../lib/domain/time";
import { FakePaymentGateway, createFakePaymentGatewayStore } from "../../lib/server/fakes/fake-payment-gateway";
import type { AuthSession, SessionReader } from "../../lib/server/guards";
import type { PaymentGatewayPort } from "../../lib/server/ports/payment-gateway";
import { refundDecisionResponseSchema } from "../../lib/server/schemas/refund-decisions";
import { refundRequestCreatedSchema } from "../../lib/server/schemas/refund-requests";
import { createRefundDecisionRoute } from "../../lib/server/services/refund-decisions";
import { createRefundRequestRoute } from "../../lib/server/services/refund-requests";
import { refundTransferCompleteResponseSchema, refundTransferReinputResponseSchema } from "../../lib/server/schemas/refund-transfers";
import { createRefundTransferCompleteRoute, createRefundTransferReinputRoute } from "../../lib/server/services/refund-transfers";
import { insertCancellationChain, type CancellationChain } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const BASE = "http://localhost";
const TEST_USER_HEADER = "x-test-auth-user";
const fakeSession: SessionReader = async (headers) => {
  const id = headers.get(TEST_USER_HEADER);
  if (id === null) return null;
  const session: AuthSession = { user: { id } };
  return session;
};

// 2026-11-05(목) 14:20 KST 접수 → 2026-11-06(금) 10:00 KST 승인
const RECEIVED_AT = Temporal.Instant.from("2026-11-05T05:20:00Z");
const DECIDED_AT = Temporal.Instant.from("2026-11-06T01:00:00Z");

const REGULAR_NOTICE = {
  cancellableUntil: "첫 수업 시작 전까지",
  tiers: [
    { point: "before_start", percent: 100 },
    { point: "before_one_third", percent: 67 },
    { point: "before_half", percent: 50 },
    { point: "after_half", percent: 0 },
  ],
  nonRefundableCases: "이미 들은 회차",
  processingBusinessDays: 5,
  ownerContact: "0212345678",
};

const APPROVE = { decision: "approve", amount: 107200, noticeItemCode: "tier:before_one_third" } as const;

// 송금 완료·재입력은 승인 다음 날 2026-11-07(토) 11:30 KST 에 누른다
const TRANSFER_AT = Temporal.Instant.from("2026-11-07T02:30:00Z");
const TRANSFER_AT_ISO = "2026-11-07T02:30:00.000Z";

/** 이 처리기는 포트를 부르지 않는다 — 불리면 시험이 실패하도록 모든 메서드가 거절한다 */
const unusedGateway: PaymentGatewayPort = {
  createPayment: () => Promise.reject(new Error("송금 처리는 PG 를 부르지 않는다")),
  getPayment: () => Promise.reject(new Error("송금 처리는 PG 를 부르지 않는다")),
  cancelPayment: () => Promise.reject(new Error("송금 처리는 PG 를 부르지 않는다")),
  refund: () => Promise.reject(new Error("송금 처리는 PG 를 부르지 않는다")),
};

describe.skipIf(!dbAvailable())("계좌 환불 송금 완료·반송 처리(S4-1.5a)", () => {
  let handle: TestDb;
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await handle.pool.query(text, params)).rows as T[];

  beforeAll(() => {
    handle = openTestDb();
  });
  afterAll(async () => {
    await truncateAll(handle.pool);
    await closeTestDb(handle);
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
  });

  const deps = (at: Temporal.Instant, paymentGateway: PaymentGatewayPort) => ({ db: handle.db, getSession: fakeSession, clock: fixedClock(at), paymentGateway });

  async function makeOwner(academyId: string): Promise<{ authUserId: string; staffId: string }> {
    const staffId = randomUUID();
    const authUserId = `auth-owner-${staffId}`;
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '김대표', 'active', now())", [staffId, authUserId]);
    await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'owner')", [staffId]);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffId]);
    return { authUserId, staffId };
  }

  /**
   * 정규 4회 180,000원 예약 + 환불 요청. 카드·간편결제는 진짜 요청 경로(S4-1.2)로, 계좌 결제분은 저장한 환불 계좌를 건 요청 행을 넣는다
   * (계좌 저장 API 는 S4-1.2a 가 따로 시험한다 — 여기서는 실행만 본다).
   */
  async function regularRequest(method: "card" | "easy_pay" | "virtual_account"): Promise<{ chain: CancellationChain; requestId: string; accountId: string | null }> {
    const chain = await insertCancellationChain(handle.pool, { method: method === "virtual_account" ? "virtual_account" : "card", amount: 180000 });
    if (method === "easy_pay") await q("UPDATE payments SET method = 'easy_pay' WHERE id = $1", [chain.paymentId]);
    await q("UPDATE classes SET class_kind = 'regular', title = '살사 온투 기초' WHERE id = (SELECT class_id FROM class_offerings WHERE id = $1)", [chain.offeringId]);
    await q("UPDATE orders SET class_kind = 'regular', session_count = 4 WHERE id = $1", [chain.orderId]);
    await q("UPDATE refund_notice_versions SET content = $2::jsonb WHERE id = (SELECT refund_notice_version_id FROM orders WHERE id = $1)", [
      chain.orderId,
      JSON.stringify(REGULAR_NOTICE),
    ]);
    await q(`INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at) VALUES (uuidv7(), $1, 0, '2026-11-01T10:00:00Z', '2026-11-01T12:00:00Z')`, [chain.offeringId]);

    if (method === "virtual_account") {
      const accountId = randomUUID();
      await q(
        `INSERT INTO refund_accounts (id, order_id, member_id, bank_code, account_number_enc, account_masked, holder_name, holder_matches_identity)
         VALUES ($1, $2, $3, 'KOOKMIN', '\\x00'::bytea, '국민은행 ****-**-7890', '취소 시험 회원', true)`,
        [accountId, chain.orderId, chain.memberId],
      );
      const requestId = randomUUID();
      await q(
        `INSERT INTO refund_requests (id, order_id, reservation_id, academy_id, member_id, kind, reason_kind, notice_version_id, refund_account_id,
                                      received_at, answer_due_at, idempotency_key)
         SELECT $1, o.id, $2, $3, o.member_id, 'regular', 'personal', o.refund_notice_version_id, $6, $4::timestamptz,
                $4::timestamptz + interval '5 days', 'direct-key-0001'
           FROM orders o WHERE o.id = $5`,
        [requestId, chain.reservationId, chain.academyId, RECEIVED_AT.toString(), chain.orderId, accountId],
      );
      return { chain, requestId, accountId };
    }
    const create = createRefundRequestRoute(deps(RECEIVED_AT, new FakePaymentGateway({ store: createFakePaymentGatewayStore() })));
    const response = await create(
      new Request(`${BASE}/api/refund-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", [TEST_USER_HEADER]: chain.authUserId, "Idempotency-Key": `key-${randomUUID()}` },
        body: JSON.stringify({ reservationId: chain.reservationId, reasonKind: "schedule_change", reasonText: "일정이 바뀌어 더 다닐 수 없어요" }),
      }),
      undefined,
    );
    expect(response.status).toBe(201);
    return { chain, requestId: refundRequestCreatedSchema.parse(await response.json()).requestId, accountId: null };
  }

  async function decide(gateway: PaymentGatewayPort, academyId: string, requestId: string, authUserId: string, body: unknown = APPROVE) {
    const route = createRefundDecisionRoute(deps(DECIDED_AT, gateway));
    return route(
      new Request(`${BASE}/api/academies/${academyId}/refund-requests/${requestId}/decision`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-app-token",
          "content-type": "application/json",
          [TEST_USER_HEADER]: authUserId,
          "Idempotency-Key": "decision-key-0001",
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ academyId, requestId }) },
    );
  }

  const orderTotals = async (orderId: string) =>
    (await q<{ refunded_total_amount: number; status: string }>("SELECT refunded_total_amount, status FROM orders WHERE id = $1", [orderId]))[0]!;
  const requestStatus = async (requestId: string) =>
    (await q<{ status: string; completed: boolean }>("SELECT status, completed_at IS NOT NULL AS completed FROM refund_requests WHERE id = $1", [requestId]))[0]!;
  const events = async (requestId: string) =>
    (await q<{ event_type: string }>(
      "SELECT e.event_type FROM refund_events e JOIN refunds r ON r.id = e.refund_id WHERE r.refund_request_id = $1 ORDER BY e.created_at, e.id",
      [requestId],
    )).map((e) => e.event_type);

  /** 계좌(가상계좌) 결제분 요청을 승인해 송금 대기(pending owner_bank_transfer) 환불 행 하나를 만든다 */
  async function pendingTransfer() {
    const { chain, requestId, accountId } = await regularRequest("virtual_account");
    const owner = await makeOwner(chain.academyId);
    const gateway = new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(DECIDED_AT) });
    expect((await decide(gateway, chain.academyId, requestId, owner.authUserId)).status).toBe(200);
    const [row] = await q<{ id: string }>("SELECT id FROM refunds WHERE refund_request_id = $1", [requestId]);
    return { chain, requestId, accountId, owner, gateway, refundId: row!.id };
  }

  async function post(kind: "complete" | "request-reinput", academyId: string, refundId: string, authUserId: string, body: unknown, at = TRANSFER_AT) {
    const route = kind === "complete" ? createRefundTransferCompleteRoute(deps(at, unusedGateway)) : createRefundTransferReinputRoute(deps(at, unusedGateway));
    return route(
      new Request(`${BASE}/api/academies/${academyId}/refund-transfers/${refundId}/${kind}`, {
        method: "POST",
        headers: { authorization: "Bearer test-app-token", "content-type": "application/json", [TEST_USER_HEADER]: authUserId },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ academyId, refundId }) },
    );
  }

  const transferRow = async (refundId: string) =>
    (await q<Record<string, unknown>>(
      `SELECT status, refunded_amount, failure_code, reinput_reason, transfer_completed_by_staff_account_id,
              to_char(transfer_completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS transfer_completed_at,
              to_char(reinput_requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS reinput_requested_at
         FROM refunds WHERE id = $1`,
      [refundId],
    ))[0]!;
  const notifications = (memberId: string) =>
    q<{ kind: string; dedupe_key: string; payload: Record<string, unknown> }>(
      "SELECT kind, dedupe_key, payload FROM notifications WHERE recipient_member_id = $1 AND kind IN ('refund_completed', 'refund_account_reinput') ORDER BY created_at",
      [memberId],
    );
  const audits = (refundId: string) =>
    q<{ action: string; actor_staff_account_id: string }>("SELECT action, actor_staff_account_id FROM audit_logs WHERE target_table = 'refunds' AND target_id = $1", [refundId]);

  test("① 이름 대조 체크가 없으면 422 NAME_CHECK_REQUIRED — 환불·요청·알림 모두 그대로", async () => {
    const t = await pendingTransfer();
    for (const body of [{}, { nameChecked: false }]) {
      const response = await post("complete", t.chain.academyId, t.refundId, t.owner.authUserId, body);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "NAME_CHECK_REQUIRED" });
    }
    expect(await transferRow(t.refundId)).toMatchObject({ status: "pending", refunded_amount: 0, transfer_completed_at: null });
    expect(await requestStatus(t.requestId)).toEqual({ status: "in_progress", completed: false });
    expect(await notifications(t.chain.memberId)).toHaveLength(0);
  });

  test("② 송금 완료 → succeeded · 송금 완료 기록 1행 · 요청 completed · 알림 refund_completed 1건 · 감사 1행 · 두 번 눌러도 한 번", async () => {
    const t = await pendingTransfer();
    const first = await post("complete", t.chain.academyId, t.refundId, t.owner.authUserId, { nameChecked: true });
    expect(first.status).toBe(200);
    const body = refundTransferCompleteResponseSchema.parse(await first.json());
    expect(body).toEqual({ refundId: t.refundId, status: "succeeded", completedAt: TRANSFER_AT_ISO });

    // 송금 완료 기록 1행 — 언제·누가 눌렀나
    expect(await transferRow(t.refundId)).toMatchObject({
      status: "succeeded",
      refunded_amount: 107200,
      transfer_completed_at: TRANSFER_AT_ISO,
      transfer_completed_by_staff_account_id: t.owner.staffId,
      failure_code: null,
    });
    expect(await q("SELECT 1 FROM refunds WHERE id = $1 AND transfer_completed_at IS NOT NULL", [t.refundId])).toHaveLength(1);
    expect(await requestStatus(t.requestId)).toEqual({ status: "completed", completed: true });
    // 돌려준 금액은 합계에 그대로 남는다(승인 때 올린 값)
    expect(await orderTotals(t.chain.orderId)).toMatchObject({ refunded_total_amount: 107200 });
    expect(await events(t.requestId)).toEqual(["refund_requested", "transfer_completed"]);
    const sent = await notifications(t.chain.memberId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "refund_completed", dedupe_key: `refund:${t.refundId}:completed`, payload: { amount: 107200, requestId: t.requestId } });
    expect(await audits(t.refundId)).toEqual([{ action: "refund.transfer_completed", actor_staff_account_id: t.owner.staffId }]);
    // 플랫폼은 돈을 보내지 않는다 — 포트 호출 0
    expect(t.gateway.refundCalls()).toHaveLength(0);

    // 두 번째 누름(조금 뒤) — 같은 본문, 기록은 늘지 않는다
    const again = await post("complete", t.chain.academyId, t.refundId, t.owner.authUserId, { nameChecked: true }, TRANSFER_AT.add({ minutes: 3 }));
    expect(again.status).toBe(200);
    expect(refundTransferCompleteResponseSchema.parse(await again.json())).toEqual(body);
    expect(await events(t.requestId)).toEqual(["refund_requested", "transfer_completed"]);
    expect(await notifications(t.chain.memberId)).toHaveLength(1);
    expect(await audits(t.refundId)).toHaveLength(1);

    // 끝난 건에 다시 입력 요청은 409
    const late = await post("request-reinput", t.chain.academyId, t.refundId, t.owner.authUserId, { reason: "name_mismatch" });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: "TRANSFER_NOT_PENDING" });
  });

  test("③ 이름 다름 → failed(ACCOUNT_NAME_MISMATCH) · 합계 되돌림 · 요청 처리 중 · 재입력 요청 알림 1건 · 같은 이유 재생 200 · 다른 이유·완료 409", async () => {
    const t = await pendingTransfer();
    const first = await post("request-reinput", t.chain.academyId, t.refundId, t.owner.authUserId, { reason: "name_mismatch" });
    expect(first.status).toBe(200);
    const body = refundTransferReinputResponseSchema.parse(await first.json());
    expect(body).toEqual({ refundId: t.refundId, status: "failed", reason: "name_mismatch", reinputRequestedAt: TRANSFER_AT_ISO });

    expect(await transferRow(t.refundId)).toMatchObject({
      status: "failed",
      refunded_amount: 0,
      failure_code: "ACCOUNT_NAME_MISMATCH",
      reinput_reason: "name_mismatch",
      reinput_requested_at: TRANSFER_AT_ISO,
      transfer_completed_at: null,
    });
    // 이 시도로는 돈이 나가지 않았다 — 승인 때 올린 합계를 되돌린다. 요청은 새 계좌를 기다리며 처리 중
    expect(await orderTotals(t.chain.orderId)).toMatchObject({ refunded_total_amount: 0 });
    expect(await requestStatus(t.requestId)).toEqual({ status: "in_progress", completed: false });
    expect(await events(t.requestId)).toEqual(["refund_requested", "transfer_reinput_requested"]);

    // 재입력 요청 알림 1건 — 앱이 이 요청의 환불 계좌 입력(C9A)으로 이어 간다
    const sent = await notifications(t.chain.memberId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: "refund_account_reinput",
      dedupe_key: `refund:${t.refundId}:reinput`,
      payload: { title: "계좌를 다시 입력해 주세요", reason: "name_mismatch", requestId: t.requestId, amount: 107200 },
    });
    expect(await audits(t.refundId)).toEqual([{ action: "refund.reinput_requested", actor_staff_account_id: t.owner.staffId }]);

    // 같은 이유로 다시 눌러도 200 같은 본문, 알림·감사는 그대로 1건
    const again = await post("request-reinput", t.chain.academyId, t.refundId, t.owner.authUserId, { reason: "name_mismatch" }, TRANSFER_AT.add({ minutes: 1 }));
    expect(again.status).toBe(200);
    expect(refundTransferReinputResponseSchema.parse(await again.json())).toEqual(body);
    expect(await notifications(t.chain.memberId)).toHaveLength(1);
    expect(await audits(t.refundId)).toHaveLength(1);

    // 다른 이유로 다시 닫거나, 닫힌 시도를 송금 완료로 바꾸려 하면 409
    for (const [kind, payload] of [["request-reinput", { reason: "returned" }], ["complete", { nameChecked: true }]] as const) {
      const response = await post(kind, t.chain.academyId, t.refundId, t.owner.authUserId, payload);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "TRANSFER_NOT_PENDING" });
    }
    // 실패한 시도는 「원인당 살아 있는 환불 1건」에서 빠져, 새 계좌가 오면 다음 시도 행을 만들 수 있다(FR-103)
    expect(await q("SELECT 1 FROM refunds WHERE basis_kind = 'request' AND basis_id = $1 AND status <> 'failed'", [t.requestId])).toHaveLength(0);
  });

  test("④ 송금 반송 → failed(TRANSFER_RETURNED) · 알림 문구가 반송을 말한다", async () => {
    const t = await pendingTransfer();
    const response = await post("request-reinput", t.chain.academyId, t.refundId, t.owner.authUserId, { reason: "returned" });
    expect(response.status).toBe(200);
    expect(await transferRow(t.refundId)).toMatchObject({ status: "failed", failure_code: "TRANSFER_RETURNED", reinput_reason: "returned" });
    const [sent] = await notifications(t.chain.memberId);
    expect(sent).toMatchObject({ kind: "refund_account_reinput", payload: { reason: "returned" } });
    expect(String(sent!.payload.message)).toContain("되돌아왔어요");
  });

  test("⑤ 카드분은 409 TRANSFER_NOT_PENDING · 남의 학원 환불은 404 · 다른 학원 대표는 403 · 형식 오류 422", async () => {
    const t = await pendingTransfer();

    // 카드 결제분(PG 가 이미 처리한 환불)은 송금 버튼의 대상이 아니다
    const card = await regularRequest("card");
    const cardOwner = await makeOwner(card.chain.academyId);
    const cardGateway = new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(DECIDED_AT) });
    expect((await decide(cardGateway, card.chain.academyId, card.requestId, cardOwner.authUserId)).status).toBe(200);
    const [cardRefund] = await q<{ id: string }>("SELECT id FROM refunds WHERE refund_request_id = $1", [card.requestId]);
    const notPending = await post("complete", card.chain.academyId, cardRefund!.id, cardOwner.authUserId, { nameChecked: true });
    expect(notPending.status).toBe(409);
    expect(await notPending.json()).toMatchObject({ code: "TRANSFER_NOT_PENDING" });

    // 카드 학원 대표가 자기 학원 경로로 남의 학원 환불을 부르면 없는 건과 같다
    const foreign = await post("complete", card.chain.academyId, t.refundId, cardOwner.authUserId, { nameChecked: true });
    expect(foreign.status).toBe(404);
    // 남의 학원 경로로 부르면 가드가 막는다
    const forbidden = await post("request-reinput", t.chain.academyId, t.refundId, cardOwner.authUserId, { reason: "returned" });
    expect(forbidden.status).toBe(403);
    // 모르는 이유는 형식 오류
    const invalid = await post("request-reinput", t.chain.academyId, t.refundId, t.owner.authUserId, { reason: "other" });
    expect(invalid.status).toBe(422);

    expect(await transferRow(t.refundId)).toMatchObject({ status: "pending" });
    expect(await notifications(t.chain.memberId)).toHaveLength(0);
  });

  test("⑥ DB 방어선 — 계좌분은 송금 완료 기록 없이 succeeded 가 될 수 없다 · 재입력 칸은 실패한 시도에만", async () => {
    const t = await pendingTransfer();
    await expect(q("UPDATE refunds SET status = 'succeeded', refunded_amount = requested_amount WHERE id = $1", [t.refundId])).rejects.toThrow(/ck_refunds_transfer_account/);
    await expect(q("UPDATE refunds SET reinput_requested_at = now(), reinput_reason = 'returned' WHERE id = $1", [t.refundId])).rejects.toThrow(/ck_refunds_reinput/);
  });
});
