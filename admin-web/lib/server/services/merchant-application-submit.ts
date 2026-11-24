// S1-1.11(입점 신청 제출 API) — `POST /api/merchant-applications/me/submit`
//   계약: _workspace/03_contracts/07-owner-onboarding.md §2 「제출 순서(한 트랜잭션)」 1~6 · 수용 시나리오 1·2 · 열린 점 ⑦
//   데이터: data-model §7-3 merchant_applications · merchant_application_documents · uploaded_files · §7-4 merchant_consents
//   요구: FR-250(입점 심사) · FR-251(입점 조건 동의) · FR-085(등록 형태·증빙) · FR-087(증빙 없으면 엄격 기준) · FR-249(동의 기록)
//
// 흐름:
//   ① staff_self 확인(초안 경로와 같은 함수) → ② Idempotency-Key 헤더(필수) → ③ 본문 zod 검사
//   ④ 한 트랜잭션에서 계약 순서 1~6:
//      1 같은 키로 이미 제출했으면 처음 응답 그대로 200
//      2 신청이 draft 인가(아니면 409 APPLICATION_NOT_EDITABLE, 신청이 아예 없으면 404)
//      3 판매자 정보·학원 정보·정산 계좌가 다 찼나(422 VALIDATION_FAILED + fields)
//      4 증빙: 사업자등록증 + 등록 형태별 1종(422 EVIDENCE_MISSING)
//      5 약관: 현재 판본인가(409 TERMS_VERSION_OUTDATED) · 필수 5개 동의(422 REQUIRED_CONSENT_MISSING)
//      6 동의 기록 · 파일 attached_at · 상태 submitted · 감사 merchant_application.submitted
//
// 멱등을 어디에 기록하나(계약 07 열린 점 ⑦ ⓐ — 추천안으로 진행):
//   merchant_applications 에는 멱등 키 칸이 없다. 칸을 새로 만드는 대신, 제출 때 반드시 쓰는 감사 행(audit_logs, 수정·삭제 불가)의
//   after 에 「키의 sha256」과 「처음 응답」을 함께 넣는다. 다시 오면 그 행을 찾아 처음 응답을 그대로 돌려준다.
//   키 원문은 남기지 않는다(로그·감사를 읽는 사람이 키를 재사용하지 못하게).
//   같은 키 두 요청이 동시에 와도, 둘 다 신청 행을 FOR UPDATE 로 잠그므로 뒤 요청은 앞 요청이 끝난 뒤에 감사 행을 보고 재생한다.
import { createHash } from "node:crypto";

import { z } from "zod";

import type { MerchantDocumentKind, TermsKind } from "../../domain/constants";
import { MERCHANT_ONBOARDING_ITEMS, buildMerchantOnboardingTerms, judgeMerchantConsents } from "../../domain/merchant-consents";
import { judgeMerchantEvidence } from "../../domain/merchant-evidence";
import { HttpError, parseJsonBody, readIdempotencyKey, withRoute, type FieldIssue } from "../http";
import {
  applicationResponseSchema,
  createStaffSelf,
  readMyApplication,
  toResponse,
  type ApplicationResponse,
  type ApplicationRow,
  type MerchantApplicationDraftDeps,
} from "./merchant-application-draft";
import { readCurrentOnboardingVersions } from "./merchant-onboarding-terms";
import type { Tx } from "./staff-signup";

/** 감사 행 이름 — 재생(1단계)도 이 이름으로 찾는다 */
export const SUBMITTED_AUDIT_ACTION = "merchant_application.submitted";

const DETAIL = {
  notFound: "입점 신청이 없어요. 먼저 신청서를 저장해 주세요",
  notEditable: "이미 제출한 신청이에요",
  evidenceMissing: "사업자등록증과 등록 형태 증빙을 올려 주세요",
  consentMissing: "필수 동의 항목에 모두 동의해 주세요",
  termsOutdated: "약관이 새로 바뀌었어요. 화면을 새로 고쳐 다시 동의해 주세요",
  required: "제출하려면 채워야 해요",
} as const;

