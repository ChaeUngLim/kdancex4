// S3-5.9(앱 강사 명단 화면) — `GET /api/instructor/headcount?date=&academyId=`(계약 18 §7 강사 경로).
// 강사 홈(I1)의 「오늘 수업 인원」과 수업 인원 한눈에(I7)가 하루 인원표(오늘 인원 = 확정 − 결석 예정 + 현장)를 읽는다.
// 처리는 lib/server/services/instructor-headcount.ts. 읽기 전에 기한 지난 결제 대기를 닫아서 강사 집계와 같은 deps(가짜 PG 원장 포함)를 쓴다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createInstructorHeadcountRoute } from "@/lib/server/services/instructor-headcount";

// 요청마다 다른 강사·다른 날짜다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createInstructorHeadcountRoute(cancellationRouteDeps);
