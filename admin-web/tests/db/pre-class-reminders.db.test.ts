// S7-1.7(수업 전 알림 작업) — `POST /api/internal/jobs/notifications/pre-class`(계약 15 §1-4 · 수용 ⑤ · FR-140)
//   verify: 두 번 불러도 알림 행 1건 · skip 0
//   이름: verify 의 tests/db/s7-1-7.db.test.ts 는 Task 번호 이름이라 기능 이름(pre-class-reminders)으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 설정이 없는 회원은 1시간 전(기본) — 61분 전엔 없고, 60분 전에 1건. 다시 불러도·동시에 불러도 1건(수용 ⑤).
//      본문 제목·글(KST 시각)·회차, 받는 사람·학원·예약 칸, 주문 칸은 비움. 새로 만든 행만 발송기에 한 번 넘긴다
//   ② 회원이 고른 시점(하루 전·2시간 전·30분 전)대로 — 그 시각 1분 전엔 없고 그 시각에 1건
//   ③ 대상이 아닌 것: 휴강 회차 · 입금 전 주문 · 취소 예약 · 전액 환불 주문 · 결석을 미리 알린 회원 · 이미 시작한 회차
//   ④ 여러 회차 수업 — 같은 주문의 둘째 회차도 제 시각에 따로 1건(주문 유니크에 막히지 않는다)
//   ⑤ 발송이 실패해도 알림 행은 남고 작업은 created 를 돌려준다
//   ⑥ 내부 경로: 토큰 없으면 401(기록 0) · 맞으면 200 { created } · 다시 부르면 0 · 모르는 칸 422
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { PreClassLead } from "@/lib/domain/constants";
import { fixedClock } from "@/lib/domain/time";
import type { NotificationSenderPort } from "@/lib/server/ports/notification-sender";
import { PRE_CLASS_REMINDER_KIND, runPreClassReminders } from "@/lib/server/services/pre-class-reminders";
import { insertCancellationChain, type CancellationChain } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 모든 시각은 수업 시작(START, KST 12월 1일 19:00) 기준으로 잰다
const START = Temporal.Instant.from("2026-12-01T10:00:00Z");

interface ReminderRow {
  recipient_member_id: string;
  academy_id: string;
  reservation_id: string;
  order_id: string | null;
  dedupe_key: string;
  delivery_status: string;
  payload: Record<string, unknown>;
}

/** 넘겨받은 id 를 적어 두는 발송기 — 실패하게 만들 수도 있다 */
class RecordingSender implements NotificationSenderPort {
  readonly calls: string[][] = [];
  fail = false;
  async deliver(ids: readonly string[]): Promise<void> {
    this.calls.push([...ids]);
    if (this.fail) throw new Error("발송 시험 실패");
  }
}

