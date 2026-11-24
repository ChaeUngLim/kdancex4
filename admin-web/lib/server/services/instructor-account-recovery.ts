// S2-1.8(강사 계정 찾기·비밀번호 재설정 API(I31B)) — 경로 둘의 처리기.
//   계약: _workspace/03_contracts/11-instructor.md §1-4 · 권한 public(세션 없음 — 로그인을 못 하는 사람이 쓰는 경로다)
//   근거: spec FR-011(강사·대표 계정 승인) 「아이디·비밀번호 찾기」 화면 문단 · FR-191(로그인 세션·기기 분실) · Q41(강사 가입 규칙)
//
// 흐름(앱 I31B): 휴대폰 본인확인 → ① lookup(「찾은 계정」 카드) → ② reset-password(같은 토큰 + 새 비밀번호)
//
// 이 파일이 지키는 네 가지(verify):
//   - 찾는 열쇠는 본인확인 토큰을 푼 CI 해시 하나뿐이다. 아이디·이름·전화번호를 받지 않으니, 남의 토큰이 없으면 남의 계정을 못 찾는다
//   - 한 사람(CI)에 강사 계정은 하나라(uq_staff_accounts_ci) 늘 계정 하나만 보인다. 강사 역할이 없으면 404
//   - 응답에서 그대로 보이는 것은 아이디뿐이다. 이름·전화번호는 가린 값, 학원은 이름과 수만
//   - 비밀번호를 바꾸면 같은 트랜잭션에서 그 계정의 모든 세션과 같은 기기 30일 기억(trust_device)을 지운다 → 다른 기기 로그인이 모두 끝난다
//
// 토큰 재사용 막기(계약 §1-4 「jti 기록」): 가짜 본인확인 토큰에는 jti 칸이 없다. 그래서 토큰 글자 전체의 sha256 을 jti 로 쓴다
//   (서명이 들어 있어 토큰마다 다르다). 기록은 Better Auth 의 auth.verification 에 한 줄로 둔다 — 같은 기기 기억(trust-device-…)이
//   이미 쓰는 표라 새 테이블·마이그레이션이 필요 없다. 원문 토큰은 저장하지 않는다.
import { createHash } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import { z } from "zod";

import type { Db } from "../../../prisma/db";
import { maskPersonName, maskPhone, passwordProblem, verificationTokenSchema } from "../../domain/staff-signup";
import { HttpError, parseJsonBody, withRoute } from "../http";
import { clientIp, type OwnerSignupDeps } from "./owner-signup";
import type { Tx } from "./staff-signup";

/** 강사 가입과 같은 재료(db · 본인확인 포트 · 시계 · 요청 제한)를 받는다 */
export type InstructorAccountRecoveryDeps = OwnerSignupDeps;

// ---- 요청·응답 계약(11 §1-4). 테스트가 본문을 이 스키마로 parse 해 키 이름·타입을 1대1로 본다 -------------

export const accountRecoveryLookupRequestSchema = z.strictObject({ verificationToken: verificationTokenSchema });

export const accountRecoveryLookupResponseSchema = z.strictObject({
  nameMasked: z.string(),
  phoneMasked: z.string(),
  username: z.string(),
  // 가입한 날(KST 날짜)
  joinedOn: z.iso.date(),
  // 소속된 학원 이름(앞에서 ACADEMY_NAME_PREVIEW 개)과 전체 수 — 화면은 「라틴하우스 강남 외 1」로 보인다
  academyNames: z.array(z.string()),
  academyCount: z.number().int().nonnegative(),
});

export const accountRecoveryResetRequestSchema = z.strictObject({
  verificationToken: verificationTokenSchema,
  // 형식(8자 이상·영문·숫자·기호·아이디와 다름)은 아이디를 알아야 판정한다 → 계정을 찾은 뒤 처리기에서 본다
  newPassword: z.string().max(200),
});

export const accountRecoveryResetResponseSchema = z.strictObject({
  ok: z.literal(true),
  sessionsRevoked: z.number().int().nonnegative(),
});

/** 찾은 계정 카드에 보이는 학원 이름 수. 계약 예시(이름 1개 + 수 2)와 같다 */
export const ACADEMY_NAME_PREVIEW = 1;

/** 쓴 토큰 기록을 얼마나 남기나. 토큰 유효 시간(10분)보다 넉넉히 길면 된다 — 만료된 토큰은 verify 가 먼저 막는다 */
const USED_TOKEN_KEEP_HOURS = 24;
const USED_TOKEN_IDENTIFIER_PREFIX = "identity-token-used-";
// 같은 기기 30일 기억 기록의 identifier 앞 글자(two-factor 설치본 실측, staff-auth.ts 와 같은 값)
const TRUST_DEVICE_IDENTIFIER_PREFIX = "trust-device-";

