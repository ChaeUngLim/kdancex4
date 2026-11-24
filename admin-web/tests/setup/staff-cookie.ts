// DB 테스트 공용 — 직원 세션 토큰을 「관리자 웹이 보내는 모양」(서명한 Better Auth 세션 쿠키)으로 바꾼다.
//
// 왜 필요한가:
//   대표 앱도 부르는 콘솔 경로(appToo)는 요청이 어떻게 왔는지로 규칙을 가른다(2026-11-23).
//   Bearer 토큰으로 오면 대표 앱이라 2단계를 묻지 않고, 쿠키로 오면 관리자 웹이라 2단계를 꼭 묻는다.
//   그래서 「2단계 전이면 401」 같은 웹 규칙을 확인하려면 Bearer 가 아니라 쿠키로 보내야 한다.
//
// 서명 방법은 화면 테스트(tests/e2e/support/console-session.ts 의 signSessionToken)와 똑같다 —
//   better-call 의 signCookieValue 처럼 「토큰.HMAC-SHA256(base64)」 를 URL 인코딩한다.
import { createHmac } from "node:crypto";

/** Better Auth 의 세션 쿠키 이름(기본 접두사 better-auth, http 주소라 __Secure- 가 붙지 않는다) */
const SESSION_COOKIE = "better-auth.session_token";

/** `Cookie` 헤더에 그대로 넣을 값을 만든다. secret 은 그 테스트가 Better Auth 를 만들 때 쓴 값이어야 한다. */
export function staffSessionCookie(token: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  return `${SESSION_COOKIE}=${encodeURIComponent(`${token}.${signature}`)}`;
}
