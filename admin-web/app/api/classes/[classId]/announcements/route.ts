// S2-3.5(강사 수업 공지) — 계약 11 §6-3, 보드 I13 · I13B. 처리 내용은 lib/server/services/class-announcements.ts 에 있다.
//   POST — 수강생 공지 보내기(Idempotency-Key 필수). 공지 행과 확정 수강생마다 알림 행을 한 트랜잭션에 쓴다
//   GET  — 보낸 공지 목록(강사·대표, 최신순)
import { createClassAnnouncementRoutes } from "@/lib/server/services/class-announcements";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const routes = createClassAnnouncementRoutes({ db, getSession: readStaffSession });

export const POST = routes.create;
export const GET = routes.list;
