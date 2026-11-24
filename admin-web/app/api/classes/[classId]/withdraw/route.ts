// S2-2.8b(수업 등록 취소 API) — `POST /api/classes/{classId}/withdraw`(계약 11 §4-4 「등록 취소」, 보드 I2S).
// 올린 사람이 승인 대기 중인 수업을 임시 저장으로 되돌린다. 승인 요청 때 만든 회차·판매 단위·자리 묶음은 지우고
// 승인 기록 withdrawn 을 남긴다. 처리 내용은 lib/server/services/class-withdrawal.ts 에 있다.
import { createClassWithdrawRoute } from "@/lib/server/services/class-withdrawal";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createClassWithdrawRoute({ db, getSession: readStaffSession });
