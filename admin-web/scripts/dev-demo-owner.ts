// 개발 DB 전용 시연 대표 계정 만들기 — 2026-11-23 사용자 요청(아이디 brad · 비밀번호 brad).
//   대표 계정 + 승인된 학원(라틴하우스 강남) + 지점 + 정산 계좌를 한 번에 넣는다. E2E 도우미 signInNewOwner 와 같은 표·같은 값이다.
//   비밀번호 4자는 가입 화면 규칙(8자 이상)을 거치지 않는다 — 그래서 개발 DB(이름이 kdance_next)에만 넣게 막는다.
//   실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-owner.ts   (같은 아이디가 있으면 아무것도 하지 않는다)
import "dotenv/config";

import { randomUUID } from "node:crypto";
import { getMigrations } from "better-auth/db/migration";
import pg from "pg";

import { createFieldCipher } from "../lib/server/field-encryption";
import { ACADEMY_PAYOUT_ACCOUNT_CONTEXT } from "../lib/server/services/admin-merchant-review";
import { createStaffAuth } from "../lib/server/staff-auth";

const USERNAME = "brad";
const PASSWORD = "brad";

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");

const pool = new pg.Pool({ connectionString: url, max: 2 });
const secret = process.env["BETTER_AUTH_SECRET"]!;
const auth = createStaffAuth({ pool, secret, baseURL: process.env["BETTER_AUTH_URL"]! });
await (await getMigrations(auth.options)).runMigrations();
const ctx = await auth.$context;

const { rowCount } = await pool.query('SELECT 1 FROM auth."user" WHERE username = $1', [USERNAME]);
if ((rowCount ?? 0) > 0) {
  console.log(`이미 있다: ${USERNAME}`);
  await pool.end();
  process.exit(0);
}

// Better Auth 사용자 + 비밀번호(credential) — 로그인 화면이 쓰는 것과 같은 해시 방식
const user = await ctx.internalAdapter.createUser(
  { email: `${USERNAME}@example.com`, name: "브래드", emailVerified: true, username: USERNAME, displayUsername: USERNAME },
  { method: "admin" },
);
await ctx.internalAdapter.linkAccount({
  userId: user.id,
  providerId: "credential",
  accountId: user.id,
  password: await ctx.password.hash(PASSWORD),
});

const staffAccountId = randomUUID();
const academyId = randomUUID();
const branchId = randomUUID();
await pool.query(
  "INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '브래드', 'active', now())",
  [staffAccountId, user.id],
);
await pool.query(
  `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, approved_at, registration_verified_at,
                          registration_type, industry_code, card_payment_enabled, platform_fee_exempt_until,
                          business_name, representative_name, business_registration_number, business_address, phone)
   VALUES ($1, '라틴하우스 강남', '서울', '강남구', 'active', now(), now() - interval '50 days', now() - interval '50 days',
           'sports_facility', '921902', true, (now() + interval '315 days')::date,
           '라틴하우스', '브래드', '1234567890', '서울 강남구 테헤란로 000, 3층', '020000000')`,
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
const cipher = createFieldCipher(process.env["FIELD_ENCRYPTION_KEY"]!);
await pool.query(
  `INSERT INTO academy_payout_accounts (id, academy_id, bank_code, account_enc, account_last4, holder_name, created_by_account_id)
   VALUES (uuidv7(), $1, '088', $2, $3, '라틴하우스', $4)`,
  [academyId, Buffer.from(cipher.encrypt(account, ACADEMY_PAYOUT_ACCOUNT_CONTEXT)), account.slice(-4), staffAccountId],
);
console.log(`만들었다: ${USERNAME} · 학원 ${academyId}`);
await pool.end();
