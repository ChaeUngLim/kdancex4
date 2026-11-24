// S3-1.5(취향·기준 장르 API) — 앱 실행 때 `GET /api/me` · `PUT /api/me/profile` · `PUT /api/me/base-genre` 에 넘길 deps.
// 세 route.ts 가 같은 재료(db · 세션 읽기 · 시계)를 쓰므로 한 곳에서 만든다.
import { getDeps } from "@/lib/server/deps";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import type { HomeOfferingsDeps } from "@/lib/server/services/home-offerings";
import type { MemberProfileDeps } from "@/lib/server/services/member-profile";
import type { OfferingDetailDeps } from "@/lib/server/services/offering-detail";
import { db } from "@/prisma/db";

// 회원·직원이 Better Auth 하나를 같이 쓰므로 세션 읽기는 같은 함수다(계약 README §2).
// 시계는 getter 로 넘긴다 — import 만으로 앱 설정을 읽지 않고, 처음 쓰는 요청에서 읽는다
export const memberProfileAppDeps: MemberProfileDeps = {
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
};

// S3-3.7 — 홈 목록·수업 상세 경로의 deps. 위 재료에 PG 를 더한다 — 읽기 전 정리가 기한 지난 결제의 계좌를 폐기한다.
// 위 객체를 펼쳐(...) 복사하면 그 순간 getter 가 불려 앱 설정을 읽으므로, getter 를 그대로 다시 적는다
export const catalogAppDeps: HomeOfferingsDeps & OfferingDetailDeps = {
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
  get paymentGateway() {
    return getDeps().paymentGateway;
  },
};
