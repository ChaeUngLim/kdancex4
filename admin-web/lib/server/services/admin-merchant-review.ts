// S1-1.14(심사 시작·승인 API) — `POST /api/admin/merchant-applications/{id}/start-review` · `…/{id}/approve`
// S1-1.15(심사 반려 API)     — `POST /api/admin/merchant-applications/{id}/reject`
//   계약: _workspace/03_contracts/07-owner-onboarding.md §3(심사 — 권한 admin) · 수용 시나리오 3·4 · 열린 점 ⑩ · ⑪(반려)
//   데이터: data-model §7-2 role_grants · §7-3 academies · academy_owners · academy_branches · academy_payout_accounts ·
//           merchant_applications · §7-4 merchant_consents · §7-7 notifications · audit_logs
//   요구: FR-250(입점 심사) · FR-124(플랫폼 수수료 1년 면제) · FR-125b(카드 수수료 동의 → 카드 결제) · FR-185(감사 기록)
//
// 두 경로가 하는 일:
//   심사 시작 — 제출된(submitted) 신청을 「심사 중」(in_review)으로 바꾼다. 이미 심사 중이면 아무것도 바꾸지 않고 같은 본문 200.
//   승인     — 심사 중 신청 하나로 학원·첫 지점·정산 계좌·대표 연결·대표 역할을 「한 트랜잭션」에서 한 번에 만든다.
//   반려     — 심사 중 신청을 「정해진 사유 4종」(FR-250) 중 하나와 설명 글로 끝낸다. 신청자는 알림과 내 신청 조회
//              (GET /api/merchant-applications/me 의 rejectReasonCode·rejectReasonText)로 사유를 받고, 다음 초안 저장 때
//              새 신청 행이 열린다(거절 뒤 재신청은 새 행 — data-model §7-3).
//
// 승인 전에는 학원이 없다(수용 ④):
//   학원 행은 이 승인 트랜잭션만 만든다. 승인 전 정보는 merchant_applications 에만 있어서, 승인 전 학원의 수업·설정 화면은
//   가리킬 학원 id 자체가 없다(설정 경로는 대표 연결이 없어 403).
//
// 「두 번 눌러도 학원은 하나」를 지키는 장치 세 겹(수용 ③ · 동시 승인 2건 → 1건 성공 1건 409):
//   ① 신청 행을 FOR UPDATE 로 잠근다 — 같은 신청의 승인 요청은 한 줄로 선다
//   ② 같은 Idempotency-Key 로 이미 승인했으면 감사 행에 남겨 둔 처음 응답을 그대로 돌려준다(같은 academyId)
//   ③ 상태 갱신은 조건부다(WHERE status = 'in_review'). 0행이면 409 APPLICATION_STATE_CONFLICT — 트랜잭션 전체가 되돌아가
//      앞에서 만든 학원·계좌 행도 남지 않는다
// 멱등 키는 제출(S1-1.11)과 같은 방식으로 감사 행 after 에 「키 지문(sha256)」과 「처음 응답」으로 남긴다(테이블을 늘리지 않음).
import { createHash } from "node:crypto";

import { z } from "zod";

import { MERCHANT_REJECT_REASONS } from "../../domain/constants";
import { accountLast4 } from "../../domain/payout-account";
import { createGuards } from "../guards";
import { HttpError, parseJsonBody, parseWith, readIdempotencyKey, withRoute } from "../http";
import {
  readAdminApplications,
  toAdminResponse,
  type AdminApplication,
  type AdminMerchantApplicationsDeps,
} from "./admin-merchant-applications";
import { PAYOUT_ACCOUNT_CONTEXT } from "./merchant-application-draft";
import { grantRoleInTx } from "./role-grants";
import type { Tx } from "./staff-signup";

/** 감사 행 이름(data-model §7-9). 승인 재생(②)도 이 이름으로 찾는다 */
export const REVIEW_STARTED_AUDIT_ACTION = "merchant_application.review_started";
export const APPROVED_AUDIT_ACTION = "merchant_application.approved";
export const REJECTED_AUDIT_ACTION = "merchant_application.rejected";

