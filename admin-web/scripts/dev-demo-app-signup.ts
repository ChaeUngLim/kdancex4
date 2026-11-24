// 개발 DB 전용 — 앱(Expo 웹)에서 가입 화면부터 결제 대기 화면까지 실제로 눌러 보는 시연용 로그인 계정(M3-END.2(Expo 웹 실행 시도)).
//
// 무엇을 넣나:
//   로그인만 되는 계정 1개 — 이메일 demo-signup@example.com / 비밀번호 demo-signup-1234.
//   회원 행(members)은 넣지 않는다. 그래서 앱에서 로그인하면 서버가 403 SIGNUP_INCOMPLETE 를 돌려주고,
//   앱이 약관 동의 → 본인확인 → 가입 정보 → 취향 → 기준 장르 → 홈 순서로 진짜 가입 경로를 밟게 된다.
//
// 왜 회원 행을 SQL 로 넣지 않나: 이 계정의 목적이 「가입 화면을 사람처럼 지나가 보기」라서,
//   회원 행·본인확인 기록·약관 동의 기록은 모두 앱이 부르는 가입 API(POST /api/members)가 만들어야 한다.
//   로그인 계정은 소셜 로그인(S8-2)이 아직 없어 다른 시연 스크립트와 같이 Better Auth 내부 어댑터로 만든다.
//
// 볼 수업: dev-demo-member-catalog.ts 가 만든 brad 학원의 게시 수업(바차타 센슈얼 입문 등)을 그대로 쓴다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-app-signup.ts
//   두 번 돌려도 같은 결과 — 계정이 이미 있으면 아무것도 넣지 않고, 가입을 이미 마쳤는지만 알려 준다.
//   다시 가입 화면부터 보고 싶으면 이메일을 바꾸는 대신 DEMO_SIGNUP_EMAIL 환경 변수로 새 주소를 준다.
import "dotenv/config";

import { createDb } from "../prisma/db";
import { createStaffAuth } from "../lib/server/staff-auth";

const EMAIL = process.env["DEMO_SIGNUP_EMAIL"] ?? "demo-signup@example.com";
const PASSWORD = "demo-signup-1234";

// 시연 계정 주소는 꼭 @example.com 이어야 한다(실제 사람에게 메일이 갈 수 없는 주소)
if (!EMAIL.endsWith("@example.com")) throw new Error("시연 계정 이메일은 @example.com 이어야 한다");

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);

// 이미 있으면 건너뛴다. 가입을 마쳤으면(회원 행 있음) 그 사실만 알려 준다 — 덮어쓰거나 지우지 않는다
const [existing] = await q<{ id: string; member: boolean }>(
  `SELECT u.id, EXISTS (SELECT 1 FROM members m WHERE m.auth_user_id = u.id) AS member
     FROM auth."user" u WHERE u.email = $1`,
  [EMAIL],
);
if (existing !== undefined) {
  console.log(existing.member ? `이미 가입을 마친 계정: ${EMAIL}` : `이미 있다(가입 전): ${EMAIL}`);
} else {
  // 로그인 신원만 만든다 — 이메일·비밀번호 로그인(credential)
  const user = await ctx.internalAdapter.createUser({ email: EMAIL, name: "가입 시연", emailVerified: true }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(PASSWORD) });
  console.log(`만들었다(가입 전 로그인 계정): ${EMAIL}`);
}

// 앱 홈에 보일 게시 수업이 있는지 확인만 한다 — 없으면 앞 시연 스크립트를 먼저 돌리라고 알린다
const [published] = await q<{ n: number }>("SELECT count(*)::int AS n FROM classes WHERE status = 'published'");
if ((published?.n ?? 0) === 0) console.log("게시 수업이 없다 — scripts/dev-demo-member-catalog.ts 를 먼저 돌린다");

await db.close();
await pool.end();
