// S7-2.6(이용 제한 절차) — `POST /api/admin/restrictions`(이용 제한 절차 시작 · 사유 통지, 계약 15 §2-8). 2단계 인증을 마친 관리자 웹 운영자만.
// 절차 1행 · 대상 알림 · 감사 restriction.opened 가 한 트랜잭션에 들어간다. 처리 내용은 lib/server/services/restrictions.ts.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createRestrictionRoutes } from "@/lib/server/services/restrictions";

export const dynamic = "force-dynamic";

export const POST = createRestrictionRoutes(memberProfileAppDeps).open;
