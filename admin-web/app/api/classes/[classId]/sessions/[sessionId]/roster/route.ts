// S3-5.2(명단 API) — `GET /api/classes/{classId}/sessions/{sessionId}/roster`(계약 18 §4, 보드 W6 · W23 · I23).
// 대표 · 위임 강사 · 담당 강사가 그 회차의 결제 완료 수강생(닉네임·연령대·가린 연락처)과 결제 대기 인원 수를 본다.
// 결제 대기는 숫자만 — 이름이 응답에 없다(Q20). 처리 내용은 lib/server/services/session-roster.ts.
// 재료(db·세션·시계·PG 포트)는 주문 목록과 같은 cancellationRouteDeps — 기한 지난 결제 대기를 닫을 때 같은 PG 를 봐야 해서다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createSessionRosterRoute } from "@/lib/server/services/session-roster";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createSessionRosterRoute(cancellationRouteDeps);
