// S1-1.10(입점 신청 초안 저장·조회 API) — `GET /api/merchant-applications/me` · `PUT /api/merchant-applications/me/draft`
//   계약: _workspace/03_contracts/07-owner-onboarding.md §2(입점 신청 — W2a) · 머리말(staff_self)
//   데이터: data-model §7-3 merchant_applications · merchant_application_documents
//   관련: FR-250(입점 심사) · FR-299(결제 정보 보안 — 계좌번호 원문은 암호화해서만 저장, 응답·로그에는 가린 값만)
//
// 흐름(PUT):
//   ① staff_self 확인 — 세션·active 직원 계정(401·403), 그다음 2단계 인증(401 SECOND_FACTOR_REQUIRED).
//      인증 앱을 아직 등록하지 않은 대표는 여기서 막힌다(D24 — 계좌번호를 받는 화면이라서).
//   ② 본문 검사(zod). 초안이라 모든 칸이 선택이다 — 「다 채웠나」는 제출(S1-1 의 다른 Task)이 본다.
//      여기서는 「넣은 값의 모양」만 본다(사업자등록번호 10자리, 계좌번호 숫자 등).
//   ③ 한 트랜잭션: 내 열린 신청을 잠그고 → 없으면 새 초안 → draft 가 아니면 409 → 칸 전체 교체 → 증빙 목록 전체 교체
//   ④ 저장한 그대로 다시 읽어 Application 응답(계좌번호는 가린 값)
//
// 「전체 교체」의 뜻(계약 07 §2): 보낸 본문이 곧 초안 전체다. 본문에서 빠진 칸은 비운다.
// 그래서 화면은 1·2단계 값을 늘 함께 보낸다. 계좌번호 원문은 응답에 없으므로, 화면이 계좌를 다시 보내지 않으면
// 저장된 계좌도 지워진다 — 화면을 만들 때(W2a) 이 점을 지킨다(증거 EVIDENCE.md 에 적어 둠).
import { z } from "zod";

import { ACADEMY_REGISTRATION_TYPES, MERCHANT_APPLICATION_STATUSES, MERCHANT_DOCUMENT_KINDS } from "../../domain/constants";
import {
  ACCOUNT_NUMBER_PATTERN,
  accountLast4,
  maskAccountNumber,
  normalizeAccountNumber,
} from "../../domain/payout-account";
import type { FieldCipher } from "../field-encryption";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, parseJsonBody, withRoute } from "../http";
import type { Tx } from "./staff-signup";

/** 암호화한 계좌번호를 묶을 칸 이름(추가 인증 데이터). 다른 칸으로 옮겨 붙인 값은 풀리지 않는다 */
export const PAYOUT_ACCOUNT_CONTEXT = "merchant_applications.payout_account_enc";

export type MerchantApplicationDraftDeps = GuardDeps & {
  /** getter 로 넘겨도 된다 — 앱은 처음 쓰는 요청에서 환경 변수 키를 읽는다 */
  readonly fieldCipher: FieldCipher;
};

const DETAIL = {
  secondFactor: "인증 앱 코드로 2단계 인증을 마쳐 주세요",
  notFound: "입점 신청이 없어요",
  notEditable: "제출한 신청은 고칠 수 없어요",
  invalidDocument: "올린 증빙 파일을 찾을 수 없어요. 다시 올려 주세요",
} as const;

// ---- 요청 스키마 ----------------------------------------------------------------------------

// 빈 글자·공백만 보낸 칸은 「안 채움」(null)으로 본다 — 화면이 빈 입력칸을 "" 로 보내도 같게 저장되게
const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : value),
    z.string().max(max).nullable().optional(),
  );
// 숫자만 받는 칸. 하이픈·공백은 걷어 낸 뒤 검사한다(「123-45-67890」도 받는다)
const digitsText = (pattern: RegExp, message: string) =>
  z.preprocess(
    (value) => (typeof value === "string" ? (value.trim() === "" ? null : normalizeAccountNumber(value)) : value),
    z.string().regex(pattern, message).nullable().optional(),
  );

