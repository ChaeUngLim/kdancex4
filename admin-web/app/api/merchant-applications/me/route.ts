// S1-1.10(입점 신청 초안 저장·조회 API) — `GET /api/merchant-applications/me`(계약 07 §2).
// 처리 내용은 lib/server/services/merchant-application-draft.ts 에 있고, 이 파일은 앱의 db·세션·암호화 도구를 이어 줄 뿐이다.
import { merchantApplicationAppDeps } from "@/lib/server/merchant-application-app";
import { createGetMyApplicationRoute } from "@/lib/server/services/merchant-application-draft";

// 요청마다 다른 사람이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createGetMyApplicationRoute(merchantApplicationAppDeps());
