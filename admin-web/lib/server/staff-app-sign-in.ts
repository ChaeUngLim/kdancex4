// 강사·대표 앱 전용 로그인 — POST /api/auth/sign-in/staff-app (2026-11-25 사용자 결정 「앱은 2단계 없이 통과」)
//   계약: _workspace/03_contracts/README.md §6-1 · spec FR-303(관리자 웹 2단계 인증) · CLAUDE-decisions.md ADR(앱 로그인 2단계 생략)
//
// 왜 경로를 하나 더 두나:
//   관리자 웹에서 인증 앱(TOTP)을 켠 계정은 기존 아이디 로그인(/sign-in/username)에서 토큰 대신 twoFactorRedirect 를 받는다
//   — twoFactor 플러그인의 after 훅이 그 경로(정확히 세 경로)에 붙어 방금 만든 세션을 지우기 때문이다(설치본 1.7.5 실측).
//   앱에는 6자리를 넣는 화면이 없으므로, 앱만 쓰는 경로를 Better Auth 안에 플러그인 엔드포인트로 하나 더 둔다.
//
// 왜 Next.js 라우트가 아니라 Better Auth 플러그인인가:
//   - 비밀번호 확인·세션 만들기를 Better Auth 의 같은 함수(ctx.context.password·internalAdapter)로 한다 → 해시 규칙이 갈라지지 않는다
//   - 경로가 /sign-in 으로 시작해 Better Auth 기본 요청 제한(IP·경로당 10초 3회, 운영에서 켜짐)을 기존 로그인과 똑같이 받는다
//   - staff-auth.ts 의 세션 훅이 「어느 경로에서 만든 세션인가」(엔드포인트 문맥의 path)를 읽을 수 있다 → 아래 ③
//
// 이 경로가 지키는 것:
//   ① 틀린 아이디·비밀번호는 기존 아이디 로그인과 같은 401 본문(계정이 있는지 흘리지 않는다)
//   ② 직원 계정(staff_accounts)이 active 일 때만 세션을 준다 — 회원(직원 계정 없음)·탈퇴는 403 STAFF_ACCOUNT_REQUIRED, 정지는 403 ACCOUNT_SUSPENDED
//   ③ 만든 세션은 「2단계를 마치지 않은 세션」(secondFactorVerified=false)이다 → 관리자 웹 콘솔 경로는 여전히 401 SECOND_FACTOR_REQUIRED
//   ④ 쿠키를 심지 않는다(토큰만 본문으로) — 브라우저에 관리자 웹 세션이 생기지 않게
//   ⑤ 같은 아이디 또는 같은 IP 가 15분에 5회 틀리면 15분 동안 429(계약 §6-4 authFailure 규칙, Redis, 꺼지면 막는 쪽)
//   ⑥ (보안 리뷰 C1·H1, 2026-11-25) 앱 세션에는 이름표(appSession=true)를 붙이고, 그 세션으로는 Better Auth 의
//      2단계 관리·계정 관리 경로를 하나도 못 부르게 한다 — 허용 목록(세션 읽기·로그아웃) 밖은 전부 403 APP_SESSION_FORBIDDEN.
//      왜 막는 목록이 아니라 허용 목록인가: 막는 목록은 라이브러리가 경로를 하나 더하면 그 경로가 저절로 열린다.
//      막지 않으면 생기는 일: 앱 토큰으로 인증 앱을 끄고 다시 등록해 6자리를 넣으면 「2단계를 마친 세션」을 새로 받아
//      관리자 웹 콘솔이 열렸다(C1). 비밀번호 바꾸기·다른 세션 끊기로 계정을 통째로 넘겨받을 수도 있었다(H1).
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { USERNAME_ERROR_CODES } from "better-auth/plugins/username";
import type { Pool } from "pg";
import { z } from "zod";

import { HttpError } from "./http";
import type { RateLimiter, RateLimitRule } from "./rate-limit";

/** 앱 로그인 경로(Better Auth 기준 경로 — 바깥 주소는 /api/auth 를 앞에 붙인다). */
const STAFF_APP_SIGN_IN_PATH_VALUE = "/sign-in/staff-app";
export const STAFF_APP_SIGN_IN_PATH = STAFF_APP_SIGN_IN_PATH_VALUE;

