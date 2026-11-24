// S2-4.2(개인 레슨 개설 API) — `POST /api/instructor/private-lesson-products`(계약 11 §10-1, 보드 I10B).
// S2-4.10(개인 레슨 상품·모집 시간·수강권 목록 API) — `GET` 내 상품 목록(I10 · I10B)을 같은 파일에 더했다.
// 처리 내용은 lib/server/services/private-lesson-products.ts 에 있다(본문 zod 검증 · 소속 학원 판정 · 멱등키).
import { createPrivateLessonProductRoutes } from "@/lib/server/services/private-lesson-products";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const routes = () => createPrivateLessonProductRoutes({ db, getSession: readStaffSession });

export const GET = routes().list;
export const POST = routes().create;
