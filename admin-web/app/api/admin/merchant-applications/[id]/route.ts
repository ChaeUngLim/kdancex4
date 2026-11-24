// S1-1.13(운영자 심사 목록·상세 API) — `GET /api/admin/merchant-applications/{id}`(계약 07 §3).
// 운영자가 신청 하나와 증빙 파일 id 를 본다(계좌는 가린 값). 처리 내용은 lib/server/services/admin-merchant-applications.ts 에 있다.
import { merchantApplicationAppDeps } from "@/lib/server/merchant-application-app";
import { createGetMerchantApplicationRoute } from "@/lib/server/services/admin-merchant-applications";

// 요청마다 다른 신청이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createGetMerchantApplicationRoute(merchantApplicationAppDeps());
