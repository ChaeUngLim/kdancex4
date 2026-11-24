// S7-1.5(발송 포트 실구현) — DB 없이 보는 순수 규칙: 푸시 제목·본문 만들기와 발송기 고르기(PUSH_DELIVERY).
import { describe, expect, test } from "vitest";

import { InvalidPushDeliveryError, PushNotificationSender, pushDeliveryOf, pushTextOf } from "../../lib/server/adapters/push-notification-sender";
import { createDeps } from "../../lib/server/deps";
import { FakeNotificationSender } from "../../lib/server/fakes/fake-notification-sender";

const BASE_ENV = { PG_WEBHOOK_SECRET: "x", FAKE_IDENTITY_SECRET: "a", IDENTITY_CI_PEPPER: "b" };

describe("pushTextOf — 휴대폰에 뜰 글(알림함 줄과 같은 규칙)", () => {
  test("결제 확인은 「결제 완료 · 수업명」과 금액", () => {
    expect(pushTextOf("payment_confirmed_member", { title: "살사 입문 4주", amount: 120000 })).toEqual({
      title: "결제 완료 · 살사 입문 4주",
      body: "120,000원",
    });
  });

  test("입금 기한 임박은 기본 제목과 수업·금액", () => {
    expect(pushTextOf("payment_deadline_soon", { offeringTitle: "바차타 초급", amount: 80000 })).toEqual({
      title: "입금 기한이 곧 끝나요",
      body: "바차타 초급 · 80,000원",
    });
  });

  test("그 밖의 종류는 payload 의 title·body, 없으면 기본 문구", () => {
    expect(pushTextOf("session_cancelled", { title: "휴강 안내", body: "11월 28일 수업이 쉬어요" })).toEqual({
      title: "휴강 안내",
      body: "11월 28일 수업이 쉬어요",
    });
    expect(pushTextOf("absence_marked", {})).toEqual({ title: "새 알림", body: "앱에서 자세히 확인해 주세요" });
    // 글자가 아닌 값·빈 글자는 쓰지 않는다
    expect(pushTextOf("class_changed", { title: 3, body: "  " })).toEqual({ title: "새 알림", body: "앱에서 자세히 확인해 주세요" });
  });
});

describe("pushDeliveryOf — 어떤 발송기를 쓸지", () => {
  test("비우면 개발은 fake, 베타·운영은 expo", () => {
    expect(pushDeliveryOf(undefined, "development")).toBe("fake");
    expect(pushDeliveryOf("  ", "development")).toBe("fake");
    expect(pushDeliveryOf(undefined, "beta")).toBe("expo");
    expect(pushDeliveryOf(undefined, "production")).toBe("expo");
  });

  test("값을 주면 그대로, 모르는 값은 오류", () => {
    expect(pushDeliveryOf("expo", "development")).toBe("expo");
    expect(pushDeliveryOf("fake", "beta")).toBe("fake");
    expect(() => pushDeliveryOf("fcm", "beta")).toThrow(InvalidPushDeliveryError);
  });

  test("deps.ts 가 설정대로 구현을 고른다", () => {
    expect(createDeps({ ...BASE_ENV }).notificationSender).toBeInstanceOf(FakeNotificationSender);
    expect(createDeps({ ...BASE_ENV, PUSH_DELIVERY: "expo" }).notificationSender).toBeInstanceOf(PushNotificationSender);
  });
});
