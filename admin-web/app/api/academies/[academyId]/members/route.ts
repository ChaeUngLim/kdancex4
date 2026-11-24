// S3-5.2(명단 API) — `GET /api/academies/{academyId}/members`(계약 18 §3-1, FR-079(대표 회원 조회)).
// 대표·위임 강사가 관리자 웹(W6·W23)·대표 앱에서 「우리 학원 회원」을 닉네임 순으로 본다. 위임 강사에게는 문의 칸이 없다.
// 처리 내용은 lib/server/services/academy-members.ts 에 있다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createAcademyMembersRoute } from "@/lib/server/services/academy-members";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createAcademyMembersRoute(cancellationRouteDeps);
