// S1-1.13(운영자 심사 목록·상세 API) — `GET /api/admin/merchant-applications`(계약 07 §3).
// 운영자가 제출된 입점 신청 목록을 본다(계좌는 가린 값). 처리 내용은 lib/server/services/admin-merchant-applications.ts 에 있고,
// 이 파일은 앱의 db·세션·암호화 도구(merchantApplicationAppDeps — 계좌를 풀어 가린 값을 만든다)를 이어 줄 뿐이다.
import { merchantApplicationAppDeps } from "@/lib/server/merchant-application-app";
import { createListMerchantApplicationsRoute } from "@/lib/server/services/admin-merchant-applications";

// 요청마다 다른 목록이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createListMerchantApplicationsRoute(merchantApplicationAppDeps());
