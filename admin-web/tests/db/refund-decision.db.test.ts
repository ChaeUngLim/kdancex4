// S4-1.4(대표 환불 입력) — 대표가 환불 요청을 열어 미리 채운 금액을 보고, 금액을 고쳐 승인하거나 근거를 골라 거절하는지
// 실제 PostgreSQL 에서 본다.
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §2-2(상세) · §2-3(decision) · §1-2(오류 코드) · §1-3(같은 결정 재생)
//   (로드맵 verify 의 파일 이름 `tests/db/s4-1-4.db.test.ts` 를 기능 이름 `refund-decision.db.test.ts` 로 바꿨다)
//
// 확인하는 것:
//   ① 상세 200 — 근거 항목 5개(시점 넷 + 안 되는 경우) · 미리 채움 120,600원(180,000원 × 67%) · 환불 상한 · 읽어도 상태 그대로
//   ② 결제액보다 큰 금액 거부 409 REFUND_EXCEEDS_PAID(SC-010(환불 초과 0건)) — 이미 잡힌 환불을 서버가 다시 읽어 뺀다
//   ③ 근거 항목이 없거나 목록 밖이면 거부 422 NOTICE_ITEM_REQUIRED(승인·거절 둘 다) · 금액 빈칸·소수·음수 422 VALIDATION_FAILED
//   ④ 승인 200 — 고친 금액·근거·결정자 기록, 감사 1행, 같은 결정 재생 200, 다른 결정 409 REFUND_ALREADY_DECIDED, 회원 철회 409
//   ⑤ 거절 200(근거 필수) · 0원 승인 · 상한과 같은 금액 승인 · 계좌 결제분 계좌 없음 422 · 이벤트형 거절 409
//   ⑥ 권한·경로 — 다른 학원 대표 403 · 남의 학원 경로로 부르면 404 · 열쇠 없음 400 · 세션 없음 401 · 철회된 요청 409
//   ⑦ 시점이 다 적히지 않은 옛 공지 판본 — 적힌 항목만 근거로 고를 수 있고, 미리 채움은 비운다(500 이 아니다)
// 다른 DB 테스트와 표를 함께 쓰므로 테스트마다 truncateAll 로 비운다(DB 테스트는 flock 으로 하나씩 돈다).
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "../../lib/domain/time";
import { FakePaymentGateway, createFakePaymentGatewayStore } from "../../lib/server/fakes/fake-payment-gateway";
import type { AuthSession, SessionReader } from "../../lib/server/guards";
import { refundDecisionResponseSchema, refundRequestDetailSchema } from "../../lib/server/schemas/refund-decisions";
import { refundRequestCreatedSchema } from "../../lib/server/schemas/refund-requests";
import { createRefundDecisionRoute, createRefundRequestDetailRoute } from "../../lib/server/services/refund-decisions";
import { createRefundRequestRoute, createWithdrawRefundRequestRoute } from "../../lib/server/services/refund-requests";
import { insertCancellationChain, type CancellationChain } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const BASE = "http://localhost";
// 시험용 세션 읽기 — 가드 자체는 staff-guards.db.test.ts 가 시험한다. 헤더의 사용자 id 를 그대로 세션으로 본다.
// 대표는 앱(Bearer)으로 부른다 — 앱은 2단계 인증을 묻지 않는다(계약 §1-1 「웹·앱 같은 경로·같은 판정」)
const TEST_USER_HEADER = "x-test-auth-user";
const fakeSession: SessionReader = async (headers) => {
  const id = headers.get(TEST_USER_HEADER);
  if (id === null) return null;
  const session: AuthSession = { user: { id } };
  return session;
};

// 2026-11-05(목) 14:20 KST 접수
const RECEIVED_AT = Temporal.Instant.from("2026-11-05T05:20:00Z");
const DECIDED_AT = Temporal.Instant.from("2026-11-06T01:00:00Z");