/** 증빙 종류 → 화면 안내 이름(오류 문장에 쓴다) */
const DOC_LABEL: Readonly<Record<MerchantDocumentKind, string>> = {
  business_registration: "사업자등록증",
  academy_registration: "학원 등록증",
  tutoring_center_report: "교습소 신고증",
  sports_facility_report: "체육시설 신고증",
};

// ---- 요청 스키마(계약 07 §2 「제출 요청」) -------------------------------------------------------

export const submitRequestSchema = z.strictObject({
  // 항목 5개 + 여유. 같은 판본을 여러 번 보내는 것은 판정 함수가 다룬다(true·false 섞이면 동의로 치지 않음)
  consents: z.array(z.strictObject({ termsVersionId: z.uuid(), agreed: z.boolean() })).max(20),
});
export type SubmitRequest = z.infer<typeof submitRequestSchema>;

/** 키 원문 대신 남기는 지문. 같은 사람의 같은 키만 같은 값이 된다(사람 id 를 섞어 다른 사람 키와 겹치지 않게) */
export function idempotencyFingerprint(staffAccountId: string, key: string): string {
  return createHash("sha256").update(`merchant-submit:${staffAccountId}:${key}`).digest("hex");
}

// ---- 1단계: 재생 ---------------------------------------------------------------------------

