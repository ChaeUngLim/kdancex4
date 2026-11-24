// S7-1.5(발송 포트 실구현) — 커밋 뒤 NotificationSenderPort 가 실제 푸시를 보낸다(계약 15 §1-4 · §1-5 수용 ②).
//   푸시 서비스는 가짜 Expo 서버(fakes/fake-expo-push-server.ts)에 진짜 HTTP 로 붙는다 — 실제 exp.host 는 부르지 않는다.
//   ① 수용 ②: 권한 거절 기기만 있는 회원 → 알림함 행은 남고 skipped, 발송 시도 0
//   ② 권한 허용 기기 → 그 토큰으로 1건 보내고 sent. 제목·본문·data(notificationId·kind)
//   ③ 거절 기기 + 허용 기기 → 허용 기기에만 보낸다
//   ④ 토큰이 아예 없음·닫힌 토큰뿐 → skipped, 시도 0
//   ⑤ 같은 id 로 두 번 불러도 한 번만 보낸다(선점) · 이미 skipped 인 행도 다시 보지 않는다
//   ⑥ 등록 안 된 기기(DeviceNotRegistered) → 토큰 닫힘 · 받을 기기가 없으니 skipped
//   ⑦ 푸시 서비스가 계속 503 → retry_wait(1분 뒤 다시) — S7-1.6(발송 재시도 작업)이 pending 되돌리기를 바꿨다
//   ⑧ 직원(강사) 알림도 직원 토큰으로 간다 · 빈 목록·모양 틀린 id 는 아무 일 없음
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { systemClock } from "@/lib/domain/time";
import { createExpoPushGateway } from "@/lib/server/adapters/expo-push-gateway";
import { PushNotificationSender } from "@/lib/server/adapters/push-notification-sender";
import { FakeExpoPushServer } from "@/lib/server/fakes/fake-expo-push-server";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const GRANTED = "ExponentPushToken[doyun-galaxy-s24-granted]";
const DENIED = "ExponentPushToken[doyun-galaxy-tab-denied]";

