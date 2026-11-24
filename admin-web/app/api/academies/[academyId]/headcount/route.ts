// S3-5.9c(대표 앱 현장 등록·주문 화면) — `GET /api/academies/{academyId}/headcount?date=`(계약 18 §7 대표 경로).
// 대표 앱 홈(O6)의 「오늘 우리 학원 수업」 표와 현장 등록(O40)의 회차 목록이 이 하루 인원표를 읽는다.
// 처리는 lib/server/services/owner-headcount.ts. 읽기 전에 기한 지난 결제 대기를 닫아서 주문 목록과 같은 deps(가짜 PG 원장 포함)를 쓴다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createOwnerHeadcountRoute } from "@/lib/server/services/owner-headcount";

// 요청마다 다른 학원·다른 날짜다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createOwnerHeadcountRoute(cancellationRouteDeps);
