// S7-2.5(신고 접수·처리) — `POST /api/reports`(신고 접수) · `GET /api/reports`(내 신고와 진행 단계)(계약 15 §2-7, 보드 C11A).
// 처리 내용은 lib/server/services/reports.ts 에 있다. 본문은 그 파일이 쓰는 createReportSchema(zod)로 검사한다.
// 서비스 밖 거래 신고(FR-255)도 같은 경로다 — 사유 값 off_platform_payment.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createReportRoutes } from "@/lib/server/services/reports";

// 사람마다 다른 응답이고 POST 는 DB 에 쓴다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

const routes = createReportRoutes(memberProfileAppDeps);
export const POST = routes.create;
export const GET = routes.listMine;