/** 이 사람의 신청 중 같은 키 지문으로 제출한 감사 행이 있으면 그때 응답을 돌려준다 */
async function findReplay(tx: Tx, staffAccountId: string, fingerprint: string): Promise<ApplicationResponse | null> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT (l.after -> 'response')::text AS doc
               FROM audit_logs l
               WHERE l.action = ${SUBMITTED_AUDIT_ACTION} AND l.target_table = 'merchant_applications'
                 AND l.target_id IN (SELECT a.id FROM merchant_applications a
                                     WHERE a.applicant_account_id = ${staffAccountId}::uuid)
                 AND l.after ->> 'idempotencyKeySha256' = ${fingerprint}
               ORDER BY l.occurred_at
               LIMIT 1`
      .returnsRow({ doc: "pg/text@1" })
      .build(),
  );
  return row === undefined ? null : applicationResponseSchema.parse(JSON.parse(row.doc));
}

// ---- 2단계: 상태 -------------------------------------------------------------------------------

/** 열린 신청(초안·제출·심사 중)을 잠근다. 많아야 하나(uq_merchant_app_open). 철회(S1-1.12)도 같은 잠금을 쓴다 */
export async function lockOpenApplication(tx: Tx, staffAccountId: string): Promise<{ id: string; status: string } | undefined> {
  const [open] = await tx.query(
    tx.raw.sql`SELECT id, status FROM merchant_applications
               WHERE applicant_account_id = ${staffAccountId}::uuid AND status IN ('draft', 'submitted', 'in_review')
               FOR UPDATE`
      .returnsRow({ id: "pg/uuid@1", status: "pg/text@1" })
      .build(),
  );
  return open;
}

// ---- 3단계: 다 찼나 ----------------------------------------------------------------------------

/**
 * 제출에 필요한 칸 확인. 계약 3단계의 판매자 정보 5항목(상호·대표자명·주소·전화·사업자등록번호)에 더해,
 * 승인 때 학원·지점·정산 계좌 행을 만들려면 반드시 있어야 하는 칸(학원 이름·지점 이름·지역·등록 형태·계좌)도 여기서 본다
 * (열린 점 ⑦ ⓑ — 이 칸이 비면 승인 트랜잭션이 NOT NULL 로 깨진다).
 * 통신판매업 신고번호는 「신고 대상인 학원만」(FR-240)이고 대상 여부를 아직 받지 않으므로 비어도 통과한다.
 */
function findMissingFields(row: ApplicationRow): FieldIssue[] {
  const checks: [string, unknown][] = [
    ["academyName", row.academy_name],
    ["branchName", row.branch_name],
    ["businessName", row.business_name],
    ["representativeName", row.representative_name],
    ["businessRegistrationNumber", row.business_registration_number],
    ["businessAddress", row.business_address],
    ["region.sido", row.region_sido],
    ["region.gu", row.region_gu],
    ["phone", row.phone],
    ["registrationType", row.registration_type],
    ["payoutAccount.bankCode", row.payout_bank_code],
    ["payoutAccount.accountNumber", row.payout_account_enc_b64],
    ["payoutAccount.holderName", row.payout_holder_name],
  ];
  const issues: FieldIssue[] = checks.filter(([, value]) => value === null).map(([path]) => ({ path, message: DETAIL.required }));
  // 초안 저장도 10자리를 검사하지만, 제출이 최종 관문이라 한 번 더 본다(DB 의 academies.ck_academies_brn 과 같은 규칙)
  const brn = row.business_registration_number;
  if (brn !== null && !/^[0-9]{10}$/.test(brn)) {
    issues.push({ path: "businessRegistrationNumber", message: "사업자등록번호는 숫자 10자리예요" });
  }
  return issues;
}

// ---- 6단계: 기록 ---------------------------------------------------------------------------

type SubmitWrite = {
  applicationId: string;
  staffAccountId: string;
  agreed: { item: TermsKind; termsVersionId: string }[];
};

/** 동의 행(항목마다 1행, agreed_at = 서버 시각) · 붙인 파일 attached_at · 상태 submitted */
async function writeSubmission(tx: Tx, input: SubmitWrite): Promise<void> {
  const agreed = JSON.stringify(input.agreed);
  await tx.execute(
    tx.raw.sql`INSERT INTO merchant_consents (id, application_id, staff_account_id, terms_version_id, item, agreed_at, source)
               SELECT uuidv7(), ${input.applicationId}::uuid, ${input.staffAccountId}::uuid, c."termsVersionId"::uuid, c.item,
                      now(), 'application'
               FROM jsonb_to_recordset(${agreed}::jsonb) AS c(item text, "termsVersionId" text)`
      .affectedCount()
      .build(),
  );
  // 붙인 파일은 이제 주인이 있다 — 24시간 정리 작업(S1-1.35)이 지우지 않는다
  await tx.execute(
    tx.raw.sql`UPDATE uploaded_files SET attached_at = now()
               WHERE attached_at IS NULL
                 AND id IN (SELECT file_id FROM merchant_application_documents WHERE application_id = ${input.applicationId}::uuid)`
      .affectedCount()
      .build(),
  );
  await tx.execute(
    tx.raw.sql`UPDATE merchant_applications SET status = 'submitted', submitted_at = now(), updated_at = now()
               WHERE id = ${input.applicationId}::uuid AND status = 'draft'`
      .affectedCount()
      .build(),
  );
}

/**
 * 감사 1행. after 에는 상태·엄격 기준 표시·동의 판본·키 지문·처음 응답을 넣는다.
 * 응답에는 계좌번호가 가린 값으로만 들어 있다(FR-299) — 원문은 감사 기록에도 없다.
 */
async function writeAudit(
  tx: Tx,
  input: SubmitWrite & { fingerprint: string; strictRefundStandard: boolean; response: ApplicationResponse },
): Promise<void> {
  const after = JSON.stringify({
    status: "submitted",
    registrationType: input.response.registrationType,
    // FR-087: 등록 형태 증빙이 없는 학원(미등록) → 승인 뒤 환불 공지에 가장 엄격한 학원법 기준
    strictRefundStandard: input.strictRefundStandard,
    consents: input.agreed,
    idempotencyKeySha256: input.fingerprint,
    response: input.response,
  });
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, action, target_table, target_id, before, after)
               VALUES (uuidv7(), 'staff', ${input.staffAccountId}::uuid, ${SUBMITTED_AUDIT_ACTION}, 'merchant_applications',
                       ${input.applicationId}::uuid, ${JSON.stringify({ status: "draft" })}::json, ${after}::json)`
      .affectedCount()
      .build(),
  );
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

