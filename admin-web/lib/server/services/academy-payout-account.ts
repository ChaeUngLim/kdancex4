// S1-1.21(정산 계좌 변경 API) — `PUT /api/academies/{academyId}/payout-account` 처리기.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §4 「정산 계좌 변경」 · 열린 점 ⑯(이 Task 에서 임시 확정한 것)
//   데이터: data-model §7-3 academy_payout_accounts(active → replaced, 판본처럼 쌓음) · §7-9 notifications · audit_logs
//   요구: FR-139(계좌 변경 재확인 — 대표 계좌는 관리자 웹 + 2단계 인증으로만, 변경 사실을 대표에게 알림) · FR-299(결제 정보 보안)
//
// 무엇을 하나:
//   대표가 관리자 웹에서 정산 계좌를 새 계좌로 바꾼다. 인증 앱 6자리(totpCode)를 이 요청에서 한 번 더 받는다.
//     - totpCode 가 없으면 401 SECOND_FACTOR_REQUIRED, 틀리면 422 TOTP_INVALID(틀린 횟수를 세어 15분 5회면 429)
//     - 한 트랜잭션: 옛 계좌 행 replaced(replaced_at) → 새 계좌 행 active(예금주 확인 전 = holder_verified_at NULL)
//       → 대표에게 알림 payout_account_changed(가린 번호) → 감사 payout_account.changed(전후 모두 가린 값)
//     - 새 계좌는 「확인 대기」로 시작한다. 운영자가 통장 사본으로 예금주를 확인하기 전에는 지급하지 않는다(확인은 S1-1.22 몫)
//
// 왜 옛 행을 고치지 않고 새 행을 쌓나:
//   지난 지급이 어느 계좌로 갔는지 나중에도 알 수 있어야 한다. 그래서 옛 행은 replaced 로 두고 새 행을 만든다.
//   학원 하나에 active 는 하나뿐이다(uq_payout_accounts_active) — 학원 행을 FOR UPDATE 로 잠가 변경 두 건이 겹쳐도 차례로 반영된다.
//
// 멱등(같은 요청을 두 번 보냈을 때):
//   헤더 Idempotency-Key 필수. 입점 승인(S1-1.14)과 같이 감사 행 after 에 「키 지문(sha256)」과 「처음 응답」을 남기고,
//   같은 사람·같은 학원·같은 키로 다시 오면 계좌를 또 바꾸지 않고 처음 응답을 그대로 200 으로 돌려준다
//   (README §4.9 주문 규칙과 같이 본문이 달라도 처음 것).
import { createHash } from "node:crypto";

import { z } from "zod";

import type { Db } from "../../../prisma/db";
import { ACCOUNT_NUMBER_PATTERN, accountLast4, maskAccountNumber, normalizeAccountNumber } from "../../domain/payout-account";
import { createConsoleRoute } from "../console-route";
import type { FieldCipher } from "../field-encryption";
import type { GuardDeps, StaffContext } from "../guards";
import { HttpError, parseJsonBody, readIdempotencyKey } from "../http";
import type { RateLimiter, RateLimitRule } from "../rate-limit";
import type { TotpChecker } from "../staff-totp";
import { ACADEMY_PAYOUT_ACCOUNT_CONTEXT } from "./admin-merchant-review";
import type { Tx } from "./staff-signup";

/** 감사 행 이름(data-model §7-9). 멱등 재생도 이 이름으로 찾는다 */
export const PAYOUT_ACCOUNT_CHANGED_AUDIT_ACTION = "payout_account.changed";

const HOLDER_NAME_MAX = 50;

// ---- 요청·응답 계약(07 §4 「정산 계좌 변경」) ----------------------------------------------------

/**
 * 요청 — 은행 코드 3자리 · 계좌번호(하이픈·공백은 걷어 숫자 10~16자리) · 예금주 · 인증 앱 6자리.
 * totpCode 는 스키마에서 선택 칸으로 둔다 — 빠졌을 때 422 가 아니라 401 SECOND_FACTOR_REQUIRED 로 답하려고(계약)
 */
export const payoutAccountChangeRequestSchema = z.strictObject({
  bankCode: z.string().regex(/^[0-9]{3}$/, "은행 코드는 숫자 3자리예요"),
  accountNumber: z.preprocess(
    (value) => (typeof value === "string" ? normalizeAccountNumber(value) : value),
    z.string().regex(ACCOUNT_NUMBER_PATTERN, "계좌번호는 숫자 10~16자리예요"),
  ),
  holderName: z.string().trim().min(1, "예금주를 적어 주세요").max(HOLDER_NAME_MAX),
  totpCode: z.string().optional(),
});
export type PayoutAccountChangeRequest = z.infer<typeof payoutAccountChangeRequestSchema>;

/** 200 응답 — 계좌번호 원문은 싣지 않는다(가린 값만) */
export const payoutAccountChangeResponseSchema = z.strictObject({
  bankCode: z.string(),
  accountMasked: z.string(),
  holderName: z.string(),
  holderVerified: z.literal(false),
  changedAt: z.string(),
});
export type PayoutAccountChangeResponse = z.infer<typeof payoutAccountChangeResponseSchema>;

