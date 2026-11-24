// S3-5.4(현장 등록 인원) — `PUT /api/classes/{classId}/sessions/{sessionId}/onsite-headcount`(계약 18 §6, FR-106 · O-07).
// 대표 · 위임 강사 · 담당 강사가 그 회차의 현장 등록 인원을 남·여(또는 단일)로 통째로 바꾼다.
// 바뀌었으면 감사 기록 1건이 남고, 주문·결제·정산 표는 건드리지 않는다. 처리 내용은 lib/server/services/session-onsite-headcount.ts.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createSessionOnsiteHeadcountRoute } from "@/lib/server/services/session-onsite-headcount";

// 부를 때마다 DB 를 바꾸는 경로다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const PUT = createSessionOnsiteHeadcountRoute(cancellationRouteDeps);
