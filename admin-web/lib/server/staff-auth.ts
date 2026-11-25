// 직원 로그인 설정(S0-3.3) — Better Auth 설정 파일 하나.
//   직원(강사·대표·운영자)은 「아이디 + 비밀번호」로 들어오고, 2단계 인증은 「인증 앱(TOTP)」 하나만 쓴다.
//   계약: _workspace/03_contracts/README.md 6-1(세션과 로그인 흐름).
//
// 왜 플러그인을 이 셋만 켜나(껐다는 것이 곧 설계다):
//   - username  : 아이디 로그인(POST /api/auth/sign-in/username)
//   - twoFactor : 인증 앱 6자리 코드. otpOptions.sendOTP 를 주지 않으므로 문자·이메일 코드는 켜지지 않는다.
//   - bearer    : 강사·대표 앱이 쿠키 대신 토큰으로 같은 계정을 쓴다(계약 §2).
//   패스키·phone-number 플러그인은 아예 넣지 않는다 → 그 경로는 라우터에 없어서 404 가 난다.
// 공개 가입은 막는다(disableSignUp): 직원 계정은 초대·승인으로만 만든다(FR-300).
//
// S0-3.8(관리자 웹 2단계 인증 게이트) — 세션마다 「2단계를 마쳤나」를 적는다(session.secondFactorVerified).
//   왜 계정 값(twoFactorEnabled)만으로 부족하나: 인증 앱을 등록하기 전에 비밀번호만으로 만든 세션(예: 다른 기기,
//   강사 앱의 토큰)은 등록이 끝난 뒤에도 그대로 남는다. 계정 값만 보면 그 「1단계만 마친 세션」이 콘솔을 연다.
//   그래서 세션이 만들어지는 순간의 계정 상태를 세션에 박아 둔다 — 아래 SECOND_FACTOR_SESSION_FIELD 참고.
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer } from "better-auth/plugins/bearer";
import { twoFactor } from "better-auth/plugins/two-factor";
import { username } from "better-auth/plugins/username";
import { Kysely, PostgresDialect } from "kysely";
import type { Pool } from "pg";

import { APP_WEB_DEV_ORIGIN } from "../../proxy";
import {
  APP_SESSION_FIELD,
  appCallerSession,
  rejectAppCaller,
  STAFF_APP_SIGN_IN_PATH,
  staffAppSignInPlugin,
  type StaffAppSignInLimit,
} from "./staff-app-sign-in";

export { APP_SESSION_FIELD, STAFF_APP_SIGN_IN_PATH } from "./staff-app-sign-in";

export type StaffAuthOptions = {
  /** 앱이 쓰는 pg 풀(prisma/db.ts 의 BYO 풀). 접속 수를 늘리지 않으려고 같은 풀을 넘겨받는다. */
  pool: Pool;
  /** 쿠키·토큰 서명용 비밀값(.env 의 BETTER_AUTH_SECRET). */
  secret: string;
  /** 이 서버의 바깥 주소(예: https://admin.example.com). */
  baseURL: string;
  /**
   * 앱 로그인(POST /api/auth/sign-in/staff-app)의 아이디·IP 실패 횟수 제한(계약 §6-4 authFailure).
   * 실서버 인스턴스(staff-auth-instance.ts)는 늘 넘긴다. 빠지면 Better Auth 기본 제한(IP·경로당 10초 3회, 운영만)만 걸린다.
   */
  appSignInLimit?: StaffAppSignInLimit;
};

/** 인증 앱 등록 화면에 보이는 발급처 이름. */
export const STAFF_TOTP_ISSUER = "K-DanceX4";

