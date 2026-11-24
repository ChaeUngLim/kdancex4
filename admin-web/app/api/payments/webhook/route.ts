// S3-3.9(웹훅 확정 일괄 처리) — `POST /api/payments/webhook`(계약 03-checkout-payment.md §6, FR-287(웹훅 확정)).
// 처리 내용은 lib/server/services/payment-webhook.ts. 본문은 그 파일의 paymentWebhookBodySchema(zod)로 검사한다.
// 로그인 없는 경로다 — PG 가 보내는 요청이라 서명(webhook-signature)이 인증을 대신한다.
// 재료(DB·시계·PG·검증기·서명 실패 제한)는 가짜 PG dev 경로와 같이 쓰려고 payment-webhook-route-deps.ts 로 뺐다(S3-3.14).
import { paymentWebhookRouteDeps } from "@/lib/server/payment-webhook-route-deps";
import { createPaymentWebhookRoute } from "@/lib/server/services/payment-webhook";

export const dynamic = "force-dynamic";

export const POST = createPaymentWebhookRoute(paymentWebhookRouteDeps);