/** `POST /api/merchant-applications/me/submit` — 초안을 제출한다. 헤더 `Idempotency-Key` 필수 */
export function createSubmitApplicationRoute(deps: MerchantApplicationDraftDeps) {
  const staffSelf = createStaffSelf(deps);
  return withRoute<unknown>(async (request) => {
    // 권한부터 본다 — 로그인하지 않은 사람에게 「키가 없다」(400)보다 「로그인하라」(401)를 먼저 알린다
    const staff = await staffSelf(request);
    const key = readIdempotencyKey(request, { required: true });
    const body = await parseJsonBody(request, submitRequestSchema);
    const fingerprint = idempotencyFingerprint(staff.staffAccountId, key);
    const cipher = deps.fieldCipher;

    const response = await deps.db.transaction(async (tx): Promise<ApplicationResponse> => {
      // 2단계의 잠금을 1단계보다 먼저 건다 — 같은 키 동시 요청에서 뒤 요청이 앞 요청의 감사 행을 보게 하려고
      const open = await lockOpenApplication(tx, staff.staffAccountId);

      // 1 같은 키 재요청 → 처음 응답 그대로
      const replay = await findReplay(tx, staff.staffAccountId, fingerprint);
      if (replay !== null) return replay;

      // 2 draft 만 제출한다
      if (open === undefined) {
        const latest = await readMyApplication(tx, staff.staffAccountId);
        if (latest === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);
        throw HttpError.conflict("APPLICATION_NOT_EDITABLE", DETAIL.notEditable);
      }
      if (open.status !== "draft") throw HttpError.conflict("APPLICATION_NOT_EDITABLE", DETAIL.notEditable);
      const row = await readMyApplication(tx, staff.staffAccountId);
      if (row === null || row.id !== open.id) throw new Error("잠근 초안을 다시 읽지 못했다");

      // 3 칸이 다 찼나
      const missingFields = findMissingFields(row);
      if (missingFields.length > 0) {
        throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", { fields: missingFields });
      }
      // 위에서 registrationType 이 null 이 아님을 확인했다
      const registrationType = row.registration_type as NonNullable<ApplicationRow["registration_type"]>;

      // 4 증빙
      const evidence = judgeMerchantEvidence(registrationType, row.documents.map((d) => d.docKind));
      if (!evidence.ok) {
        const names = evidence.missing.map((kind) => DOC_LABEL[kind]).join(", ");
        throw HttpError.unprocessable("EVIDENCE_MISSING", `${DETAIL.evidenceMissing} (빠진 것: ${names})`);
      }

      // 5 약관 — 조회 API 와 같은 함수로 「지금 시행 중인 판본」을 읽어 판정한다
      const items = buildMerchantOnboardingTerms(await readCurrentOnboardingVersions(tx));
      const consents = judgeMerchantConsents(items, body.consents);
      if (!consents.ok && consents.code === "TERMS_VERSION_OUTDATED") {
        throw HttpError.conflict("TERMS_VERSION_OUTDATED", DETAIL.termsOutdated);
      }
      if (!consents.ok) {
        const labels = MERCHANT_ONBOARDING_ITEMS.filter((def) => consents.missing.includes(def.item)).map((def) => def.label);
        throw HttpError.unprocessable("REQUIRED_CONSENT_MISSING", `${DETAIL.consentMissing} (빠진 것: ${labels.join(", ")})`);
      }

      // 6 기록 — 상태를 바꾼 뒤 다시 읽어 응답을 만들고, 그 응답을 감사 행에 같이 남긴다(재생용)
      const write: SubmitWrite = { applicationId: row.id, staffAccountId: staff.staffAccountId, agreed: consents.agreed };
      await writeSubmission(tx, write);
      const submitted = await readMyApplication(tx, staff.staffAccountId);
      if (submitted === null) throw new Error("제출한 신청을 다시 읽지 못했다");
      const result = toResponse(submitted, cipher);
      await writeAudit(tx, { ...write, fingerprint, strictRefundStandard: evidence.strictRefundStandard, response: result });
      return result;
    });

    return Response.json(response, { headers: { "Cache-Control": "private, no-store" } });
  });
}