export type PayoutAccountChangeDeps = GuardDeps & {
  readonly fieldCipher: FieldCipher;
  /** 인증 앱 코드 확인(staff-totp.ts) */
  readonly totp: TotpChecker;
  /** 코드 실패 횟수 세기 — 로그인 실패와 같은 칸(authFailure)을 쓴다. 따로 세면 5+5 번을 넣어 볼 수 있다 */
  readonly limiter: RateLimiter;
  readonly totpFailureRule: RateLimitRule;
};

const DETAIL = {
  notFound: "학원을 찾을 수 없어요",
  secondFactor: "계좌를 바꾸려면 인증 앱 코드를 다시 입력해 주세요",
  totpInvalid: "인증 앱 코드가 맞지 않아요",
} as const;

/** 키 원문 대신 남기는 지문. 학원·직원을 섞어 「이 학원·이 사람의 이 키」만 같은 값이 된다 */
export function payoutChangeIdempotencyFingerprint(academyId: string, staffAccountId: string, key: string): string {
  return createHash("sha256").update(`payout-account-change:${academyId}:${staffAccountId}:${key}`).digest("hex");
}

// ---- 인증 앱 코드 다시 확인 -------------------------------------------------------------------

/**
 * totpCode 를 확인한다. 없으면 401, 막혀 있으면 429, 틀리면 실패 1회를 더하고 422.
 * 세는 단위는 로그인 계정(auth 사용자 id) — 같은 사람이 로그인 화면과 이 경로를 번갈아 넣어 봐도 한 칸에 쌓인다.
 */
async function assertFreshTotp(deps: PayoutAccountChangeDeps, staff: StaffContext, code: string | undefined): Promise<void> {
  if (code === undefined || code.trim() === "") throw new HttpError("SECOND_FACTOR_REQUIRED", DETAIL.secondFactor);
  const subjects = [`account:${staff.authUserId}`];
  await deps.limiter.assertAllowed(deps.totpFailureRule, subjects);
  if (await deps.totp(staff.authUserId, code.trim())) return;
  await deps.limiter.recordFailure(deps.totpFailureRule, subjects);
  throw new HttpError("TOTP_INVALID", DETAIL.totpInvalid);
}

// ---- 쓰기 ------------------------------------------------------------------------------------

/** 학원 행을 잠근다. 없으면 false */
async function lockAcademy(tx: Tx, academyId: string): Promise<boolean> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT id FROM academies WHERE id = ${academyId}::uuid FOR UPDATE`.returnsRow({ id: "pg/uuid@1" }).build(),
  );
  return row !== undefined;
}

/** 같은 키로 이미 바꿨으면 그때 응답. 없으면 null */
async function findReplay(tx: Tx, academyId: string, fingerprint: string): Promise<PayoutAccountChangeResponse | null> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT (after::jsonb -> 'response')::text AS response FROM audit_logs
               WHERE action = ${PAYOUT_ACCOUNT_CHANGED_AUDIT_ACTION} AND academy_id = ${academyId}::uuid
                 AND after::jsonb ->> 'idempotencyKeySha256' = ${fingerprint}
               LIMIT 1`
      .returnsRow({ response: "pg/text@1" })
      .build(),
  );
  return row === undefined ? null : payoutAccountChangeResponseSchema.parse(JSON.parse(row.response));
}

type MaskedAccount = { payoutAccountId: string; bankCode: string; accountMasked: string; holderName: string };

/** 지금 쓰는 계좌를 replaced 로 돌리고 그 가린 값을 돌려준다(감사 before 용). 계좌가 없었으면 null */
async function retireActiveAccount(tx: Tx, cipher: FieldCipher, academyId: string): Promise<MaskedAccount | null> {
  const [row] = await tx.query(
    tx.raw.sql`UPDATE academy_payout_accounts SET status = 'replaced', replaced_at = now()
               WHERE academy_id = ${academyId}::uuid AND status = 'active'
               RETURNING id, bank_code, encode(account_enc, 'base64') AS account_enc_b64, holder_name`
      .returnsRow({ id: "pg/uuid@1", bank_code: "pg/text@1", account_enc_b64: "pg/text@1", holder_name: "pg/text@1" })
      .build(),
  );
  if (row === undefined) return null;
  const plain = cipher.decrypt(Buffer.from(row.account_enc_b64, "base64"), ACADEMY_PAYOUT_ACCOUNT_CONTEXT);
  return { payoutAccountId: row.id, bankCode: row.bank_code, accountMasked: maskAccountNumber(plain), holderName: row.holder_name };
}

