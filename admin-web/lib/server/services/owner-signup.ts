// S1-1.8(대표 가입 API) — 대표(입점 신청자) 가입 경로 셋의 처리기.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §0 · 권한 public(세션 없음)
//   근거: spec FR-011(강사·대표 계정 승인) 「대표도 가입할 때 휴대폰 본인확인」 · FR-249(약관 동의 기록)
//
// 흐름(앱 쪽): 본인확인 토큰 → ① identity-check → ② username-available → ③ signup
//   → 로그인(/api/auth/sign-in/username) → 인증 앱 등록(two-factor/enable → verify-totp, S0-3.8 그대로) → 입점 신청.
//
// 이 파일이 지키는 세 가지(verify):
//   - 본인확인 없이는 계정이 하나도 생기지 않는다 — 토큰을 먼저 풀고, 실패하면 DB 를 건드리지 않는다
//   - 같은 사람(CI)의 두 번째 직원 계정은 409 STAFF_ACCOUNT_EXISTS(uq_staff_accounts_ci 가 최종 방어선)
//   - 가입 직후에는 owner 역할이 없다 — 역할은 입점 승인 때 운영자가 준다(role-grants.ts 의 부여 경로)
import { z } from "zod";

import type { Db } from "../../../prisma/db";
import {
  STAFF_DISPLAY_NAME_MAX_LENGTH,
  isValidStaffUsername,
  maskUsername,
  passwordProblem,
  verificationTokenSchema,
} from "../../domain/staff-signup";
import type { Clock } from "../../domain/time";
import { HttpError, parseJsonBody, parseWith, withRoute } from "../http";
import type { IdentityVerificationPort } from "../ports/identity";
import type { RateLimitRule, RateLimiter } from "../rate-limit";
import { findStaffByCi, insertStaffAccount, isUsernameTaken, resolveIdentity } from "./staff-signup";

/** 아이디 중복 확인 요청 제한 — 아이디가 있는지 알려 주는 경로라 마구 넣어 보지 못하게(15분 30회, 추천값) */
export const USERNAME_CHECK_RULE: RateLimitRule = Object.freeze({ name: "signup-username-check", limit: 30, windowSeconds: 15 * 60 });

export type OwnerSignupDeps = {
  db: Db;
  identityVerification: IdentityVerificationPort;
  clock: Clock;
  limiter: RateLimiter;
  /** 본인확인을 쓰는 두 경로(identity-check·signup)의 제한. 보통 loadRateLimitRules().identityVerification */
  identityRule: RateLimitRule;
};

// ---- 요청·응답 계약(07 §0). 테스트가 본문을 이 스키마로 parse 해 키 이름·타입을 1대1로 본다 ------------

export const identityCheckRequestSchema = z.strictObject({ verificationToken: verificationTokenSchema });
export const identityCheckResponseSchema = z.strictObject({
  eligible: z.literal(true),
  nameMasked: z.string(),
  phoneMasked: z.string(),
  ageVerified: z.literal(true),
});

export const usernameAvailableResponseSchema = z.union([
  z.strictObject({ available: z.literal(true) }),
  z.strictObject({ available: z.literal(false), reason: z.enum(["taken", "format"]) }),
]);

export const ownerSignupRequestSchema = z
  .strictObject({
    verificationToken: verificationTokenSchema,
    username: z.string().refine(isValidStaffUsername, "아이디는 영문 소문자·숫자 4~20자예요"),
    password: z.string(),
    displayName: z.string().trim().min(1).max(STAFF_DISPLAY_NAME_MAX_LENGTH),
    // 동의 여부는 boolean 으로만 받는다 — false 는 형식 오류가 아니라 422 CONSENT_REQUIRED 로 따로 알린다
    consents: z.strictObject({ merchantPrivacyCollection: z.boolean() }),
  })
  .superRefine((body, ctx) => {
    // 비밀번호 규칙(Q41)은 아이디를 알아야 판정한다(「아이디와 같으면 안 됨」) — 그래서 객체 단위로 본다
    const problem = passwordProblem(body.password, body.username);
    if (problem !== null) ctx.addIssue({ code: "custom", path: ["password"], message: problem });
  });

