// S1-1.8(대표 가입 API) — 앱 실행 때 대표 가입 경로에 넘길 deps 를 한 곳에서 만든다(route.ts 셋이 같이 쓴다).
//
// 왜 본인확인 포트를 「부를 때 꺼내는」 얇은 껍데기로 넘기나: getDeps().identityVerification 은 처음 꺼낼 때
// FAKE_IDENTITY_SECRET 같은 비밀값을 읽는다. route.ts 를 import 하는 순간(빌드 포함) 꺼내면 비밀값이 없는
// 환경에서 import 만으로 실패한다. 요청이 올 때 꺼내면 그 요청만 500 이 되고 서버 로그에 변수 이름이 남는다.
import { db } from "../../prisma/db";
import { getDeps } from "./deps";
import type { IdentityVerificationPort } from "./ports/identity";
import { createRateLimiter, loadRateLimitRules } from "./rate-limit";
import type { OwnerSignupDeps } from "./services/owner-signup";

const lazyIdentity: IdentityVerificationPort = {
  verify: (token, now) => getDeps().identityVerification.verify(token, now),
};

export function ownerSignupAppDeps(): OwnerSignupDeps {
  return {
    db,
    identityVerification: lazyIdentity,
    clock: () => getDeps().clock(),
    limiter: createRateLimiter(),
    identityRule: loadRateLimitRules().identityVerification,
  };
}