/** 새 계좌 행(active, 예금주 확인 전). 만든 시각을 함께 돌려준다 */
async function insertActiveAccount(
  tx: Tx,
  cipher: FieldCipher,
  input: { academyId: string; staffAccountId: string; body: PayoutAccountChangeRequest },
): Promise<{ id: string; createdAt: string }> {
  const encryptedB64 = Buffer.from(cipher.encrypt(input.body.accountNumber, ACADEMY_PAYOUT_ACCOUNT_CONTEXT)).toString("base64");
  const [row] = await tx.query(
    tx.raw.sql`INSERT INTO academy_payout_accounts
                 (id, academy_id, bank_code, account_enc, account_last4, holder_name, created_by_account_id)
               VALUES (uuidv7(), ${input.academyId}::uuid, ${input.body.bankCode}, decode(${encryptedB64}, 'base64'),
                       ${accountLast4(input.body.accountNumber)}, ${input.body.holderName}, ${input.staffAccountId}::uuid)
               RETURNING id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`
      .returnsRow({ id: "pg/uuid@1", created_at: "pg/text@1" })
      .build(),
  );
  if (row === undefined) throw new Error("정산 계좌 행을 만들지 못했다");
  return { id: row.id, createdAt: row.created_at };
}

/**
 * 이 학원의 지금 대표에게 알림 1건(직원 알림함, category settlement). 계좌는 가린 값만 싣는다.
 * 남이 내 세션으로 바꿨을 때 대표가 바로 알아차리게 하려는 알림이라, 바꾼 사람이 대표 자신이어도 보낸다.
 */
async function notifyOwner(tx: Tx, academyId: string, newAccountId: string, masked: Omit<MaskedAccount, "payoutAccountId">) {
  const payload = JSON.stringify({ academyId, payoutAccountId: newAccountId, ...masked });
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               SELECT uuidv7(), o.staff_account_id, ${academyId}::uuid, 'settlement', 'payout_account_changed',
                      ${`payout_account:${newAccountId}:changed`}, ${payload}::jsonb
               FROM academy_owners o WHERE o.academy_id = ${academyId}::uuid AND o.status = 'active'
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/** 계좌 바꾸기 한 트랜잭션. 같은 키 재요청이면 처음 응답을 그대로 돌려준다 */
async function changePayoutAccount(
  db: Db,
  cipher: FieldCipher,
  input: { academyId: string; staff: StaffContext; body: PayoutAccountChangeRequest; fingerprint: string },
): Promise<PayoutAccountChangeResponse> {
  const { academyId, staff, body, fingerprint } = input;
  return db.transaction(async (tx) => {
    if (!(await lockAcademy(tx, academyId))) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const replay = await findReplay(tx, academyId, fingerprint);
    if (replay !== null) return replay;

    // 옛 계좌를 먼저 내려야 새 행이 uq_payout_accounts_active 에 걸리지 않는다
    const before = await retireActiveAccount(tx, cipher, academyId);
    const created = await insertActiveAccount(tx, cipher, { academyId, staffAccountId: staff.staffAccountId, body });
    const masked = { bankCode: body.bankCode, accountMasked: maskAccountNumber(body.accountNumber), holderName: body.holderName };
    await notifyOwner(tx, academyId, created.id, masked);

    const response: PayoutAccountChangeResponse = { ...masked, holderVerified: false, changedAt: created.createdAt };
    // 감사 1행 — 전후 모두 가린 값(끝자리만 보이는 번호). 키는 지문만 남긴다(원문을 읽은 사람이 재사용하지 못하게)
    const after = JSON.stringify({
      payoutAccount: { payoutAccountId: created.id, ...masked, holderVerified: false },
      idempotencyKeySha256: fingerprint,
      response,
    });
    await tx.execute(
      tx.raw.sql`INSERT INTO audit_logs
                   (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, before, after)
                 VALUES (uuidv7(), 'staff', ${staff.staffAccountId}::uuid, 'owner', ${academyId}::uuid,
                         ${PAYOUT_ACCOUNT_CHANGED_AUDIT_ACTION}, 'academy_payout_accounts', ${created.id}::uuid,
                         ${JSON.stringify({ payoutAccount: before })}::json, ${after}::json)`
        .affectedCount()
        .build(),
    );
    return response;
  });
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

type AcademyParams = { params: Promise<{ academyId: string }> };

/**
 * `PUT /api/academies/{academyId}/payout-account` — 대표(관리자 웹, 2단계 인증 세션)만.
 * 순서: 권한(세션·2단계·대표) → 멱등 키(없으면 400) → 본문(422) → 인증 앱 코드 다시 확인(401·429·422) → 트랜잭션
 */
export function createPayoutAccountChangeRoute(deps: PayoutAccountChangeDeps) {
  const consoleRoute = createConsoleRoute(deps);

  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (request, context, staff) => {
      // 경로 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다)
      const parsedId = z.uuid().safeParse((await context.params).academyId);
      if (!parsedId.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
      const academyId = parsedId.data;

      const key = readIdempotencyKey(request, { required: true });
      const body = await parseJsonBody(request, payoutAccountChangeRequestSchema);
      await assertFreshTotp(deps, staff, body.totpCode);

      const fingerprint = payoutChangeIdempotencyFingerprint(academyId, staff.staffAccountId, key);
      const result = await changePayoutAccount(deps.db, deps.fieldCipher, { academyId, staff, body, fingerprint });
      return Response.json(result, { status: 200, headers: { "Cache-Control": "private, no-store" } });
    },
  );
}
