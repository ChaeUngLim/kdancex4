// S1-1.9(입점 필수 동의 판정과 약관 조회) — `GET /api/terms/merchant-onboarding`(계약 07 §2).
// 입점 신청 3단계에 보일 동의 항목 5개와 항목별 현재 판본을 준다.
// 처리 내용은 lib/server/services/merchant-onboarding-terms.ts 에 있고, 이 파일은 앱의 db·로그인 세션을 이어 줄 뿐이다.
import { createMerchantOnboardingTermsRoute } from "@/lib/server/services/merchant-onboarding-terms";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 판본은 시행일이 지나면 바뀌고, 로그인한 직원만 받는다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createMerchantOnboardingTermsRoute({ db, getSession: readStaffSession });