// twoFactor 플러그인은 문자·이메일 코드 경로(send-otp·verify-otp)와 백업 코드 경로를 라우터에 항상 올려 둔다.
// 문자·이메일은 설정이 없어 400 으로 실패할 뿐 경로 자체는 보이므로, 「없는 경로」(404)가 되도록 앞단에서 막는다.
// S0-3.9(같은 기기 30일 기억 설정) — 백업 코드는 쓰지 않는다(spec FR-303, 2026-11-19 사용자 확정).
//   코드를 못 받으면 「플랫폼 지원 문의」로 풀어 준다. 백업 코드로 2단계를 넘는 길이 남지 않게 두 경로도 404 로 막는다.
export const STAFF_DISABLED_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
  "/two-factor/verify-backup-code",
  "/two-factor/generate-backup-codes",
  // 비밀번호만으로 인증 앱 비밀값을 돌려주는 읽기 경로. 우리 화면은 등록 때 enable 응답의 totpURI 만 쓴다.
  // 앱 세션 차단(앞단 한 겹)만 지키던 자리라 아예 없앤다(2026-11-25 보안 리뷰 r3 LOW-1).
  "/two-factor/get-totp-uri",
]);

/** 앞단 훅: 막아 둔 경로는 라우터에 없는 것처럼 404 를 준다. */
export const staffAuthBeforeHook = createAuthMiddleware(async (ctx) => {
  if (STAFF_DISABLED_AUTH_PATHS.has(ctx.path)) throw new APIError("NOT_FOUND", { message: "Not Found" });
});

// ── S0-3.9(같은 기기 30일 기억 설정) ─────────────────────────────────────────────
// 6자리를 넣을 때 trustDevice: true 를 같이 보내면 그 기기(브라우저·앱)에 「기억 쿠키」(trust_device)가 생기고,
// 그 뒤 30일 동안은 같은 기기에서 비밀번호만으로 들어온다. 이 30일 값은 여기 한 곳에만 둔다.

/** 같은 기기를 기억하는 날 수. spec FR-303 「같은 기기 30일」. */
export const TRUST_DEVICE_DAYS = 30;
/** 플러그인 설정(trustDeviceMaxAge)은 초 단위로 받는다. */
export const TRUST_DEVICE_MAX_AGE_SECONDS = TRUST_DEVICE_DAYS * 24 * 60 * 60;

// 플러그인이 기억 기록(auth.verification 한 행)의 identifier 앞에 붙이는 글자(two-factor 설치본 실측).
const TRUST_DEVICE_IDENTIFIER_PREFIX = "trust-device-";

// 왜 훅이 더 필요한가 — 「30일은 처음 인증한 날부터 고정, 로그인할 때마다 늘리지 않는다」(spec FR-303, 2026-11-19).
//   플러그인(1.7.5)은 기억 쿠키로 로그인할 때마다 옛 기록을 지우고 「지금부터 30일」짜리 새 기록을 만든다.
//   그대로 두면 29일째에 한 번 들어오면 59일째까지 6자리를 안 묻는다(밀어내기).
//   그래서 같은 요청 안에서 지워지는 옛 기록의 만료 시각을 잠깐 쥐고 있다가, 새로 만드는 기록에 그대로 옮겨 준다.
//   요청(엔드포인트 문맥)을 열쇠로 쓰는 WeakMap 이라 요청이 끝나면 저절로 사라지고, 다른 요청으로 새지 않는다.
const rotatingTrustExpiry = new WeakMap<object, Date>();

type VerificationRow = { identifier: string; expiresAt: Date };

function isTrustDeviceRow(row: { identifier?: unknown }): boolean {
  return typeof row.identifier === "string" && row.identifier.startsWith(TRUST_DEVICE_IDENTIFIER_PREFIX);
}

