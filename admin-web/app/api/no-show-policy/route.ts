// S1-3.8(노쇼 기준 조회 API) — `GET /api/no-show-policy`(계약 09 §2, 보드 W8B).
// 처리 내용(직원 확인·2단계 인증·기준 한 벌)은 lib/server/services/no-show-policy.ts 에 있고,
// 이 파일은 앱의 db·로그인 인스턴스를 이어 줄 뿐이다.
import { createNoShowPolicyRoute } from "@/lib/server/services/no-show-policy";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 로그인 여부를 매 요청 확인해야 한다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createNoShowPolicyRoute({ db, getSession: readStaffSession });
