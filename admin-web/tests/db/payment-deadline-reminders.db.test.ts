// S3-4.4(입금 기한 임박 알림 작업) — `POST /api/internal/jobs/payment-deadline-reminders`(계약 04 §10 · FR-114a)
//   verify: 작업을 두 번 불러도 알림 행 1건(플랜 S3-4 수용 ③) · skip 0
//   이름: verify 의 tests/db/s3-4-4.db.test.ts 는 Task 번호 이름이라 기능 이름(payment-deadline-reminders)으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 기한 1시간 전부터 알림 1건(회원·학원·주문, payload 제목·수업 이름·금액·기한, 계좌번호 없음, delivery pending).
//      1시간 1초 전에는 아직 없다. 두 번 부르면 두 번째는 notified 0, 행 1건 그대로(수용 ③) · 동시에 두 번 불러도 1건
//   ② 발급~기한이 1시간보다 짧으면 그 절반이 지난 때부터 보낸다(40분짜리 → 20분째부터)
//   ③ 대상이 아닌 것: 기한이 지난 결제 · 카드 결제 · 이미 입금된 주문 · 셀프 취소된 주문
//   ④ 내부 경로: 토큰 없으면 401(기록 0) · 맞으면 200 { notified } · 다시 부르면 0 · 모르는 칸 422
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { PAYMENT_DEADLINE_SOON_KIND, runPaymentDeadlineReminders } from "@/lib/server/services/payment-deadline-reminders";
import { insertCancellationChain, type CancellationChain } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 모든 시각은 기한(DUE) 기준으로 잰다
const DUE = Temporal.Instant.from("2026-12-01T12:00:00Z");

interface ReminderRow {
  recipient_member_id: string;
  academy_id: string;
  order_id: string;
  delivery_status: string;
  payload: Record<string, unknown>;
}

