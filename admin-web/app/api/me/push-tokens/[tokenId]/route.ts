// S7-1.1(SP-4 푸시 경로 조사) — `DELETE /api/me/push-tokens/{tokenId}`(계약 15 §1-2). 로그아웃·권한 끔 때 앱이 부른다.
// 내 토큰만 닫는다(남의 것·없는 id 는 404). 이미 닫혔으면 처음 닫은 시각으로 200 — 규칙은 lib/server/services/push-tokens.ts.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createPushTokenRoutes } from "@/lib/server/services/push-tokens";

export const dynamic = "force-dynamic";

const routes = createPushTokenRoutes(memberProfileAppDeps);
export const DELETE = routes.deleteToken;
