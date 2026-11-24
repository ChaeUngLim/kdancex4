// S1-2.8(소속 목록 조회 API) — 대표가 학원의 소속 신청(대기)과 소속 강사(소속 중)를 한 목록으로 본다.
//   계약: _workspace/03_contracts/08-owner-staff.md §3 「소속 목록·승인·거절 — 권한 owner」 · 수용 시나리오 5
//   데이터: data-model §7-5 instructor_affiliations · instructor_delegations(지금 켜진 위임) · staff_accounts.phone_masked
//   요구: FR-011(소속 승인) · FR-071(소속 강사 관리) · FR-187(연락처 마스킹) · 보드 W3a(강사 관리) · O37(대표 앱 강사 관리)
//
// 경로 하나(권한은 owner + 관리자 웹 2단계 — 위임 강사는 못 쓴다):
//   GET /api/academies/{academyId}/affiliations?status=pending|active → 200 { items: [...] }
//
// 무엇을 보여 주고 무엇을 숨기나:
//   - 상태는 대기(pending)·소속 중(active) 두 가지만 연다. 거절·철회·해제 행은 이력이라 이 목록에 넣지 않는다.
//     status 를 비우면 둘 다, 그 밖의 값이면 422 VALIDATION_FAILED(모르는 값을 조용히 무시하지 않는다).
//   - 연락처는 가입할 때 만들어 둔 가린 값(010-****-5678)만 내린다. 원문(phone_enc)은 읽지도 않는다(FR-187).
//   - 활동 장르는 강사 프로필(instructor_profiles, S2-1.2 가입이 만든다)에서 읽는다. 프로필이 없는 옛 계정만 null 이다(S2-1.3).
//   - 경로의 학원만 본다. 다른 학원 대표가 이 학원 id 로 부르면 가드가 403 으로 막는다(시나리오 5).
import { z } from "zod";

import { AFFILIATION_SOURCES, GENRES } from "../../domain/constants";
import { ASSIGNABLE_DELEGATION_PERMISSIONS } from "../../domain/permissions";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseWith } from "../http";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

/** 이 목록이 여는 상태 — 대기·소속 중. 거절·철회·해제는 이력이라 넣지 않는다 */
export const AFFILIATION_LIST_STATUSES = ["pending", "active"] as const;

const DETAIL = { academyNotFound: "학원을 찾을 수 없어요" } as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청·응답 계약(08 §3) --------------------------------------------------------------------

/** 쿼리 — status 하나만 받는다. 모르는 쿼리 이름도 422(오타를 「전체 보기」로 넘기지 않는다) */
export const affiliationListQuerySchema = z.strictObject({
  status: z.enum(AFFILIATION_LIST_STATUSES).optional(),
});

export const affiliationListItemSchema = z.strictObject({
  affiliationId: z.uuid(),
  status: z.enum(AFFILIATION_LIST_STATUSES),
  source: z.enum(AFFILIATION_SOURCES),
  requestedAt: z.iso.datetime({ offset: true }),
  instructor: z.strictObject({
    accountId: z.uuid(),
    displayName: z.string(),
    /** 가린 연락처. 본인확인 전 계정이라 값이 없으면 null */
    phoneMasked: z.string().nullable(),
    /** 강사 프로필의 활동 장르 하나. 프로필이 없는 계정이면 null */
    activityGenre: z.enum(GENRES).nullable(),
  }),
  message: z.string().nullable(),
  isAcademyEmployee: z.boolean(),
  /** 지금 켜진 위임 권한(이름 순, 웹 2종 + 앱 class_submit). 대기 중인 신청은 늘 빈 배열이다 */
  permissions: z.array(z.enum(ASSIGNABLE_DELEGATION_PERMISSIONS)),
});
export type AffiliationListItem = z.infer<typeof affiliationListItemSchema>;

export const affiliationListSchema = z.strictObject({ items: z.array(affiliationListItemSchema) });

// ---- 읽기 ------------------------------------------------------------------------------------

type AffiliationRow = {
  id: string;
  status: string;
  source: string;
  requested_at: string;
  instructor_account_id: string;
  display_name: string;
  phone_masked: string;
  applicant_message: string;
  has_message: boolean;
  is_academy_employee: boolean;
  permissions: string;
  activity_genre: string;
};

