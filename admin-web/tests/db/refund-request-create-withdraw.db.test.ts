// S4-1.2(환불 요청 생성·철회) — 회원이 환불을 요청하고, 대표가 결정하기 전에는 철회하는지 실제 PostgreSQL 에서 본다.
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §2-1 · §1-2 · §1-3 · §8 수용 ④
//   (로드맵 verify 의 파일 이름 `tests/db/s4-1-2.db.test.ts` 를 기능 이름 `refund-request-create-withdraw.db.test.ts` 로 바꿨다)
//
// 확인하는 것:
//   ① 정규 요청 201 — 상태 접수 · 답할 기한 = 접수 + 3영업일(주말·공휴일 건너뜀, 같은 시각) · 감사 1행 · 예약·주문은 그대로
//   ② 같은 열쇠 재생 200(행 하나) · 다른 열쇠라도 처리 전 요청이 있으면 409 REFUND_REQUEST_OPEN(+ requestId) · 동시 2건도 행 하나
//   ③ 막히는 경우 — 남의 예약 403 · 없는 예약 404 · 입금 전 예약 409 · 이벤트형 409 · 열쇠 없음 400 · 형식 오류 422
//   ④ 계좌 결제분 — 환불 계좌가 없거나 남의 계좌면 422 REFUND_ACCOUNT_REQUIRED, 쓰는 계좌면 201(계좌 id 저장) · 카드에 계좌 422
//   ⑤ 철회 — 처리 전(접수·처리 중) 성공, 다시 눌러도 200 · 처리 중(승인 뒤) 거부 409(수용 ④) · 남의 요청 403 · 철회 뒤 새 요청 가능
//   ⑥ 표시 상태 — 기한이 지난 처리 전 요청을 같은 열쇠로 다시 읽으면 displayStatus = pending_overdue
// 다른 DB 테스트와 표를 함께 쓰므로 테스트마다 truncateAll 로 비운다(DB 테스트는 flock 으로 하나씩 돈다).
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "../../lib/domain/time";
import type { SessionReader } from "../../lib/server/guards";
import { refundRequestCreatedSchema, refundRequestWithdrawnSchema } from "../../lib/server/schemas/refund-requests";
import {
  createRefundRequestRoute,
  createWithdrawRefundRequestRoute,
  type RefundRequestDeps,
} from "../../lib/server/services/refund-requests";
import { insertCancellationChain, insertMember, type CancellationChain } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const BASE = "http://localhost";
// 시험용 세션 읽기 — 가드 자체는 staff-guards.db.test.ts 가 시험한다. 헤더의 사용자 id 를 그대로 세션으로 본다
const TEST_USER_HEADER = "x-test-auth-user";
const fakeSession: SessionReader = async (headers) => {
  const id = headers.get(TEST_USER_HEADER);
  return id === null ? null : { user: { id } };
};

// 2026-11-05(목) 14:20 KST 접수. 3영업일 = 11-06(금) · 11-09(월) · 11-10(화)
const RECEIVED_AT = Temporal.Instant.from("2026-11-05T05:20:00Z");

