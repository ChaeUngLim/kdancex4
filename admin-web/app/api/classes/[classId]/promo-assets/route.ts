// SX-6.7(검토 후 게시 경로) — `GET|PUT /api/classes/{classId}/promo-assets`(계약 16 §4-7).
// 수업의 홍보 표지(올린 사진이 먼저 · 없으면 AI 이미지)와 소개 문구를 저장하고 「검토 끝」 확인을 남긴다.
// 처리 내용은 lib/server/services/class-promo-assets.ts 에 있고(zod 검사 promoAssetsBodySchema 포함),
// 이 파일은 앱의 db·로그인 세션을 이어 줄 뿐이다. 게시 관문(PROMO_REVIEW_REQUIRED)은 승인 요청·대표 승인 쪽에 있다.
import { createClassPromoAssetsRoutes } from "@/lib/server/services/class-promo-assets";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const routes = createClassPromoAssetsRoutes({ db, getSession: readStaffSession });

export const GET = routes.read;
export const PUT = routes.save;
