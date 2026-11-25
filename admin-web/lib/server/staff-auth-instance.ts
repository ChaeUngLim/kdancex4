// 앱이 쓰는 직원 로그인(Better Auth) 하나 — 라우트들이 같은 인스턴스로 세션을 읽는다.
//   설정 자체는 staff-auth.ts(S0-3.3)에 있고, 이 파일은 공용 pg 풀과 환경 변수로 한 번만 만들어 둔다.
//
// 왜 처음 부를 때 만드나: import 시점에 만들면 BETTER_AUTH_SECRET 이 없는 환경(빌드 등)에서 import 만으로
// 실패한다. 처음 요청이 올 때 만들고, 값이 없으면 그 요청이 500 이 되며 서버 로그에 이유가 남는다.
import { pool } from "../../prisma/db";
import { createRateLimiter, loadRateLimitRules } from "./rate-limit";
import { createStaffAuth, type StaffAuth } from "./staff-auth";
import type { SessionReader } from "./guards";

// next dev 는 파일을 저장할 때마다 모듈을 다시 평가한다 — globalThis 에 두어 인스턴스를 하나로 유지한다(prisma/db.ts 와 같은 방식).
const globalForAuth = globalThis as unknown as { __kdanceStaffAuth?: StaffAuth };

export function getStaffAuth(): StaffAuth {
  if (globalForAuth.__kdanceStaffAuth !== undefined) return globalForAuth.__kdanceStaffAuth;
  const secret = process.env["BETTER_AUTH_SECRET"];
  const baseURL = process.env["BETTER_AUTH_URL"];
  if (!secret || !baseURL) throw new Error("BETTER_AUTH_SECRET·BETTER_AUTH_URL 환경 변수가 필요하다(.env.example 참고)");
  globalForAuth.__kdanceStaffAuth = createStaffAuth({
    pool,
    secret,
    baseURL,
    // 앱 로그인은 6자리가 없어 비밀번호가 유일한 관문이다 — 아이디·IP 실패 횟수를 Redis 에 센다(계약 §6-4).
    appSignInLimit: { limiter: createRateLimiter(), rule: loadRateLimitRules().authFailure },
  });
  return globalForAuth.__kdanceStaffAuth;
}

/** 가드에 넘길 세션 읽기 함수. 쿠키든 Authorization: Bearer 든 Better Auth 가 같은 세션으로 읽는다. */
export const readStaffSession: SessionReader = (headers) => getStaffAuth().api.getSession({ headers });
