// S3-5.6(대시보드 결제 타일·강사 집계) — `GET /api/instructor/dashboard?from=&to=&academyId=`(계약 18 §9, FR-064(강사 대시보드 집계)).
// 강사 홈(I1)이 내 수업마다 신청 인원·남은 자리·취소 인원을 요일별·학원별로 본다. 처리는 lib/server/services/instructor-dashboard.ts.
// 읽기 전에 기한 지난 결제 대기를 닫아서 주문 목록과 같은 cancellationRouteDeps(같은 가짜 PG 원장)를 쓴다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createInstructorDashboardRoute } from "@/lib/server/services/instructor-dashboard";

// 요청마다 다른 강사·다른 시각이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createInstructorDashboardRoute(cancellationRouteDeps);