describe.skipIf(!dbAvailable())("푸시 알림 발송기(NotificationSenderPort 실구현, S7-1.5)", () => {
  let handle: TestDb;
  let server: FakeExpoPushServer;
  let endpoint: string;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const sender = () =>
    new PushNotificationSender({
      db: handle.db,
      clock: systemClock,
      // 기다리기는 0초 — 503 재시도 시험이 빨리 끝나게
      pushGateway: createExpoPushGateway({ endpoint, sleep: async () => {}, maxAttempts: 3 }),
    });

  async function member(name = "이도윤"): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, $3, 'male', '1995-03-14', $4, $5, $6, now(), now())`,
      [id, `user-${randomUUID()}`, name, `010${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, `ci-${randomUUID()}`, `n${id.slice(0, 8)}`],
    );
    return id;
  }

  async function staff(): Promise<string> {
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '강사 서하린', 'active', now())", [
      id,
      `user-${randomUUID()}`,
    ]);
    return id;
  }

  async function token(owner: { memberId?: string; staffId?: string }, value: string, permission: string, deviceId = randomUUID(), revoked = false) {
    await q(
      `INSERT INTO push_tokens (id, member_id, staff_account_id, platform, token, device_id, permission_state, revoked_at)
       VALUES ($1, $2, $3, 'android', $4, $5, $6, CASE WHEN $7::boolean THEN now() END)`,
      [randomUUID(), owner.memberId ?? null, owner.staffId ?? null, value, deviceId, permission, revoked],
    );
  }

  /** 결제 확인 알림 행 — 업무 트랜잭션이 커밋해 둔 상태를 흉내 낸다 */
  async function notification(recipient: { memberId?: string; staffId?: string }, kind = "payment_confirmed_member"): Promise<string> {
    const id = randomUUID();
    const payload =
      kind === "payment_confirmed_member" ? { title: "살사 입문 4주", amount: 120000 } : { title: "수업 승인 요청", body: "바차타 초급 수업을 확인해 주세요" };
    await q(
      `INSERT INTO notifications (id, recipient_member_id, recipient_staff_account_id, kind, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [id, recipient.memberId ?? null, recipient.staffId ?? null, kind, JSON.stringify(payload)],
    );
    return id;
  }

  const statusOf = async (id: string) => (await q("SELECT delivery_status FROM notifications WHERE id = $1", [id])).rows[0]?.delivery_status as string | undefined;
  const sentTokens = () => server.requests.flatMap((request) => (request.body as { to: string }[]).map((message) => message.to));

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
  });

  beforeEach(async () => {
    await truncateAll(handle.pool);
    server = new FakeExpoPushServer();
    endpoint = await server.start();
  });

  afterAll(async () => {
    await server?.stop();
    await truncateAll(handle.pool);
    await closeTestDb(handle);
  });

  test("① 수용 ②: 푸시 권한 거절 기기에는 알림함 행만 있고 발송 시도 0", async () => {
    const memberId = await member();
    await token({ memberId }, DENIED, "denied");
    const id = await notification({ memberId });

    const report = await sender().deliverWithReport([id]);

    expect(report).toEqual({ sent: 0, skipped: 1, failed: 0, leftForDispatch: 0, attempts: 0 });
    expect(server.requests).toHaveLength(0);
    // 알림함 행은 그대로 있다 — 회원은 앱 알림함에서 본다
    const inbox = await q("SELECT id, delivery_status FROM notifications WHERE recipient_member_id = $1", [memberId]);
    expect(inbox.rows).toEqual([{ id, delivery_status: "skipped" }]);
    await server.stop();
  });

  test("② 권한 허용 기기 → 실제 HTTP 로 1건 보내고 sent", async () => {
    const memberId = await member();
    await token({ memberId }, GRANTED, "granted");
    const id = await notification({ memberId });

    const report = await sender().deliverWithReport([id]);

    expect(report).toMatchObject({ sent: 1, skipped: 0, failed: 0, attempts: 1 });
    expect(await statusOf(id)).toBe("sent");
    expect(server.requests).toHaveLength(1);
    const [message] = server.requests[0]!.body as Record<string, unknown>[];
    expect(message).toMatchObject({
      to: GRANTED,
      title: "결제 완료 · 살사 입문 4주",
      body: "120,000원",
      data: { notificationId: id, kind: "payment_confirmed_member" },
    });
    await server.stop();
  });

  test("③ 거절 기기와 허용 기기가 함께 있으면 허용 기기에만 보낸다", async () => {
    const memberId = await member();
    await token({ memberId }, DENIED, "denied");
    await token({ memberId }, GRANTED, "granted");
    const id = await notification({ memberId });

    await sender().deliver([id]);

    expect(sentTokens()).toEqual([GRANTED]);
    expect(await statusOf(id)).toBe("sent");
    await server.stop();
  });

  test("④ 토큰이 없거나 닫힌 토큰·권한 모름뿐이면 skipped, 시도 0", async () => {
    const none = await member("한지우");
    const closed = await member("서하린");
    await token({ memberId: closed }, "ExponentPushToken[closed]", "granted", randomUUID(), true);
    await token({ memberId: closed }, "ExponentPushToken[unknown]", "unknown");
    const a = await notification({ memberId: none });
    const b = await notification({ memberId: closed });

    const report = await sender().deliverWithReport([a, b]);

    expect(report).toMatchObject({ skipped: 2, attempts: 0 });
    expect(server.requests).toHaveLength(0);
    expect([await statusOf(a), await statusOf(b)]).toEqual(["skipped", "skipped"]);
    await server.stop();
  });

  test("⑤ 같은 id 를 두 번(동시에) 불러도 한 번만 보낸다", async () => {
    const memberId = await member();
    await token({ memberId }, GRANTED, "granted");
    const id = await notification({ memberId });

    const [first, second] = await Promise.all([sender().deliverWithReport([id]), sender().deliverWithReport([id])]);
    const third = await sender().deliverWithReport([id]);

    expect(first.sent + second.sent).toBe(1);
    expect(third).toMatchObject({ sent: 0, skipped: 0, attempts: 0 });
    expect(sentTokens()).toEqual([GRANTED]);
    await server.stop();
  });

  test("⑥ 등록 안 된 기기 → 토큰을 닫고 skipped", async () => {
    const memberId = await member();
    await token({ memberId }, GRANTED, "granted");
    server.unregister(GRANTED);
    const id = await notification({ memberId });

    const report = await sender().deliverWithReport([id]);

    expect(report).toMatchObject({ sent: 0, skipped: 1, attempts: 1 });
    expect(await statusOf(id)).toBe("skipped");
    const revoked = await q("SELECT revoked_at FROM push_tokens WHERE token = $1", [GRANTED]);
    expect(revoked.rows[0]?.revoked_at).not.toBeNull();
    await server.stop();
  });

  test("⑦ 푸시 서비스가 계속 503 이면 retry_wait 로 두고, 재시도 작업이 다시 보낸다(S7-1.6)", async () => {
    const memberId = await member();
    await token({ memberId }, GRANTED, "granted");
    const id = await notification({ memberId });
    server.failNext(3, 503);

    const report = await sender().deliverWithReport([id]);

    expect(report).toMatchObject({ sent: 0, failed: 1, attempts: 1 });
    expect(server.requests).toHaveLength(3);
    expect(await statusOf(id)).toBe("retry_wait");
    // 같은 id 로 deliver 를 다시 불러도 보내지 않는다 — 다시 보내기는 재시도 작업의 몫이다
    expect(await sender().deliverWithReport([id])).toMatchObject({ sent: 0, attempts: 0 });
    // 기다림이 끝났다고 치고(1분 앞당김) 서비스가 살아난 뒤 재시도 작업이 보낸다
    await q("UPDATE notifications SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [id]);
    expect(await sender().retryDue()).toMatchObject({ retried: 1, sent: 1, failed: 0 });
    expect(await statusOf(id)).toBe("sent");
    await server.stop();
  });

  test("⑧ 직원 알림은 직원 토큰으로 간다 · 빈 목록·모양 틀린 id 는 아무 일 없음", async () => {
    const staffId = await staff();
    await token({ staffId }, "ExponentPushToken[harin-phone]", "granted");
    const id = await notification({ staffId }, "class_submitted");

    expect(await sender().deliverWithReport([])).toMatchObject({ sent: 0, attempts: 0 });
    expect(await sender().deliverWithReport(["not-a-uuid"])).toMatchObject({ sent: 0, attempts: 0 });
    await sender().deliver([id]);

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.body).toMatchObject([
      { to: "ExponentPushToken[harin-phone]", title: "수업 승인 요청", body: "바차타 초급 수업을 확인해 주세요" },
    ]);
    expect(await statusOf(id)).toBe("sent");
    await server.stop();
  });
});
