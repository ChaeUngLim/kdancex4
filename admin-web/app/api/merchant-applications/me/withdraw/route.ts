// S1-1.12(입점 신청 철회 API) — `POST /api/merchant-applications/me/withdraw`(계약 07 §2, draft·submitted 만 → withdrawn).
// 처리 내용은 lib/server/services/merchant-application-withdraw.ts 에 있고, 이 파일은 앱의 db·세션·암호화 도구를 이어 줄 뿐이다.
// 본문 검사(zod withdrawRequestSchema — 빈 본문이나 {} 만)도 그 파일에서 한다.
import { merchantApplicationAppDeps } from "@/lib/server/merchant-application-app";
import { createWithdrawApplicationRoute } from "@/lib/server/services/merchant-application-withdraw";

// 요청마다 다른 사람이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createWithdrawApplicationRoute(merchantApplicationAppDeps());
