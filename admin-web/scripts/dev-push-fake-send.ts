// S7-1.1(SP-4 푸시 경로 조사) — 가짜 Expo 푸시 서버로 푸시 1건을 보내 보고 서버가 받은 요청을 출력한다.
//   진짜 exp.host·DB 에는 닿지 않는다. 내 PC 127.0.0.1 빈 포트에 가짜 서버를 띄웠다가 끝나면 내린다.
//   토큰은 시연용 가짜 값이고, 출력에는 앞 6자만 남긴다(push-tokens.ts 의 maskPushToken).
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-push-fake-send.ts
import { createExpoPushGateway } from "../lib/server/adapters/expo-push-gateway";
import { FakeExpoPushServer } from "../lib/server/fakes/fake-expo-push-server";
import { maskPushToken } from "../lib/server/services/push-tokens";

const DEMO_TOKEN = "ExponentPushToken[demo-doyun-galaxy-s24]";

const server = new FakeExpoPushServer();
const endpoint = await server.start();
try {
  // 재시도도 같이 보이도록 첫 요청에는 503 을 한 번 준다 — 발송기가 0.2초 기다렸다 다시 보내 ok 가 나야 한다
  server.failNext(1, 503);
  const gateway = createExpoPushGateway({ endpoint, baseDelayMs: 200 });
  const outcomes = await gateway.send([
    { to: DEMO_TOKEN, title: "결제가 확인됐어요", body: "토요 살사 입문 4회 · 12월 6일 시작", data: { screen: "/my/orders" } },
  ]);

  const mask = (value: unknown): unknown => JSON.parse(JSON.stringify(value).split(DEMO_TOKEN).join(maskPushToken(DEMO_TOKEN)));
  console.log(`가짜 서버 주소: ${endpoint}`);
  server.requests.forEach((r, i) => {
    console.log(`요청 ${i + 1}: ${r.method} ${r.path} → HTTP ${r.status}`);
    console.log(`  머리글: content-type=${r.headers["content-type"]} accept=${r.headers["accept"]} accept-encoding=${r.headers["accept-encoding"]}`);
    console.log(`  본문: ${JSON.stringify(mask(r.body))}`);
  });
  console.log(`결과: ${JSON.stringify(mask(outcomes))}`);

  const sent = outcomes.filter((o) => o.status === "ok").length;
  console.log(`발송 ${sent}건 접수(ok) · 받은 요청 ${server.requests.length}건(503 1회 뒤 재시도)`);
  if (sent !== 1) process.exitCode = 1;
} finally {
  await server.stop();
}
