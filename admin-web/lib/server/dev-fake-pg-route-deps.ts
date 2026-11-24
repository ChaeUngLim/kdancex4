// S3-3.14(가짜 PG dev 경로) — 두 dev 경로(입금·재전송, 계약 03 §7)에 넘길 재료. route.ts 는 Next.js 가 정한 이름 말고는
// 내보낼 수 없어서 여기에 둔다. 재전송 기록은 globalThis 하나라(services/dev-fake-pg.ts) 두 경로가 따로 처리기를 만들어도 같은 기록을 본다.
import { getDevFakePaymentGateway, getDevWebhookSigner, getDeps } from "./deps";
import { paymentWebhookRouteDeps } from "./payment-webhook-route-deps";
import type { DevFakePgDeps } from "./services/dev-fake-pg";
import { processPaymentWebhook } from "./services/payment-webhook";

export const devFakePgRouteDeps: DevFakePgDeps = {
  gateway: () => getDevFakePaymentGateway(),
  sign: (input) => getDevWebhookSigner()(input),
  // 서명 시각과 웹훅 처리기의 「지금」이 같은 시계를 봐야 허용 오차 판정이 어긋나지 않는다
  clock: () => getDeps().clock(),
  // 진짜 웹훅 경로와 같은 재료 — 서명 검증·중복 판정·금액 대조가 운영과 똑같이 돈다
  processWebhook: (input) => processPaymentWebhook(paymentWebhookRouteDeps, input),
};
