// S2-2.13(수업 목록 읽기 API) — `GET /api/classes/{classId}/sessions`(계약 11 §4-6, 보드 I6B).
// 올린 사람·그 학원 대표가 수업의 회차 목록(시각·홀·강사·대타 여부·결제한 회원 수)을 읽는다.
// 처리 내용은 lib/server/services/class-list-reads.ts 에 있다.
import { createClassSessionListRoute } from "@/lib/server/services/class-list-reads";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const GET = createClassSessionListRoute({ db, getSession: readStaffSession });
