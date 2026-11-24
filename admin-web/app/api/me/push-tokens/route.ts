// S7-1.1(SP-4 푸시 경로 조사) — `POST /api/me/push-tokens`(계약 15 §1-2, 보드 C1A).
// 등록·갱신 규칙(같은 토큰 재등록 200 · 다른 계정이면 옛 줄 닫기 · 거절 기기도 기록)은 lib/server/services/push-tokens.ts 에 있다.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createPushTokenRoutes } from "@/lib/server/services/push-tokens";

export const dynamic = "force-dynamic";

// 회원·직원이 같은 Better Auth 세션을 쓰므로 재료(db · 세션 읽기 · 시계)는 회원 경로와 같다
const routes = createPushTokenRoutes(memberProfileAppDeps);
export const POST = routes.postToken;
