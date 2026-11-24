// 개발 DB 전용 — 회원 알림 설정(보드 C1A, S7-1.4(알림 설정 API))이 빈 기본값이 아니라 실제 회원이 고른 값으로 보이게 하는 시연 데이터.
//
// 무엇을 넣나(모두 진짜 경로 PUT /api/me/notification-settings 의 처리기를 그대로 불러서 쓴다 — 행을 SQL 로 직접 넣지 않는다):
//   - 「이도윤」(demo-activity@example.com) — 수업 2시간 전 알림 · 광고성 동의 · 쿠폰 소멸 켬 · 대기 자리 끔
//   - 「이도윤」의 갤럭시 기기 푸시 토큰 1개(권한 허용) — 진짜 경로 POST /api/me/push-tokens 처리기로 등록(S7-1.1).
//     토큰은 시연용 가짜 값이라 실제 기기에는 가지 않는다. 다시 돌리면 같은 토큰이라 200(줄 그대로, 확인 시각만 갱신)
//   - 「한지우」(demo-empty@example.com)   — 손대지 않는다(설정 행 없음 = 기본값 화면 촬영용)
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-notification-settings.ts
//   두 번 돌려도 같은 결과 — 같은 값을 다시 보내면 경로가 아무것도 바꾸지 않는다(설정 행 updated_at·동의 기록 줄 그대로).
//   먼저 scripts/dev-demo-member-activity.ts 가 이도윤을 만들어 두어야 한다.
import "dotenv/config";

import { systemClock } from "../lib/domain/time";
import { createMemberNotificationSettingsRoutes } from "../lib/server/services/member-notification-settings";
import { createPushTokenRoutes } from "../lib/server/services/push-tokens";
import { createStaffAuth } from "../lib/server/staff-auth";
import { createDb } from "../prisma/db";

const ACTIVE_EMAIL = "demo-activity@example.com";
const DOYUN_DEVICE = { token: "ExponentPushToken[demo-doyun-galaxy-s24]", platform: "android", deviceId: "demo-galaxy-s24", permission: "granted" } as const;
const DOYUN_SETTINGS = { preClassLead: "two_hours", marketingAgreed: true, couponExpiryNotice: true, waitlistNotice: false } as const;

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;

async function finish(code = 0): Promise<never> {
  await db.close();
  await pool.end();
  process.exit(code);
}

// 이도윤의 로그인 계정을 찾는다. 없으면 앞 시연 스크립트를 먼저 돌리라고 알리고 멈춘다
const { rows } = await pool.query<{ user_id: string }>(
  `SELECT u.id AS user_id FROM auth."user" u JOIN members m ON m.auth_user_id = u.id WHERE u.email = $1`,
  [ACTIVE_EMAIL],
);
const doyun = rows[0];
if (doyun === undefined) {
  console.error(`${ACTIVE_EMAIL} 회원이 없다 — scripts/dev-demo-member-activity.ts 를 먼저 돌린다`);
  await finish(1);
}

// 진짜 세션으로 진짜 처리기를 부른다(앱이 보내는 요청과 같은 모양)
const token = (await ctx.internalAdapter.createSession(doyun!.user_id)).token;
const routes = createMemberNotificationSettingsRoutes({
  db,
  getSession: (headers: Headers) => auth.api.getSession({ headers }),
  clock: systemClock,
});
const res = await routes.putSettings(
  new Request("http://localhost:3000/api/me/notification-settings", {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(DOYUN_SETTINGS),
  }),
  {},
);
const body = (await res.json()) as Record<string, unknown>;
if (res.status !== 200) {
  console.error(`저장 실패 ${res.status}`, body);
  await finish(1);
}
console.log("이도윤 알림 설정:", JSON.stringify(body));

// 이도윤 기기 토큰 — 앱이 권한을 받은 뒤 보내는 요청과 같은 모양(응답에는 토큰 값이 없다)
const pushRoutes = createPushTokenRoutes({ db, getSession: (headers: Headers) => auth.api.getSession({ headers }), clock: systemClock });
const pushRes = await pushRoutes.postToken(
  new Request("http://localhost:3000/api/me/push-tokens", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(DOYUN_DEVICE),
  }),
  {},
);
const pushBody = (await pushRes.json()) as Record<string, unknown>;
if (pushRes.status !== 201 && pushRes.status !== 200) {
  console.error(`토큰 등록 실패 ${pushRes.status}`, pushBody);
  await finish(1);
}
// 줄 id 는 찍지 않는다 — 비밀값 검사(gitleaks)가 「…token…: 긴 값」 모양을 키로 오인한다. 권한 상태만 남긴다
console.log(`이도윤 푸시 기기: HTTP ${pushRes.status} (201=새로 · 200=이미 있음) · 권한 ${String(pushBody["permission"])}`);
await finish(0);
