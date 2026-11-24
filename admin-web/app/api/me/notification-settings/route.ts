// S7-1.4(알림 설정 API) — `GET`·`PUT /api/me/notification-settings`(계약 15 §1-1, 보드 C1A).
// 거래 알림 끄기 거부·광고성 동의 기록은 lib/server/services/member-notification-settings.ts 에 있고, 이 파일은 앱의 재료를 이어 줄 뿐이다.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createMemberNotificationSettingsRoutes } from "@/lib/server/services/member-notification-settings";

export const dynamic = "force-dynamic";

// 회원 경로라 deps(db · 세션 읽기 · 시계)는 취향 API 와 같은 것을 쓴다
const routes = createMemberNotificationSettingsRoutes(memberProfileAppDeps);
export const GET = routes.getSettings;
export const PUT = routes.putSettings;
