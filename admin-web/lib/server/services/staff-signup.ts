// S1-1.8(대표 가입 API) — 직원 계정 가입의 공용 부품. 대표 가입(owner-signup.ts)이 먼저 쓰고,
// 강사 가입(S2-1.2)이 같은 부품을 그대로 가져다 쓴다(2026-11-20 D24 「서비스 코드는 나눠 둔다」).
//   계약: _workspace/03_contracts/07-owner-onboarding.md §0 · 11-instructor.md §1-1~§1-3
//   데이터: 03_data-model.md §7-2 staff_accounts(`uq_staff_accounts_ci` — 한 사람 한 직원 계정)
//
// 부품 넷:
//   ① resolveIdentity     — 본인확인 토큰을 풀고 만 19세를 본다(포트만 안다, 가짜·실물 모름)
//   ② findStaffByCi       — 같은 사람(CI 해시)의 직원 계정이 이미 있나
//   ③ isUsernameTaken     — 아이디가 이미 쓰였나(Better Auth 의 auth."user".username)
//   ④ insertStaffAccount  — 한 트랜잭션 안에서 auth.user · auth.account(비밀번호) · staff_accounts 를 만든다
//
// 왜 Better Auth API(createUser)를 안 쓰고 SQL 로 직접 넣나:
//   Better Auth 의 쓰기는 자기 연결로 따로 커밋된다. 그러면 「로그인 계정은 생겼는데 staff_accounts 는 없다」
//   (CI 중복으로 뒤에서 막힌 경우)는 반쪽 계정이 남는다. 같은 트랜잭션에 넣어야 하나가 막히면 셋 다 없던 일이 된다.
//   비밀번호 해시는 Better Auth 의 hashPassword 를 그대로 써서 로그인 경로(sign-in/username)가 같은 값을 검증한다.
import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import type { Db } from "../../../prisma/db";
import {
  STAFF_MIN_AGE_YEARS,
  isAtLeastAge,
  maskPersonName,
  maskPhone,
} from "../../domain/staff-signup";
import { toKstDate } from "../../domain/time";
import { HttpError } from "../http";
import type { IdentityVerificationPort } from "../ports/identity";

/** 트랜잭션 안의 쿼리 손잡이. db.transaction 콜백이 받는 값과 같다 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** 본인확인을 마친 사람. 원래 CI·전체 연락처는 이 밖으로 내보내지 않는다(응답·로그에는 가린 값만) */
export type VerifiedPerson = {
  ciHash: string;
  name: string;
  birthDate: Temporal.PlainDate;
  phone: string;
  nameMasked: string;
  phoneMasked: string;
};

const DETAIL = {
  tokenInvalid: "본인확인을 다시 해 주세요",
} as const;

/**
 * ① 토큰을 풀고 나이를 본다. 무효·만료 토큰은 422 VALIDATION_FAILED(01 §2 와 같은 코드),
 * 만 19세 미만은 호출하는 쪽이 정한 코드(대표 OWNER_UNDER_19 · 강사 INSTRUCTOR_UNDER_19)로 422.
 */
export async function resolveIdentity(
  identity: IdentityVerificationPort,
  token: string,
  now: Temporal.Instant,
  underAge: { code: string; detail: string },
): Promise<VerifiedPerson> {
  const result = await identity.verify(token, now);
  if (!result.ok) {
    // 무효인지 만료인지는 칸 안내로만 나눈다 — 어느 쪽이든 앱은 본인확인을 처음부터 다시 연다
    throw new HttpError("VALIDATION_FAILED", DETAIL.tokenInvalid, {
      fields: [{ path: "verificationToken", message: result.reason === "expired" ? "본인확인 시간이 지났어요" : "본인확인 결과가 맞지 않아요" }],
    });
  }
  // 기준일 = 요청 시각의 KST 날짜(계약 07 §0 · 11 §1-1)
  if (!isAtLeastAge(result.birthDate, toKstDate(now), STAFF_MIN_AGE_YEARS)) {
    throw HttpError.unprocessable(underAge.code, underAge.detail);
  }
  return {
    ciHash: result.ciHash,
    name: result.name,
    birthDate: result.birthDate,
    phone: result.phone,
    nameMasked: maskPersonName(result.name),
    phoneMasked: maskPhone(result.phone),
  };
}

