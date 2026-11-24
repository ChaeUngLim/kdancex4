// S0-4.1(주입 지점과 이관 대응표) · T-M3-6 — `lib/server/deps.ts` 단위 테스트
//
// 확인하는 것은 둘이다.
//   ① deps.ts 가 포트 넷 + 시계를 만들어 주고, 비밀값이 빠지면 그 포트만 이름이 박힌 오류를 낸다
//   ② 서비스·라우트 코드가 `fakes/` 를 직접 import 하지 않는다 — 구상 구현을 고르는 곳은 deps.ts 하나다
import "temporal-polyfill/full/global";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { fixedClock } from "../../lib/domain/time";
import { createDeps, getDeps, MissingDepsConfigError, type ServerDeps } from "../../lib/server/deps";
import { FakeNotificationSender } from "../../lib/server/fakes/fake-notification-sender";
import { FakePaymentGateway, createFakePaymentGatewayStore } from "../../lib/server/fakes/fake-payment-gateway";
import { signWebhook } from "../../lib/server/fakes/hmac-webhook-verifier";

const ENV = {
  PG_WEBHOOK_SECRET: "test-pg-webhook-secret-0123456789abcdef",
  FAKE_IDENTITY_SECRET: "test-fake-identity-secret-0123456789abcdef",
  IDENTITY_CI_PEPPER: "test-identity-ci-pepper-fedcba9876543210",
} as const;