export const draftRequestSchema = z.strictObject({
  academyName: optionalText(100),
  branchName: optionalText(100),
  businessName: optionalText(100),
  representativeName: optionalText(50),
  businessRegistrationNumber: digitsText(/^[0-9]{10}$/, "사업자등록번호는 숫자 10자리예요"),
  mailOrderReportNumber: optionalText(50),
  businessAddress: optionalText(200),
  region: z
    .strictObject({ sido: optionalText(20), gu: optionalText(20) })
    .nullable()
    .optional(),
  phone: digitsText(/^[0-9]{8,12}$/, "전화번호는 숫자 8~12자리예요"),
  registrationType: z.enum(ACADEMY_REGISTRATION_TYPES).nullable().optional(),
  industryCode: optionalText(20),
  // 증빙 — 같은 종류는 하나만(PK application_id, doc_kind), 같은 파일을 두 종류에 붙일 수 없다(uq_app_docs_file)
  documents: z
    .array(z.strictObject({ docKind: z.enum(MERCHANT_DOCUMENT_KINDS), fileId: z.uuid() }))
    .max(MERCHANT_DOCUMENT_KINDS.length)
    .optional()
    .superRefine((docs, ctx) => {
      if (docs === undefined) return;
      if (new Set(docs.map((d) => d.docKind)).size !== docs.length) {
        ctx.addIssue({ code: "custom", message: "같은 종류의 증빙은 하나만 붙일 수 있어요" });
      }
      if (new Set(docs.map((d) => d.fileId)).size !== docs.length) {
        ctx.addIssue({ code: "custom", message: "같은 파일을 두 번 붙일 수 없어요" });
      }
    }),
  payoutAccount: z
    .strictObject({
      bankCode: digitsText(/^[0-9]{3}$/, "은행 코드는 숫자 3자리예요"),
      accountNumber: digitsText(ACCOUNT_NUMBER_PATTERN, "계좌번호는 숫자 10~16자리예요"),
      holderName: optionalText(50),
    })
    .nullable()
    .optional(),
});
export type DraftRequest = z.infer<typeof draftRequestSchema>;

// ---- 응답 스키마(계약 07 §2 의 Application) ----------------------------------------------------

