// 화면(E2E) 테스트 공용 — 「2단계 인증까지 마친 직원」으로 브라우저를 로그인시킨다(S1-1.31 에서 처음 만듦).
//
// 왜 로그인 화면을 거치지 않나:
//   로그인·인증 앱 화면(W1a·W1b2)은 S0-3.12 가 따로 확인했다. 다른 화면의 테스트마다 인증 앱 6자리를 만들어 넣으면
//   테스트가 그 화면과 상관없는 이유로 깨진다. 그래서 DB 테스트(tests/db)와 같은 방법으로 Better Auth 내부 도구로
//   계정·세션을 만들고, 그 세션 토큰을 서명 쿠키로 브라우저에 넣는다. 서버는 진짜 세션 표에서 그 세션을 읽는다.
//
// 어느 DB 에 만드나: 개발 서버와 같은 DATABASE_URL(.env 를 읽고, 실행할 때 준 값이 있으면 그것이 이긴다).
//   테스트 DB 로 돌리려면 `DATABASE_URL=<테스트 DB 주소>` 를 주고 돌린다 — 그러면 Playwright 가 띄우는 개발 서버도 같은 DB 를 본다.
import { createHmac, randomBytes, randomUUID } from "node:crypto";

import "dotenv/config";
import type { BrowserContext } from "@playwright/test";
import { symmetricEncrypt } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import pg from "pg";

import { createFieldCipher } from "../../../lib/server/field-encryption";
import { ACADEMY_PAYOUT_ACCOUNT_CONTEXT } from "../../../lib/server/services/admin-merchant-review";
import { createStaffAuth } from "../../../lib/server/staff-auth";

