// S7-4.8a(공휴일 운영자 입력 API(P9)) — `GET`·`POST /api/admin/console/holidays`(계약 13 §10-1).
// 연도별 공휴일 목록(조회 기록 포함)과 운영자 줄 더하기. 처리 내용과 zod 본문 검사(createHolidayRequestSchema)는
// lib/server/services/admin-holidays.ts 에 있고, 이 파일은 앱의 db·로그인 세션·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createAdminHolidaysRoutes } from "@/lib/server/services/admin-holidays";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 운영자·다른 연도다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

const routes = createAdminHolidaysRoutes({
  db,
  getSession: readStaffSession,
  // getter 로 넘긴다 — deps 는 처음 쓰는 요청에서 만든다(deps.ts 의 지연 생성)
  get clock() {
    return getDeps().clock;
  },
});

export const GET = routes.list;
export const POST = routes.create;
