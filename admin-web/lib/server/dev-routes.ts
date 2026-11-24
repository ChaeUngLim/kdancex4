// S0-4.2(dev 전용 경로 차단) — 계약 README §1 「시험 전용 경로」:
//   `/api/dev/**` 는 `KDANCE_DEV_ROUTES=true` 일 때만 응답하고, 아니면 404. 운영 배포 값은 `false`.
//
// dev 경로는 가짜 본인확인(`/api/dev/identity/fake-verify`)·가짜 PG 입금(`/api/dev/fake-pg/**`)처럼
// 운영에서 열리면 곧바로 사고가 나는 문들이다. 그래서 규칙을 둘로 못 박는다.
//   1. 판정은 환경 변수 **하나**(`KDANCE_DEV_ROUTES`)로만 한다. NODE_ENV 같은 다른 값은 보지 않는다
//      — 판정 근거가 둘이면 「어느 쪽이 이기나」를 따져야 하고, 그 틈으로 문이 열린다
//   2. 정확히 문자열 `"true"` 일 때만 연다. 비었거나 `"TRUE"`·`"1"`·오타면 닫는다(닫는 쪽으로 실패)
//
// 쓰는 법: `export const POST = withDevRoute(async (request) => { … })` — dev 경로 route.ts 는 전부 이것을 거친다.
// 같은 판정이 필요한 다른 자리(가입 경로 열기, 내부 작업의 시험용 시계 `asOf`)는 `devRoutesEnabled()` 를 쓴다.
import { HttpError, withRoute } from "./http";

/** 판정에 쓰는 환경 변수 이름. 이 이름 말고는 읽지 않는다 */
export const DEV_ROUTES_ENV = "KDANCE_DEV_ROUTES";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * dev 경로가 열려 있나. 값이 정확히 `"true"` 일 때만 참이다.
 * 요청마다 부르므로 서버를 다시 띄우지 않고 테스트에서 env 를 바꿔 넣을 수 있다.
 */
export function devRoutesEnabled(env: Env = process.env): boolean {
  return env[DEV_ROUTES_ENV] === "true";
}

// 404 문구는 다른 「없는 자원」과 같게 둔다 — 문구로 「여기에 dev 경로가 있다」는 사실이 새지 않게.
const NOT_FOUND_DETAIL = "찾을 수 없어요";

type RouteHandler<C> = (request: Request, context: C) => Response | Promise<Response>;

/**
 * dev 전용 Route Handler 를 감싼다. 닫혀 있으면 처리기를 **아예 부르지 않고** 404 를 준다
 * (본문 파싱·가짜 원장 접근도 일어나지 않는다). 열려 있으면 공통 HTTP 계층(`withRoute`)을 그대로 탄다.
 *
 * `env` 는 테스트용 주입점이다. 생략하면 요청 때의 `process.env` 를 읽는다.
 */
export function withDevRoute<C>(
  handler: RouteHandler<C>,
  env: Env = process.env,
): (request: Request, context: C) => Promise<Response> {
  return withRoute<C>((request, context) => {
    if (!devRoutesEnabled(env)) throw new HttpError("NOT_FOUND", NOT_FOUND_DETAIL);
    return handler(request, context);
  });
}