/** ② 같은 CI 의 직원 계정(상태 무관 — 정지·탈퇴 계정도 같은 사람이다). 아이디와 켜진 역할도 같이 읽는다 */
export async function findStaffByCi(
  db: Db | Tx,
  ciHash: string,
): Promise<{ staffAccountId: string; username: string; roles: string[] } | null> {
  const [row] = await db.query(
    db.raw.sql`SELECT s.id, u.username,
                      COALESCE((SELECT string_agg(g.role::text, ',' ORDER BY g.role::text) FROM role_grants g
                                WHERE g.staff_account_id = s.id AND g.status = 'active'), '') AS roles
               FROM staff_accounts s JOIN auth."user" u ON u.id = s.auth_user_id
               WHERE s.identity_ci_hash = ${ciHash}`
      .returnsRow({ id: "pg/uuid@1", username: "pg/text@1", roles: "pg/text@1" })
      .build(),
  );
  if (row === undefined) return null;
  return { staffAccountId: row.id, username: row.username, roles: row.roles === "" ? [] : row.roles.split(",") };
}

/** ③ 아이디가 이미 쓰였나. username 플러그인은 소문자로 맞춰 저장하므로 같은 규칙으로 비교한다 */
export async function isUsernameTaken(db: Db | Tx, username: string): Promise<boolean> {
  const [row] = await db.query(
    db.raw.sql`SELECT 1 AS hit FROM auth."user" WHERE username = ${username.toLowerCase()} LIMIT 1`
      .returnsRow({ hit: "pg/int4@1" })
      .build(),
  );
  return row !== undefined;
}

export type NewStaffAccount = {
  person: VerifiedPerson;
  username: string;
  password: string;
  displayName: string;
};

/**
 * ④ 트랜잭션 tx 안에서 로그인 계정과 직원 계정을 만든다. 역할(role_grants)은 만들지 않는다 —
 * 대표는 입점 승인 때 운영자가, 강사는 강사 가입이 따로 준다(데이터 모델 §7-2 「부여 경로」).
 *
 * 동시에 같은 아이디·같은 CI 로 두 번 들어와도 하나만 남는다: 유니크 색인이 최종 방어선이고,
 * 막힌 쪽은 ON CONFLICT DO NOTHING 으로 행을 못 받아 409 를 던진다 → tx 전체가 되돌려진다.
 */
export async function insertStaffAccount(
  tx: Tx,
  input: NewStaffAccount,
  conflicts: { ciTaken: () => HttpError; usernameTaken: () => HttpError },
): Promise<{ staffAccountId: string; authUserId: string }> {
  const authUserId = randomUUID();
  const username = input.username.toLowerCase();
  // Better Auth 는 user.email 을 반드시 요구한다(유니크). 직원은 이메일을 받지 않으므로 바깥으로 나가지 않는
  // 예약 도메인(.invalid, RFC 2606)에 계정 id 로 만든 주소를 넣는다 — 아이디·이름이 주소에 새지 않는다.
  const placeholderEmail = `staff-${authUserId}@users.invalid`;

  // 아이디 유니크(auth."user".username) — 겹치면 행이 안 나온다
  const [user] = await tx.query(
    tx.raw.sql`INSERT INTO auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt", username, "displayUsername")
               VALUES (${authUserId}, ${input.displayName}, ${placeholderEmail}, false, now(), now(), ${username}, ${input.username})
               ON CONFLICT DO NOTHING RETURNING id`
      .returnsRow({ id: "pg/text@1" })
      .build(),
  );
  if (user === undefined) throw conflicts.usernameTaken();

  // 비밀번호는 Better Auth 의 credential 계정에 둔다(로그인 경로가 여기서 읽는다)
  const passwordHash = await hashPassword(input.password);
  await tx.execute(
    tx.raw.sql`INSERT INTO auth.account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
               VALUES (${randomUUID()}, ${authUserId}, 'credential', ${authUserId}, ${passwordHash}, now(), now())`
      .affectedCount()
      .build(),
  );

  // 한 사람 한 직원 계정(uq_staff_accounts_ci) — 겹치면 행이 안 나온다.
  // phone_enc 는 암호화 키가 정해지지 않아 비워 둔다(계약 07 열린 점 ⑤ ⓒ). 가린 번호만 저장한다
  const [staff] = await tx.query(
    tx.raw.sql`INSERT INTO staff_accounts (id, auth_user_id, display_name, identity_ci_hash, birth_date, phone_masked, updated_at)
               VALUES (uuidv7(), ${authUserId}, ${input.displayName}, ${input.person.ciHash},
                       ${input.person.birthDate.toString()}::date, ${input.person.phoneMasked}, now())
               ON CONFLICT DO NOTHING RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (staff === undefined) throw conflicts.ciTaken();

  return { staffAccountId: staff.id, authUserId };
}
