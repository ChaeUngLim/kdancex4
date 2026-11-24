// S1-1.24(동의 기록·약관 전문·통지 읽음 API) — `GET /api/terms/versions/{termsVersionId}`(계약 07 §5, FR-249).
// 동의 기록 줄을 누르면 그때 동의한 판본의 전문을 그대로 연다. 권한은 로그인 직원(2단계 인증까지).
// 처리 내용은 lib/server/services/terms-consent-records.ts 에 있다.
import { createTermsVersionRoute } from "@/lib/server/services/terms-consent-records";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const GET = createTermsVersionRoute({ db, getSession: readStaffSession });