/**
 * 학원 정산 계좌 칸의 암호화 「칸 이름」(추가 인증 데이터). 신청서 계좌 칸(PAYOUT_ACCOUNT_CONTEXT)과 다르게 둔다 —
 * 신청서의 암호문을 그대로 옮겨 붙이면 풀리지 않게 하려고, 승인 때 한 번 풀어 이 이름으로 다시 암호화한다.
 * 계좌 변경(S1-1.21)·지급(S5-3)도 이 이름으로 푼다.
 */
export const ACADEMY_PAYOUT_ACCOUNT_CONTEXT = "academy_payout_accounts.account_enc";

/** 409 코드 — 계약 07 §3 「0행이면 409 APPLICATION_STATE_CONFLICT」. 심사 시작도 같은 코드를 쓴다 */
const STATE_CONFLICT = "APPLICATION_STATE_CONFLICT";

const DETAIL = {
  notFound: "입점 신청을 찾을 수 없어요",
  notSubmitted: "제출된 신청만 심사를 시작할 수 있어요",
  decided: "이미 심사가 끝난 신청이에요",
  withdrawn: "신청자가 철회한 신청이에요",
  notInReview: "심사 중인 신청만 승인할 수 있어요. 먼저 심사를 시작해 주세요",
  notInReviewReject: "심사 중인 신청만 반려할 수 있어요. 먼저 심사를 시작해 주세요",
  rejectedDifferently: "이미 다른 사유로 반려한 신청이에요",
} as const;

/** 반려 설명 글 최대 길이 — 다른 「사유 글」 칸(환불 사유 등)과 같은 500자 */
export const REJECT_REASON_TEXT_MAX = 500;

// ---- 요청·응답 스키마 -----------------------------------------------------------------------

// 두 경로 모두 계약에 본문이 없다. 빈 본문이나 {} 만 받고, 다른 칸이 오면 422(잘못 부른 것을 조용히 넘기지 않게 — 철회와 같은 규칙)
export const emptyBodySchema = z.strictObject({});

/** 승인 응답(계약 07 §3) */
export const approveResponseSchema = z.strictObject({
  applicationId: z.uuid(),
  status: z.literal("approved"),
  academyId: z.uuid(),
});
export type ApproveResponse = z.infer<typeof approveResponseSchema>;

/**
 * 반려 요청(계약 07 §3). 사유 코드는 4종 중 하나가 필수(ck_merchant_app_rejected 도 같은 약속을 DB 에서 지킨다).
 * 설명 글은 앞뒤 공백을 지우고 1~500자 — 계약 예시처럼 「무엇이 달랐는지」를 신청자에게 그대로 보여 주는 글이라 비우지 않는다.
 */
export const rejectRequestSchema = z.strictObject({
  reasonCode: z.enum(MERCHANT_REJECT_REASONS),
  reasonText: z.string().trim().min(1).max(REJECT_REASON_TEXT_MAX),
});
export type RejectRequest = z.infer<typeof rejectRequestSchema>;

/** 키 원문 대신 남기는 지문. 신청 id 를 섞어 「이 신청에 대한 이 키」만 같은 값이 된다 */
export function approveIdempotencyFingerprint(applicationId: string, key: string): string {
  return createHash("sha256").update(`merchant-approve:${applicationId}:${key}`).digest("hex");
}

/** 빈 본문은 {} 로 본다. 본문이 있으면 JSON 이어야 하고 빈 객체여야 한다 */
async function readEmptyBody(request: Request): Promise<void> {
  const text = await request.text();
  if (text.trim() === "") return;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
  }
  parseWith(emptyBodySchema, raw);
}

/** 경로 id — 모양이 틀리면 없는 신청과 같이 404(상세 경로와 같은 규칙. 형 변환 오류 500 을 막는다) */
async function readApplicationId(context: ApplicationParams): Promise<string> {
  const { id } = await context.params;
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  return parsed.data;
}

// ---- DB --------------------------------------------------------------------------------

type LockedApplication = { id: string; status: string; applicant_account_id: string; payout_account_enc_b64: string };

/**
 * 신청 행을 잠근다. 운영자에게 보이는 신청(한 번이라도 제출된 것)만 — 초안은 없는 신청으로 본다(상세 경로와 같은 기준).
 * 계좌 암호문은 base64 글자로 받는다(raw 레인은 NULL 을 표현하지 않아 COALESCE 로 빈 글자를 준다 — 제출된 신청엔 늘 있다).
 */
