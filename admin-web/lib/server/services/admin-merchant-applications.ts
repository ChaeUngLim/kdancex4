// S1-1.13(운영자 심사 목록·상세 API) — `GET /api/admin/merchant-applications` · `GET /api/admin/merchant-applications/{id}`
//   계약: _workspace/03_contracts/07-owner-onboarding.md §3(심사 — 권한 admin) · 열린 점 ⑨
//   데이터: data-model §7-3 merchant_applications(색인 ix_merchant_app_status_submitted (status, submitted_at)) ·
//           merchant_application_documents
//   요구: FR-250(입점 심사) · FR-299(결제 정보 보안 — 계좌번호는 가린 값만 내보낸다) · FR-303(관리자 웹 2단계 인증)
//
// 흐름(두 경로 같음):
//   ① 운영자 확인 — requireStaff("admin", web). 세션 401 → 직원 계정 403 → 2단계 401 → 운영자 아님 403(대표도 403)
//   ② 쿼리·경로 검사(zod) — 틀리면 422(목록) · 모양이 틀린 id 는 404(상세 — 형 변환 오류 500 을 막는다)
//   ③ 읽기 — 「한 번이라도 제출된」 신청만 보인다(submitted_at IS NOT NULL). 대표가 아직 쓰고 있는 초안,
//      제출하지 않고 철회한 초안은 운영자에게 온 적이 없으니 목록에도 없고 상세는 404 다
//   ④ 응답 — 대표 쪽과 같은 Application 모양(계좌는 accountMasked 만) + 신청자(applicant)
//
// 목록 순서는 제출 시각이 이른 것부터다(먼저 낸 신청을 먼저 심사 — 줄 서기). 다음 쪽은 nextCursor 로 받는다.
// 커서는 「마지막으로 본 (제출 시각, id)」를 base64url 로 감싼 글자다 — 그 뒤의 행만 읽어 같은 행이 두 번 나오지 않는다.
import { z } from "zod";

import { MERCHANT_APPLICATION_STATUSES } from "../../domain/constants";
import { createGuards } from "../guards";
import { HttpError, parseWith, withRoute } from "../http";
import {
  applicationResponseSchema,
  toResponse,
  type ApplicationRow,
  type MerchantApplicationDraftDeps,
} from "./merchant-application-draft";
import type { Tx } from "./staff-signup";

/** 운영자 경로도 대표 쪽과 같은 deps(db·세션·암호화 도구) — 계좌번호를 풀어 가린 값을 만들려면 암호화 도구가 필요하다 */
export type AdminMerchantApplicationsDeps = MerchantApplicationDraftDeps;

const DETAIL = {
  notFound: "입점 신청을 찾을 수 없어요",
  badCursor: "목록 위치(cursor)가 올바르지 않아요. 처음부터 다시 불러 주세요",
} as const;

/** 한 쪽 기본 개수와 최대 개수 */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// 운영자가 거를 수 있는 상태 — draft(초안)는 운영자에게 보이지 않으므로 뺀다
export const ADMIN_VISIBLE_STATUSES = MERCHANT_APPLICATION_STATUSES.filter((s) => s !== "draft");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// DB 가 내주는 시각 모양(to_char ... US"Z") — 커서 안의 시각이 이 모양이 아니면 받지 않는다
const CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

// ---- 커서 -----------------------------------------------------------------------------------

type Cursor = { submittedAt: string; id: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.submittedAt}|${cursor.id}`, "utf8").toString("base64url");
}

/** 커서를 풀어 모양을 확인한다. 화면이 만든 값이 아니면(손으로 고친 값 등) null */
export function decodeCursor(raw: string): Cursor | null {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [submittedAt, id, ...rest] = text.split("|");
  if (rest.length > 0 || submittedAt === undefined || id === undefined) return null;
  if (!CURSOR_TIME_PATTERN.test(submittedAt) || !UUID_PATTERN.test(id)) return null;
  return { submittedAt, id };
}

// ---- 요청 스키마(쿼리) ------------------------------------------------------------------------

export const listQuerySchema = z.strictObject({
  // 비우면 운영자에게 보이는 상태 전부
  status: z.enum(ADMIN_VISIBLE_STATUSES).optional(),
  cursor: z
    .string()
    .max(200)
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") return undefined;
      const decoded = decodeCursor(value);
      if (decoded === null) {
        ctx.addIssue({ code: "custom", message: DETAIL.badCursor });
        return z.NEVER;
      }
      return decoded;
    }),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

// ---- 응답 스키마 ------------------------------------------------------------------------------

/** 운영자가 보는 신청 한 건 = 대표 쪽 Application(계좌는 가린 값) + 누가 냈나 */
export const adminApplicationSchema = applicationResponseSchema.extend({
  applicant: z.strictObject({ staffAccountId: z.uuid(), displayName: z.string() }),
});
export type AdminApplication = z.infer<typeof adminApplicationSchema>;

export const adminApplicationListSchema = z.strictObject({
  items: z.array(adminApplicationSchema),
  nextCursor: z.string().nullable(),
});

// ---- DB 읽기 --------------------------------------------------------------------------------

export type AdminApplicationRow = ApplicationRow & { applicant_account_id: string; applicant_display_name: string };

/**
 * 고른 id 들의 신청을 Application 모양 재료(JSON)로 읽는다. 목록·상세가 같은 함수를 쓴다 — 두 응답 모양이 어긋나지 않게.
 * 칸 목록은 대표 쪽 readMyApplication(merchant-application-draft.ts)과 같고, 신청자 id·표시 이름을 더 읽는다.
 * 제출된 적 없는 신청(submitted_at NULL)은 여기서도 한 번 더 거른다.
 */
export async function readAdminApplications(db: AdminMerchantApplicationsDeps["db"] | Tx, ids: string[]): Promise<AdminApplicationRow[]> {
  if (ids.length === 0) return [];
  const rows = await db.query(
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
                                        FROM merchant_application_documents d WHERE d.application_id = a.id), '[]'::json),
                 'applicant_account_id', s.id, 'applicant_display_name', s.display_name
               )::text AS doc
               FROM merchant_applications a
               JOIN staff_accounts s ON s.id = a.applicant_account_id
               WHERE a.id = ANY(string_to_array(${ids.join(",")}, ',')::uuid[]) AND a.submitted_at IS NOT NULL
               ORDER BY a.submitted_at, a.id`
      .returnsRow({ doc: "pg/text@1" })
      .build(),
  );
  return rows.map((row) => JSON.parse(row.doc) as AdminApplicationRow);
}

