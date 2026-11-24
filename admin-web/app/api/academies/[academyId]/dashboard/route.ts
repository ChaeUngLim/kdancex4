// S1-4.5(대시보드 API) — `GET /api/academies/{academyId}/dashboard?date=YYYY-MM-DD`(계약 10 §1, FR-079b).
// 대표가 관리자 웹 첫 화면(W29)에서 할 일과 타일을 본다. 준비 안 된 타일은 available:false 로 내린다.
// 처리 내용은 lib/server/services/owner-dashboard.ts 에 있고, 이 파일은 앱의 db·세션·시계·PG 포트를 이어 줄 뿐이다.
// S3-5.6 부터 읽기 전에 기한 지난 결제 대기를 닫아서, 주문 목록과 같은 cancellationRouteDeps(같은 가짜 PG 원장)를 쓴다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createOwnerDashboardRoute } from "@/lib/server/services/owner-dashboard";

// 요청마다 다른 학원·다른 세션·다른 시각이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createOwnerDashboardRoute(cancellationRouteDeps);