export const ownerSignupResponseSchema = z.strictObject({
  accountId: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  roles: z.array(z.string()).length(0),
  next: z.literal("sign_in"),
});

const DETAIL = {
  underAge: "만 19세 이상만 가입할 수 있어요",
  exists: "이미 가입한 계정이 있어요. 그 아이디로 로그인해 주세요",
  usernameTaken: "이미 쓰고 있는 아이디예요",
  consent: "개인정보 수집·이용에 동의해 주세요",
} as const;

const UNDER_AGE = { code: "OWNER_UNDER_19", detail: DETAIL.underAge } as const;
const PRIVACY_KIND = "merchant_privacy_collection";

/**
 * 요청 제한의 대상 = 보낸 쪽 IP. 세션이 없는 경로라 계정으로는 셀 수 없다.
 * 앞단 프록시가 넣는 x-forwarded-for 의 첫 값을 쓴다(없으면 하나의 칸 「unknown」에 모아 센다 — 막는 쪽으로).
 * 강사 가입(instructor-signup.ts)도 같은 규칙으로 센다.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** 이미 있는 사람에게 줄 409. 가린 아이디만 싣는다(역할·CI 는 내보내지 않는다) */
function staffExists(username: string): HttpError {
  return HttpError.conflict("STAFF_ACCOUNT_EXISTS", DETAIL.exists, { maskedUsername: maskUsername(username) });
}

