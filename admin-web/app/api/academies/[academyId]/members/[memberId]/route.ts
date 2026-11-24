// S3-5.2(명단 API) — `GET /api/academies/{academyId}/members/{memberId}`(계약 18 §3-2, FR-079(대표 회원 조회)).
// 한 회원의 수강 이력과 결석 예정 이력을 펼친다. 연락처는 가린 값만(전체는 S3-5.3(연락처 전체 열람)).
// 처리 내용은 lib/server/services/academy-members.ts 에 있다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createAcademyMemberDetailRoute } from "@/lib/server/services/academy-members";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createAcademyMemberDetailRoute(cancellationRouteDeps);
