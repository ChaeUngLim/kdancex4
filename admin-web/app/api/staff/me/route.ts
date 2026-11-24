// S0-3.7(직원 정보 조회 API) — `GET /api/staff/me`(계약 README §6-1).
// 로그인한 직원의 역할·학원별 메뉴·consoleAccess 를 서버가 계산해 준다. 화면은 받은 메뉴만 그린다.
// 처리 내용은 lib/server/services/staff-me.ts 에 있고, 이 파일은 앱의 db·로그인 인스턴스를 이어 줄 뿐이다.
import { createStaffMeRoute } from "@/lib/server/services/staff-me";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 사람마다 다른 응답이고 권한을 매 요청 DB 에서 읽어야 한다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createStaffMeRoute({ db, getSession: readStaffSession });