export function createOwnerSignupRoutes(deps: OwnerSignupDeps) {
  const { db, identityVerification, clock, limiter, identityRule } = deps;

  /** 지금 시행 중인 개인정보 수집·이용 판본(07 §2 「현재 판본」 규칙과 같다). 없으면 운영자가 발행해야 한다 → 500 */
  async function currentPrivacyVersionId(tx: Parameters<Parameters<Db["transaction"]>[0]>[0]): Promise<string> {
    const [row] = await tx.query(
      tx.raw.sql`SELECT id FROM terms_versions WHERE kind = ${PRIVACY_KIND} AND effective_at <= now()
                 ORDER BY effective_at DESC, published_at DESC LIMIT 1`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (row === undefined) throw new Error("시행 중인 merchant_privacy_collection 약관 판본이 없다(운영자가 먼저 발행해야 한다)");
    return row.id;
  }

  /** ① POST /api/owner/signup/identity-check — 가입 자격 먼저 보기. 아무것도 쓰지 않는다 */
  const identityCheck = withRoute<unknown>(async (request) => {
    await limiter.consume(identityRule, [`ip:${clientIp(request)}`]);
    const { verificationToken } = await parseJsonBody(request, identityCheckRequestSchema);
    const person = await resolveIdentity(identityVerification, verificationToken, clock(), UNDER_AGE);
    const existing = await findStaffByCi(db, person.ciHash);
    if (existing !== null) throw staffExists(existing.username);
    const body: z.infer<typeof identityCheckResponseSchema> = {
      eligible: true,
      nameMasked: person.nameMasked,
      phoneMasked: person.phoneMasked,
      ageVerified: true,
    };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  });

  /** ② GET /api/owner/signup/username-available?username= — 형식이 틀리면 DB 를 보지 않고 format 으로 답한다 */
  const usernameAvailable = withRoute<unknown>(async (request) => {
    await limiter.consume(USERNAME_CHECK_RULE, [`ip:${clientIp(request)}`]);
    const { username } = parseWith(
      z.object({ username: z.string().max(100) }),
      { username: new URL(request.url).searchParams.get("username") ?? "" },
    );
    let body: z.infer<typeof usernameAvailableResponseSchema>;
    if (!isValidStaffUsername(username)) body = { available: false, reason: "format" };
    else if (await isUsernameTaken(db, username)) body = { available: false, reason: "taken" };
    else body = { available: true };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  });

  /** ③ POST /api/owner/signup — 계정 만들기. 순서: 제한 → 본문 → 동의 → 본인확인 → (트랜잭션) 계정·감사 */
  const signup = withRoute<unknown>(async (request) => {
    await limiter.consume(identityRule, [`ip:${clientIp(request)}`]);
    const input = await parseJsonBody(request, ownerSignupRequestSchema);
    if (!input.consents.merchantPrivacyCollection) throw HttpError.unprocessable("CONSENT_REQUIRED", DETAIL.consent);

    // 본인확인이 먼저다 — 토큰이 틀리면 여기서 422 로 끝나 어떤 행도 생기지 않는다(verify 「본인확인 없이 가입 0」)
    const now = clock();
    const person = await resolveIdentity(identityVerification, input.verificationToken, now, UNDER_AGE);

    // 이미 있는 사람은 트랜잭션 전에 걸러 친절한 409(가린 아이디)를 준다. 동시 요청은 아래 유니크가 막는다
    const existing = await findStaffByCi(db, person.ciHash);
    if (existing !== null) throw staffExists(existing.username);

    // 동시 가입에서 진 쪽 — 유니크 색인에 막혔을 때 「내가 적은 아이디」를 가려 보내면 안내가 틀린다.
    // 트랜잭션 안에서는 표식 오류만 던지고, 되돌려진 뒤 밖에서 먼저 만든 계정을 다시 읽어 같은 409 를 준다
    // (강사 가입 S2-1.2a 와 같은 방식)
    const ciRaceLost = HttpError.conflict("STAFF_ACCOUNT_EXISTS", DETAIL.exists);
    const created = await db.transaction(async (tx) => {
      const privacyVersionId = await currentPrivacyVersionId(tx);
      const account = await insertStaffAccount(
        tx,
        { person, username: input.username, password: input.password, displayName: input.displayName },
        {
          ciTaken: () => ciRaceLost,
          usernameTaken: () => HttpError.conflict("USERNAME_TAKEN", DETAIL.usernameTaken),
        },
      );
      // 감사 1행 = 가입 기록 + 개인정보 동의 기록(판본 id·서버 시각). staff_consents 가 생기기 전까지의 자리다(07 열린 점 ⑤ ⓐ).
      // 이름·연락처·CI 는 남기지 않는다
      const after = JSON.stringify({
        username: input.username,
        displayName: input.displayName,
        roles: [],
        consents: [{ item: PRIVACY_KIND, termsVersionId: privacyVersionId, agreedAt: now.toString() }],
      });
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, action, target_table, target_id, after)
                   VALUES (uuidv7(), 'staff', ${account.staffAccountId}::uuid, 'owner.signup_completed',
                           'staff_accounts', ${account.staffAccountId}::uuid, ${after}::json)`
          .affectedCount()
          .build(),
      );
      return account;
    }).catch(async (error: unknown) => {
      if (error !== ciRaceLost) throw error;
      // 이긴 쪽은 이미 커밋됐다 — 그 계정의 아이디(가림)로 위의 순차 경로와 같은 409 를 준다
      const winner = await findStaffByCi(db, person.ciHash);
      // 이긴 쪽마저 되돌려진 드문 경우 — 가린 아이디를 채울 수 없으니 500 으로 멈추고 다시 시도하게 한다
      if (winner === null) throw new Error("같은 CI 동시 가입에서 이긴 계정을 찾지 못했다");
      throw staffExists(winner.username);
    });

    const body: z.infer<typeof ownerSignupResponseSchema> = {
      accountId: created.staffAccountId,
      username: input.username,
      displayName: input.displayName,
      roles: [],
      next: "sign_in",
    };
    return Response.json(body, { status: 201, headers: { "Cache-Control": "no-store" } });
  });

  return { identityCheck, usernameAvailable, signup };
}