async function lockSubmittedApplication(tx: Tx, applicationId: string): Promise<LockedApplication | undefined> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT id, status, applicant_account_id::text AS applicant_account_id,
                      COALESCE(encode(payout_account_enc, 'base64'), '') AS payout_account_enc_b64
               FROM merchant_applications
               WHERE id = ${applicationId}::uuid AND submitted_at IS NOT NULL
               FOR UPDATE`
      .returnsRow({ id: "pg/uuid@1", status: "pg/text@1", applicant_account_id: "pg/text@1", payout_account_enc_b64: "pg/text@1" })
      .build(),
  );
  return row;
}

/** 상태별 409 문장 — 화면이 「왜 안 되는지」를 바로 보이게 */
function conflictDetail(status: string, fallback: string): string {
  if (status === "approved" || status === "rejected") return DETAIL.decided;
  if (status === "withdrawn") return DETAIL.withdrawn;
  return fallback;
}

/** 운영자 화면용 신청 한 건을 다시 읽는다(심사 시작 응답) */
async function readOne(tx: Tx, applicationId: string, deps: AdminMerchantApplicationsDeps): Promise<AdminApplication> {
  const [row] = await readAdminApplications(tx, [applicationId]);
  if (row === undefined) throw new Error("잠근 신청을 다시 읽지 못했다");
  return toAdminResponse(row, deps);
}

// ---- 승인 트랜잭션의 조각들 -----------------------------------------------------------------

/** 같은 키로 이미 승인했으면 그때 응답 */
async function findApproveReplay(tx: Tx, applicationId: string, fingerprint: string): Promise<ApproveResponse | null> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT (l.after -> 'response')::text AS doc
               FROM audit_logs l
               WHERE l.action = ${APPROVED_AUDIT_ACTION} AND l.target_table = 'merchant_applications'
                 AND l.target_id = ${applicationId}::uuid
                 AND l.after ->> 'idempotencyKeySha256' = ${fingerprint}
               ORDER BY l.occurred_at
               LIMIT 1`
      .returnsRow({ doc: "pg/text@1" })
      .build(),
  );
  return row === undefined ? null : approveResponseSchema.parse(JSON.parse(row.doc));
}

type CreatedAcademy = { id: string; card_payment_enabled: string; platform_fee_exempt_until: string };

/**
 * 학원 행 — 판매자 정보는 신청서의 사본이다(승인 뒤 신청서를 고쳐도 학원 값은 그대로).
 *   - registration_verified_at = 지금: 운영자가 증빙을 보고 승인했다는 뜻
 *   - card_payment_enabled: 이 신청이 카드 수수료 고지(card_fee_notice)에 동의했을 때만 true(FR-125b)
 *   - platform_fee_exempt_until = 승인일(KST 날짜) + 1년(FR-124). 어느 분류가 면제를 받는지는 platform_fee_rates 가 정한다
 *     (개인 레슨은 면제 없음 — 결정 13). 여기서는 날짜만 적는다
 * 값을 매개변수로 넘기지 않고 신청 행에서 바로 옮긴다 — NULL 칸(통신판매업 번호·업종코드)도 그대로 옮겨진다.
 */
async function insertAcademy(tx: Tx, applicationId: string): Promise<CreatedAcademy> {
  const [row] = await tx.query(
    tx.raw.sql`INSERT INTO academies
                 (id, name, region_sido, region_gu, status, registration_type, registration_verified_at, industry_code,
                  business_name, representative_name, business_registration_number, mail_order_report_number,
                  business_address, phone, card_payment_enabled, platform_fee_exempt_until, approved_at, updated_at)
               SELECT uuidv7(), a.academy_name, a.region_sido, a.region_gu, 'active', a.registration_type, now(), a.industry_code,
                      a.business_name, a.representative_name, a.business_registration_number, a.mail_order_report_number,
                      a.business_address, a.phone,
                      EXISTS (SELECT 1 FROM merchant_consents c
                              WHERE c.application_id = a.id AND c.item = 'card_fee_notice' AND c.withdrawn_at IS NULL),
                      ((now() AT TIME ZONE 'Asia/Seoul')::date + interval '1 year')::date,
                      now(), now()
               FROM merchant_applications a
               WHERE a.id = ${applicationId}::uuid
               RETURNING id, card_payment_enabled::text AS card_payment_enabled,
                         platform_fee_exempt_until::text AS platform_fee_exempt_until`
      .returnsRow({ id: "pg/uuid@1", card_payment_enabled: "pg/text@1", platform_fee_exempt_until: "pg/text@1" })
      .build(),
  );
  if (row === undefined) throw new Error("학원 행을 만들지 못했다");
  return row;
}