/** databaseHooks.verification — 기억 기록의 만료를 처음 인증한 날 + 30일로 묶어 둔다. */
export const trustDeviceFixedWindowHooks = {
  delete: {
    // 기억 쿠키로 로그인하는 순간 플러그인이 옛 기록을 지운다 → 그 만료 시각을 이 요청에 적어 둔다.
    before: async (row: VerificationRow, ctx: object | null | undefined) => {
      if (ctx && isTrustDeviceRow(row)) rotatingTrustExpiry.set(ctx, new Date(row.expiresAt));
    },
  },
  create: {
    // 같은 요청에서 새 기억 기록을 만들면, 새 30일 대신 옛 만료 시각을 그대로 쓴다.
    // 6자리로 처음 기억시킬 때(verify-totp)는 지운 기록이 없으므로 플러그인 값(지금 + 30일)이 그대로 간다.
    before: async (row: VerificationRow, ctx: object | null | undefined) => {
      if (!ctx || !isTrustDeviceRow(row)) return;
      const original = rotatingTrustExpiry.get(ctx);
      if (!original) return;
      rotatingTrustExpiry.delete(ctx);
      const fixed = original < new Date(row.expiresAt) ? original : new Date(row.expiresAt);
      return { data: { ...row, expiresAt: fixed } };
    },
  },
};

// ── 인증 앱 코드가 바뀌는 간격(2026-11-23 사용자 결정) ─────────────────────────────
// 표준(RFC 6238)은 30초다. Google Authenticator·Microsoft Authenticator 는 간격 설정을 무시하고 30초로만 만들므로
// 베타·운영은 반드시 30초다. 개발 PC 에서 사람이 직접 따라 넣으며 시연할 때만 5분으로 늘린다.
// 「개발 PC」 판정은 dev 경로 스위치(KDANCE_DEV_ROUTES 가 정확히 "true")와 KDANCE_ENV=development(빈 값 포함)가 둘 다 맞을 때뿐이다
// — 테스트는 이 스위치 없이 auth 를 만들므로 30초 그대로다(30초 코드를 계산하는 기존 테스트가 깨지지 않는다).

/** 표준 간격(초) */
export const STANDARD_TOTP_PERIOD_SECONDS = 30;
/** 개발 PC 시연용 간격(초) — 5분 */
export const DEV_TOTP_PERIOD_SECONDS = 300;

/** 지금 환경에서 쓸 간격(초). auth 를 만들 때 한 번 정한다 */
export function staffTotpPeriodSeconds(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const deployEnv = (env["KDANCE_ENV"] ?? "").trim();
  const devPc = env["KDANCE_DEV_ROUTES"] === "true" && (deployEnv === "" || deployEnv === "development");
  return devPc ? DEV_TOTP_PERIOD_SECONDS : STANDARD_TOTP_PERIOD_SECONDS;
}

// S3-4.7b(앱 캘린더·알림함·내역 시연 데이터) — 2026-11-23 사용자 결정 「개발 전용으로 8081 신뢰」.
//   Better Auth 는 로그인 요청의 Origin 이 baseURL(관리자 웹 :3000)과 다르면 403 INVALID_ORIGIN 으로 막는다.
//   앱을 PC 브라우저(Expo 웹, localhost:8081)로 띄워 실서버에 이메일 로그인하면 이 검사에 걸린다.
//   그래서 dev 경로 스위치(KDANCE_DEV_ROUTES 가 정확히 "true")일 때만 앱 웹 출처 하나를 믿는 출처에 더한다.
//   판정 규칙은 proxy.ts(앱 웹 CORS)와 같다 — 운영·베타는 이 값을 비우므로 빈 목록 = 지금처럼 막힌다.
//   휴대폰 앱(네이티브)은 Origin 을 싣지 않아 이 설정과 상관없다.

/** 지금 환경에서 더 믿을 출처 목록. 개발 PC 면 [앱 웹 출처], 아니면 빈 목록 */
export function staffTrustedOrigins(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  return env["KDANCE_DEV_ROUTES"] === "true" ? [APP_WEB_DEV_ORIGIN] : [];
}

