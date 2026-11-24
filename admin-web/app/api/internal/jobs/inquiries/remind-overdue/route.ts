// S7-2.3(답변과 응답 기한 재알림) — `POST /api/internal/jobs/inquiries/remind-overdue`(계약 15 §2-6).
// 시간 작업 실행기(S0-4.4, cron)가 부른다. 헤더 `X-Internal-Token` 이 맞을 때만 열린다(S0-4.3).
//
// 1영업일 안에 첫 답이 없는 문의를 받는 쪽(학원 문의 = 대표, 시스템 문의 = 운영자)에 inquiry_overdue 로 한 번만 다시 알린다.
// 두 번 불러도 두 번째는 0 이다(overdue_reminded_at IS NULL 조건 — 수용 ②).
// 본문 `{ "asOf": "…Z" }` 는 `KDANCE_DEV_ROUTES=true` 일 때만 쓴다(시험용 시계 — 내부 작업 공통 규칙).
// 응답은 200 `{ "reminded": n }`.
import { fixedClock } from "@/lib/domain/time";
import { getDeps } from "@/lib/server/deps";
import { devRoutesEnabled } from "@/lib/server/dev-routes";
import { parseJsonBody } from "@/lib/server/http";
import { withInternalRoute } from "@/lib/server/internal-routes";
import { remindOverdueBodySchema, remindOverdueResultSchema } from "@/lib/server/schemas/inquiries";
import { remindOverdueInquiries } from "@/lib/server/services/inquiry-replies";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = withInternalRoute(async (request) => {
  const body = await parseJsonBody(request, remindOverdueBodySchema);
  const deps = getDeps();
  // 시험용 시계는 dev 경로가 켜진 환경에서만 받는다 — 운영에서 시각을 바깥이 정하게 두지 않는다
  const clock = body.asOf && devRoutesEnabled() ? fixedClock(Temporal.Instant.from(body.asOf)) : deps.clock;
  const result = await remindOverdueInquiries({ db, clock });
  return Response.json(remindOverdueResultSchema.parse(result));
});