/** 첫 지점 — 신청서의 지점 이름·사업장 주소·지역·전화. 운영시간·시설은 대표가 설정에서 채운다(FR-070) */
async function insertFirstBranch(tx: Tx, applicationId: string, academyId: string): Promise<string> {
  const [row] = await tx.query(
    tx.raw.sql`INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, phone, updated_at)
               SELECT uuidv7(), ${academyId}::uuid, a.branch_name, a.business_address, a.region_sido, a.region_gu, a.phone, now()
               FROM merchant_applications a WHERE a.id = ${applicationId}::uuid
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (row === undefined) throw new Error("지점 행을 만들지 못했다");
  return row.id;
}

/**
 * 정산 계좌 1행. 계좌번호는 신청서 칸에서 풀어 학원 계좌 칸 이름으로 다시 암호화한다(원문은 이 함수 밖으로 나가지 않는다).
 * 예금주 확인 칸(holder_verified_at·holder_verify_method)은 비워 둔다 — 확인은 통장 사본을 보고 하는 수동 확인뿐이고
 * (R15 확정, manual_document), 승인 서류에는 통장 사본이 없다. 확인 전 계좌로는 지급하지 않는다(열린 점 ④) — 열린 점 ⑩ ⓒ.
 * 만든 사람(created_by_account_id)은 계좌를 입력한 신청자다 — 열린 점 ⑩ ⓓ.
 */
async function insertPayoutAccount(
  tx: Tx,
  input: { applicationId: string; academyId: string; encryptedB64: string; last4: string },
): Promise<string> {
  const [row] = await tx.query(
    tx.raw.sql`INSERT INTO academy_payout_accounts
                 (id, academy_id, bank_code, account_enc, account_last4, holder_name, created_by_account_id)
               SELECT uuidv7(), ${input.academyId}::uuid, a.payout_bank_code, decode(${input.encryptedB64}, 'base64'),
                      ${input.last4}, a.payout_holder_name, a.applicant_account_id
               FROM merchant_applications a WHERE a.id = ${input.applicationId}::uuid
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (row === undefined) throw new Error("정산 계좌 행을 만들지 못했다");
  return row.id;
}

/** 대표 연결 — 학원당 활성 대표는 하나(uq_academy_owners_active). 새 학원이라 겹칠 일이 없다 */
async function insertOwner(tx: Tx, academyId: string, staffAccountId: string): Promise<string> {
  const [row] = await tx.query(
    tx.raw.sql`INSERT INTO academy_owners (id, academy_id, staff_account_id)
               VALUES (uuidv7(), ${academyId}::uuid, ${staffAccountId}::uuid)
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (row === undefined) throw new Error("대표 연결 행을 만들지 못했다");
  return row.id;
}

/** 조건부 갱신 — 심사 중일 때만 승인으로. 바뀐 행이 없으면 false */
async function markApproved(tx: Tx, input: { applicationId: string; academyId: string; adminId: string }): Promise<boolean> {
  const rows = await tx.query(
    tx.raw.sql`UPDATE merchant_applications
               SET status = 'approved', academy_id = ${input.academyId}::uuid, decided_at = now(),
                   reviewed_by_account_id = ${input.adminId}::uuid, updated_at = now()
               WHERE id = ${input.applicationId}::uuid AND status = 'in_review'
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  return rows.length === 1;
}

/** 동의 기록에 학원을 잇는다 — 대표가 학원 설정에서 「무엇에 동의했나」를 학원 기준으로 찾는다(O35) */
async function linkConsents(tx: Tx, applicationId: string, academyId: string): Promise<void> {
  await tx.execute(
    tx.raw.sql`UPDATE merchant_consents SET academy_id = ${academyId}::uuid
               WHERE application_id = ${applicationId}::uuid AND academy_id IS NULL`
      .affectedCount()
      .build(),
  );
}

/** 신청자에게 승인 알림 1건(직원 알림함, category approval). 열쇠가 있어 같은 승인 알림은 두 번 생기지 않는다 */
async function notifyApproved(tx: Tx, input: { applicationId: string; academyId: string; applicantId: string }): Promise<void> {
  const payload = JSON.stringify({ applicationId: input.applicationId, academyId: input.academyId });
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               VALUES (uuidv7(), ${input.applicantId}::uuid, ${input.academyId}::uuid, 'approval', 'merchant_application_approved',
                       ${`merchant_application:${input.applicationId}:approved`}, ${payload}::jsonb)
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/**
 * 신청자에게 반려 알림 1건(직원 알림함, category approval). 사유 코드와 글을 payload 에 함께 싣는다(계약 「알림에 사유 포함」).
 * 학원은 아직 없으므로 academy_id 는 비운다. 열쇠(dedupe_key)가 있어 같은 신청의 반려 알림은 두 번 생기지 않는다.
 */
async function notifyRejected(
  tx: Tx,
  input: { applicationId: string; applicantId: string; reason: RejectRequest },
): Promise<void> {
  const payload = JSON.stringify({
    applicationId: input.applicationId,
    reasonCode: input.reason.reasonCode,
    reasonText: input.reason.reasonText,
  });
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, category, kind, dedupe_key, payload)
               VALUES (uuidv7(), ${input.applicantId}::uuid, 'approval', 'merchant_application_rejected',
                       ${`merchant_application:${input.applicationId}:rejected`}, ${payload}::jsonb)
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/** 이미 반려된 신청의 사유 — 같은 요청을 다시 보냈는지 견주려고 읽는다 */
async function readRejectReason(tx: Tx, applicationId: string): Promise<{ code: string; text: string }> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT COALESCE(reject_reason_code, '') AS code, COALESCE(reject_reason_text, '') AS text
               FROM merchant_applications WHERE id = ${applicationId}::uuid`
      .returnsRow({ code: "pg/text@1", text: "pg/text@1" })
      .build(),
  );
  if (row === undefined) throw new Error("잠근 신청의 반려 사유를 읽지 못했다");
  return row;
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

type ApplicationParams = { params: Promise<{ id: string }> };

/** `POST /api/admin/merchant-applications/{id}/start-review` — submitted → in_review. 이미 심사 중이면 200 같은 본문 */
export function createStartReviewRoute(deps: AdminMerchantApplicationsDeps) {
  const guards = createGuards(deps);
  return withRoute<ApplicationParams>(async (request, context) => {
    // ① 운영자만(관리자 웹이라 2단계 인증까지) — 권한을 먼저 본다(대표에게 신청이 「있는지」를 알려 주지 않는다)
    const staff = await guards.requireStaff("admin", { surface: "web", headers: request.headers });
    await readEmptyBody(request);
    const applicationId = await readApplicationId(context);

    const result = await deps.db.transaction(async (tx): Promise<AdminApplication> => {
      const locked = await lockSubmittedApplication(tx, applicationId);
      if (locked === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);

      // 이미 심사 중 — 아무것도 바꾸지 않는다(누가 먼저 시작했든 같은 본문)
      if (locked.status === "in_review") return readOne(tx, applicationId, deps);
      if (locked.status !== "submitted") throw HttpError.conflict(STATE_CONFLICT, conflictDetail(locked.status, DETAIL.notSubmitted));

      await tx.execute(
        tx.raw.sql`UPDATE merchant_applications
                   SET status = 'in_review', review_started_at = now(), reviewed_by_account_id = ${staff.staffAccountId}::uuid,
                       updated_at = now()
                   WHERE id = ${applicationId}::uuid AND status = 'submitted'`
          .affectedCount()
          .build(),
      );
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, action, target_table, target_id, before, after)
                   VALUES (uuidv7(), 'staff', ${staff.staffAccountId}::uuid, 'admin', ${REVIEW_STARTED_AUDIT_ACTION},
                           'merchant_applications', ${applicationId}::uuid,
                           ${JSON.stringify({ status: "submitted" })}::json, ${JSON.stringify({ status: "in_review" })}::json)`
          .affectedCount()
          .build(),
      );
      return readOne(tx, applicationId, deps);
    });

    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  });
}