const ADMIN_WEB_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** 폴더 아래 .ts·.tsx 파일 경로를 모은다(node_modules·.next 는 건너뛴다) */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("createDeps — 포트 구현 만들기", () => {
  test("포트 넷과 시계를 모두 준다", () => {
    const deps: ServerDeps = createDeps(ENV);
    expect(deps.clock()).toBeInstanceOf(Temporal.Instant);
    expect(typeof deps.paymentGateway.createPayment).toBe("function");
    expect(typeof deps.paymentGateway.refund).toBe("function");
    expect(typeof deps.webhookVerifier.verify).toBe("function");
    expect(typeof deps.identityVerification.verify).toBe("function");
    expect(typeof deps.notificationSender.deliver).toBe("function");
  });

  test("같은 deps 에서 다시 꺼내면 같은 구현이다(가짜 알림 기록이 흩어지지 않는다)", () => {
    const deps = createDeps(ENV);
    expect(deps.paymentGateway).toBe(deps.paymentGateway);
    expect(deps.webhookVerifier).toBe(deps.webhookVerifier);
    expect(deps.identityVerification).toBe(deps.identityVerification);
    expect(deps.notificationSender).toBe(deps.notificationSender);
  });

  test("웹훅 검증기는 PG_WEBHOOK_SECRET 으로 서명한 본문을 통과시킨다", () => {
    const deps = createDeps(ENV);
    const now = Temporal.Instant.from("2026-11-20T01:00:00Z");
    const rawBody = '{"type":"Transaction.Paid"}';
    const headers = new Headers(
      signWebhook({
        secret: ENV.PG_WEBHOOK_SECRET,
        webhookId: "wh_1",
        timestampSeconds: Math.floor(now.epochMilliseconds / 1000),
        rawBody,
      }),
    );
    expect(deps.webhookVerifier.verify(headers, rawBody, now)).toBe(true);
    expect(deps.webhookVerifier.verify(headers, `${rawBody} `, now)).toBe(false);
  });

  test("비밀값이 빠지면 그 포트만 이름이 박힌 오류를 내고, 다른 포트는 그대로 쓴다", () => {
    const deps = createDeps({ PG_WEBHOOK_SECRET: ENV.PG_WEBHOOK_SECRET });
    // 결제·알림은 비밀값이 없어도 만들어진다(지연 생성)
    expect(typeof deps.paymentGateway.getPayment).toBe("function");
    expect(typeof deps.notificationSender.deliver).toBe("function");
    expect(() => deps.identityVerification).toThrow(MissingDepsConfigError);
    expect(() => deps.identityVerification).toThrow(/FAKE_IDENTITY_SECRET/);
  });

  test("빈 문자열 비밀값도 없는 것으로 보고, 오류 문구에 다른 비밀값을 싣지 않는다", () => {
    const deps = createDeps({ ...ENV, PG_WEBHOOK_SECRET: "  " });
    let message = "";
    try {
      void deps.webhookVerifier;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("PG_WEBHOOK_SECRET");
    for (const value of Object.values(ENV)) expect(message).not.toContain(value);
  });

  test("deps 는 얼려 있어 바깥에서 구현을 바꿔 끼울 수 없다", () => {
    const deps = createDeps(ENV);
    expect(Object.isFrozen(deps)).toBe(true);
    expect(() => {
      (deps as { notificationSender: unknown }).notificationSender = null;
    }).toThrow(TypeError);
  });
});

describe("getDeps — 프로세스 하나에 deps 하나", () => {
  test("여러 번 불러도 같은 객체다", () => {
    expect(getDeps()).toBe(getDeps());
  });
});

describe("서비스는 deps 객체를 인자로 받는다", () => {
  // 서비스 함수의 모양 예시: 필요한 포트만 Pick 으로 받는다. 테스트는 getDeps 대신 가짜를 직접 넘긴다
  async function notifyAfterCommit(
    deps: Pick<ServerDeps, "notificationSender">,
    notificationIds: readonly string[],
  ): Promise<void> {
    await deps.notificationSender.deliver(notificationIds);
  }

  test("가짜를 직접 넣어 서비스 함수를 시험할 수 있다", async () => {
    const sender = new FakeNotificationSender();
    await notifyAfterCommit({ notificationSender: sender }, ["n1", "n2"]);
    expect(sender.deliveredIds()).toEqual(["n1", "n2"]);
  });

  test("Pick 한 deps 에 원장을 따로 준 가짜 PG 를 넣어도 된다", async () => {
    const gateway = new FakePaymentGateway({
      store: createFakePaymentGatewayStore(),
      clock: fixedClock(Temporal.Instant.from("2026-11-20T01:00:00Z")),
    });
    const deps: Pick<ServerDeps, "paymentGateway"> = { paymentGateway: gateway };
    const created = await deps.paymentGateway.createPayment({
      gatewayPaymentId: "pay_deps_1",
      method: "virtual_account",
      amount: 30000,
      dueAt: Temporal.Instant.from("2026-11-21T01:00:00Z"),
      orderName: "주입 확인",
    });
    expect(created.status).toBe("ready");
  });
});

describe("구상 구현을 고르는 곳은 deps.ts 하나", () => {
  test("lib·app 아래에서 fakes/ 를 import 하는 파일은 deps.ts 와 fakes/ 자신뿐이다", () => {
    const allowed = new Set(["lib/server/deps.ts"]);
    const offenders = [...sourceFiles(join(ADMIN_WEB_ROOT, "lib")), ...sourceFiles(join(ADMIN_WEB_ROOT, "app"))]
      .map((path) => relative(ADMIN_WEB_ROOT, path).split("\\").join("/"))
      .filter((path) => !allowed.has(path) && !path.startsWith("lib/server/fakes/"))
      .filter((path) =>
        /(?:from|import)\s*\(?\s*["'][^"']*\/fakes\//.test(readFileSync(join(ADMIN_WEB_ROOT, path), "utf8")),
      );
    expect(offenders).toEqual([]);
  });

  test("deps.ts 는 실제로 fakes/ 를 import 한다(검사가 헛돌지 않는지 확인)", () => {
    const source = readFileSync(join(ADMIN_WEB_ROOT, "lib/server/deps.ts"), "utf8");
    expect(/from\s*["']\.\/fakes\//.test(source)).toBe(true);
  });
});