/** Better Auth 의 세션 쿠키 이름(기본 접두사 better-auth, http 주소라 __Secure- 가 붙지 않는다) */
const SESSION_COOKIE = "better-auth.session_token";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경 변수가 필요하다(admin-web/.env)`);
  return value;
}

/** better-call 의 signCookieValue 와 같은 방식 — 「토큰.HMAC-SHA256(base64)」 를 URL 인코딩 */
function signSessionToken(token: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  return encodeURIComponent(`${token}.${signature}`);
}

export type ConsoleStaff = {
  staffAccountId: string;
  username: string;
  pool: pg.Pool;
  /** 인증 앱 비밀값 — createOTP(totpSecret).totp() 로 진짜 6자리를 만든다(대표 흐름 M1-END.4 에서 더함) */
  totpSecret: string;
};

type StaffAuthContext = Awaited<ReturnType<typeof createStaffAuth>["$context"]>;

/**
 * 인증 앱 등록을 끝낸 상태로 만든다 — Better Auth 2단계 플러그인과 같은 방법(BETTER_AUTH_SECRET 로 암호화)으로
 * twoFactor 행을 넣는다. 계좌 변경처럼 6자리를 다시 묻는 화면이 진짜 코드를 받아 확인할 수 있게 하려는 것이다.
 */
async function registerTotp(ctx: StaffAuthContext, secret: string, userId: string): Promise<string> {
  await ctx.internalAdapter.updateUser(userId, { twoFactorEnabled: true });
  const totpSecret = randomBytes(20).toString("hex");
  await ctx.adapter.create({
    model: "twoFactor",
    data: {
      secret: await symmetricEncrypt({ key: secret, data: totpSecret }),
      backupCodes: await symmetricEncrypt({ key: secret, data: "[]" }),
      userId,
      verified: true,
    },
  });
  return totpSecret;
}

/**
 * 새 직원 계정(인증 앱 등록 완료, 역할 없음 = 입점 신청자)을 만들고 그 세션 쿠키를 브라우저 문맥에 넣는다.
 * 아이디는 실행마다 새로 만든다 — 같은 DB 에서 여러 번 돌려도 서로 부딪치지 않는다.
 */
export async function signInNewApplicant(context: BrowserContext, baseURL: string): Promise<ConsoleStaff> {
  const secret = requireEnv("BETTER_AUTH_SECRET");
  const pool = new pg.Pool({ connectionString: requireEnv("DATABASE_URL"), max: 2 });
  const auth = createStaffAuth({ pool, secret, baseURL });
  // auth 스키마 표가 없으면(테스트 DB 는 vitest 가 앱 스키마만 다시 만든다) DB 테스트와 같이 Better Auth 표를 만든다.
  // 이미 있으면 바뀐 것이 없어 아무것도 하지 않는다
  await (await getMigrations(auth.options)).runMigrations();
  const ctx = await auth.$context;

  const username = `e2e_${randomBytes(4).toString("hex")}`;
  const user = await ctx.internalAdapter.createUser(
    { email: `${username}@example.com`, name: username, emailVerified: true, username, displayUsername: username },
    { method: "admin" },
  );
  // 인증 앱을 켠 뒤에 세션을 만들어야 세션이 「2단계를 마친 세션」으로 적힌다(staff-auth.ts 의 세션 훅).
  // 비밀값도 함께 넣어 둔다 — 이 신청자가 승인돼 대표가 되면 계좌 변경 때 진짜 6자리를 넣어야 한다(M1-END.4)
  const totpSecret = await registerTotp(ctx, secret, user.id);
  const session = await ctx.internalAdapter.createSession(user.id);

  const staffAccountId = randomUUID();
  await pool.query(
    "INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())",
    [staffAccountId, user.id, "김대표"],
  );

  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: signSessionToken(session.token, secret),
      domain: new URL(baseURL).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return { staffAccountId, username, pool, totpSecret };
}

/** 입점 동의 5항목마다 「지금 시행 중인」 판본이 없으면 하나 발행해 둔다(운영자가 발행하는 일을 대신) */
export async function ensureOnboardingTerms(pool: pg.Pool): Promise<void> {
  const kinds = ["merchant_terms", "platform_fee_notice", "card_fee_notice", "content_license", "one_plus_one_notice"];
  for (const kind of kinds) {
    const { rowCount } = await pool.query("SELECT 1 FROM terms_versions WHERE kind = $1 AND effective_at <= now()", [kind]);
    if ((rowCount ?? 0) > 0) continue;
    await pool.query(
      `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at)
       VALUES ($1, $2, '1.0', $3, now() - interval '40 days', now() - interval '1 day')`,
      [randomUUID(), kind, `${kind} 1.0 본문 — E2E 테스트가 발행한 판본`],
    );
  }
}

// ---- 대표(학원 설정 화면 S1-1.32 에서 더함) -----------------------------------------------------------

export type ConsoleOwner = ConsoleStaff & { academyId: string; branchId: string };

/**
 * 입점 승인이 끝난 학원의 대표로 브라우저를 로그인시킨다 — 학원·지점·정산 계좌(신한 …521)·대표 연결을 DB 에 직접 만든다.
 * 인증 앱 비밀값도 Better Auth 2단계 플러그인과 같은 방법(BETTER_AUTH_SECRET 로 암호화)으로 저장해,
 * 계좌 변경 테스트가 진짜 6자리 코드(createOTP(totpSecret).totp())를 만들어 넣을 수 있게 한다.
 * 계좌번호는 앱과 같은 열쇠(FIELD_ENCRYPTION_KEY)·같은 칸 이름으로 암호화한다 — 개발 서버가 풀어 가린 값으로 보여 준다.
 */
export async function signInNewOwner(context: BrowserContext, baseURL: string): Promise<ConsoleOwner> {
  const secret = requireEnv("BETTER_AUTH_SECRET");
  const cipher = createFieldCipher(requireEnv("FIELD_ENCRYPTION_KEY"));
  const pool = new pg.Pool({ connectionString: requireEnv("DATABASE_URL"), max: 2 });
  const auth = createStaffAuth({ pool, secret, baseURL });
  await (await getMigrations(auth.options)).runMigrations();
  const ctx = await auth.$context;

  const username = `e2e_${randomBytes(4).toString("hex")}`;
  const user = await ctx.internalAdapter.createUser(
    { email: `${username}@example.com`, name: username, emailVerified: true, username, displayUsername: username },
    { method: "admin" },
  );
  const totpSecret = await registerTotp(ctx, secret, user.id);
  const session = await ctx.internalAdapter.createSession(user.id);

  const staffAccountId = randomUUID();
  const academyId = randomUUID();
  const branchId = randomUUID();
  await pool.query(
    "INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())",
    [staffAccountId, user.id, "김대표"],
  );
  await pool.query(
    `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, approved_at, registration_verified_at,
                            registration_type, industry_code, card_payment_enabled, platform_fee_exempt_until,
                            business_name, representative_name, business_registration_number, business_address, phone)
     VALUES ($1, '라틴하우스 강남', '서울', '강남구', 'active', now(), now() - interval '50 days', now() - interval '50 days',
             'sports_facility', '921902', true, (now() + interval '315 days')::date,
             '라틴하우스', '김대표', '1234567890', '서울 강남구 테헤란로 000, 3층', '020000000')`,
    [academyId],
  );
  await pool.query(
    `INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, phone, opening_hours, facilities, parking, accessibility, updated_at)
     VALUES ($1, $2, '강남점', '서울 강남구 테헤란로 000, 3층', '서울', '강남구', '020000000',
             '평일 14:00–23:00 · 주말 12:00–20:00', '강의실 2곳 · 탈의실 · 샤워실', '건물 지하 1시간 무료', '엘리베이터 있음', now())`,
    [branchId, academyId],
  );
  await pool.query("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffAccountId]);
  await pool.query("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'owner')", [staffAccountId]);
  const account = "110000000521";
  await pool.query(
    `INSERT INTO academy_payout_accounts (id, academy_id, bank_code, account_enc, account_last4, holder_name, created_by_account_id)
     VALUES (uuidv7(), $1, '088', $2, $3, '라틴하우스', $4)`,
    [academyId, Buffer.from(cipher.encrypt(account, ACADEMY_PAYOUT_ACCOUNT_CONTEXT)), account.slice(-4), staffAccountId],
  );

  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: signSessionToken(session.token, secret),
      domain: new URL(baseURL).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return { staffAccountId, username, pool, academyId, branchId, totpSecret };
}

// ---- 운영자(입점 심사 화면 S1-1.33 에서 더함) ---------------------------------------------------------

/**
 * 운영자(admin 역할, 2단계 인증 완료)로 브라우저를 로그인시킨다. 계정·세션은 신청자와 같은 방법으로 만들고 역할 행만 더한다.
 * 운영자 역할은 원래 사람이 DB 에서 주는 것이라(가입 경로 없음) 여기서도 role_grants 에 바로 넣는다.
 */
export async function signInNewAdmin(context: BrowserContext, baseURL: string): Promise<ConsoleStaff> {
  const staff = await signInNewApplicant(context, baseURL);
  await staff.pool.query("UPDATE staff_accounts SET display_name = '박운영' WHERE id = $1", [staff.staffAccountId]);
  await staff.pool.query("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'admin')", [staff.staffAccountId]);
  return staff;
}

// ---- 강사 소속(강사 관리 화면 S1-2.14 에서 더함) ------------------------------------------------------

export type SeedAffiliation = {
  displayName: string;
  phoneMasked?: string;
  status: "pending" | "active";
  message?: string;
  isAcademyEmployee?: boolean;
  /** 소속 중일 때 켜 둘 위임(웹 2종 + 앱 class_submit) */
  permissions?: string[];
  /** 신청 시각 — 목록이 최근 신청부터라 순서를 정하려고 준다 */
  requestedAt: string;
};

/**
 * 대표의 학원에 강사 한 명과 소속 행(대기 또는 소속 중)을 DB 에 바로 만든다. 소속 id 를 돌려준다.
 * 강사는 이 화면에서 로그인하지 않으므로 Better Auth 사용자 없이 직원 계정 행만 만든다(auth_user_id 는 겹치지 않는 글자).
 * 소속 중 프리랜서는 승인 때처럼 몫 비율 첫 행(60%)도 함께 넣는다.
 */
export async function seedAffiliation(owner: ConsoleOwner, seed: SeedAffiliation): Promise<string> {
  const instructorId = randomUUID();
  await owner.pool.query(
    "INSERT INTO staff_accounts (id, auth_user_id, display_name, phone_masked, status, updated_at) VALUES ($1, $2, $3, $4, 'active', now())",
    [instructorId, `e2e-instructor-${randomBytes(6).toString("hex")}`, seed.displayName, seed.phoneMasked ?? null],
  );
  await owner.pool.query("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'instructor')", [instructorId]);
  const active = seed.status === "active";
  const { rows } = await owner.pool.query<{ id: string }>(
    `INSERT INTO instructor_affiliations
       (id, academy_id, instructor_account_id, status, source, applicant_message, is_academy_employee, requested_at, decided_at, updated_at)
     VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, now()) RETURNING id`,
    [
      owner.academyId,
      instructorId,
      seed.status,
      "application", // 초대 경로(invite)는 초대 행(invite_id)이 있어야 해서(ck_aff_source_invite) 앱 신청으로만 만든다
      seed.message ?? null,
      seed.isAcademyEmployee ?? false,
      seed.requestedAt,
      active ? seed.requestedAt : null,
    ],
  );
  const affiliationId = rows[0]!.id;
  if (active && !(seed.isAcademyEmployee ?? false)) {
    await owner.pool.query(
      `INSERT INTO instructor_share_rates (id, affiliation_id, rate_bp, effective_from, created_by_account_id)
       VALUES (uuidv7(), $1, 6000, $2::timestamptz, $3)`,
      [affiliationId, seed.requestedAt, owner.staffAccountId],
    );
  }
  for (const permission of seed.permissions ?? []) {
    await owner.pool.query(
      "INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)",
      [affiliationId, permission, owner.staffAccountId],
    );
  }
  return affiliationId;
}