/** `POST /api/admin/merchant-applications/{id}/approve` — in_review → approved. 헤더 `Idempotency-Key` 필수 */
export function createApproveRoute(deps: AdminMerchantApplicationsDeps) {
  const guards = createGuards(deps);
  return withRoute<ApplicationParams>(async (request, context) => {
    // 권한 → 키 → 본문 → 경로 id 순서(제출 경로와 같다 — 막혀야 할 사람에게는 400 보다 401·403 을 먼저)
    const staff = await guards.requireStaff("admin", { surface: "web", headers: request.headers });
    const key = readIdempotencyKey(request, { required: true });
    await readEmptyBody(request);
    const applicationId = await readApplicationId(context);
    const fingerprint = approveIdempotencyFingerprint(applicationId, key);

    const result = await deps.db.transaction(async (tx): Promise<ApproveResponse> => {
      // ① 잠금 — 같은 신청의 승인 요청이 동시에 와도 한 줄로 선다. 뒤 요청은 앞 요청이 끝난 뒤의 상태를 본다
      const locked = await lockSubmittedApplication(tx, applicationId);
      if (locked === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);

      // ② 같은 키 재요청 → 처음 응답 그대로(같은 academyId)
      const replay = await findApproveReplay(tx, applicationId, fingerprint);
      if (replay !== null) return replay;

      // 다른 키로 온 두 번째 승인은 여기서 409 — 이미 approved 라 학원을 또 만들지 않는다
      if (locked.status !== "in_review") throw HttpError.conflict(STATE_CONFLICT, conflictDetail(locked.status, DETAIL.notInReview));

      // 학원 → 첫 지점 → 정산 계좌 → 대표 연결 → 대표 역할(계약 07 §3 순서)
      const academy = await insertAcademy(tx, applicationId);
      const branchId = await insertFirstBranch(tx, applicationId, academy.id);
      const plainAccount = deps.fieldCipher.decrypt(Buffer.from(locked.payout_account_enc_b64, "base64"), PAYOUT_ACCOUNT_CONTEXT);
      const last4 = accountLast4(plainAccount);
      const encryptedB64 = Buffer.from(deps.fieldCipher.encrypt(plainAccount, ACADEMY_PAYOUT_ACCOUNT_CONTEXT)).toString("base64");
      const payoutAccountId = await insertPayoutAccount(tx, { applicationId, academyId: academy.id, encryptedB64, last4 });
      const ownerId = await insertOwner(tx, academy.id, locked.applicant_account_id);
      // 역할 부여는 한 함수(role-grants)만 거친다 — 「운영자만 대표 역할을 줄 수 있다」 판정이 여기서도 같다. 이미 있으면 그대로
      const roleGrant = await grantRoleInTx(tx, staff, { staffAccountId: locked.applicant_account_id, role: "owner" });

      // ③ 조건부 갱신. 잠금 덕에 보통은 1행이지만, 0행이면 409 를 던져 위에서 만든 행을 모두 되돌린다
      const updated = await markApproved(tx, { applicationId, academyId: academy.id, adminId: staff.staffAccountId });
      if (!updated) throw HttpError.conflict(STATE_CONFLICT, DETAIL.notInReview);

      await linkConsents(tx, applicationId, academy.id);
      await notifyApproved(tx, { applicationId, academyId: academy.id, applicantId: locked.applicant_account_id });

      const response: ApproveResponse = { applicationId, status: "approved", academyId: academy.id };
      // 감사 1행 — 계좌는 끝 4자리만 남긴다(FR-299). 키는 지문만(원문을 읽은 사람이 재사용하지 못하게)
      const after = JSON.stringify({
        status: "approved",
        academyId: academy.id,
        branchId,
        payoutAccount: { payoutAccountId, last4 },
        academyOwnerId: ownerId,
        ownerRoleGrant: { roleGrantId: roleGrant.roleGrantId, created: roleGrant.created },
        cardPaymentEnabled: academy.card_payment_enabled === "true",
        platformFeeExemptUntil: academy.platform_fee_exempt_until,
        idempotencyKeySha256: fingerprint,
        response,
      });
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs
                     (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, before, after)
                   VALUES (uuidv7(), 'staff', ${staff.staffAccountId}::uuid, 'admin', ${academy.id}::uuid, ${APPROVED_AUDIT_ACTION},
                           'merchant_applications', ${applicationId}::uuid, ${JSON.stringify({ status: "in_review" })}::json,
                           ${after}::json)`
          .affectedCount()
          .build(),
      );
      return response;
    });

    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  });
}

/**
 * `POST /api/admin/merchant-applications/{id}/reject` — in_review → rejected. 본문 `{ reasonCode, reasonText }`.
 * 계약에 Idempotency-Key 가 없다. 대신 「같은 사유로 이미 반려됐으면 200 같은 본문」으로 두 번 눌러도 안전하게 한다
 * (심사 시작의 「이미 심사 중이면 같은 본문」과 같은 방식). 다른 사유로 다시 오면 409 — 처음 사유를 몰래 덮어쓰지 않는다.
 */
export function createRejectRoute(deps: AdminMerchantApplicationsDeps) {
  const guards = createGuards(deps);
  return withRoute<ApplicationParams>(async (request, context) => {
    // 권한 → 본문 → 경로 id 순서(심사 시작과 같다 — 막혀야 할 사람에게는 422·404 보다 401·403 을 먼저)
    const staff = await guards.requireStaff("admin", { surface: "web", headers: request.headers });
    const reason = await parseJsonBody(request, rejectRequestSchema);
    const applicationId = await readApplicationId(context);

    const result = await deps.db.transaction(async (tx): Promise<AdminApplication> => {
      // 잠금 — 반려와 승인이 동시에 와도 한 줄로 서서, 둘 중 먼저 끝난 쪽만 남는다(뒤 요청은 409)
      const locked = await lockSubmittedApplication(tx, applicationId);
      if (locked === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);

      if (locked.status === "rejected") {
        // 같은 사유·같은 글이면 다시 누른 것 — 아무것도 바꾸지 않고 같은 본문(알림·감사도 더 남기지 않는다)
        const saved = await readRejectReason(tx, applicationId);
        if (saved.code === reason.reasonCode && saved.text === reason.reasonText) return readOne(tx, applicationId, deps);
        throw HttpError.conflict(STATE_CONFLICT, DETAIL.rejectedDifferently);
      }
      if (locked.status !== "in_review") {
        throw HttpError.conflict(STATE_CONFLICT, conflictDetail(locked.status, DETAIL.notInReviewReject));
      }

      // 조건부 갱신 — 심사 중일 때만. 사유 코드가 함께 들어가야 ck_merchant_app_rejected(rejected ↔ 사유 코드)를 지킨다.
      // 이 행이 「끝 상태」가 되므로 uq_merchant_app_open(열린 신청 하나)에서 빠지고, 신청자는 새 초안을 만들 수 있다
      const rows = await tx.query(
        tx.raw.sql`UPDATE merchant_applications
                   SET status = 'rejected', reject_reason_code = ${reason.reasonCode}, reject_reason_text = ${reason.reasonText},
                       decided_at = now(), reviewed_by_account_id = ${staff.staffAccountId}::uuid, updated_at = now()
                   WHERE id = ${applicationId}::uuid AND status = 'in_review'
                   RETURNING id`
          .returnsRow({ id: "pg/uuid@1" })
          .build(),
      );
      if (rows.length !== 1) throw HttpError.conflict(STATE_CONFLICT, DETAIL.notInReviewReject);

      await notifyRejected(tx, { applicationId, applicantId: locked.applicant_account_id, reason });
      // 감사 1행 — 무엇을 어떤 사유로 반려했는지. 계좌 같은 민감한 값은 넣지 않는다
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, action, target_table, target_id, before, after)
                   VALUES (uuidv7(), 'staff', ${staff.staffAccountId}::uuid, 'admin', ${REJECTED_AUDIT_ACTION},
                           'merchant_applications', ${applicationId}::uuid, ${JSON.stringify({ status: "in_review" })}::json,
                           ${JSON.stringify({ status: "rejected", reasonCode: reason.reasonCode, reasonText: reason.reasonText })}::json)`
          .affectedCount()
          .build(),
      );
      return readOne(tx, applicationId, deps);
    });

    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  });
}