/** 정규 공지 판본 내용 — 시점별 % 넷(W4a). 1/3 전 67% 는 계약 §2-2 예시와 같다 */
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

describe.skipIf(!dbAvailable())("대표 환불 입력(S4-1.4)", () => {
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

  // S4-1.5(수단별 환불 실행)부터 승인이 카드 부분 취소를 부른다 — 테스트마다 따로 만든 가짜 PG 원장을 쓴다
  const deps = (at: Temporal.Instant) => ({
    db: handle.db,
    getSession: fakeSession,
    clock: fixedClock(at),
    paymentGateway: new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(at) }),
  });

  /** 대표 직원 계정 하나를 만들고 그 학원의 대표로 건다. 돌려주는 값은 세션 헤더에 넣을 사용자 id */
  async function makeOwner(academyId: string): Promise<{ authUserId: string; staffId: string }> {
    const staffId = randomUUID();
    const authUserId = `auth-owner-${staffId}`;
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '김대표', 'active', now())", [staffId, authUserId]);
    await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'owner')", [staffId]);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffId]);
    return { authUserId, staffId };
  }

  /**
   * 정규 4회 과정(180,000원) 예약 + 회원의 진짜 환불 요청(S4-1.2 경로). 받은 시각 전에 1회가 끝나 있다
   * → 1/4 진행 = 1/3 전 → 67% → 미리 채움 120,600원 · 회차당 45,000원 · 남은 3회(계약 §2-2 예시와 같은 숫자)
   */
  async function regularRequest(options: { method?: "card" | "virtual_account" } = {}): Promise<{ chain: CancellationChain; requestId: string }> {
    const chain = await insertCancellationChain(handle.pool, { method: options.method ?? "card", amount: 180000 });
    await q("UPDATE classes SET class_kind = 'regular', title = '살사 온투 기초' WHERE id = (SELECT class_id FROM class_offerings WHERE id = $1)", [chain.offeringId]);
    await q("UPDATE orders SET class_kind = 'regular', session_count = 4 WHERE id = $1", [chain.orderId]);
    await q("UPDATE refund_notice_versions SET content = $2::jsonb WHERE id = (SELECT refund_notice_version_id FROM orders WHERE id = $1)", [
      chain.orderId,
      JSON.stringify(REGULAR_NOTICE),
    ]);
    await q("UPDATE members SET nickname = '살사러버' WHERE id = $1", [chain.memberId]);
    // 받은 시각(11-05) 전에 끝난 회차 1개
    await q(
      `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at)
       VALUES (uuidv7(), $1, 0, '2026-11-01T10:00:00Z', '2026-11-01T12:00:00Z')`,
      [chain.offeringId],
    );
    if (options.method === "virtual_account") {
      // 계좌 결제분은 요청 경로가 환불 계좌를 요구한다 — 요청 행만 직접 넣고 계좌는 비워 둔다(⑤ 의 「계좌 없음」 장면)
      const requestId = randomUUID();
      await q(
        `INSERT INTO refund_requests (id, order_id, reservation_id, academy_id, member_id, kind, reason_kind, notice_version_id,
                                      received_at, answer_due_at, idempotency_key)
         SELECT $1, o.id, $2, $3, o.member_id, 'regular', 'personal', o.refund_notice_version_id, $4::timestamptz,
                $4::timestamptz + interval '5 days', 'direct-key-0001'
           FROM orders o WHERE o.id = $5`,
        [requestId, chain.reservationId, chain.academyId, RECEIVED_AT.toString(), chain.orderId],
      );
      return { chain, requestId };
    }
    const create = createRefundRequestRoute(deps(RECEIVED_AT));
    const response = await create(
      new Request(`${BASE}/api/refund-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", [TEST_USER_HEADER]: chain.authUserId, "Idempotency-Key": `key-${randomUUID()}` },
        body: JSON.stringify({
          reservationId: chain.reservationId,
          reasonKind: "schedule_change",
          reasonText: "일정이 바뀌어 더 다닐 수 없어요",
          desiredText: "남은 회차 환불",
        }),
      }),
      undefined,
    );
    expect(response.status).toBe(201);
    return { chain, requestId: refundRequestCreatedSchema.parse(await response.json()).requestId };
  }

  const ctx = (academyId: string, requestId: string) => ({ params: Promise.resolve({ academyId, requestId }) });

  function ownerRequest(path: string, authUserId: string | null, init: { method?: string; body?: unknown; key?: string | null } = {}) {
    const headers: Record<string, string> = { authorization: "Bearer test-app-token", "content-type": "application/json" };
    if (authUserId !== null) headers[TEST_USER_HEADER] = authUserId;
    if (init.key !== null) headers["Idempotency-Key"] = init.key ?? `decision-${randomUUID()}`;
    return new Request(`${BASE}${path}`, {
      method: init.method ?? "POST",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  }

  async function detail(academyId: string, requestId: string, authUserId: string) {
    const route = createRefundRequestDetailRoute(deps(DECIDED_AT));
    return route(ownerRequest(`/api/academies/${academyId}/refund-requests/${requestId}`, authUserId, { method: "GET", key: null }), ctx(academyId, requestId));
  }

  async function decide(academyId: string, requestId: string, authUserId: string | null, body: unknown, key?: string | null) {
    const route = createRefundDecisionRoute(deps(DECIDED_AT));
    return route(
      ownerRequest(`/api/academies/${academyId}/refund-requests/${requestId}/decision`, authUserId, { body, key }),
      ctx(academyId, requestId),
    );
  }

  const requestRow = async (requestId: string) =>
    (
      await q<Record<string, unknown>>(
        `SELECT status, decision_kind, decided_amount, notice_item_code, decision_note, decided_by_staff_account_id,
                decided_at IS NOT NULL AS has_decided_at
           FROM refund_requests WHERE id = $1`,
        [requestId],
      )
    )[0]!;

  const UNDECIDED = { status: "received", decision_kind: null, decided_amount: null, notice_item_code: null };

  test("① 상세 200 — 근거 항목 5개 · 미리 채움 120,600원 · 환불 상한 180,000원 · 읽어도 상태는 그대로", async () => {
    const { chain, requestId } = await regularRequest();
    const owner = await makeOwner(chain.academyId);
    const response = await detail(chain.academyId, requestId, owner.authUserId);
    expect(response.status).toBe(200);
    const body = refundRequestDetailSchema.parse(await response.json());
    expect(body).toMatchObject({
      requestId,
      kind: "regular",
      status: "received",
      member: { nickname: "살사러버" },
      classTitle: "살사 온투 기초 · 4회",
      paidAmount: 180000,
      paymentMethod: "card",
      reason: { kind: "schedule_change", text: "일정이 바뀌어 더 다닐 수 없어요", desired: "남은 회차 환불" },
      assist: {
        sessionsTotal: 4,
        sessionsElapsed: 1,
        remainingSessions: 3,
        perSessionAmount: 45000,
        appliedPoint: "before_one_third",
        appliedPercent: 67,
        suggestedAmount: 120600,
      },
      eventCancel: null,
      maxAmount: 180000,
      refundableAmount: 180000,
      notice: { version: 1, processingBusinessDays: 5 },
      refundAccount: { accountMasked: null },
      decision: null,
    });
    expect(body.noticeItems.map((item) => item.code)).toEqual([
      "tier:before_start",
      "tier:before_one_third",
      "tier:before_half",
      "tier:after_half",
      "no_refund_case",
    ]);
    expect(body.noticeItems[1]).toEqual({ code: "tier:before_one_third", label: "2항 · 총 기간의 1/3 이 지나기 전 · 67%", percent: 67 });
    // 연락처·본명이 응답 어디에도 없다(FR-187(연락처 마스킹)) — 픽스처 회원 이름·전화
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("010-1111-2222");
    expect(raw).not.toContain("취소 시험 회원");
    // 읽기 GET 은 상태를 바꾸지 않는다(계약 열린 점 ④)
    expect(await requestRow(requestId)).toMatchObject(UNDECIDED);
  });

  test("② 결제액보다 큰 금액 거부 409 REFUND_EXCEEDS_PAID — 서버가 결제액·이미 잡힌 환불을 다시 읽는다", async () => {
    const { chain, requestId } = await regularRequest();
    const owner = await makeOwner(chain.academyId);

    const over = await decide(chain.academyId, requestId, owner.authUserId, { decision: "approve", amount: 180001, noticeItemCode: "tier:before_start" });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ code: "REFUND_EXCEEDS_PAID", refundableAmount: 180000 });
    expect(await requestRow(requestId)).toMatchObject(UNDECIDED);

    // 같은 주문에 다른 원인(예: 휴강 환불)으로 100,000원이 이미 돌아갔다 → 남은 상한 80,000원.
    // 화면이 옛 상한(180,000원)을 들고 와도 서버가 다시 계산해 막는다(계약 §2-3 「maxAmount 를 믿지 않는다」)
    await q(
      `INSERT INTO refunds (id, reservation_id, payment_id, idempotency_key, requested_amount, refunded_amount, refund_rate_bp, status, reason, updated_at)
       VALUES (uuidv7(), $1, $2, 'refund:closure_choice:test:1', 100000, 100000, 5556, 'succeeded', 'member_request', now())`,
      [chain.reservationId, chain.paymentId],
    );
    const stale = await decide(chain.academyId, requestId, owner.authUserId, {
      decision: "approve",
      amount: 120600,
      noticeItemCode: "tier:before_one_third",
      maxAmount: 180000,
    });
    // 모르는 칸(maxAmount)은 받지 않는다 — 클라이언트 상한이 끼어들 틈이 없다
    expect(stale.status).toBe(422);
    const overLeft = await decide(chain.academyId, requestId, owner.authUserId, { decision: "approve", amount: 120600, noticeItemCode: "tier:before_one_third" });
    expect(overLeft.status).toBe(409);
    expect(await overLeft.json()).toMatchObject({ code: "REFUND_EXCEEDS_PAID", refundableAmount: 80000 });
    // 상세도 같은 상한을 보여 주고, 미리 채움값도 남은 금액까지만 채운다
    const after = refundRequestDetailSchema.parse(await (await detail(chain.academyId, requestId, owner.authUserId)).json());
    expect(after).toMatchObject({ maxAmount: 180000, refundableAmount: 80000, assist: { suggestedAmount: 80000 } });
    expect(await requestRow(requestId)).toMatchObject(UNDECIDED);
    expect(await q("SELECT 1 FROM audit_logs WHERE target_id = $1 AND action LIKE 'refund_request.%ed' AND action <> 'refund_request.created'", [requestId])).toHaveLength(0);
  });

  test("③ 근거 항목이 없으면 거부 422 NOTICE_ITEM_REQUIRED(승인·거절) · 빈 금액·소수·음수 422 VALIDATION_FAILED", async () => {
    const { chain, requestId } = await regularRequest();
    const owner = await makeOwner(chain.academyId);
    const send = (body: unknown) => decide(chain.academyId, requestId, owner.authUserId, body);

    for (const body of [
      { decision: "approve", amount: 120600 },
      { decision: "approve", amount: 120600, noticeItemCode: "" },
      { decision: "approve", amount: 120600, noticeItemCode: "   " },
      { decision: "approve", amount: 120600, noticeItemCode: "tier:made_up" },
      { decision: "reject", memberMessage: "환불이 어려워요" },
      { decision: "reject", noticeItemCode: null },
      { decision: "reject", noticeItemCode: "window:d9_d7" },
    ]) {
      const response = await send(body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(await response.json()).toMatchObject({ code: "NOTICE_ITEM_REQUIRED" });
    }
    for (const body of [
      { decision: "approve", noticeItemCode: "tier:before_one_third" },
      { decision: "approve", amount: 1200.5, noticeItemCode: "tier:before_one_third" },
      { decision: "approve", amount: -1, noticeItemCode: "tier:before_one_third" },
      { decision: "approve", amount: "120600", noticeItemCode: "tier:before_one_third" },
      { decision: "maybe", noticeItemCode: "tier:before_one_third" },
      { decision: "reject", noticeItemCode: "tier:after_half", memberMessage: "가".repeat(501) },
    ]) {
      const response = await send(body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(await response.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    }
    // 어느 것도 처리로 넘어가지 않았다
    expect(await requestRow(requestId)).toMatchObject(UNDECIDED);
  });

  test("④ 승인 200 — 고친 금액·근거·결정자 기록 · 감사 1행 · 같은 결정 재생 200 · 다른 결정 409 · 회원 철회 409", async () => {
    const { chain, requestId } = await regularRequest();
    const owner = await makeOwner(chain.academyId);
    // 미리 채운 120,600원을 대표가 107,200원으로 고쳐 승인한다
    const body = { decision: "approve", amount: 107200, noticeItemCode: "tier:before_one_third", memberMessage: "이번에는 아쉽지만 다음 수업에서 또 만나요" };
    const first = await decide(chain.academyId, requestId, owner.authUserId, body, "decision-key-0001");
    expect(first.status).toBe(200);
    const outcome = refundDecisionResponseSchema.parse(await first.json());
    // 카드 결제분이라 승인과 함께 PG 부분 취소가 실행돼 요청이 완료된다(S4-1.5 — 실행 자체는 refund-execution.db.test.ts 가 본다)
    expect(outcome).toMatchObject({
      requestId,
      status: "completed",
      decisionKind: "approved",
      decidedAmount: 107200,
      noticeItemCode: "tier:before_one_third",
      refund: { executionKind: "pg_cancel", status: "succeeded", refundedAmount: 107200 },
      orderStatus: "paid",
    });
    expect(await requestRow(requestId)).toEqual({
      status: "completed",
      decision_kind: "approved",
      decided_amount: 107200,
      notice_item_code: "tier:before_one_third",
      decision_note: "이번에는 아쉽지만 다음 수업에서 또 만나요",
      decided_by_staff_account_id: owner.staffId,
      has_decided_at: true,
    });
    const [kept] = await q("SELECT suggested_amount FROM refund_requests WHERE id = $1", [requestId]);
    expect(kept).toEqual({ suggested_amount: 120600 });
    const audits = await q<{ action: string; actor_staff_account_id: string; after: Record<string, unknown> }>(
      "SELECT action, actor_staff_account_id, after FROM audit_logs WHERE target_id = $1 AND action = 'refund_request.approved'",
      [requestId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_staff_account_id: owner.staffId, after: { amount: 107200, noticeItemCode: "tier:before_one_third", refundableAmount: 180000 } });

    // 같은 결정을 다시 보내면(두 번 누름) 200 같은 본문, 기록은 하나
    const replay = await decide(chain.academyId, requestId, owner.authUserId, body, "decision-key-0001");
    expect(replay.status).toBe(200);
    expect(refundDecisionResponseSchema.parse(await replay.json())).toEqual(outcome);
    expect(await q("SELECT 1 FROM audit_logs WHERE target_id = $1 AND action = 'refund_request.approved'", [requestId])).toHaveLength(1);

    // 승인 뒤 거절은 409
    const flip = await decide(chain.academyId, requestId, owner.authUserId, { decision: "reject", noticeItemCode: "tier:after_half" });
    expect(flip.status).toBe(409);
    expect(await flip.json()).toMatchObject({ code: "REFUND_ALREADY_DECIDED" });

    // 승인이 선 뒤에는 회원이 철회할 수 없다(S4-1.2 규칙과 맞물린다)
    const withdraw = createWithdrawRefundRequestRoute(deps(DECIDED_AT));
    const refused = await withdraw(
      new Request(`${BASE}/api/refund-requests/${requestId}/withdraw`, { method: "POST", headers: { [TEST_USER_HEADER]: chain.authUserId } }),
      { params: Promise.resolve({ requestId }) },
    );
    expect(refused.status).toBe(409);

    // 상세에 결정이 보인다. 예약·주문 상태 전이는 아직 없다 — S4-1.7(주문 상태 전이·감사·실패 기록·결과 알림)
    const after = refundRequestDetailSchema.parse(await (await detail(chain.academyId, requestId, owner.authUserId)).json());
    expect(after.decision).toMatchObject({ kind: "approved", amount: 107200, noticeItemCode: "tier:before_one_third" });
    const [state] = await q("SELECT r.status AS reservation, o.status AS ord FROM reservations r JOIN orders o ON o.id = r.order_id WHERE r.id = $1", [chain.reservationId]);
    expect(state).toEqual({ reservation: "confirmed", ord: "paid" });
  });

  test("⑤ 거절(근거 필수) · 0원 승인 · 상한과 같은 금액 승인 · 계좌 결제분 계좌 없음 422 · 이벤트형 거절 409", async () => {
    const a = await regularRequest();
    const owner = await makeOwner(a.chain.academyId);
    const rejected = await decide(a.chain.academyId, a.requestId, owner.authUserId, {
      decision: "reject",
      noticeItemCode: "tier:after_half",
      memberMessage: "총 기간의 1/2 이 지난 뒤라 환불이 어려워요",
    });
    expect(rejected.status).toBe(200);
    expect(refundDecisionResponseSchema.parse(await rejected.json())).toMatchObject({ status: "rejected", decisionKind: "rejected", decidedAmount: null, refund: null });
    expect(await requestRow(a.requestId)).toMatchObject({ status: "rejected", decision_kind: "rejected", decided_amount: null, notice_item_code: "tier:after_half", has_decided_at: true });

    // 0원 승인(「환불이 안 되는 경우」를 근거로) — 0원도 정해진 입력이다
    const b = await regularRequest();
    const ownerB = await makeOwner(b.chain.academyId);
    const zero = await decide(b.chain.academyId, b.requestId, ownerB.authUserId, { decision: "approve", amount: 0, noticeItemCode: "no_refund_case" });
    expect(zero.status).toBe(200);
    expect(await requestRow(b.requestId)).toMatchObject({ decision_kind: "approved", decided_amount: 0, notice_item_code: "no_refund_case" });

    // 상한과 같은 금액(전액 180,000원)은 된다
    const c = await regularRequest();
    const ownerC = await makeOwner(c.chain.academyId);
    const full = await decide(c.chain.academyId, c.requestId, ownerC.authUserId, { decision: "approve", amount: 180000, noticeItemCode: "tier:before_start" });
    expect(full.status).toBe(200);

    // 계좌 결제분인데 환불 계좌가 없으면 승인 불가(거절은 된다)
    const d = await regularRequest({ method: "virtual_account" });
    const ownerD = await makeOwner(d.chain.academyId);
    const noAccount = await decide(d.chain.academyId, d.requestId, ownerD.authUserId, { decision: "approve", amount: 120600, noticeItemCode: "tier:before_one_third" });
    expect(noAccount.status).toBe(422);
    expect(await noAccount.json()).toMatchObject({ code: "REFUND_ACCOUNT_REQUIRED" });
    expect(await requestRow(d.requestId)).toMatchObject(UNDECIDED);

    // 이벤트형은 거절이 없다 — 요청 행을 이벤트형으로 바꿔 본다(이벤트형 접수 경로는 S4-2)
    const e = await regularRequest();
    const ownerE = await makeOwner(e.chain.academyId);
    await q("UPDATE refund_requests SET kind = 'event', suggested_amount = 150000 WHERE id = $1", [e.requestId]);
    const eventReject = await decide(e.chain.academyId, e.requestId, ownerE.authUserId, { decision: "reject", noticeItemCode: "no_refund_case" });
    expect(eventReject.status).toBe(409);
    expect(await eventReject.json()).toMatchObject({ code: "EVENT_REFUND_NOT_REJECTABLE" });
  });

  test("⑥ 권한·경로 — 다른 학원 대표 403 · 남의 학원 경로 404 · 열쇠 없음 400 · 세션 없음 401 · 철회된 요청 409", async () => {
    const { chain, requestId } = await regularRequest();
    const owner = await makeOwner(chain.academyId);
    const other = await insertCancellationChain(handle.pool, { method: "card" });
    const otherOwner = await makeOwner(other.academyId);
    const approve = { decision: "approve", amount: 120600, noticeItemCode: "tier:before_one_third" };

    // 다른 학원 대표가 이 학원 경로로 부르면 403(학원 가드)
    expect((await decide(chain.academyId, requestId, otherOwner.authUserId, approve)).status).toBe(403);
    expect((await detail(chain.academyId, requestId, otherOwner.authUserId)).status).toBe(403);
    // 자기 학원 경로에 남의 요청 id 를 넣으면 없는 요청과 같다(404)
    expect((await decide(other.academyId, requestId, otherOwner.authUserId, approve)).status).toBe(404);
    expect((await detail(other.academyId, requestId, otherOwner.authUserId)).status).toBe(404);
    expect((await detail(chain.academyId, randomUUID(), owner.authUserId)).status).toBe(404);
    expect((await detail(chain.academyId, "not-a-uuid", owner.authUserId)).status).toBe(404);
    // 회원 계정은 직원 경로를 못 쓴다
    expect((await decide(chain.academyId, requestId, chain.authUserId, approve)).status).toBe(403);
    expect((await decide(chain.academyId, requestId, null, approve)).status).toBe(401);
    const noKey = await decide(chain.academyId, requestId, owner.authUserId, approve, null);
    expect(noKey.status).toBe(400);
    expect(await requestRow(requestId)).toMatchObject(UNDECIDED);

    // 회원이 먼저 철회한 요청은 결정할 수 없다
    await q("UPDATE refund_requests SET status = 'withdrawn', withdrawn_at = now() WHERE id = $1", [requestId]);
    const late = await decide(chain.academyId, requestId, owner.authUserId, approve);
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: "REFUND_ALREADY_DECIDED" });
  });

  test("⑦ 옛 공지 판본(시점 1개뿐) — 적힌 항목 + 안 되는 경우만, 미리 채움 없음, 그 항목으로 결정된다", async () => {
    const { chain, requestId } = await regularRequest();
    const owner = await makeOwner(chain.academyId);
    await q("UPDATE refund_notice_versions SET content = $2::jsonb WHERE id = (SELECT refund_notice_version_id FROM orders WHERE id = $1)", [
      chain.orderId,
      JSON.stringify({ tiers: [{ point: "before_start", percent: 100 }], ownerContact: "02-000-0000", nonRefundableCases: "수강 시작 뒤 단순 변심" }),
    ]);
    const response = await detail(chain.academyId, requestId, owner.authUserId);
    expect(response.status).toBe(200);
    const body = refundRequestDetailSchema.parse(await response.json());
    expect(body.noticeItems.map((i) => i.code)).toEqual(["tier:before_start", "no_refund_case"]);
    expect(body).toMatchObject({ assist: null, notice: { version: 1, processingBusinessDays: null } });
    expect((await decide(chain.academyId, requestId, owner.authUserId, { decision: "reject", noticeItemCode: "tier:after_half" })).status).toBe(422);
    const ok = await decide(chain.academyId, requestId, owner.authUserId, { decision: "reject", noticeItemCode: "no_refund_case" });
    expect(ok.status).toBe(200);
  });
});