describe.skipIf(!dbAvailable())("입금 기한 임박 알림 작업(계약 04 §10, S3-4.4)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const run = (now: Temporal.Instant) => runPaymentDeadlineReminders({ db: handle.db, clock: fixedClock(now) });

  /** 입금 전(pending) 주문 한 사슬 — 결제의 발급 시각과 기한을 정해 준다 */
  async function pendingOrder(o: { issuedBefore: { minutes?: number; hours?: number }; method?: "virtual_account" | "card" }): Promise<CancellationChain> {
    const chain = await insertCancellationChain(handle.pool, { stage: "pending", method: o.method ?? "virtual_account", startsInHours: 240 });
    await q("UPDATE payments SET created_at = $2::timestamptz, due_at = $3::timestamptz WHERE id = $1", [
      chain.paymentId,
      DUE.subtract(o.issuedBefore).toString(),
      DUE.toString(),
    ]);
    return chain;
  }

  const reminderRows = async (): Promise<ReminderRow[]> =>
    (
      await q(
        `SELECT recipient_member_id::text, academy_id::text, order_id::text, delivery_status::text, payload
           FROM notifications WHERE kind = $1 ORDER BY order_id`,
        [PAYMENT_DEADLINE_SOON_KIND],
      )
    ).rows as ReminderRow[];

  beforeAll(() => {
    handle = openTestDb({ poolMax: 8 });
  });
  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await closeTestDb(handle);
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
  });

  test("① 기한 1시간 전부터 1건 — 두 번 불러도·동시에 불러도 1건(수용 ③)", async () => {
    const chain = await pendingOrder({ issuedBefore: { hours: 24 } });

    // 1시간 1초 전: 아직 아니다
    expect(await run(DUE.subtract({ minutes: 60, seconds: 1 }))).toEqual({ notified: 0 });
    expect(await reminderRows()).toHaveLength(0);

    // 정확히 1시간 전: 보낸다
    expect(await run(DUE.subtract({ minutes: 60 }))).toEqual({ notified: 1 });
    // 두 번째 호출(10분 뒤 cron)과 동시 두 번 — 모두 새 행 0
    expect(await run(DUE.subtract({ minutes: 50 }))).toEqual({ notified: 0 });
    const both = await Promise.all([run(DUE.subtract({ minutes: 40 })), run(DUE.subtract({ minutes: 40 }))]);
    expect(both.map((r) => r.notified)).toEqual([0, 0]);

    const rows = await reminderRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.recipient_member_id).toBe(chain.memberId);
    expect(row?.academy_id).toBe(chain.academyId);
    expect(row?.order_id).toBe(chain.orderId);
    expect(row?.delivery_status).toBe("pending");
    expect(row?.payload).toEqual({ title: "입금 기한이 곧 끝나요", offeringTitle: "살사 입문", amount: 120000, dueAt: "2026-12-01T12:00:00Z" });
    // 계좌번호·은행·예금주는 본문에 넣지 않는다(계약 04 §2) — 앱은 주문 조회로 계좌를 보여 준다
    expect(JSON.stringify(row?.payload)).not.toMatch(/account|bank|holder/i);
  });

  test("동시에 처음 불러도 1건", async () => {
    await pendingOrder({ issuedBefore: { hours: 24 } });
    const both = await Promise.all([run(DUE.subtract({ minutes: 30 })), run(DUE.subtract({ minutes: 30 }))]);
    expect(both.map((r) => r.notified).sort()).toEqual([0, 1]);
    expect(await reminderRows()).toHaveLength(1);
  });

  test("② 발급~기한이 1시간보다 짧으면 절반이 지난 때부터(40분 → 20분째)", async () => {
    await pendingOrder({ issuedBefore: { minutes: 40 } });
    // 발급 19분째(기한 21분 전): 아직
    expect(await run(DUE.subtract({ minutes: 21 }))).toEqual({ notified: 0 });
    // 발급 20분째(기한 20분 전): 보낸다
    expect(await run(DUE.subtract({ minutes: 20 }))).toEqual({ notified: 1 });
    expect(await reminderRows()).toHaveLength(1);
  });

  test("③ 기한 지남 · 카드 · 입금 완료 · 셀프 취소는 대상이 아니다", async () => {
    await pendingOrder({ issuedBefore: { hours: 24 }, method: "card" });
    const paid = await pendingOrder({ issuedBefore: { hours: 24 } });
    await q("UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1", [paid.orderId]);
    await q("UPDATE payments SET status = 'paid', paid_at = now() WHERE id = $1", [paid.paymentId]);
    const cancelled = await pendingOrder({ issuedBefore: { hours: 24 } });
    await q("UPDATE orders SET status = 'cancelled', closed_at = now() WHERE id = $1", [cancelled.orderId]);
    await q("UPDATE payments SET status = 'cancelled' WHERE id = $1", [cancelled.paymentId]);
    const late = await pendingOrder({ issuedBefore: { hours: 24 } });

    // 기한 30분 전: 카드·입금 완료·셀프 취소 셋은 빠지고, 아직 입금 전인 가상계좌(late)만 나온다
    expect(await run(DUE.subtract({ minutes: 30 }))).toEqual({ notified: 1 });
    expect((await reminderRows()).map((r) => r.order_id)).toEqual([late.orderId]);

    // 기한 순간·지난 뒤 처음 도는 작업은 아무것도 만들지 않는다(만료 정리의 몫)
    await truncateAll(handle.pool);
    await pendingOrder({ issuedBefore: { hours: 24 } });
    expect(await run(DUE)).toEqual({ notified: 0 });
    expect(await run(DUE.add({ minutes: 5 }))).toEqual({ notified: 0 });
    expect(await reminderRows()).toHaveLength(0);
  });

  describe("④ 내부 경로 POST /api/internal/jobs/payment-deadline-reminders", () => {
    const TOKEN = "test-internal-token-payment-deadline";
    const AS_OF = DUE.subtract({ minutes: 30 }).toString();
    const call = async (headers: Record<string, string>, body = "{}") => {
      const { POST } = await import("../../app/api/internal/jobs/payment-deadline-reminders/route");
      return POST(new Request("http://localhost/api/internal/jobs/payment-deadline-reminders", { method: "POST", headers, body }), undefined);
    };
    beforeAll(() => {
      process.env["INTERNAL_API_TOKEN"] = TOKEN;
      process.env["KDANCE_DEV_ROUTES"] = "true";
    });
    afterAll(async () => {
      delete process.env["INTERNAL_API_TOKEN"];
      delete process.env["KDANCE_DEV_ROUTES"];
      // 경로가 쓰는 공용 연결 풀을 닫는다(다른 내부 작업 테스트와 같은 정리)
      const shared = await import("../../prisma/db");
      await shared.pool.end();
    });

    test("토큰이 없으면 401 이고 기록이 생기지 않는다", async () => {
      await pendingOrder({ issuedBefore: { hours: 24 } });
      const response = await call({ "Content-Type": "application/json" }, JSON.stringify({ asOf: AS_OF }));
      expect(response.status).toBe(401);
      expect(await reminderRows()).toHaveLength(0);
    });

    test("토큰이 맞으면 200 { notified } — 다시 부르면 0 · 모르는 칸은 422", async () => {
      await pendingOrder({ issuedBefore: { hours: 24 } });
      const headers = { "X-Internal-Token": TOKEN, "Content-Type": "application/json" };

      const response = await call(headers, JSON.stringify({ asOf: AS_OF }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ notified: 1 });

      const again = await call(headers, JSON.stringify({ asOf: AS_OF }));
      expect(await again.json()).toEqual({ notified: 0 });
      expect(await reminderRows()).toHaveLength(1);

      const unknown = await call(headers, JSON.stringify({ asOf: AS_OF, extra: 1 }));
      expect(unknown.status).toBe(422);
    });
  });
});