export const applicationResponseSchema = z.strictObject({
  applicationId: z.uuid(),
  status: z.enum(MERCHANT_APPLICATION_STATUSES),
  academyName: z.string().nullable(),
  branchName: z.string().nullable(),
  businessName: z.string().nullable(),
  representativeName: z.string().nullable(),
  businessRegistrationNumber: z.string().nullable(),
  mailOrderReportNumber: z.string().nullable(),
  businessAddress: z.string().nullable(),
  region: z.strictObject({ sido: z.string().nullable(), gu: z.string().nullable() }),
  phone: z.string().nullable(),
  registrationType: z.enum(ACADEMY_REGISTRATION_TYPES).nullable(),
  industryCode: z.string().nullable(),
  documents: z.array(z.strictObject({ docKind: z.enum(MERCHANT_DOCUMENT_KINDS), fileId: z.uuid() })),
  // 계좌번호 원문은 없다 — 가린 값만(FR-299)
  payoutAccount: z.strictObject({
    bankCode: z.string().nullable(),
    accountMasked: z.string().nullable(),
    holderName: z.string().nullable(),
  }),
  rejectReasonCode: z.string().nullable(),
  rejectReasonText: z.string().nullable(),
  academyId: z.uuid().nullable(),
  submittedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ApplicationResponse = z.infer<typeof applicationResponseSchema>;

// ---- DB 읽기 --------------------------------------------------------------------------------

/** DB 한 행을 JSON 하나로 받는다 — NULL 칸을 null 그대로 받으려고(raw 레인의 글자 코덱은 NULL 을 표현하지 않는다) */
export type ApplicationRow = {
  id: string;
  status: ApplicationResponse["status"];
  academy_name: string | null;
  branch_name: string | null;
  business_name: string | null;
  representative_name: string | null;
  business_registration_number: string | null;
  mail_order_report_number: string | null;
  business_address: string | null;
  region_sido: string | null;
  region_gu: string | null;
  phone: string | null;
  registration_type: ApplicationResponse["registrationType"];
  industry_code: string | null;
  payout_bank_code: string | null;
  payout_account_enc_b64: string | null;
  payout_holder_name: string | null;
  reject_reason_code: string | null;
  reject_reason_text: string | null;
  academy_id: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  documents: { docKind: ApplicationResponse["documents"][number]["docKind"]; fileId: string }[];
};

/**
 * 고르는 기준(계약 「열린 신청 또는 마지막 신청」): 열린 신청(초안·제출·심사 중)이 있으면 그것,
 * 없으면 가장 최근에 만든 신청. 열린 신청은 uq_merchant_app_open 때문에 많아야 하나다.
 */
export async function readMyApplication(db: GuardDeps["db"] | Tx, staffAccountId: string): Promise<ApplicationRow | null> {
  const [row] = await db.query(
    db.raw.sql`SELECT json_build_object(
                 'id', a.id, 'status', a.status,
                 'academy_name', a.academy_name, 'branch_name', a.branch_name, 'business_name', a.business_name,
                 'representative_name', a.representative_name,
                 'business_registration_number', a.business_registration_number,
                 'mail_order_report_number', a.mail_order_report_number, 'business_address', a.business_address,
                 'region_sido', a.region_sido, 'region_gu', a.region_gu, 'phone', a.phone,
                 'registration_type', a.registration_type, 'industry_code', a.industry_code,
                 'payout_bank_code', a.payout_bank_code,
                 'payout_account_enc_b64', encode(a.payout_account_enc, 'base64'),
                 'payout_holder_name', a.payout_holder_name,
                 'reject_reason_code', a.reject_reason_code, 'reject_reason_text', a.reject_reason_text,
                 'academy_id', a.academy_id,
                 'submitted_at', to_char(a.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                 'decided_at', to_char(a.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                 'created_at', to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                 'updated_at', to_char(a.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                 'documents', COALESCE((SELECT json_agg(json_build_object('docKind', d.doc_kind, 'fileId', d.file_id)
                                                        ORDER BY d.doc_kind)
                                        FROM merchant_application_documents d WHERE d.application_id = a.id), '[]'::json)
               )::text AS doc
               FROM merchant_applications a
               WHERE a.applicant_account_id = ${staffAccountId}::uuid
               ORDER BY (a.status IN ('draft', 'submitted', 'in_review')) DESC, a.created_at DESC, a.id DESC
               LIMIT 1`
      .returnsRow({ doc: "pg/text@1" })
      .build(),
  );
  return row === undefined ? null : (JSON.parse(row.doc) as ApplicationRow);
}

/** DB 행 → 응답. 계좌번호는 풀어서 가린 값만 만든다(원문은 이 함수 밖으로 나가지 않는다) */
export function toResponse(row: ApplicationRow, cipher: FieldCipher): ApplicationResponse {
  const accountMasked =
    row.payout_account_enc_b64 === null
      ? null
      : maskAccountNumber(cipher.decrypt(Buffer.from(row.payout_account_enc_b64, "base64"), PAYOUT_ACCOUNT_CONTEXT));
  return {
    applicationId: row.id,
    status: row.status,
    academyName: row.academy_name,
    branchName: row.branch_name,
    businessName: row.business_name,
    representativeName: row.representative_name,
    businessRegistrationNumber: row.business_registration_number,
    mailOrderReportNumber: row.mail_order_report_number,
    businessAddress: row.business_address,
    region: { sido: row.region_sido, gu: row.region_gu },
    phone: row.phone,
    registrationType: row.registration_type,
    industryCode: row.industry_code,
    documents: row.documents,
    payoutAccount: { bankCode: row.payout_bank_code, accountMasked, holderName: row.payout_holder_name },
    rejectReasonCode: row.reject_reason_code,
    rejectReasonText: row.reject_reason_text,
    academyId: row.academy_id,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---- 초안 저장 ------------------------------------------------------------------------------

/**
 * ③ 트랜잭션 안에서 「편집할 초안」의 id 를 얻는다.
 *   - 열린 신청이 draft → 그 행(잠금)
 *   - 열린 신청이 submitted·in_review → 409 APPLICATION_NOT_EDITABLE
 *   - 열린 신청이 없고 마지막 신청이 approved → 409(이미 입점한 계정 — 두 번째 학원 입점은 계약에 없다)
 *   - 열린 신청이 없음(처음 · 거절 · 철회 뒤) → 새 초안. 동시에 두 요청이 와도 uq_merchant_app_open 이 하나만 남긴다
 */
async function lockEditableDraft(tx: Tx, staffAccountId: string): Promise<string> {
  const lockOpen = async () => {
    const [open] = await tx.query(
      tx.raw.sql`SELECT id, status FROM merchant_applications
                 WHERE applicant_account_id = ${staffAccountId}::uuid AND status IN ('draft', 'submitted', 'in_review')
                 FOR UPDATE`
        .returnsRow({ id: "pg/uuid@1", status: "pg/text@1" })
        .build(),
    );
    return open;
  };

  const open = await lockOpen();
  if (open !== undefined) {
    if (open.status !== "draft") throw HttpError.conflict("APPLICATION_NOT_EDITABLE", DETAIL.notEditable);
    return open.id;
  }

  const [approved] = await tx.query(
    tx.raw.sql`SELECT 1 AS hit FROM merchant_applications
               WHERE applicant_account_id = ${staffAccountId}::uuid AND status = 'approved' LIMIT 1`
      .returnsRow({ hit: "pg/int4@1" })
      .build(),
  );
  if (approved !== undefined) throw HttpError.conflict("APPLICATION_NOT_EDITABLE", DETAIL.notEditable);

  // 열린 신청 유니크(부분 색인)에 걸리면 행이 안 나온다 — 그 사이 다른 요청이 만든 초안을 다시 잠가 쓴다
  await tx.execute(
    tx.raw.sql`INSERT INTO merchant_applications (id, applicant_account_id, status, updated_at)
               VALUES (uuidv7(), ${staffAccountId}::uuid, 'draft', now())
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
  const created = await lockOpen();
  if (created === undefined) throw new Error("초안을 만들었는데 열린 신청을 찾지 못했다");
  if (created.status !== "draft") throw HttpError.conflict("APPLICATION_NOT_EDITABLE", DETAIL.notEditable);
  return created.id;
}

/**
 * 증빙 파일 확인: 내가 올린 입점 증빙(merchant_evidence)이어야 한다.
 * 없는 파일·남의 파일·사진 용도 파일은 똑같이 422 로 답한다 — 남의 파일이 「있는지」를 알려 주지 않으려고.
 * 이미 다른 신청(예: 거절된 옛 신청)에 붙은 파일도 uq_app_docs_file 때문에 붙일 수 없어 같은 422 다.
 */
async function assertOwnEvidenceFiles(
  tx: Tx,
  staffAccountId: string,
  applicationId: string,
  documents: NonNullable<DraftRequest["documents"]>,
): Promise<void> {
  for (const [index, doc] of documents.entries()) {
    const [file] = await tx.query(
      tx.raw.sql`SELECT f.id FROM uploaded_files f
                 WHERE f.id = ${doc.fileId}::uuid AND f.uploader_account_id = ${staffAccountId}::uuid
                   AND f.purpose = 'merchant_evidence'
                   AND NOT EXISTS (SELECT 1 FROM merchant_application_documents d
                                   WHERE d.file_id = f.id AND d.application_id <> ${applicationId}::uuid)`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (file === undefined) {
      throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", {
        fields: [{ path: `documents.${index}.fileId`, message: DETAIL.invalidDocument }],
      });
    }
  }
}

/** 초안 칸 전체 교체 + 증빙 목록 전체 교체(한 트랜잭션). 계좌번호는 여기서 암호화한다 */
async function saveDraft(tx: Tx, cipher: FieldCipher, applicationId: string, body: DraftRequest): Promise<void> {
  const account = body.payoutAccount ?? null;
  const accountNumber = account?.accountNumber ?? null;
  // 원문은 이 지역 변수를 벗어나지 않는다 — DB 에는 암호문(base64 로 넘겨 decode)과 끝 4자리만 간다
  const encB64 = accountNumber === null ? null : Buffer.from(cipher.encrypt(accountNumber, PAYOUT_ACCOUNT_CONTEXT)).toString("base64");
  const last4 = accountNumber === null ? null : accountLast4(accountNumber);

  // 값은 JSON 하나로 넘기고 SQL 이 칸마다 꺼낸다(`->>` 는 빠진 칸·null 을 NULL 로 준다).
  // 칸마다 매개변수를 따로 두지 않는 이유: raw 레인은 null 을 매개변수로 받지 않는다
  const values = JSON.stringify({
    academyName: body.academyName ?? null,
    branchName: body.branchName ?? null,
    businessName: body.businessName ?? null,
    representativeName: body.representativeName ?? null,
    businessRegistrationNumber: body.businessRegistrationNumber ?? null,
    mailOrderReportNumber: body.mailOrderReportNumber ?? null,
    businessAddress: body.businessAddress ?? null,
    regionSido: body.region?.sido ?? null,
    regionGu: body.region?.gu ?? null,
    phone: body.phone ?? null,
    registrationType: body.registrationType ?? null,
    industryCode: body.industryCode ?? null,
    bankCode: account?.bankCode ?? null,
    accountEnc: encB64,
    accountLast4: last4,
    holderName: account?.holderName ?? null,
  });

  await tx.execute(
    tx.raw.sql`UPDATE merchant_applications AS a SET
                 academy_name = v->>'academyName', branch_name = v->>'branchName',
                 business_name = v->>'businessName', representative_name = v->>'representativeName',
                 business_registration_number = v->>'businessRegistrationNumber',
                 mail_order_report_number = v->>'mailOrderReportNumber',
                 business_address = v->>'businessAddress',
                 region_sido = v->>'regionSido', region_gu = v->>'regionGu',
                 phone = v->>'phone', registration_type = v->>'registrationType',
                 industry_code = v->>'industryCode',
                 payout_bank_code = v->>'bankCode',
                 payout_account_enc = decode(v->>'accountEnc', 'base64'),
                 payout_account_last4 = v->>'accountLast4', payout_holder_name = v->>'holderName',
                 updated_at = now()
               FROM (SELECT ${values}::jsonb AS v) AS input
               WHERE a.id = ${applicationId}::uuid AND a.status = 'draft'`
      .affectedCount()
      .build(),
  );

  // 증빙: 지우고 다시 넣는다(전체 교체). 파일 attached_at 은 제출 때 채운다(계약 07 §2 순서 6)
  await tx.execute(
    tx.raw.sql`DELETE FROM merchant_application_documents WHERE application_id = ${applicationId}::uuid`.affectedCount().build(),
  );
  const documents = JSON.stringify(body.documents ?? []);
  await tx.execute(
    tx.raw.sql`INSERT INTO merchant_application_documents (application_id, doc_kind, file_id)
               SELECT ${applicationId}::uuid, d."docKind", d."fileId"::uuid
               FROM jsonb_to_recordset(${documents}::jsonb) AS d("docKind" text, "fileId" text)`
      .affectedCount()
      .build(),
  );
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

/** 두 경로가 함께 쓰는 ① staff_self 확인. 제출(S1-1.11)도 같은 함수를 쓴다 */
export function createStaffSelf(deps: MerchantApplicationDraftDeps) {
  const guards = createGuards(deps);
  return async (request: Request) => {
    const staff = await guards.requireStaffAccount(request);
    if (!staff.secondFactorVerified) throw new HttpError("SECOND_FACTOR_REQUIRED", DETAIL.secondFactor);
    return staff;
  };
}

/** `GET /api/merchant-applications/me` — 열린 신청 또는 마지막 신청. 없으면 404 */
export function createGetMyApplicationRoute(deps: MerchantApplicationDraftDeps) {
  const staffSelf = createStaffSelf(deps);
  return withRoute<unknown>(async (request) => {
    const staff = await staffSelf(request);
    const row = await readMyApplication(deps.db, staff.staffAccountId);
    if (row === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    return Response.json(toResponse(row, deps.fieldCipher));
  });
}

/** `PUT /api/merchant-applications/me/draft` — 1·2단계 저장(전체 교체). 초안이 없으면 만든다 */
export function createPutDraftRoute(deps: MerchantApplicationDraftDeps) {
  const staffSelf = createStaffSelf(deps);
  return withRoute<unknown>(async (request) => {
    const staff = await staffSelf(request);
    const body = await parseJsonBody(request, draftRequestSchema);
    const cipher = deps.fieldCipher;

    await deps.db.transaction(async (tx) => {
      const applicationId = await lockEditableDraft(tx, staff.staffAccountId);
      if (body.documents !== undefined) {
        await assertOwnEvidenceFiles(tx, staff.staffAccountId, applicationId, body.documents);
      }
      await saveDraft(tx, cipher, applicationId, body);
    });

    const row = await readMyApplication(deps.db, staff.staffAccountId);
    if (row === null) throw new Error("저장한 초안을 다시 읽지 못했다");
    return Response.json(toResponse(row, cipher));
  });
}
