// S0-3.8(관리자 웹 2단계 인증 게이트) — 관리자 웹 콘솔 경로를 감싸는 래퍼 하나.
//   계약: _workspace/03_contracts/README.md §6-1(「2단계 인증을 마친 세션만 콘솔 경로를 쓸 수 있다」) · §6-2 · §6-4
//   관련: FR-303(관리자 웹 2단계 인증) · FR-300(주소로 직접 들어가도 서버가 막는다)
//
// 왜 래퍼를 따로 두나:
//   콘솔 경로마다 `requireStaff(…, { surface: "web" })` 를 손으로 쓰면, 어느 경로 하나가 surface 를 빠뜨리거나
//   "app" 으로 잘못 적는 순간 비밀번호만 낸 세션이 그 메뉴를 연다. 콘솔 경로는 이 래퍼로만 만들게 해서
//   「관리자 웹 = 2단계 필수」를 경로 작성자가 고를 수 없는 값으로 묶는다.
//
// 쓰는 법(Route Handler):
//   const consoleRoute = createConsoleRoute({ db, getSession: readStaffSession });
//   export const GET = consoleRoute(
//     { permission: "roster_manage", academyId: async (ctx) => (await ctx.params).academyId },
//     async (request, ctx, staff) => Response.json(…),
//   );
// 처리 순서: README §6-2 의 ①세션 → ②직원 계정 → ③2단계(SECOND_FACTOR_REQUIRED) → ④~⑦ 권한 → 처리기.
// 강사·대표 앱 경로(bearer, 2단계 없음)는 이 래퍼를 쓰지 않고 requireStaff(…, { surface: "app" }) 를 쓴다.
// 예외 — 대표 앱도 같은 경로를 부르는 콘솔 경로(2026-11-23): 명세에 `appToo: true` 를 적는다. 그러면 Bearer 요청은
// 앱 규칙(2단계 없음)으로, 쿠키 요청은 지금처럼 2단계 필수로 판정한다(수업 승인 class-approval.ts 와 같은 방식).
// 적지 않은 경로는 Bearer 를 보내도 web 이다 — 앱 토큰으로 관리자 웹 전용 메뉴를 열 수 없다.
import { createGuards, type GuardDeps, type StaffContext, type StaffPermission, type Surface } from "./guards";
import { withRoute } from "./http";

/** 운영자 경로 — 학원에 매이지 않는다. */
type PlatformSpec = { permission: "admin" };

/** 학원 경로 — 경로 매개변수 등에서 학원 id 를 꺼내는 함수를 함께 준다(빠뜨리면 타입 검사에서 막힌다). */
type AcademySpec<C> = {
  permission: Exclude<StaffPermission, "admin">;
  academyId: (context: C) => string | Promise<string>;
  /** 대표 앱도 부르는 경로인가 — 켜면 Bearer 요청은 앱 규칙, 쿠키 요청은 2단계 필수(위 주석) */
  appToo?: true;
};

/**
 * 이 요청을 어느 면(web/app)으로 판정할지. 앱도 부르는 경로에서 Bearer 로 온 요청만 app 이고, 나머지는 모두 web 이다.
 */
export function consoleSurface(request: Request, appToo: boolean): Surface {
  if (!appToo) return "web";
  return (request.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer ") ? "app" : "web";
}

export type ConsoleRouteSpec<C> = PlatformSpec | AcademySpec<C>;

/** 가드를 통과한 직원(staff)을 세 번째 인자로 받는 처리기. */
export type ConsoleHandler<C> = (request: Request, context: C, staff: StaffContext) => Promise<Response>;

export function createConsoleRoute(deps: GuardDeps) {
  const guards = createGuards(deps);

  return function consoleRoute<C>(spec: ConsoleRouteSpec<C>, handler: ConsoleHandler<C>) {
    return withRoute<C>(async (request, context) => {
      // 운영자 경로는 언제나 web(2단계 필수). 학원 경로는 appToo 가 켜진 경로의 Bearer 요청만 app 이다(§6-1).
      const staff =
        spec.permission === "admin"
          ? await guards.requireStaff("admin", { surface: "web", headers: request.headers })
          : await guards.requireStaff(spec.permission, {
              surface: consoleSurface(request, (spec as AcademySpec<C>).appToo === true),
              headers: request.headers,
              academyId: await (spec as AcademySpec<C>).academyId(context),
            });
      return handler(request, context, staff);
    });
  };
}

export type ConsoleRoute = ReturnType<typeof createConsoleRoute>;