/** 직원 2단계 인증 플러그인. 인증 앱(TOTP)만, 같은 기기 30일. createStaffAuth 와 테스트가 같은 설정을 쓴다. */
export function staffTwoFactorPlugin() {
  // sendOTP 를 주지 않아 문자·이메일 OTP 경로는 꺼져 있다.
  return twoFactor({
    issuer: STAFF_TOTP_ISSUER,
    trustDeviceMaxAge: TRUST_DEVICE_MAX_AGE_SECONDS,
    totpOptions: { period: staffTotpPeriodSeconds() },
  });
}

/** 세션 표(auth.session)에 더하는 칸 이름. 가드(guards.ts)가 이 값을 읽는다. */
export const SECOND_FACTOR_SESSION_FIELD = "secondFactorVerified";

export function createStaffAuth({ pool, secret, baseURL, appSignInLimit }: StaffAuthOptions) {
  // Better Auth 는 Kysely 로 DB 에 붙는다. 테이블은 `auth` 스키마에 둔다(public 을 건드리지 않는다).
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });

  return betterAuth({
    secret,
    baseURL,
    // 개발 PC 에서만 앱 웹(:8081) 출처를 더 믿는다(위 staffTrustedOrigins). auth 를 만들 때 한 번 정한다.
    trustedOrigins: staffTrustedOrigins(),
    appName: STAFF_TOTP_ISSUER,
    database: { db, type: "postgres", schemaName: "auth" },
    session: {
      // 2단계를 마친 세션인가. 사용자가 보내는 값으로는 바꿀 수 없다(input: false) — 아래 훅만 정한다.
      additionalFields: {
        [SECOND_FACTOR_SESSION_FIELD]: { type: "boolean", required: false, defaultValue: false, input: false },
        // 앱 로그인(/sign-in/staff-app)으로 만든 세션의 이름표(2026-11-25, 보안 리뷰 C1·H1). 엔드포인트가 직접 true 로 적는다.
        // 이 이름표가 붙은 세션은 2단계를 마친 세션이 될 수 없고, 2단계·계정 관리 경로를 부르지 못한다(staff-app-sign-in.ts).
        [APP_SESSION_FIELD]: { type: "boolean", required: false, defaultValue: false, input: false },
      },
    },
    databaseHooks: {
      session: {
        // 앱 세션이 지울 수 있는 세션은 자기 자신뿐이다(로그아웃). 남의 세션을 지우는 revoke-* 는 여기서 끊는다.
        delete: {
          before: async (row: { token?: unknown }, ctx: unknown) => {
            const caller = appCallerSession(ctx);
            if (caller && row.token !== caller["token"]) rejectAppCaller(ctx);
          },
        },
        create: {
          // 세션이 생기는 순간, 그 계정이 이미 인증 앱을 켜 두었으면 「2단계를 마친 세션」으로 적는다.
          // 이 판정이 맞는 이유(two-factor 설치본 실측, S0-3.2·S0-3.6):
          //   - 인증 앱이 켜진 계정은 비밀번호만으로는 세션이 남지 않는다 — 플러그인이 곧바로 지우고
          //     twoFactorRedirect 를 준다. 남는 것은 6자리 코드(verify-totp)나 같은 기기 30일 쿠키를 거친 세션뿐이다.
          //   - 인증 앱을 처음 등록할 때는 플러그인이 계정 값을 먼저 켜고 나서 새 세션을 만든다 → 그 새 세션도 true.
          //   - 등록 전에 만든 세션은 그때 계정 값이 꺼져 있었으므로 false 로 남는다 → 콘솔에서 401.
          //   - 앱 세션(2026-11-25)은 6자리 없이 만들어진다 → 계정 값과 상관없이 false, 이름표(appSession)도 true 로 못 박는다.
          //     「앱 세션인가」는 막는 쪽으로 넓게 본다(보안 리뷰 L1) — 셋 중 하나라도 맞으면 앱 세션이다:
          //       ① 엔드포인트가 넘긴 이름표 ② 지금 요청 경로가 앱 로그인 ③ 지금 요청을 보낸 세션이 앱 세션(앱 세션이 어떤 길로든
          //       새 세션을 만들게 되면 그 새 세션도 앱 세션으로 물려받는다 — C1 의 「verify-totp 로 새 세션」 같은 길을 원천 차단)
          //     이 판정이 빗나가도 guards.ts 의 isSecondFactorVerified 가 appSession 을 한 번 더 본다.
          before: async (session, ctx) => {
            const callerSession = (ctx?.context as { session?: { session?: Record<string, unknown> } | null } | undefined)?.session?.session;
            const fromApp =
              (session as Record<string, unknown>)[APP_SESSION_FIELD] === true ||
              ctx?.path === STAFF_APP_SIGN_IN_PATH ||
              callerSession?.[APP_SESSION_FIELD] === true;
            if (fromApp) {
              return { data: { ...session, [APP_SESSION_FIELD]: true, [SECOND_FACTOR_SESSION_FIELD]: false } };
            }
            const { rows } = await pool.query<{ twoFactorEnabled: boolean | null }>(
              'SELECT "twoFactorEnabled" FROM auth."user" WHERE id = $1',
              [session.userId],
            );
            const verified = rows[0]?.twoFactorEnabled === true;
            return { data: { ...session, [SECOND_FACTOR_SESSION_FIELD]: verified } };
          },
        },
      },
      verification: trustDeviceFixedWindowHooks,
      // ── 2차 재리뷰(R2-C1) 깊이 방어: 앱 세션으로는 계정·비밀번호·다른 세션을 바꾸지 못한다 ──────────────
      // 앞단 허용 목록 훅(staff-app-sign-in.ts)이 쿠키·토큰 해석 차이로 빗나가도, 데이터가 바뀌는 순간에 한 번 더 막는다.
      // 판정은 Better Auth 가 그 요청에서 실제로 쓴 세션(ctx.context.session)으로 한다 — 해석을 우리가 다시 하지 않는다.
      //   user    : 2단계 끄기·켜기(twoFactorEnabled), 이름·이메일 바꾸기, 탈퇴
      //   account : 비밀번호 바꾸기·설정(account.password), 소셜 연결·해제
      //   session : 다른 세션 끊기(revoke-*). 자기 세션 지우기(로그아웃)만 허용한다
      // 못 막는 것: 인증 앱 비밀값 표(twoFactor) — 플러그인이 hooks 를 거치지 않는 ctx.context.adapter 로 바로 쓴다(설치본 실측).
      //   이미 켜진 계정에 enable 을 다시 부르면 그 표의 비밀값만 바뀐다. 이 길은 앞단 허용 목록 훅만 지킨다.
      user: {
        update: { before: async (_data: unknown, ctx: unknown) => rejectAppCaller(ctx) },
        delete: { before: async (_data: unknown, ctx: unknown) => rejectAppCaller(ctx) },
      },
      account: {
        create: { before: async (_data: unknown, ctx: unknown) => rejectAppCaller(ctx) },
        update: { before: async (_data: unknown, ctx: unknown) => rejectAppCaller(ctx) },
        delete: { before: async (_data: unknown, ctx: unknown) => rejectAppCaller(ctx) },
      },
    },
    emailAndPassword: {
      enabled: true, // username 플러그인이 이 비밀번호 로그인 위에서 돈다
      disableSignUp: true, // 공개 가입 끔: POST /sign-up/email 은 거절된다
    },
    hooks: { before: staffAuthBeforeHook },
    plugins: [
      username(),
      // 인증 앱(TOTP)만 + 같은 기기 30일(S0-3.9). 설정은 staffTwoFactorPlugin 한 곳.
      staffTwoFactorPlugin(),
      bearer(),
      // 강사·대표 앱 전용 로그인 — 2단계를 묻지 않는 대신 그 세션은 콘솔을 열지 못한다(staff-app-sign-in.ts).
      staffAppSignInPlugin({ pool, limit: appSignInLimit }),
    ],
  });
}

export type StaffAuth = ReturnType<typeof createStaffAuth>;