/** 앱 세션 이름표 칸(auth.session). staff-auth.ts 가 칸을 만들고, 세션 훅·가드가 이 값을 우선해서 본다. */
export const APP_SESSION_FIELD = "appSession";

/**
 * 앱 세션으로 부를 수 있는 Better Auth 경로 — 이것뿐이다.
 *   /get-session(내 세션 읽기) · /sign-out(로그아웃) · /ok·/error(상태 확인) · 앱 로그인 자신(다시 로그인)
 * 앱 화면에 비밀번호 바꾸기 같은 기능이 필요해지면 그때 따로 열고, 이 목록과 테스트를 함께 고친다.
 */
export const APP_SESSION_ALLOWED_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/get-session",
  "/sign-out",
  "/ok",
  "/error",
  STAFF_APP_SIGN_IN_PATH_VALUE,
]);

const APP_SESSION_FORBIDDEN = forbiddenBody("APP_SESSION_FORBIDDEN", "앱 로그인으로는 쓸 수 없는 기능이에요. 관리자 웹에서 해 주세요");

/** 아이디·IP 실패 횟수를 세는 제한기와 규칙. 없으면(테스트 일부) Better Auth 기본 제한만 걸린다. */
export type StaffAppSignInLimit = { limiter: RateLimiter; rule: RateLimitRule };

export type StaffAppSignInOptions = { pool: Pool; limit?: StaffAppSignInLimit };

// 화면 문구는 가드(guards.ts DETAIL)와 같은 말을 쓴다 — 앱이 같은 코드를 같은 문구로 보여 주게.
// detail·code 를 함께 실어 우리 오류 모양(§4)으로도 읽히게 한다(앱의 apiFetch 는 detail·code 가 있어야 문구를 꺼낸다).
// message 는 Better Auth 응답 관례(클라이언트가 읽는 칸)를 맞추려고 같은 문구를 한 번 더 둔다.
function forbiddenBody(code: string, detail: string) {
  return { code, detail, message: detail };
}
const STAFF_REQUIRED = forbiddenBody("STAFF_ACCOUNT_REQUIRED", "직원 계정으로 로그인해 주세요");
const SUSPENDED = forbiddenBody("ACCOUNT_SUSPENDED", "이용이 정지된 계정이에요");

const bodySchema = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) });

/** 앞단 프록시가 넣는 x-forwarded-for 첫 값(없으면 「unknown」 한 칸 — 막는 쪽). owner-signup.ts clientIp 와 같은 규칙. */
function clientIp(headers: Headers | undefined): string {
  const forwarded = headers?.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers?.get("x-real-ip")?.trim() || "unknown";
}

/** 우리 요청 제한 오류(HttpError 429)를 Better Auth 응답으로 옮긴다 — 본문은 계약 §6-4 모양 그대로. */
function toRateLimitedApiError(error: HttpError): APIError {
  const seconds = Number(error.headers["Retry-After"] ?? error.extra["retryAfterSeconds"] ?? 60);
  return new APIError(
    "TOO_MANY_REQUESTS",
    { detail: error.detail, code: "RATE_LIMITED", retryAfterSeconds: seconds },
    { "Retry-After": String(seconds) },
  );
}

/** 서명된 값 「TOKEN.서명」에서 토큰만. Better Auth(better-call)와 같이 마지막 점에서 나눈다. 점이 없으면 값 그대로(막는 쪽으로 후보에 넣는다). */
function tokenPart(value: string): string {
  const dot = value.lastIndexOf(".");
  return dot > 0 ? value.slice(0, dot) : value;
}

/**
 * Bearer 머리글에서 Better Auth 가 쓸 토큰 — 설치본 bearer 플러그인(1.7.5 plugins/bearer/index.mjs)과 같은 규칙.
 *   「bearer 」 7글자를 대소문자 무시로 보고, 점이 있으면 서명된 값(% 가 있으면 한 번 디코드), 없으면 날 토큰.
 *   플러그인은 서명이 틀리면 바꾸지 않고 지나가는데, 여기서는 서명을 따지지 않고 후보에 넣는다 — 막기만 하는 판정이라 더 넓게 본다.
 */