/**
 * 목록 한 쪽의 id 를 고른다. 하나 더(limit + 1) 읽어 「다음 쪽이 있나」를 안다.
 * raw 레인은 null 을 매개변수로 받지 않아서, 거르지 않을 때도 값을 넣는다:
 *   - 상태 — 쉼표로 이은 목록(거르지 않으면 보이는 상태 전부)
 *   - 커서 — 없으면 '-infinity'(가장 이른 시각보다 앞) — 모든 행이 그 뒤다
 */
async function selectPageIds(
  db: AdminMerchantApplicationsDeps["db"],
  input: { statuses: readonly string[]; after: Cursor | null; take: number },
): Promise<{ id: string; submitted_at: string }[]> {
  const afterTime = input.after?.submittedAt ?? "-infinity";
  const afterId = input.after?.id ?? "00000000-0000-0000-0000-000000000000";
  return db.query(
    db.raw.sql`SELECT a.id, to_char(a.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS submitted_at
               FROM merchant_applications a
               WHERE a.submitted_at IS NOT NULL
                 AND a.status = ANY(string_to_array(${input.statuses.join(",")}, ','))
                 AND (a.submitted_at, a.id) > (${afterTime}::timestamptz, ${afterId}::uuid)
               ORDER BY a.submitted_at, a.id
               LIMIT ${input.take}::int`
      .returnsRow({ id: "pg/uuid@1", submitted_at: "pg/text@1" })
      .build(),
  );
}

/** DB 행 → 응답. 계좌 가리기는 대표 쪽 toResponse 가 한다(원문은 이 함수 밖으로 나가지 않는다) */
export function toAdminResponse(row: AdminApplicationRow, deps: Pick<AdminMerchantApplicationsDeps, "fieldCipher">): AdminApplication {
  return {
    ...toResponse(row, deps.fieldCipher),
    applicant: { staffAccountId: row.applicant_account_id, displayName: row.applicant_display_name },
  };
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

/** `GET /api/admin/merchant-applications?status=&cursor=&limit=` — 목록 `{items, nextCursor}` */
export function createListMerchantApplicationsRoute(deps: AdminMerchantApplicationsDeps) {
  const guards = createGuards(deps);
  return withRoute<unknown>(async (request) => {
    // ① 운영자만(관리자 웹이라 2단계 인증까지)
    await guards.requireStaff("admin", { surface: "web", headers: request.headers });

    // ② 쿼리 검사 — 같은 이름이 두 번 오면 마지막 값을 쓴다(Object.fromEntries)
    const query = parseWith(listQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    const pageSize = query.limit ?? DEFAULT_PAGE_SIZE;
    const statuses = query.status === undefined ? ADMIN_VISIBLE_STATUSES : [query.status];

    // ③ 한 쪽 + 하나 더. 넘친 하나가 있으면 이 쪽의 마지막 행이 다음 커서다
    const picked = await selectPageIds(deps.db, { statuses, after: query.cursor ?? null, take: pageSize + 1 });
    const page = picked.slice(0, pageSize);
    const last = page.at(-1);
    const nextCursor =
      picked.length > pageSize && last !== undefined ? encodeCursor({ submittedAt: last.submitted_at, id: last.id }) : null;

    const rows = await readAdminApplications(
      deps.db,
      page.map((p) => p.id),
    );
    return Response.json({ items: rows.map((row) => toAdminResponse(row, deps)), nextCursor });
  });
}

type ApplicationParams = { params: Promise<{ id: string }> };

/** `GET /api/admin/merchant-applications/{id}` — 상세(증빙 파일 id 는 documents[].fileId) */
export function createGetMerchantApplicationRoute(deps: AdminMerchantApplicationsDeps) {
  const guards = createGuards(deps);
  return withRoute<ApplicationParams>(async (request, context) => {
    // ① 운영자만 — 권한을 먼저 본다(대표가 남의 신청 id 를 넣어도 「있는지」를 알려 주지 않고 403)
    await guards.requireStaff("admin", { surface: "web", headers: request.headers });

    // ② 경로 id — 모양이 틀리면 없는 신청과 같이 404
    const { id } = await context.params;
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);

    // ③ 제출된 적 없는 초안은 운영자에게 없는 신청이다(404)
    const [row] = await readAdminApplications(deps.db, [parsed.data]);
    if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    return Response.json(toAdminResponse(row, deps));
  });
}
