// S7-1.6(발송 재시도 작업) — 발송 실패는 재시도 뒤 실패로 기록된다(계약 15 §1-4 retry · §1-5 수용 ④).
//   계속 실패하는 가짜 발송기(FakePushGateway "always_fail")로 처음 보내기 → 1분 뒤 재시도 → 5분 뒤 재시도를 돌린다.
//   ① 수용 ④: 세 번 연속 실패 → 마지막 retry 뒤 failed + delivery_error_code, 알림함 행은 그대로
//   ② 기다림이 안 끝난 행은 다시 보내지 않는다(1분·5분 경계)
//   ③ 두 번 실패하다 세 번째에 받으면 sent + delivered_at, 오류 코드는 지운다
//   ④ 재시도 작업이 동시에 두 번 돌아도 한 번만 보낸다(선점)
//   ⑤ 기다리는 사이 기기 토큰이 닫히면 시도 없이 skipped
//   ⑥ 발송 중 멈춘 sending 행(10분 넘음)은 실패 1번으로 센다 — 3번째였다면 failed
//   ⑦ 내부 경로 POST /api/internal/jobs/notifications/retry — 토큰 없으면 401, 맞으면 200 { retried, failed }, 모르는 칸 422
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { PushNotificationSender } from "@/lib/server/adapters/push-notification-sender";
import { FakePushGateway } from "@/lib/server/fakes/fake-push-gateway";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const GRANTED = "ExponentPushToken[doyun-galaxy-s24-granted]";
const START = Temporal.Instant.from("2026-11-24T01:00:00Z"); // 10:00 KST