const AFFILIATION_ROW = {
  id: "pg/uuid@1",
  status: "pg/text@1",
  source: "pg/text@1",
  requested_at: "pg/text@1",
  instructor_account_id: "pg/uuid@1",
  display_name: "pg/text@1",
  phone_masked: "pg/text@1",
  applicant_message: "pg/text@1",
  has_message: "pg/bool@1",
  is_academy_employee: "pg/bool@1",
  permissions: "pg/text@1",
  activity_genre: "pg/text@1",
} as const;

/**
 * 학원의 대기·소속 행 — 최근에 신청한 것부터.
 * 위임 권한은 행마다 따로 묻지 않고 같은 문장에서 쉼표로 이어 붙여 한 번에 읽는다(강사 수만큼 질의가 늘지 않게).
 * NULL 칸(연락처·한마디)은 빈 글자로 읽어 행 타입을 단순하게 두고, 한마디는 빈 글자와 NULL 을 has_message 로 가른다.
 */
async function selectAffiliations(deps: GuardDeps, academyId: string, statuses: readonly string[]): Promise<AffiliationRow[]> {
  const q = deps.db;
  return q.query(
    q.raw.sql`SELECT a.id, a.status, a.source,
                     to_char(a.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS requested_at,
                     a.instructor_account_id, s.display_name,
                     COALESCE(s.phone_masked, '') AS phone_masked,
                     COALESCE(a.applicant_message, '') AS applicant_message,
                     (a.applicant_message IS NOT NULL) AS has_message,
                     a.is_academy_employee,
                     COALESCE(p.activity_genre, '') AS activity_genre,
                     COALESCE((SELECT string_agg(d.permission, ',' ORDER BY d.permission)
                               FROM instructor_delegations d WHERE d.affiliation_id = a.id), '') AS permissions
              FROM instructor_affiliations a
              JOIN staff_accounts s ON s.id = a.instructor_account_id
              -- 프로필은 없을 수도 있다(가입 경로 밖에서 만든 계정) — LEFT JOIN 으로 행을 잃지 않는다
              LEFT JOIN instructor_profiles p ON p.staff_account_id = a.instructor_account_id
              WHERE a.academy_id = ${academyId}::uuid AND a.status = ANY(string_to_array(${statuses.join(",")}, ','))
              ORDER BY a.requested_at DESC, a.id DESC`
      .returnsRow(AFFILIATION_ROW)
      .build(),
  );
}

/** DB 행 → 목록 한 줄. 위임 권한은 대기 중이면 늘 비어 있다(위임은 소속 중인 강사에게만 켠다) */
function toListItem(row: AffiliationRow): AffiliationListItem {
  return affiliationListItemSchema.parse({
    affiliationId: row.id,
    status: row.status,
    source: row.source,
    requestedAt: Temporal.Instant.from(row.requested_at).toString(),
    instructor: {
      accountId: row.instructor_account_id,
      displayName: row.display_name,
      phoneMasked: row.phone_masked === "" ? null : row.phone_masked,
      activityGenre: row.activity_genre === "" ? null : row.activity_genre,
    },
    message: row.has_message ? row.applicant_message : null,
    isAcademyEmployee: row.is_academy_employee,
    permissions: row.permissions === "" ? [] : row.permissions.split(","),
  });
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

export type AffiliationListDeps = GuardDeps;

type AcademyParams = { params: Promise<{ academyId: string }> };

/** `GET /api/academies/{academyId}/affiliations?status=` — 대표만(관리자 웹, 2단계 인증) */
export function createListAcademyAffiliationsRoute(deps: AffiliationListDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (request, context) => {
      // 경로 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다)
      const parsedId = z.uuid().safeParse((await context.params).academyId);
      if (!parsedId.success) throw new HttpError("NOT_FOUND", DETAIL.academyNotFound);

      // 같은 이름이 두 번 오면 마지막 값을 쓴다(Object.fromEntries). 비우면 대기·소속 둘 다
      const query = parseWith(affiliationListQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
      const statuses = query.status === undefined ? AFFILIATION_LIST_STATUSES : [query.status];

      const rows = await selectAffiliations(deps, parsedId.data, statuses);
      return Response.json({ items: rows.map(toListItem) }, { status: 200, headers: NO_STORE });
    },
  );
}
