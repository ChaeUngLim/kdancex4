// S7-2.2(문의 생성과 조회 권한) — `POST /api/inquiries`(문의 만들기 · 받는 곳 선택) · `GET /api/inquiries`(내 문의)(계약 15 §2-2).
// 처리 내용은 lib/server/services/inquiries.ts 에 있다. 본문은 그 파일이 쓰는 createInquirySchema(zod)로 검사한다.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createInquiryRoutes } from "@/lib/server/services/inquiries";

// 사람마다 다른 응답이고 POST 는 DB 에 쓴다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

// 회원·강사·대표가 같은 Better Auth 세션을 쓰므로 재료(db · 세션 읽기 · 시계)는 회원 경로와 같다
const routes = createInquiryRoutes(memberProfileAppDeps);
export const POST = routes.create;
export const GET = routes.listMine;