describe.skipIf(!dbAvailable())("발송 재시도 작업(S7-1.6)", () => {
  let handle: TestDb;
  let now: Temporal.Instant;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const at = (minutes: number, seconds = 0) => START.add({ minutes, seconds });

  const senderWith = (gateway: FakePushGateway) => new PushNotificationSender({ db: handle.db, clock: () => now, pushGateway: gateway });

  async function member(): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '이도윤', 'male', '1995-03-14', $3, $4, $5, now(), now())`,
      [id, `user-${randomUUID()}`, `010${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, `ci-${randomUUID()}`, `n${id.slice(0, 8)}`],
    );
    await q(
      `INSERT INTO push_tokens (id, member_id, platform, token, device_id, permission_state) VALUES ($1, $2, 'android', $3, $4, 'granted')`,
      [randomUUID(), id, GRANTED, randomUUID()],
    );
    return id;
  }

  /** 결제 확인 알림 행 — 업무 트랜잭션이 커밋해 둔 상태 */
  async function notification(memberId: string): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO notifications (id, recipient_member_id, kind, payload) VALUES ($1, $2, 'payment_confirmed_member', $3::jsonb)`,
      [id, memberId, JSON.stringify({ title: "살사 입문 4주", amount: 120000 })],
    );
    return id;
  }

  type Row = {
    delivery_status: string;
    attempt_count: number;
    next_attempt_at: Date | null;
    delivery_error_code: string | null;
    delivered_at: Date | null;
  };
  const rowOf = async (id: string): Promise<Row> =>
    (await q("SELECT delivery_status, attempt_count, next_attempt_at, delivery_error_code, delivered_at FROM notifications WHERE id = $1", [id]))
      .rows[0] as Row;
  const iso = (value: Date | null) => (value === null ? null : Temporal.Instant.fromEpochMilliseconds(value.getTime()).toString());

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
  });

  beforeEach(async () => {
    await truncateAll(handle.pool);
    now = START;
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await closeTestDb(handle);
  });

  test("① 수용 ④: 계속 실패하는 발송기 → 세 번 시도 뒤 failed, 알림함 행은 그대로", async () => {
    const gateway = new FakePushGateway("always_fail");
    const sender = senderWith(gateway);
    const memberId = await member();
    const id = await notification(memberId);

    // 처음 보내기(커밋 뒤 deliver) — 실패 1번 → 1분 뒤 다시
    const first = await sender.deliverWithReport([id]);
    expect(first).toMatchObject({ sent: 0, failed: 1, attempts: 1 });
    expect(await rowOf(id)).toMatchObject({ delivery_status: "retry_wait", attempt_count: 1, delivery_error_code: "http_503" });
    expect(iso((await rowOf(id)).next_attempt_at)).toBe(at(1).toString());

    // 1분 뒤 재시도 — 실패 2번 → 5분 뒤 다시
    now = at(1);
    expect(await sender.retryDue()).toEqual({ retried: 1, sent: 0, failed: 0 });
    expect(await rowOf(id)).toMatchObject({ delivery_status: "retry_wait", attempt_count: 2 });
    expect(iso((await rowOf(id)).next_attempt_at)).toBe(at(6).toString());

    // 5분 뒤 마지막 재시도 — 실패 3번 → failed
    now = at(6);
    expect(await sender.retryDue()).toEqual({ retried: 1, sent: 0, failed: 1 });
    const last = await rowOf(id);
    expect(last).toMatchObject({ delivery_status: "failed", attempt_count: 3, delivery_error_code: "http_503", next_attempt_at: null, delivered_at: null });
    expect(gateway.sent).toHaveLength(3);

    // 그 뒤로는 더 보내지 않는다. 알림함 행은 지워지지 않고 회원 쪽에 남아 있다(FR-144)
    now = at(60);
    expect(await sender.retryDue()).toEqual({ retried: 0, sent: 0, failed: 0 });
    expect(gateway.sent).toHaveLength(3);
    const inbox = await q("SELECT id, read_at FROM notifications WHERE recipient_member_id = $1", [memberId]);
    expect(inbox.rows).toEqual([{ id, read_at: null }]);
  });

  test("② 기다림이 안 끝난 행은 다시 보내지 않는다(1분·5분 경계)", async () => {
    const gateway = new FakePushGateway("always_fail");
    const sender = senderWith(gateway);
    const id = await notification(await member());
    await sender.deliver([id]);

    now = at(0, 59);
    expect(await sender.retryDue()).toMatchObject({ retried: 0 });
    now = at(1);
    expect(await sender.retryDue()).toMatchObject({ retried: 1 });
    now = at(5, 59);
    expect(await sender.retryDue()).toMatchObject({ retried: 0 });
    expect(gateway.sent).toHaveLength(2);
    expect((await rowOf(id)).attempt_count).toBe(2);
  });

  test("③ 두 번 실패하다 세 번째에 받으면 sent + delivered_at, 오류 코드는 지운다", async () => {
    const gateway = new FakePushGateway("always_fail");
    const sender = senderWith(gateway);
    const id = await notification(await member());
    await sender.deliver([id]);
    now = at(1);
    await sender.retryDue();

    gateway.setMode("ok");
    now = at(6);
    expect(await sender.retryDue()).toEqual({ retried: 1, sent: 1, failed: 0 });
    const row = await rowOf(id);
    expect(row).toMatchObject({ delivery_status: "sent", attempt_count: 3, delivery_error_code: null, next_attempt_at: null });
    expect(iso(row.delivered_at)).toBe(at(6).toString());
  });

  test("④ 재시도 작업이 동시에 두 번 돌아도 한 번만 보낸다", async () => {
    const gateway = new FakePushGateway("always_fail");
    const id = await notification(await member());
    await senderWith(gateway).deliver([id]);

    gateway.setMode("ok");
    now = at(1);
    const [a, b] = await Promise.all([senderWith(gateway).retryDue(), senderWith(gateway).retryDue()]);
    expect(a.retried + b.retried).toBe(1);
    expect(gateway.sent).toHaveLength(2); // 처음 1 + 재시도 1
    expect((await rowOf(id)).delivery_status).toBe("sent");
  });

  test("⑤ 기다리는 사이 기기 토큰이 닫히면 시도 없이 skipped", async () => {
    const gateway = new FakePushGateway("always_fail");
    const sender = senderWith(gateway);
    const memberId = await member();
    const id = await notification(memberId);
    await sender.deliver([id]);
    await q("UPDATE push_tokens SET revoked_at = now() WHERE member_id = $1", [memberId]);

    now = at(1);
    expect(await sender.retryDue()).toEqual({ retried: 0, sent: 0, failed: 0 });
    expect(gateway.sent).toHaveLength(1);
    expect(await rowOf(id)).toMatchObject({ delivery_status: "skipped", next_attempt_at: null });
  });

  test("⑥ 발송 중 멈춘 sending 행(10분 넘음)은 실패 1번 — 3번째였다면 failed", async () => {
    const gateway = new FakePushGateway("ok");
    const sender = senderWith(gateway);
    const memberId = await member();
    const stuckFirst = await notification(memberId);
    const stuckLast = await notification(memberId);
    const fresh = await notification(memberId);
    // 서버가 발송 도중 꺼져 결과가 안 적힌 상태를 흉내 낸다
    await q("UPDATE notifications SET delivery_status = 'sending', attempt_count = 1, last_attempt_at = $2 WHERE id = $1", [stuckFirst, at(-11).toString()]);
    await q("UPDATE notifications SET delivery_status = 'sending', attempt_count = 3, last_attempt_at = $2 WHERE id = $1", [stuckLast, at(-11).toString()]);
    await q("UPDATE notifications SET delivery_status = 'sending', attempt_count = 1, last_attempt_at = $2 WHERE id = $1", [fresh, at(-9).toString()]);

    expect(await sender.retryDue()).toEqual({ retried: 0, sent: 0, failed: 1 });
    expect(await rowOf(stuckFirst)).toMatchObject({ delivery_status: "retry_wait", delivery_error_code: "sending_timeout" });
    expect(iso((await rowOf(stuckFirst)).next_attempt_at)).toBe(at(1).toString());
    expect(await rowOf(stuckLast)).toMatchObject({ delivery_status: "failed", delivery_error_code: "sending_timeout" });
    // 9분밖에 안 된 행은 아직 발송 중으로 본다
    expect((await rowOf(fresh)).delivery_status).toBe("sending");
    expect(gateway.sent).toHaveLength(0);
  });

  describe("⑦ 내부 경로 POST /api/internal/jobs/notifications/retry", () => {
    const TOKEN = "test-internal-token-notification-retry";
    const call = async (headers: Record<string, string>, body = "{}") => {
      const { POST } = await import("../../app/api/internal/jobs/notifications/retry/route");
      return POST(new Request("http://localhost/api/internal/jobs/notifications/retry", { method: "POST", headers, body }), {});
    };

    beforeAll(() => {
      process.env["INTERNAL_API_TOKEN"] = TOKEN;
    });
    afterAll(() => {
      delete process.env["INTERNAL_API_TOKEN"];
    });

    test("토큰이 없으면 401", async () => {
      expect((await call({})).status).toBe(401);
    });

    test("토큰이 맞으면 200 과 계약 모양 { retried, failed }", async () => {
      const response = await call({ "X-Internal-Token": TOKEN, "Content-Type": "application/json" }, JSON.stringify({ limit: 50 }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["failed", "retried"]);
      expect(typeof body["retried"]).toBe("number");
    });

    test("모르는 칸·범위 밖 limit 은 422", async () => {
      expect((await call({ "X-Internal-Token": TOKEN }, JSON.stringify({ asOf: "2026-11-24T00:00:00Z" }))).status).toBe(422);
      expect((await call({ "X-Internal-Token": TOKEN }, JSON.stringify({ limit: 0 }))).status).toBe(422);
    });
  });
});
