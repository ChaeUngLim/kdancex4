// S7-2.10(대표 앱 문의함 화면 O22) — `GET /api/academies/{academyId}/inquiries/{inquiryId}`(대표가 답하기 전에 대화 전체를 읽는다).
// 그 학원의 active 대표만 연다. 다른 학원 문의·시스템 문의는 403, 없는 문의 404. 처리 내용은 lib/server/services/inquiries.ts.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createInquiryRoutes } from "@/lib/server/services/inquiries";

export const dynamic = "force-dynamic";

export const GET = createInquiryRoutes(memberProfileAppDeps).ownerReadOne;
