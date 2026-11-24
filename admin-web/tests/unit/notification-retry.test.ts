// S7-1.6(발송 재시도 작업) — 재시도 판정 순수 함수와 deps 연결.
//   시도는 처음 포함 3번, 1번째 실패 뒤 1분 · 2번째 실패 뒤 5분 · 3번째 실패면 failed(계약 15 §1-4 retry · 열린 점 ③)
import { describe, expect, test } from "vitest";

import { decideAfterFailure, MAX_DELIVERY_ATTEMPTS } from "@/lib/domain/notification-retry";
import { PushNotificationSender } from "@/lib/server/adapters/push-notification-sender";
import { createDeps } from "@/lib/server/deps";
import { FakeNotificationRetry } from "@/lib/server/fakes/fake-notification-retry";
import { FakePushGateway } from "@/lib/server/fakes/fake-push-gateway";

const FAILED_AT = Temporal.Instant.from("2026-11-24T12:00:00Z");

describe("decideAfterFailure", () => {
  test("1번째 실패 → 1분 뒤 다시", () => {
    expect(decideAfterFailure(1, FAILED_AT)).toEqual({ kind: "retry", nextAttemptAt: Temporal.Instant.from("2026-11-24T12:01:00Z") });
  });
  test("2번째 실패 → 5분 뒤 다시", () => {
    expect(decideAfterFailure(2, FAILED_AT)).toEqual({ kind: "retry", nextAttemptAt: Temporal.Instant.from("2026-11-24T12:05:00Z") });
  });
  test("3번째 실패(최대) → failed, 그 위도 failed", () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBe(3);
    expect(decideAfterFailure(3, FAILED_AT)).toEqual({ kind: "failed" });
    expect(decideAfterFailure(7, FAILED_AT)).toEqual({ kind: "failed" });
  });
  test("0 이하는 1번째로 본다", () => {
    expect(decideAfterFailure(0, FAILED_AT)).toEqual(decideAfterFailure(1, FAILED_AT));
  });
});

describe("FakePushGateway", () => {
  test("always_fail 은 모든 메시지에 http_503 을 준다 · ok 는 접수표를 준다", async () => {
    const gateway = new FakePushGateway("always_fail");
    const message = { to: "ExponentPushToken[x]", title: "t", body: "b" };
    expect(await gateway.send([message])).toEqual([{ to: message.to, status: "error", code: "http_503", retryable: true }]);
    gateway.setMode("ok");
    expect(await gateway.send([message])).toMatchObject([{ status: "ok" }]);
    expect(gateway.sent).toHaveLength(2);
  });
});

describe("deps.notificationRetry", () => {
  const BASE_ENV = { PG_WEBHOOK_SECRET: "x", FAKE_IDENTITY_SECRET: "a", IDENTITY_CI_PEPPER: "b" };
  test("가짜 발송기면 늘 0건인 가짜 재시도, expo 면 발송기 그 객체", async () => {
    const fake = createDeps({ ...BASE_ENV });
    expect(fake.notificationRetry).toBeInstanceOf(FakeNotificationRetry);
    expect(await fake.notificationRetry.retryDue()).toEqual({ retried: 0, sent: 0, failed: 0 });
    const real = createDeps({ ...BASE_ENV, PUSH_DELIVERY: "expo" });
    expect(real.notificationRetry).toBeInstanceOf(PushNotificationSender);
    expect(real.notificationRetry).toBe(real.notificationSender);
  });
});
