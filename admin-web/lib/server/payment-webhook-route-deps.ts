// 웹훅 처리기(계약 03 §6)에 넘길 재료 — `POST /api/payments/webhook`(S3-3.9) 과 가짜 PG dev 경로(S3-3.14, 계약 03 §7)가 같이 쓴다.
//
// 왜 한 파일로 뺐나: dev 경로는 「서명된 웹훅을 만들어 §6 처리기를 직접 부른다」. 진짜 웹훅 경로와 재료(DB·시계·PG 원장·검증기)가
// 하나라도 다르면 dev 에서 확인한 동작이 운영과 달라진다. route.ts 는 Next.js 가 정한 이름 말고는 내보낼 수 없어서 여기에 둔다.
//
// 재료를 getter 로 넘기는 이유: 웹훅 검증기는 PG_WEBHOOK_SECRET 이 있어야 만들어진다. import 시점에 만들면
// 비밀값 없는 빌드가 실패한다(cancellation-route-deps.ts 와 같은 이유). 가짜 PG 는 주문 생성과 같은 원장(getDeps)을 쓴다.
import { getDeps } from "./deps";
import { createRateLimiter, loadRateLimitRules } from "./rate-limit";
import type { PaymentWebhookDeps } from "./services/payment-webhook";
import { db } from "../../prisma/db";

// S3-3.13 — 서명 실패만 센다(10분 20회, RATE_LIMIT_WEBHOOK_SIGNATURE_FAILURE_* 환경 변수). 서명이 맞는 통지는 막지 않는다
const signatureFailureLimit = {
  limiter: createRateLimiter(),
  get rule() {
    return loadRateLimitRules().webhookSignatureFailure;
  },
};

export const paymentWebhookRouteDeps: PaymentWebhookDeps = {
  db,
  get clock() {
    return getDeps().clock;
  },
  get paymentGateway() {
    return getDeps().paymentGateway;
  },
  get webhookVerifier() {
    return getDeps().webhookVerifier;
  },
  signatureFailureLimit,
};
