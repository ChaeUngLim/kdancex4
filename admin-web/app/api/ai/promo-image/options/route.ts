// SX-6.9(앱 홍보 이미지·소개 문구 화면) — `GET /api/ai/promo-image/options?classId=…`(계약 16 §4-7).
// 칩·예시·자동 조건·엔진 카드·남은 횟수·마지막 생성을 한 번에 준다. 처리는 lib/server/services/promo-image-options.ts.
import { createPromoImageOptionsRoute } from "@/lib/server/services/promo-image-options";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const route = () => createPromoImageOptionsRoute({ db, getSession: readStaffSession });

export const GET = (request: Request, context: unknown) => route()(request, context);
