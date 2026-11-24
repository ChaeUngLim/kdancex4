// S7-2.2(문의 생성과 조회 권한) — `GET /api/inquiries/{inquiryId}`(문의 하나와 대화, 계약 15 §2-2). 문의자만 연다(남의 문의 403).
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createInquiryRoutes } from "@/lib/server/services/inquiries";

export const dynamic = "force-dynamic";

export const GET = createInquiryRoutes(memberProfileAppDeps).readOne;
