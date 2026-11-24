// S1-2.13(강의실 목록·추가·보관 API) — `GET·POST /api/academies/{academyId}/rooms`(계약 07 §4 · 열린 점 ⑱).
// 대표가 학원 설정(W22)에서 강의실 목록을 보고(보관한 강의실은 빠진다), 새 강의실을 만든다(같은 지점 같은 이름 409).
// 처리 내용은 lib/server/services/academy-rooms.ts 에 있고, 이 파일은 앱의 db·세션을 이어 줄 뿐이다.
import { createCreateRoomRoute, createListRoomsRoute } from "@/lib/server/services/academy-rooms";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createListRoomsRoute({ db, getSession: readStaffSession });
export const POST = createCreateRoomRoute({ db, getSession: readStaffSession });
