// S0-4.3(내부 작업 경로 패턴) — 계약 README §1 「내부 경로」:
//   `/api/internal/**` 는 헤더 `X-Internal-Token` 이 환경 변수 `INTERNAL_API_TOKEN` 과 같을 때만(상수 시간 비교).
//
// 내부 경로는 사람이 아니라 시간 작업 실행기(cron 등)가 부르는 문이다 — 주문 만료, 환불 자동 실행,
// 대기 줄 넘기기처럼 돈과 좌석을 움직인다. 그래서 규칙을 셋으로 못 박는다.
//   1. 토큰이 없거나 틀리면 처리기를 **아예 부르지 않고** 401 을 준다
//   2. 서버에 토큰이 설정돼 있지 않으면(빈 값 포함) 언제나 401 — 설정을 빠뜨린 배포가 문을 열어 두지 않게
//   3. 비교는 상수 시간(timingSafeEqual)으로 한다. `===` 는 첫 다른 글자에서 멈추므로,
//      응답 시간을 재면 토큰을 한 글자씩 맞혀 갈 수 있다
//
// 쓰는 법: `export const POST = withInternalRoute(async (request) => { … })` — 시간 작업 route.ts 는 전부 이것을 거친다.
import { createHash, timingSafeEqual } from "node:crypto";

import { HttpError, withRoute } from "./http";

/** 서버가 기대하는 토큰을 담는 환경 변수 이름 */
export const INTERNAL_TOKEN_ENV = "INTERNAL_API_TOKEN";
/** 호출하는 쪽이 토큰을 싣는 헤더 이름 */
export const INTERNAL_TOKEN_HEADER = "X-Internal-Token";

type Env = Readonly<Record<string, string | undefined>>;

// 401 문구는 다른 인증 실패와 같게 둔다 — 「토큰이 틀렸다」·「서버에 토큰이 없다」를 구별해 알려 주지 않는다.
const UNAUTHENTICATED_DETAIL = "인증이 필요해요";

/** 길이를 32바이트로 고정한다. 길이가 다른 두 값을 timingSafeEqual 에 넣으면 예외가 나서, 그 차이로 길이가 샌다 */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * 받은 토큰이 기대 토큰과 같은가. 둘 중 하나라도 비었으면 거짓(닫는 쪽으로 실패).
 * 두 값을 같은 길이의 해시로 바꾼 뒤 상수 시간으로 비교한다.
 */
export function internalTokenMatches(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!given || !expected) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

type RouteHandler<C> = (request: Request, context: C) => Response | Promise<Response>;

/**
 * 내부 작업 Route Handler 를 감싼다. 토큰이 맞지 않으면 처리기를 부르지 않고 401 UNAUTHENTICATED.
 * 맞으면 공통 HTTP 계층(`withRoute`)을 그대로 탄다(예상 못 한 오류는 500 INTERNAL).
 *
 * `env` 는 테스트용 주입점이다. 생략하면 요청 때의 `process.env` 를 읽는다 — 토큰을 바꿔도 다시 띄울 필요가 없다.
 */
export function withInternalRoute<C>(
  handler: RouteHandler<C>,
  env: Env = process.env,
): (request: Request, context: C) => Promise<Response> {
  return withRoute<C>((request, context) => {
    const given = request.headers.get(INTERNAL_TOKEN_HEADER);
    if (!internalTokenMatches(given, env[INTERNAL_TOKEN_ENV])) {
      throw new HttpError("UNAUTHENTICATED", UNAUTHENTICATED_DETAIL);
    }
    return handler(request, context);
  });
}