describe.skipIf(!dbAvailable())("수업 전 알림 작업(계약 15 §1-4, S7-1.7)", () => {
  let handle: TestDb;
  let sender: RecordingSender;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const run = (now: Temporal.Instant) => runPreClassReminders({ db: handle.db, clock: fixedClock(now), notificationSender: sender });

  /** 확정 예약 한 사슬 — 회차 시작을 START 로 맞추고, 시점을 고르면 알림 설정 행도 넣는다 */
  async function booking(o: { lead?: PreClassLead; stage?: "paid" | "pending" } = {}): Promise<CancellationChain> {
    const chain = await insertCancellationChain(handle.pool, { stage: o.stage ?? "paid", startsInHours: 240 });
    await q("UPDATE class_sessions SET starts_at = $2::timestamptz, ends_at = $3::timestamptz WHERE id = $1", [
      chain.sessionId,
      START.toString(),
      START.add({ hours: 2 }).toString(),
    ]);
    if (o.lead !== undefined) {
      await q("INSERT INTO notification_settings (member_id, pre_class_lead, updated_at) VALUES ($1, $2, now())", [chain.memberId, o.lead]);
    }
    return chain;
  }

  const reminderRows = async (): Promise<ReminderRow[]> =>
    (
      await q(
        `SELECT recipient_member_id::text, academy_id::text, reservation_id::text, order_id::text, dedupe_key,
                delivery_status::text, payload
           FROM notifications WHERE kind = $1 ORDER BY dedupe_key`,
        [PRE_CLASS_REMINDER_KIND],
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
    sender = new RecordingSender();
  });

  test("① 설정 없는 회원은 1시간 전 1건 — 두 번 불러도·동시에 불러도 1건(수용 ⑤)", async () => {
    const chain = await booking();

    // 61분 전: 아직 아니다
    expect(await run(START.subtract({ minutes: 61 }))).toEqual({ created: 0 });
    expect(await reminderRows()).toHaveLength(0);

    // 정확히 60분 전: 만든다
    expect(await run(START.subtract({ minutes: 60 }))).toEqual({ created: 1 });
    // 5분 뒤 다시(cron 다음 회차) · 동시에 두 번 — 모두 새 행 0
    expect(await run(START.subtract({ minutes: 55 }))).toEqual({ created: 0 });
    const both = await Promise.all([run(START.subtract({ minutes: 50 })), run(START.subtract({ minutes: 50 }))]);
    expect(both.map((r) => r.created)).toEqual([0, 0]);

    const rows = await reminderRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.recipient_member_id).toBe(chain.memberId);
    expect(row?.academy_id).toBe(chain.academyId);
    expect(row?.reservation_id).toBe(chain.reservationId);
    // 여러 회차 수업에서 주문 유니크에 걸리지 않게 주문 칸은 비운다
    expect(row?.order_id).toBeNull();
    expect(row?.dedupe_key).toBe(`preclass:${chain.sessionId}:${chain.memberId}:one_hour`);
    expect(row?.delivery_status).toBe("pending");
    expect(row?.payload).toEqual({
      title: "곧 수업이 시작해요",
      body: "살사 입문 · 12월 1일 19:00 시작",
      classTitle: "살사 입문",
      sessionId: chain.sessionId,
      startsAt: "2026-12-01T10:00:00Z",
      lead: "one_hour",
    });

    // 발송기에는 새로 만든 행 하나만, 한 번만 넘어갔다
    const [only] = (await q("SELECT id::text FROM notifications WHERE kind = $1", [PRE_CLASS_REMINDER_KIND])).rows as { id: string }[];
    expect(sender.calls).toEqual([[only?.id]]);
  });

  test("동시에 처음 불러도 1건", async () => {
    await booking();
    const both = await Promise.all([run(START.subtract({ minutes: 30 })), run(START.subtract({ minutes: 30 }))]);
    expect(both.map((r) => r.created).sort()).toEqual([0, 1]);
    expect(await reminderRows()).toHaveLength(1);
  });

  test.each([
    ["day_before", { hours: 24 }],
    ["two_hours", { hours: 2 }],
    ["thirty_min", { minutes: 30 }],
  ] as const)("② 회원이 고른 시점 %s — 그 시각 1분 전엔 없고 그 시각에 1건", async (lead, before) => {
    const chain = await booking({ lead });
    const remindAt = START.subtract(before);
    expect(await run(remindAt.subtract({ minutes: 1 }))).toEqual({ created: 0 });
    expect(await run(remindAt)).toEqual({ created: 1 });
    expect(await run(remindAt.add({ minutes: 5 }))).toEqual({ created: 0 });
    const rows = await reminderRows();
    expect(rows.map((r) => r.dedupe_key)).toEqual([`preclass:${chain.sessionId}:${chain.memberId}:${lead}`]);
    expect(rows[0]?.payload["lead"]).toBe(lead);
  });

  test("③ 휴강 · 입금 전 · 취소 예약 · 전액 환불 · 결석 예정 · 이미 시작한 회차는 대상이 아니다", async () => {
    const cancelledSession = await booking();
    await q("UPDATE class_sessions SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [cancelledSession.sessionId]);
    await booking({ stage: "pending" });
    const cancelledReservation = await booking();
    await q("UPDATE reservations SET status = 'cancelled', cancel_reason = 'member_request', cancelled_at = now() WHERE id = $1", [
      cancelledReservation.reservationId,
    ]);
    const refunded = await booking();
    await q("UPDATE orders SET status = 'refunded' WHERE id = $1", [refunded.orderId]);
    const absent = await booking();
    await q(
      `INSERT INTO attendance_marks (id, member_id, reservation_id, session_id, marked_by_kind, marked_by_member_id)
       VALUES ($1, $2, $3, $4, 'member', $2)`,
      [randomUUID(), absent.memberId, absent.reservationId, absent.sessionId],
    );
    // 결석을 거둔(cancelled_at 이 찬) 회원은 다시 대상이다
    const changedMind = await booking();
    await q(
      `INSERT INTO attendance_marks (id, member_id, reservation_id, session_id, marked_by_kind, marked_by_member_id, cancelled_at)
       VALUES ($1, $2, $3, $4, 'member', $2, now())`,
      [randomUUID(), changedMind.memberId, changedMind.reservationId, changedMind.sessionId],
    );

    expect(await run(START.subtract({ minutes: 30 }))).toEqual({ created: 1 });
    expect((await reminderRows()).map((r) => r.recipient_member_id)).toEqual([changedMind.memberId]);

    // 수업이 시작한 순간·뒤에 처음 도는 작업은 아무것도 만들지 않는다
    await truncateAll(handle.pool);
    await booking();
    expect(await run(START)).toEqual({ created: 0 });
    expect(await run(START.add({ minutes: 5 }))).toEqual({ created: 0 });
    expect(await reminderRows()).toHaveLength(0);
  });

  test("④ 여러 회차 수업 — 같은 주문의 둘째 회차도 제 시각에 따로 1건", async () => {
    const chain = await booking();
    const secondId = randomUUID();
    const second = START.add({ hours: 7 * 24 });
    await q("INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at) VALUES ($1, $2, 2, $3::timestamptz, $4::timestamptz)", [
      secondId,
      chain.offeringId,
      second.toString(),
      second.add({ hours: 2 }).toString(),
    ]);

    expect(await run(START.subtract({ minutes: 60 }))).toEqual({ created: 1 });
    // 첫 회차 때는 둘째 회차(7일 뒤)를 아직 만들지 않는다
    expect(await reminderRows()).toHaveLength(1);
    expect(await run(second.subtract({ minutes: 60 }))).toEqual({ created: 1 });
    expect((await reminderRows()).map((r) => r.dedupe_key).sort()).toEqual(
      [`preclass:${chain.sessionId}:${chain.memberId}:one_hour`, `preclass:${secondId}:${chain.memberId}:one_hour`].sort(),
    );
  });

  test("⑤ 발송이 실패해도 알림 행은 남고 created 를 돌려준다", async () => {
    await booking();
    sender.fail = true;
    expect(await run(START.subtract({ minutes: 10 }))).toEqual({ created: 1 });
    expect(sender.calls).toHaveLength(1);
    expect(await reminderRows()).toHaveLength(1);
  });

  describe("⑥ 내부 경로 POST /api/internal/jobs/notifications/pre-class", () => {
    const TOKEN = "test-internal-token-pre-class";
    const AS_OF = START.subtract({ minutes: 30 }).toString();
    const call = async (headers: Record<string, string>, body = "{}") => {
      const { POST } = await import("../../app/api/internal/jobs/notifications/pre-class/route");
      return POST(new Request("http://localhost/api/internal/jobs/notifications/pre-class", { method: "POST", headers, body }), undefined);
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
      await booking();
      const response = await call({ "Content-Type": "application/json" }, JSON.stringify({ asOf: AS_OF }));
      expect(response.status).toBe(401);
      expect(await reminderRows()).toHaveLength(0);
    });

    test("토큰이 맞으면 200 { created } — 다시 부르면 0 · 모르는 칸은 422", async () => {
      await booking();
      const headers = { "X-Internal-Token": TOKEN, "Content-Type": "application/json" };

      const response = await call(headers, JSON.stringify({ asOf: AS_OF }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ created: 1 });

      const again = await call(headers, JSON.stringify({ asOf: AS_OF }));
      expect(await again.json()).toEqual({ created: 0 });
      expect(await reminderRows()).toHaveLength(1);

      const unknown = await call(headers, JSON.stringify({ asOf: AS_OF, extra: 1 }));
      expect(unknown.status).toBe(422);
    });
  });
});
