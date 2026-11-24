// S7-1.1(SP-4 푸시 경로 조사) — Expo 형식 발송기를 가짜 Expo 서버에 붙여 본다(실제 exp.host 에는 붙지 않는다).
//   ① 요청 본문·머리글이 Expo 문서 모양이다(to·title·body·data·sound·priority·channelId, accept-encoding 등)
//   ② 100건을 넘으면 100건씩 잘라 보낸다
//   ③ 503·429 는 기다렸다 다시 보낸다(지수 백오프 · Retry-After) — 성공하면 ok
//   ④ 끝까지 실패하면 「다시 보낼 수 있는 실패」(retryable) 로 돌려준다 · 400 은 다시 보내지 않는다
//   ⑤ DeviceNotRegistered 접수표는 invalid_token 이 된다(나머지 메시지는 ok)
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createExpoPushGateway, retryDelayMs } from "@/lib/server/adapters/expo-push-gateway";
import { FakeExpoPushServer } from "@/lib/server/fakes/fake-expo-push-server";

const TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const TOKEN_B = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";

describe("Expo 푸시 발송기(가짜 서버)", () => {
  let server: FakeExpoPushServer;
  let endpoint: string;
  let waits: number[];
  const gateway = (maxAttempts = 3) =>
    createExpoPushGateway({
      endpoint,
      maxAttempts,
      sleep: async (ms) => {
        waits = [...waits, ms];
      },
    });

  beforeEach(async () => {
    server = new FakeExpoPushServer();
    endpoint = await server.start();
    waits = [];
  });
  afterEach(async () => {
    await server.stop();
  });

  test("① 본문·머리글이 Expo 푸시 API 모양이다", async () => {
    const out = await gateway().send([
      { to: TOKEN_A, title: "결제가 확인됐어요", body: "토요 살사 입문 4회 · 12월 6일 시작", data: { screen: "/my/orders" } },
    ]);
    expect(out).toEqual([{ to: TOKEN_A, status: "ok", ticketId: expect.any(String) }]);
    const [req] = server.requests;
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe("/--/api/v2/push/send");
    expect(req?.headers["content-type"]).toBe("application/json");
    expect(req?.headers["accept"]).toBe("application/json");
    expect(req?.headers["accept-encoding"]).toBe("gzip, deflate");
    expect(req?.headers["authorization"]).toBeUndefined();
    expect(req?.body).toEqual([
      {
        to: TOKEN_A,
        title: "결제가 확인됐어요",
        body: "토요 살사 입문 4회 · 12월 6일 시작",
        data: { screen: "/my/orders" },
        sound: "default",
        priority: "high",
        channelId: "default",
      },
    ]);
  });

  test("② 250건은 100·100·50 으로 잘라 보내고 결과는 보낸 순서 그대로다", async () => {
    const messages = Array.from({ length: 250 }, (_, i) => ({ to: `ExponentPushToken[t${i}]`, title: "t", body: "b" }));
    const out = await gateway().send(messages);
    expect(server.requests.map((r) => (r.body as unknown[]).length)).toEqual([100, 100, 50]);
    expect(out.map((o) => o.to)).toEqual(messages.map((m) => m.to));
    expect(out.every((o) => o.status === "ok")).toBe(true);
  });

  test("③ 503 두 번 뒤 성공 — 1초·2초 기다려 세 번째에 ok", async () => {
    server.failNext(2, 503);
    const out = await gateway().send([{ to: TOKEN_A, title: "t", body: "b" }]);
    expect(out[0]?.status).toBe("ok");
    expect(server.requests.map((r) => r.status)).toEqual([503, 503, 200]);
    expect(waits).toEqual([1000, 2000]);
  });

  test("③ 429 는 Retry-After(초)만큼 기다린다", async () => {
    server.failNext(1, 429, "7");
    const out = await gateway().send([{ to: TOKEN_A, title: "t", body: "b" }]);
    expect(out[0]?.status).toBe("ok");
    expect(waits).toEqual([7000]);
  });

  test("④ 세 번 모두 503 이면 다시 보낼 수 있는 실패로 돌려준다(더 보내지 않는다)", async () => {
    server.failNext(5, 503);
    const out = await gateway().send([{ to: TOKEN_A, title: "t", body: "b" }]);
    expect(out).toEqual([{ to: TOKEN_A, status: "error", code: "HTTP_503", retryable: true }]);
    expect(server.requests).toHaveLength(3);
  });

  test("④ 400(본문이 틀림)은 다시 보내지 않고 바로 실패", async () => {
    server.failNext(1, 400);
    const out = await gateway().send([{ to: TOKEN_A, title: "t", body: "b" }]);
    expect(out).toEqual([{ to: TOKEN_A, status: "error", code: "SERVER_ERROR", retryable: false }]);
    expect(server.requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  test("④ 서버에 닿지 못하면(네트워크 오류) 재시도 뒤 NETWORK_ERROR", async () => {
    await server.stop();
    const out = await gateway(2).send([{ to: TOKEN_A, title: "t", body: "b" }]);
    expect(out).toEqual([{ to: TOKEN_A, status: "error", code: "NETWORK_ERROR", retryable: true }]);
    expect(waits).toEqual([1000]);
  });

  test("⑤ DeviceNotRegistered 는 invalid_token, 같은 요청의 다른 기기는 ok", async () => {
    server.unregister(TOKEN_B);
    const out = await gateway().send([
      { to: TOKEN_A, title: "t", body: "b" },
      { to: TOKEN_B, title: "t", body: "b" },
    ]);
    expect(out[0]?.status).toBe("ok");
    expect(out[1]).toEqual({ to: TOKEN_B, status: "invalid_token" });
  });

  test("백오프 계산 — 1초·2초·4초, Retry-After 우선, 30초 상한", () => {
    expect([1, 2, 3].map((n) => retryDelayMs(n, null, 1000))).toEqual([1000, 2000, 4000]);
    expect(retryDelayMs(1, "3", 1000)).toBe(3000);
    expect(retryDelayMs(1, "120", 1000)).toBe(30_000);
    expect(retryDelayMs(2, "abc", 1000)).toBe(2000);
  });
});