function bearerToken(authorization: string | null | undefined): string | null {
  if (!authorization || authorization.slice(0, 7).toLowerCase() !== "bearer ") return null;
  const raw = authorization.slice(7).trim();
  if (!raw) return null;
  if (!raw.includes(".")) return raw;
  let decoded = raw;
  if (raw.includes("%")) {
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
  }
  return tokenPart(decoded);
}

/**
 * 요청이 앱 세션을 들고 왔나. 서명은 따지지 않는다 — 막기만 하는 판정이라, 남의 앱 토큰을 들고 와도 「막힘」으로만 끝난다.
 * DB 에서 직접 읽는다(bearer 플러그인이 머리글을 쿠키로 바꾼 결과는 다음 훅에 넘어오지 않아 세션 읽기 함수를 쓸 수 없다 — 설치본 dispatch 실측).
 */
async function carriesAppSession(pool: Pool, tokens: readonly string[]): Promise<boolean> {
  if (tokens.length === 0) return false;
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM auth.session WHERE token = ANY($1::text[]) AND "${APP_SESSION_FIELD}" = true`,
    [tokens],
  );
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * 지금 요청을 보낸 세션이 앱 세션이면 그 세션. 데이터 쪽 길목(databaseHooks)에서 쓴다 — 2차 재리뷰 깊이 방어.
 * ctx 는 Better Auth 가 databaseHooks before 에 넘기는 「지금 엔드포인트 문맥」(설치본 db/with-hooks.mjs: tryGetCurrentAuthEndpointContext)이고,
 * ctx.context.session 은 Better Auth 가 그 엔드포인트에서 **실제로 쓰려고 읽은 세션**이다. 쿠키·Bearer 해석을 우리가 다시 하지 않는다.
 * 엔드포인트 밖(우리 Next 라우트·스크립트)에서 부르면 ctx 가 없어 null — 그쪽은 Better Auth 세션 경로가 아니다.
 */
export function appCallerSession(ctx: unknown): Record<string, unknown> | null {
  const session = (ctx as { context?: { session?: { session?: Record<string, unknown> } | null } } | null | undefined)?.context?.session?.session;
  return session && session[APP_SESSION_FIELD] === true ? session : null;
}

/** 앱 세션이 부른 요청이면 403 으로 끊는다(데이터가 바뀌기 전). */
export function rejectAppCaller(ctx: unknown): void {
  if (appCallerSession(ctx)) throw new APIError("FORBIDDEN", APP_SESSION_FORBIDDEN);
}

/** 직원 계정 상태. 행이 없으면 null(회원 계정이거나 직원이 아닌 사용자). */
async function staffStatus(pool: Pool, authUserId: string): Promise<string | null> {
  const { rows } = await pool.query<{ status: string }>("SELECT status FROM staff_accounts WHERE auth_user_id = $1", [authUserId]);
  return rows[0]?.status ?? null;
}

export function staffAppSignInPlugin({ pool, limit }: StaffAppSignInOptions) {
  return {
    id: "kdance-staff-app-sign-in",
    // 기존 /sign-in/* 과 같은 값(10초 3회)을 이 경로에 명시해 둔다 — 기본 규칙이 바뀌어도 앱 경로가 느슨해지지 않게.
    rateLimit: [{ pathMatcher: (path: string) => path === STAFF_APP_SIGN_IN_PATH, window: 10, max: 3 }],
    hooks: {
      before: [
        {
          // ⑥ 허용 목록 밖의 경로만 본다. 세션 토큰이 없는 요청(로그인 전)은 DB 를 읽지 않고 지나간다.
          matcher: (context: { path?: string }) => !APP_SESSION_ALLOWED_AUTH_PATHS.has(context.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            // 2차 재리뷰 R2-C1: 쿠키를 손으로 읽으면 Better Auth 와 해석이 어긋난다(따옴표 쿠키로 훅을 건너뛰었다).
            // 그래서 쿠키는 Better Auth 가 세션을 읽을 때 쓰는 바로 그 함수(ctx.getSignedCookie — session.mjs 가 부르는 것)로 읽고,
            // Bearer 는 bearer 플러그인과 같은 규칙으로 읽는다. 둘 중 무엇을 Better Auth 가 쓰든 후보 안에 들어 있다.
            const fromCookie = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
            const fromBearer = bearerToken(ctx.request?.headers.get("authorization") ?? ctx.headers?.get("authorization"));
            const tokens = [fromCookie, fromBearer].filter((t): t is string => typeof t === "string" && t !== "");
            if (await carriesAppSession(pool, tokens)) throw new APIError("FORBIDDEN", APP_SESSION_FORBIDDEN);
          }),
        },
      ],
    },
    endpoints: {
      staffAppSignIn: createAuthEndpoint(STAFF_APP_SIGN_IN_PATH, { method: "POST", body: bodySchema }, async (ctx) => {
        // username 플러그인 기본 정규화(소문자)와 같게 맞춘다 — 대소문자만 바꿔 실패 횟수를 피해 가지 못하게.
        const username = ctx.body.username.toLowerCase();
        const subjects = [`account:${username}`, `ip:${clientIp(ctx.headers)}`];
        const invalid = () => APIError.from("UNAUTHORIZED", USERNAME_ERROR_CODES.INVALID_USERNAME_OR_PASSWORD);

        // 실패 한 번 = 아이디 칸·IP 칸 둘 다 1 더하기. 로그인·6자리 실패와 같은 칸(authFailure)이다.
        const fail = async (): Promise<never> => {
          if (limit) await limit.limiter.recordFailure(limit.rule, subjects).catch((e: unknown) => rethrow(e));
          throw invalid();
        };
        const rethrow = (e: unknown): never => {
          if (e instanceof HttpError && e.status === 429) throw toRateLimitedApiError(e);
          throw e;
        };

        // ⑤ 시도 전에 막혀 있나 본다(맞는 비밀번호라도 막는다 — 그래야 맞을 때까지 넣어 보는 공격이 멈춘다).
        if (limit) await limit.limiter.assertAllowed(limit.rule, subjects).catch((e: unknown) => rethrow(e));

        const user = await ctx.context.adapter.findOne<{ id: string; [key: string]: unknown }>({
          model: "user",
          where: [{ field: "username", value: username }],
        });
        if (!user) {
          // 없는 아이디도 해시 한 번만큼 시간을 쓴다 — 응답 시간으로 계정 유무를 가늠하지 못하게(기존 로그인과 같다).
          await ctx.context.password.hash(ctx.body.password);
          return fail();
        }
        const account = await ctx.context.internalAdapter.findCredentialAccount(user.id);
        if (!account?.password) return fail();
        if (!(await ctx.context.password.verify({ hash: account.password, password: ctx.body.password }))) return fail();

        // ② 비밀번호가 맞은 뒤에만 직원 여부를 알려 준다(이미 비밀번호를 아는 사람에게만 보이는 정보).
        const status = await staffStatus(pool, user.id);
        if (status === null || status === "withdrawn") throw new APIError("FORBIDDEN", STAFF_REQUIRED);
        if (status !== "active") throw new APIError("FORBIDDEN", SUSPENDED);

        // ③ 세션 만들기. 이름표(appSession=true)를 이 자리에서 직접 넘긴다(경로 비교에 기대지 않는다 — 보안 리뷰 L1).
        //    마지막 인자 true(overrideAll): 넘긴 칸이 추가 칸 기본값(false)에 덮이지 않게 한다(설치본 createSession 실측).
        //    staff-auth.ts 의 세션 훅은 이 이름표를 보고 secondFactorVerified=false 로 못 박는다.
        const session = await ctx.context.internalAdapter.createSession(user.id, false, { [APP_SESSION_FIELD]: true }, true);
        if (!session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Failed to create session" });

        // ④ 쿠키는 심지 않는다. 앱은 본문의 token 을 Bearer 로 쓴다(계약 §2).
        return ctx.json({
          token: session.token,
          user: { id: user.id, username: user["username"], displayUsername: user["displayUsername"], name: user["name"] },
        });
      }),
    },
  } satisfies BetterAuthPlugin;
}
