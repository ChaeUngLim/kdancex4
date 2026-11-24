// S1-2.13(강의실 목록·추가·보관 API) — `POST /api/academies/{academyId}/rooms/{roomId}/archive`(계약 07 §4 · 열린 점 ⑱).
// 대표가 강의실을 보관한다(지우지 않고 목록에서만 뺀다). 수업이 잡힌 강의실의 409 ROOM_IN_USE 는 회차가 생기는 M2(S2-2) 몫이다.
// 처리 내용은 lib/server/services/academy-rooms.ts 에 있고, 이 파일은 앱의 db·세션을 이어 줄 뿐이다.
import { createArchiveRoomRoute } from "@/lib/server/services/academy-rooms";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createArchiveRoomRoute({ db, getSession: readStaffSession });
