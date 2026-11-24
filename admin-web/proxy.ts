// 개발 전용 「앱 웹 → 관리자 웹 API」 허용(CORS) — 2026-11-23 사용자 결정(앱을 PC 브라우저로 실서버에 붙여 시연).
//
// 무엇을 하나:
//   앱(Expo 웹)은 localhost:8081 에서 뜨고, 제품 API 는 이 Next.js(localhost:3000)에 있다. 주소(출처)가 달라
//   브라우저가 요청을 막는다. 그래서 개발 PC 에서만 앱 웹 출처 하나를 허용하는 헤더를 붙인다.
//
// 왜 이렇게 좁게 여나:
//   - 휴대폰 앱(네이티브)은 브라우저가 아니라 CORS 가 필요 없다. 이 허용은 「PC 에서 앱을 웹으로 보는 경우」에만 쓴다.
//   - 열고 닫는 판정은 dev 경로(가짜 본인확인 등)와 같은 환경 변수 하나(KDANCE_DEV_ROUTES)로만 한다.
//     정확히 "true" 일 때만 열린다 — 운영·베타는 이 값을 비우므로 이 파일은 아무 헤더도 붙이지 않는다(lib/server/dev-routes.ts 와 같은 규칙).
//   - 쿠키는 허용하지 않는다(Allow-Credentials 없음). 앱은 쿠키가 아니라 Authorization: Bearer 토큰으로 보낸다.
//
// Next 16.3 은 middleware 대신 proxy 파일을 쓴다(node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
import { NextResponse, type NextRequest } from "next/server";

/** 허용하는 단 하나의 출처 — Expo 웹 개발 서버 기본 주소 */
export const APP_WEB_DEV_ORIGIN = "http://localhost:8081";

// 앱이 실제로 싣는 헤더만 허용한다(mobile/lib/api.ts: Content-Type · Authorization · Idempotency-Key)
const ALLOWED_HEADERS = "Content-Type, Authorization, Idempotency-Key";
const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * 순수 판정 함수 — 요청과 환경 값을 받아 응답을 정한다. 테스트가 env 를 넣어 부른다.
 * 열려 있지 않거나 출처가 다르면 아무것도 붙이지 않고 그대로 통과시킨다(라우트가 평소처럼 응답한다).
 */
export function appWebDevCors(request: NextRequest, env: Env): NextResponse {
  const open = env["KDANCE_DEV_ROUTES"] === "true";
  const allowed = open && request.headers.get("origin") === APP_WEB_DEV_ORIGIN;
  if (!allowed) return NextResponse.next();

  const corsHeaders = {
    "Access-Control-Allow-Origin": APP_WEB_DEV_ORIGIN,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    Vary: "Origin",
  };

  // 사전 요청(OPTIONS): 브라우저가 「보내도 되나」를 먼저 묻는다. 라우트까지 보내지 않고 여기서 204 로 답한다.
  if (request.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: corsHeaders });
  }

  // 실제 요청: 라우트가 만든 응답에 허용 헤더만 더한다.
  const response = NextResponse.next();
  for (const [key, value] of Object.entries(corsHeaders)) response.headers.set(key, value);
  return response;
}

/** Next 가 부르는 진입점. 두 번째 인자(이벤트)는 쓰지 않고 요청 때의 환경 값으로 판정한다. */
export function proxy(request: NextRequest): NextResponse {
  return appWebDevCors(request, process.env);
}

// API 경로에만 건다 — 화면·정적 파일에는 손대지 않는다.
export const config = {
  matcher: "/api/:path*",
};