const DETAIL = {
  tokenInvalid: "본인확인을 다시 해 주세요",
  notFound: "이 본인확인으로 가입한 강사 계정이 없어요",
  tokenUsed: "이미 쓴 본인확인이에요. 본인확인을 다시 해 주세요",
} as const;

/** 본인확인 토큰 → jti(토큰 글자 전체의 sha256 hex). 원문은 어디에도 남기지 않는다 */
function tokenJti(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 토큰을 푼다. 무효·만료는 422 VALIDATION_FAILED(가입 경로와 같은 코드). 나이는 보지 않는다 — 미성년은 애초에 계정이 없다 */
async function verifyPerson(deps: InstructorAccountRecoveryDeps, token: string, now: Temporal.Instant) {
  const result = await deps.identityVerification.verify(token, now);
  if (!result.ok) {
    throw new HttpError("VALIDATION_FAILED", DETAIL.tokenInvalid, {
      fields: [{ path: "verificationToken", message: result.reason === "expired" ? "본인확인 시간이 지났어요" : "본인확인 결과가 맞지 않아요" }],
    });
  }
  return result;
}

/** joinedOn = 가입한 날(KST 날짜 "YYYY-MM-DD") — DB 에서 KST 로 바꿔 읽는다 */
type InstructorAccount = { staffAccountId: string; authUserId: string; username: string; joinedOn: string };

/**
 * 같은 CI 의 강사 계정 하나. 강사 역할(active)이 없으면 null — 대표 계정만 있는 사람도 여기서는 「강사 계정 없음」이다.
 * CI 유니크(uq_staff_accounts_ci)라 행은 많아야 하나다.
 */
async function findInstructorByCi(db: Db | Tx, ciHash: string): Promise<InstructorAccount | null> {
  const [row] = await db.query(
    db.raw.sql`SELECT s.id, s.auth_user_id, u.username, (s.created_at AT TIME ZONE 'Asia/Seoul')::date::text AS joined_on
               FROM staff_accounts s JOIN auth."user" u ON u.id = s.auth_user_id
               WHERE s.identity_ci_hash = ${ciHash}
                 AND EXISTS (SELECT 1 FROM role_grants g
                             WHERE g.staff_account_id = s.id AND g.role = 'instructor' AND g.status = 'active')`
      .returnsRow({ id: "pg/uuid@1", auth_user_id: "pg/text@1", username: "pg/text@1", joined_on: "pg/text@1" })
      .build(),
  );
  if (row === undefined) return null;
  return { staffAccountId: row.id, authUserId: row.auth_user_id, username: row.username, joinedOn: row.joined_on };
}

/** 소속된(active) 학원 이름 — 소속이 먼저 정해진 순 */
async function activeAcademyNames(db: Db, staffAccountId: string): Promise<string[]> {
  const rows = await db.query(
    db.raw.sql`SELECT a.name FROM instructor_affiliations f JOIN academies a ON a.id = f.academy_id
               WHERE f.instructor_account_id = ${staffAccountId}::uuid AND f.status = 'active'
               ORDER BY f.decided_at NULLS LAST, f.requested_at, a.name`
      .returnsRow({ name: "pg/text@1" })
      .build(),
  );
  return rows.map((r) => r.name);
}

/** DELETE … RETURNING 한 행 수를 센다(지운 세션 수를 응답에 싣는다) */
async function deleteSessions(tx: Tx, authUserId: string): Promise<number> {
  const [row] = await tx.query(
    tx.raw.sql`WITH d AS (DELETE FROM auth.session WHERE "userId" = ${authUserId} RETURNING 1)
               SELECT count(*)::int AS n FROM d`
      .returnsRow({ n: "pg/int4@1" })
      .build(),
  );
  return row?.n ?? 0;
}

export function createInstructorAccountRecoveryRoutes(deps: InstructorAccountRecoveryDeps) {
  const { db, clock, limiter, identityRule } = deps;

  /** ① POST /api/instructor/account-recovery/lookup — 본인확인한 사람의 강사 계정 찾기. 아무것도 쓰지 않는다(토큰도 쓰지 않음) */
  const lookup = withRoute<unknown>(async (request) => {
    // 남의 아이디를 캐 보는 경로라 가입과 같은 본인확인 제한(같은 IP)을 건다
    await limiter.consume(identityRule, [`ip:${clientIp(request)}`]);
    const { verificationToken } = await parseJsonBody(request, accountRecoveryLookupRequestSchema);
    const person = await verifyPerson(deps, verificationToken, clock());

    // CI 로만 찾는다 — 휴대폰 번호가 바뀌어도 같은 사람이면 찾는다(계약 §1-4)
    const account = await findInstructorByCi(db, person.ciHash);
    if (account === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);

    const academies = await activeAcademyNames(db, account.staffAccountId);
    // 응답은 계약 스키마로 한 번 거른다 — 코드가 바뀌어 계약에 없는 칸(CI·원래 이름·번호)이 섞이면 내보내지 않고 500
    const body = accountRecoveryLookupResponseSchema.parse({
      nameMasked: maskPersonName(person.name),
      phoneMasked: maskPhone(person.phone),
      username: account.username,
      joinedOn: account.joinedOn,
      academyNames: academies.slice(0, ACADEMY_NAME_PREVIEW),
      academyCount: academies.length,
    });
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  });

  /**
   * ② POST /api/instructor/account-recovery/reset-password — 비밀번호 새로 정하기.
   * 순서: 제한 → 본문 → 본인확인 → 계정 찾기 → 비밀번호 형식 → (트랜잭션) 계정 잠금 · 토큰 1회 확인 · 비밀번호 · 세션·기기 기억 지우기 · 감사
   */
  const resetPassword = withRoute<unknown>(async (request) => {
    await limiter.consume(identityRule, [`ip:${clientIp(request)}`]);
    const input = await parseJsonBody(request, accountRecoveryResetRequestSchema);
    const now = clock();
    const person = await verifyPerson(deps, input.verificationToken, now);

    const account = await findInstructorByCi(db, person.ciHash);
    if (account === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);

    // 비밀번호 규칙은 가입과 같다(Q41) — 아이디와 같은 비밀번호도 막는다
    const problem = passwordProblem(input.newPassword, account.username);
    if (problem !== null) {
      throw new HttpError("VALIDATION_FAILED", problem, { fields: [{ path: "newPassword", message: problem }] });
    }
    const passwordHash = await hashPassword(input.newPassword);
    const jti = `${USED_TOKEN_IDENTIFIER_PREFIX}${tokenJti(input.verificationToken)}`;
    const keepUntil = now.add({ hours: USED_TOKEN_KEEP_HOURS }).toString();

    const sessionsRevoked = await db.transaction(async (tx) => {
      // 같은 사람(같은 계정)의 재설정을 한 줄로 세운다. 같은 토큰을 동시에 두 번 보내도 두 번째는 아래 확인에서 막힌다
      await tx.query(
        tx.raw.sql`SELECT id FROM staff_accounts WHERE id = ${account.staffAccountId}::uuid FOR UPDATE`
          .returnsRow({ id: "pg/uuid@1" })
          .build(),
      );
      const [used] = await tx.query(
        tx.raw.sql`SELECT 1 AS hit FROM auth.verification WHERE identifier = ${jti} LIMIT 1`
          .returnsRow({ hit: "pg/int4@1" })
          .build(),
      );
      if (used !== undefined) {
        throw new HttpError("VALIDATION_FAILED", DETAIL.tokenUsed, {
          fields: [{ path: "verificationToken", message: "이미 쓴 본인확인이에요" }],
        });
      }
      // 토큰을 썼다는 기록(값 = 그 계정의 로그인 id). 원문 토큰은 남기지 않는다
      await tx.execute(
        tx.raw.sql`INSERT INTO auth.verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
                   VALUES (gen_random_uuid()::text, ${jti}, ${account.authUserId}, ${keepUntil}::timestamptz, now(), now())`
          .affectedCount()
          .build(),
      );

      // 비밀번호는 Better Auth 의 credential 계정에 있다 — 같은 hashPassword 로 만들어야 로그인 경로가 검증한다
      await tx.execute(
        tx.raw.sql`UPDATE auth.account SET password = ${passwordHash}, "updatedAt" = now()
                   WHERE "userId" = ${account.authUserId} AND "providerId" = 'credential'`
          .affectedCount()
          .build(),
      );

      // 다른 기기 로그인 모두 끝내기(FR-191): 세션 전부 + 같은 기기 30일 기억 기록 전부
      const revoked = await deleteSessions(tx, account.authUserId);
      await tx.execute(
        tx.raw.sql`DELETE FROM auth.verification
                   WHERE value = ${account.authUserId} AND identifier LIKE ${`${TRUST_DEVICE_IDENTIFIER_PREFIX}%`}`
          .affectedCount()
          .build(),
      );

      // 감사 1행. 비밀번호·토큰 값은 남기지 않는다(README §6-4 와 같은 원칙) — 바꿨다는 사실과 끝낸 세션 수만
      const after = JSON.stringify({ via: "identity_verification", sessionsRevoked: revoked, trustedDevicesCleared: true });
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, action, target_table, target_id, after)
                   VALUES (uuidv7(), 'staff', ${account.staffAccountId}::uuid, 'instructor', 'staff.password_reset',
                           'staff_accounts', ${account.staffAccountId}::uuid, ${after}::json)`
          .affectedCount()
          .build(),
      );
      return revoked;
    });

    const body = accountRecoveryResetResponseSchema.parse({ ok: true, sessionsRevoked });
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  });

  return { lookup, resetPassword };
}
