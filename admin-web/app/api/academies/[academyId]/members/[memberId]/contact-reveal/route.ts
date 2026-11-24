// S3-5.3(연락처 전체 열람) — `POST /api/academies/{academyId}/members/{memberId}/contact-reveal`(계약 18 §5, FR-187 · SC-025).
// 대표가 사유를 적으면 그 회원의 전체 연락처를 돌려주고, 같은 트랜잭션에서 감사 기록 1건을 먼저 남긴다.
// 처리 내용은 lib/server/services/member-contact-reveal.ts 에 있다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createMemberContactRevealRoute } from "@/lib/server/services/member-contact-reveal";

// 부를 때마다 기록이 남는 경로다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createMemberContactRevealRoute(cancellationRouteDeps);