describe.skipIf(!dbAvailable())("환불 요청 생성·철회(S4-1.2)", () => {
  let handle: TestDb;
  let wide: TestDb;
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await handle.pool.query(text, params)).rows as T[];

  beforeAll(() => {
    handle = openTestDb();
    wide = openTestDb({ poolMax: 8 });
  });
  afterAll(async () => {
    await truncateAll(handle.pool);
    await closeTestDb(wide);
    await closeTestDb(handle);
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
  });

  function deps(at: Temporal.Instant = RECEIVED_AT, db: TestDb = handle): RefundRequestDeps {
    return { db: db.db, getSession: fakeSession, clock: fixedClock(at) };
  }

  function post(path: string, authUserId: string | null, body?: unknown, headers: Record<string, string> = {}) {
    return new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authUserId === null ? {} : { [TEST_USER_HEADER]: authUserId }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** 정규 과정 예약 하나 — 픽스처는 원데이(이벤트형)로 만들므로 수업·주문 스냅샷의 구분을 정규로 바꾼다 */
  async function regularChain(options: Parameters<typeof insertCancellationChain>[1] = {}): Promise<CancellationChain> {
    const chain = await insertCancellationChain(handle.pool, { method: "card", amount: 180000, ...options });
    await q("UPDATE classes SET class_kind = 'regular' WHERE id = (SELECT class_id FROM class_offerings WHERE id = $1)", [chain.offeringId]);
    await q("UPDATE orders SET class_kind = 'regular' WHERE id = $1", [chain.orderId]);
    return chain;
  }

  const body = (chain: CancellationChain, extra: Record<string, unknown> = {}) => ({
    reservationId: chain.reservationId,
    reasonKind: "schedule_change",
    reasonText: "일정이 바뀌어 더 다닐 수 없어요",
    desiredText: "남은 회차 환불",
    ...extra,
  });

  async function create(chain: CancellationChain, opts: { key?: string; extra?: Record<string, unknown>; at?: Temporal.Instant; user?: string } = {}) {
    const route = createRefundRequestRoute(deps(opts.at));
    return route(post("/api/refund-requests", opts.user ?? chain.authUserId, body(chain, opts.extra), { "Idempotency-Key": opts.key ?? `key-${randomUUID()}` }), undefined);
  }

  async function withdraw(requestId: string, authUserId: string, at: Temporal.Instant = RECEIVED_AT) {
    const route = createWithdrawRefundRequestRoute(deps(at));
    return route(post(`/api/refund-requests/${requestId}/withdraw`, authUserId), { params: Promise.resolve({ requestId }) });
  }

  const requestCount = async (chain: CancellationChain) =>
    (await q<{ n: number }>("SELECT count(*)::int AS n FROM refund_requests WHERE reservation_id = $1", [chain.reservationId]))[0]!.n;

  test("① 정규 요청 201 — 접수 · 3영업일 기한(공휴일 건너뜀) · 감사 1행 · 예약·주문 그대로", async () => {
    const chain = await regularChain();
    const response = await create(chain);
    expect(response.status).toBe(201);
    const outcome = refundRequestCreatedSchema.parse(await response.json());
    expect(outcome).toMatchObject({
      kind: "regular",
      status: "received",
      displayStatus: "received",
      withdrawable: true,
      receivedAt: "2026-11-05T05:20:00.000Z",
      answerDueAt: "2026-11-10T05:20:00.000Z",
      progress: [{ step: "received", at: "2026-11-05T05:20:00.000Z" }],
    });

    const [row] = await q(
      `SELECT order_id, academy_id, member_id, reason_kind, reason_text, desired_text, refund_account_id,
              notice_version_id = (SELECT refund_notice_version_id FROM orders WHERE id = $2) AS same_notice
         FROM refund_requests WHERE id = $1`,
      [outcome.requestId, chain.orderId],
    );
    expect(row).toMatchObject({
      order_id: chain.orderId,
      academy_id: chain.academyId,
      member_id: chain.memberId,
      reason_kind: "schedule_change",
      reason_text: "일정이 바뀌어 더 다닐 수 없어요",
      desired_text: "남은 회차 환불",
      refund_account_id: null,
      same_notice: true,
    });
    const audits = await q("SELECT actor_kind, actor_member_id, action, after FROM audit_logs WHERE target_id = $1", [outcome.requestId]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_kind: "member", actor_member_id: chain.memberId, action: "refund_request.created" });
    // 요청은 예약을 취소하지 않는다 — 금액과 실행은 대표가 정한다(FR-098)
    const [state] = await q("SELECT r.status AS reservation, o.status AS ord FROM reservations r JOIN orders o ON o.id = r.order_id WHERE r.id = $1", [chain.reservationId]);
    expect(state).toEqual({ reservation: "confirmed", ord: "paid" });

    // 공휴일이 끼면 하루 더 간다: 11-09(월)을 공휴일로 두면 11-06 · 11-10 · 11-11
    await q("UPDATE refund_requests SET status = 'withdrawn', withdrawn_at = now() WHERE id = $1", [outcome.requestId]);
    await q("INSERT INTO holidays (id, date, name, kind, source) VALUES ($1, '2026-11-09', '시험 공휴일', 'temporary_holiday', 'api')", [randomUUID()]);
    const second = refundRequestCreatedSchema.parse(await (await create(chain)).json());
    expect(second.answerDueAt).toBe("2026-11-11T05:20:00.000Z");
  });

  test("② 같은 열쇠 재생 200 · 다른 열쇠 409 REFUND_REQUEST_OPEN · 동시 2건도 행 하나", async () => {
    const chain = await regularChain();
    const first = await create(chain, { key: "same-key-0001" });
    expect(first.status).toBe(201);
    const created = refundRequestCreatedSchema.parse(await first.json());

    const replay = await create(chain, { key: "same-key-0001" });
    expect(replay.status).toBe(200);
    expect(refundRequestCreatedSchema.parse(await replay.json())).toEqual(created);

    const other = await create(chain, { key: "other-key-0002" });
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ code: "REFUND_REQUEST_OPEN", requestId: created.requestId });
    expect(await requestCount(chain)).toBe(1);

    // 다른 예약에 서로 다른 열쇠로 동시에 2건 — 예약 행 잠금 + 부분 유니크로 하나만 만들어진다
    const chain2 = await regularChain();
    const route = createRefundRequestRoute(deps(RECEIVED_AT, wide));
    const send = (key: string) =>
      route(post("/api/refund-requests", chain2.authUserId, body(chain2), { "Idempotency-Key": key }), undefined);
    const statuses = (await Promise.all([send("race-key-0001"), send("race-key-0002")])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(await requestCount(chain2)).toBe(1);
  });

  test("③ 막히는 경우 — 남의 예약 403 · 없는 예약 404 · 입금 전 409 · 이벤트형 409 · 열쇠 없음 400 · 형식 오류 422", async () => {
    const chain = await regularChain();
    const stranger = await insertMember(handle.pool);
    expect((await create(chain, { user: stranger.authUserId })).status).toBe(403);

    const missing = await create({ ...chain, reservationId: randomUUID() });
    expect(missing.status).toBe(404);

    const pending = await regularChain({ stage: "pending" });
    const notPaid = await create(pending);
    expect(notPaid.status).toBe(409);
    expect(await notPaid.json()).toMatchObject({ code: "REFUND_NOT_ALLOWED_STATE" });

    // 이벤트형(픽스처 그대로 원데이)은 S4-2 전까지 받지 않는다
    const eventChain = await insertCancellationChain(handle.pool, { method: "virtual_account" });
    const event = await create(eventChain);
    expect(event.status).toBe(409);
    expect(await event.json()).toMatchObject({ code: "REFUND_NOT_ALLOWED_STATE" });

    const route = createRefundRequestRoute(deps());
    const noKey = await route(post("/api/refund-requests", chain.authUserId, body(chain)), undefined);
    expect(noKey.status).toBe(400);
    const bad = await create(chain, { extra: { reasonKind: "angry", reasonText: "가".repeat(501) } });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    const anonymous = await route(post("/api/refund-requests", null, body(chain), { "Idempotency-Key": "anon-key-0001" }), undefined);
    expect(anonymous.status).toBe(401);
    expect(await requestCount(chain)).toBe(0);
  });

  test("④ 계좌 결제분 — 계좌 없음·남의 계좌 422, 쓰는 계좌 201 · 카드에 계좌 422", async () => {
    const chain = await regularChain({ method: "virtual_account" });
    const none = await create(chain);
    expect(none.status).toBe(422);
    expect(await none.json()).toMatchObject({ code: "REFUND_ACCOUNT_REQUIRED" });

    const insertAccount = async (orderId: string, memberId: string) => {
      const id = randomUUID();
      await q(
        `INSERT INTO refund_accounts (id, order_id, member_id, bank_code, account_number_enc, account_masked, holder_name, holder_matches_identity)
         VALUES ($1, $2, $3, '004', $4, '국민은행 ****-**-7890', '취소 시험 회원', true)`,
        [id, orderId, memberId, Buffer.from("암호화된-바이트")],
      );
      return id;
    };
    // 다른 주문의 계좌는 이 요청에 쓸 수 없다
    const otherChain = await regularChain({ method: "virtual_account" });
    const foreign = await insertAccount(otherChain.orderId, otherChain.memberId);
    const wrong = await create(chain, { extra: { refundAccountId: foreign } });
    expect(wrong.status).toBe(422);
    expect(await wrong.json()).toMatchObject({ code: "REFUND_ACCOUNT_REQUIRED" });

    const mine = await insertAccount(chain.orderId, chain.memberId);
    const ok = await create(chain, { extra: { refundAccountId: mine } });
    expect(ok.status).toBe(201);
    const created = refundRequestCreatedSchema.parse(await ok.json());
    const [row] = await q("SELECT refund_account_id FROM refund_requests WHERE id = $1", [created.requestId]);
    expect(row).toEqual({ refund_account_id: mine });

    const card = await regularChain({ method: "card" });
    const cardWithAccount = await create(card, { extra: { refundAccountId: mine } });
    expect(cardWithAccount.status).toBe(422);
    expect(await cardWithAccount.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  test("⑤ 철회 — 처리 전 성공(다시 눌러도 200) · 처리 중(승인 뒤) 거부 409 · 남의 요청 403 · 철회 뒤 새 요청", async () => {
    const chain = await regularChain();
    const created = refundRequestCreatedSchema.parse(await (await create(chain)).json());

    expect((await withdraw(created.requestId, (await insertMember(handle.pool)).authUserId)).status).toBe(403);
    expect((await withdraw(randomUUID(), chain.authUserId)).status).toBe(404);
    expect((await withdraw("not-a-uuid", chain.authUserId)).status).toBe(404);

    // 처리 전(접수) 철회 성공 — 예약은 그대로
    const done = await withdraw(created.requestId, chain.authUserId);
    expect(done.status).toBe(200);
    expect(refundRequestWithdrawnSchema.parse(await done.json())).toEqual({ status: "withdrawn" });
    const again = await withdraw(created.requestId, chain.authUserId);
    expect(again.status).toBe(200);
    const [row] = await q("SELECT status, withdrawn_at IS NOT NULL AS has_time FROM refund_requests WHERE id = $1", [created.requestId]);
    expect(row).toEqual({ status: "withdrawn", has_time: true });
    const audits = await q<{ action: string }>("SELECT action FROM audit_logs WHERE target_id = $1 ORDER BY occurred_at", [created.requestId]);
    expect(audits.map((a) => a.action)).toEqual(["refund_request.created", "refund_request.withdrawn"]);
    const [reservation] = await q("SELECT status FROM reservations WHERE id = $1", [chain.reservationId]);
    expect(reservation).toEqual({ status: "confirmed" });

    // 철회 뒤에는 같은 예약에 새 요청을 낼 수 있다
    const next = refundRequestCreatedSchema.parse(await (await create(chain)).json());
    expect(next.requestId).not.toBe(created.requestId);

    // 대표가 「처리하기」를 눌러 처리 중(in_progress)이 돼도 결정 전이면 철회된다(열린 점 ③)
    await q("UPDATE refund_requests SET status = 'in_progress', in_progress_at = now() WHERE id = $1", [next.requestId]);
    expect((await withdraw(next.requestId, chain.authUserId)).status).toBe(200);

    // 처리 중 · 승인이 선 뒤(카드 환불 실행 중·계좌 송금 대기)는 철회 거부 — 수용 ④
    const third = refundRequestCreatedSchema.parse(await (await create(chain)).json());
    await q(
      `UPDATE refund_requests SET status = 'in_progress', in_progress_at = now(), decision_kind = 'approved', decided_at = now(),
                                  decided_amount = 120600 WHERE id = $1`,
      [third.requestId],
    );
    const refused = await withdraw(third.requestId, chain.authUserId);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "REFUND_REQUEST_NOT_WITHDRAWABLE" });
    const [kept] = await q("SELECT status FROM refund_requests WHERE id = $1", [third.requestId]);
    expect(kept).toEqual({ status: "in_progress" });

    // 끝난(거절) 요청도 철회 거부
    await q(
      "UPDATE refund_requests SET status = 'rejected', decision_kind = 'rejected', decided_amount = NULL, notice_item_code = 'no_refund_case' WHERE id = $1",
      [third.requestId],
    );
    expect((await withdraw(third.requestId, chain.authUserId)).status).toBe(409);
  });

  test("⑥ 기한이 지난 처리 전 요청은 「처리 대기 중」(pending_overdue)으로 보인다", async () => {
    const chain = await regularChain();
    const created = refundRequestCreatedSchema.parse(await (await create(chain, { key: "overdue-key-01" })).json());
    expect(created.displayStatus).toBe("received");
    // 기한(11-10 14:20 KST) 1분 뒤 같은 열쇠로 다시 읽는다
    const later = await create(chain, { key: "overdue-key-01", at: Temporal.Instant.from("2026-11-10T05:21:00Z") });
    expect(later.status).toBe(200);
    const replayed = refundRequestCreatedSchema.parse(await later.json());
    expect(replayed).toMatchObject({ status: "received", displayStatus: "pending_overdue", withdrawable: true });
  });
});
