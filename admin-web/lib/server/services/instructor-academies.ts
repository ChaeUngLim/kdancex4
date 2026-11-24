// S2-1.9(학원 검색·학원 색 API) — 강사가 이름·지역으로 학원을 찾고(I27), 소속 학원마다 색을 고른다(I12·I9E).
//   계약: _workspace/03_contracts/11-instructor.md §3-1(학원 검색) · §3-2(학원 색)
//   데이터: data-model §8-2 instructor_affiliations.calendar_color_index(0~11, ck_aff_color) · 12색 이름은 lib/domain/academy-colors.ts
//   요구: FR-071(소속 강사 관리) · 보드 I27(소속 신청 — 학원 찾기) · I9E(소속 학원 · 학원 색)
//
// 경로 둘(권한은 instructor 역할. 강사 앱 경로라 2단계 인증을 묻지 않는다 — FR-303 은 관리자 웹에만 건다):
//   GET /api/instructor/academies?q=&limit=              → 200 { items: [학원 + 나와의 소속 상태] }
//   PUT /api/instructor/affiliations/{affiliationId}/color → 200 { affiliationId, colorIndex }
//
// 학원 색은 「강사 본인 화면에만」 쓰인다(I9E 「내 화면에만 보여요」). 그래서 대표·다른 강사에게 알리지 않고 감사도 남기지 않는다.
import { z } from "zod";

import { ACADEMY_COLOR_INDEX_MAX } from "../../domain/academy-colors";
import { GENRES } from "../../domain/constants";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, parseJsonBody, parseWith, withRoute } from "../http";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

/** 한 번에 돌려주는 학원 수 — 계약에 값이 없어 정한 **추천값**(목록 한 화면 + 조금) */
export const ACADEMY_SEARCH_LIMIT_DEFAULT = 20;
export const ACADEMY_SEARCH_LIMIT_MAX = 50;
/** 검색어 최대 글자 수 — 학원 이름(varchar 200)보다 짧게. 긴 글자로 DB 를 괴롭히지 못하게 */
export const ACADEMY_SEARCH_QUERY_MAX = 50;

const DETAIL = {
  forbidden: "강사 계정으로만 쓸 수 있어요",
  affiliationNotFound: "소속을 찾을 수 없어요",
  notMine: "내 소속 학원의 색만 바꿀 수 있어요",
  notActive: "소속된 학원만 색을 고를 수 있어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청·응답 계약(11 §3-1 · §3-2) ---------------------------------------------------------

/**
 * 검색 조건. q 는 비워도 된다 — 비우면 받을 수 있는 학원을 이름 순으로 보여 준다(I10B·I2 에서 학원 고르기).
 * limit 은 글자로 오므로 숫자로 바꿔 본다. 범위 밖이면 422.
 */
export const academySearchQuerySchema = z.strictObject({
  q: z.string().trim().max(ACADEMY_SEARCH_QUERY_MAX).default(""),
  limit: z.coerce.number().int().min(1).max(ACADEMY_SEARCH_LIMIT_MAX).default(ACADEMY_SEARCH_LIMIT_DEFAULT),
});

/** 계약이 말하는 소속 상태 — 철회(withdrawn)는 「관계 없음」과 같아 affiliation 을 null 로 준다 */
const SEARCH_AFFILIATION_STATUSES = ["pending", "active", "rejected", "released"] as const;

export const academySearchItemSchema = z.strictObject({
  academyId: z.uuid(),
  name: z.string(),
  region: z.strictObject({ sido: z.string(), gu: z.string() }),
  genres: z.array(z.enum(GENRES)),
  affiliation: z.strictObject({ affiliationId: z.uuid(), status: z.enum(SEARCH_AFFILIATION_STATUSES) }).nullable(),
  canSubmitClass: z.boolean(),
  canOpenPrivateLesson: z.boolean(),
});
export type AcademySearchItem = z.infer<typeof academySearchItemSchema>;
export const academySearchResultSchema = z.strictObject({ items: z.array(academySearchItemSchema) });

/** 학원 색 본문 — 번호 하나(0~11). 정수가 아니거나 범위 밖이면 422 VALIDATION_FAILED */
export const affiliationColorRequestSchema = z.strictObject({
  colorIndex: z.int().min(0).max(ACADEMY_COLOR_INDEX_MAX),
});
export const affiliationColorResponseSchema = z.strictObject({
  affiliationId: z.uuid(),
  colorIndex: z.int().min(0).max(ACADEMY_COLOR_INDEX_MAX),
});
export type AffiliationColorResponse = z.infer<typeof affiliationColorResponseSchema>;

const affiliationIdSchema = z.uuid();

// ---- 공통 --------------------------------------------------------------------------------------

export type InstructorAcademyDeps = GuardDeps;

/** 강사 경로의 문지기 — 세션 + 켜진 직원 계정 + instructor 역할 */
async function requireInstructor(guards: ReturnType<typeof createGuards>, request: Request): Promise<string> {
  const staff = await guards.requireStaffAccount(request);
  if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
  return staff.staffAccountId;
}

/**
 * 이 요청이 어느 면(surface)에서 왔나. 계약 README §2: 앱은 `Authorization: Bearer`, 관리자 웹은 쿠키.
 * canSubmitClass 는 면마다 보는 위임이 다르다 — 앱은 class_submit, 웹은 class_manage(11 §0 class_writer).
 */
export function classPermissionOf(request: Request): "class_submit" | "class_manage" {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.toLowerCase().startsWith("bearer ") ? "class_submit" : "class_manage";
}

/** LIKE 의 특수 글자(% _ \)를 글자 그대로 찾게 바꾼다 — 「50%」를 찾았는데 모든 학원이 나오지 않게 */
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

// ---- ① 학원 검색 ------------------------------------------------------------------------------

/**
 * `GET /api/instructor/academies?q=라틴` — 소속 신청할 학원 찾기(I27) · 개인 레슨 학원(I10B) · 수업 학원 고르기(I2).
 *   - 새 소속·새 수업을 받는 `active` 학원만 나온다(제한·해지 중인 학원은 08 의 ACADEMY_NOT_ACCEPTING 과 같은 판정으로 뺀다)
 *   - 이름 부분 일치 또는 시·구 부분 일치. 이름 순
 *   - 학원마다 「나와의 마지막 소속 행」을 붙인다 — 화면이 이미 소속·대기 중인 학원을 고를 수 없게(I27)
 */
export function createSearchAcademiesRoute(deps: InstructorAcademyDeps) {
  const guards = createGuards(deps);
  return withRoute<unknown>(async (request) => {
    const instructorId = await requireInstructor(guards, request);
    const params = new URL(request.url).searchParams;
    const query = parseWith(academySearchQuerySchema, {
      q: params.get("q") ?? undefined,
      limit: params.get("limit") ?? undefined,
    });
    const pattern = `%${escapeLike(query.q)}%`;
    const classPermission = classPermissionOf(request);

    // LATERAL: 학원마다 나와의 가장 최근 소속 행 하나(거절 뒤 재신청이면 새 행). I27B 카드(08 §2)와 같은 기준이다.
    // genres: 신청 받는(open) 판매 단위가 있는 수업의 장르를 모은다 — 수업 게시 상태(S2-2)가 생기기 전의 「공개 수업」 기준.
    // 정렬: 이름을 글자 번호(COLLATE "C") 순으로 — DB 마다 다른 지역 정렬 규칙에 기대지 않고 가나다 순을 늘 같게 낸다.
    // can_submit: 소속이 active 이고 이 면의 위임이 켜져 있을 때만 참. 매 요청 DB 에서 읽어 대표가 끈 바로 다음부터 false 가 된다.
    const rows = await deps.db.query(
      deps.db.raw.sql`SELECT a.id, a.name, a.region_sido, a.region_gu,
                             COALESCE(f.id::text, '') AS affiliation_id,
                             COALESCE(f.status, '') AS affiliation_status,
                             COALESCE((SELECT string_agg(DISTINCT c.genre, ',' ORDER BY c.genre)
                                       FROM classes c
                                       WHERE c.academy_id = a.id
                                         AND EXISTS (SELECT 1 FROM class_offerings o WHERE o.class_id = c.id AND o.status = 'open')), '') AS genres,
                             COALESCE(f.status = 'active' AND EXISTS (
                               SELECT 1 FROM instructor_delegations d WHERE d.affiliation_id = f.id AND d.permission = ${classPermission}
                             ), false) AS can_submit
                      FROM academies a
                      LEFT JOIN LATERAL (
                        SELECT x.id, x.status FROM instructor_affiliations x
                        WHERE x.academy_id = a.id AND x.instructor_account_id = ${instructorId}::uuid
                        ORDER BY x.requested_at DESC, x.id DESC
                        LIMIT 1
                      ) f ON true
                      WHERE a.status = 'active'
                        AND (${query.q} = ''
                             OR a.name ILIKE ${pattern} ESCAPE '\\'
                             OR a.region_sido ILIKE ${pattern} ESCAPE '\\'
                             OR a.region_gu ILIKE ${pattern} ESCAPE '\\')
                      ORDER BY a.name COLLATE "C", a.id
                      LIMIT ${query.limit}::int`
        .returnsRow({
          id: "pg/uuid@1",
          name: "pg/text@1",
          region_sido: "pg/text@1",
          region_gu: "pg/text@1",
          affiliation_id: "pg/text@1",
          affiliation_status: "pg/text@1",
          genres: "pg/text@1",
          can_submit: "pg/bool@1",
        })
        .build(),
    );

    // 응답도 스키마로 한 번 거른다 — DB 에 계약 밖 값이 있으면 조용히 내보내지 않고 500 으로 멈춘다
    const body = parseResponse({
      items: rows.map((r) => {
        // 철회(withdrawn)했거나 행이 없으면 「관계 없음」 — 다시 신청할 수 있다
        const hasRelation = r.affiliation_id !== "" && r.affiliation_status !== "withdrawn";
        return {
          academyId: r.id,
          name: r.name,
          region: { sido: r.region_sido, gu: r.region_gu },
          genres: r.genres === "" ? [] : r.genres.split(","),
          affiliation: hasRelation ? { affiliationId: r.affiliation_id, status: r.affiliation_status } : null,
          canSubmitClass: r.can_submit,
          // 개인 레슨은 소속만 있으면 열 수 있다(FR-052c — 권한 토글 없음)
          canOpenPrivateLesson: r.affiliation_status === "active",
        };
      }),
    });
    return Response.json(body, { status: 200, headers: NO_STORE });
  });
}

/** 응답 검증 실패는 클라이언트 잘못이 아니라 서버 쪽 데이터 문제다 — 422 가 아니라 500 으로 */
function parseResponse(value: unknown): z.output<typeof academySearchResultSchema> {
  const result = academySearchResultSchema.safeParse(value);
  if (!result.success) throw new Error(`학원 검색 응답이 계약과 맞지 않아요: ${result.error.message}`);
  return result.data;
}

// ---- ② 학원 색 바꾸기 --------------------------------------------------------------------------

type IdParams = { params: Promise<{ id: string }> };

/**
 * `PUT /api/instructor/affiliations/{affiliationId}/color` — 내 소속 학원의 색 번호를 바꾼다(I9E · I12 「바꾸기」).
 * `UPDATE … WHERE id AND 내 것 AND status='active'` 한 문장으로 쓴다. 0행이면 이유를 다시 읽어 가른다:
 *   없는 id 404 · 남의 소속 403 FORBIDDEN(Task verify) · 소속이 active 가 아님 409 AFFILIATION_STATE_CONFLICT(08).
 * 같은 번호를 다시 보내도 200 이다(상태 멱등 — 결과가 같다). 여러 학원이 같은 색을 써도 막지 않는다(강사가 고른 것).
 */
export function createSetAffiliationColorRoute(deps: InstructorAcademyDeps) {
  const guards = createGuards(deps);
  return withRoute<IdParams>(async (request, context) => {
    const instructorId = await requireInstructor(guards, request);
    const parsedId = affiliationIdSchema.safeParse((await context.params).id);
    if (!parsedId.success) throw new HttpError("NOT_FOUND", DETAIL.affiliationNotFound);
    const affiliationId = parsedId.data;
    const body = await parseJsonBody(request, affiliationColorRequestSchema);

    const [updated] = await deps.db.query(
      deps.db.raw.sql`UPDATE instructor_affiliations
                      SET calendar_color_index = ${body.colorIndex}::int, updated_at = now()
                      WHERE id = ${affiliationId}::uuid AND instructor_account_id = ${instructorId}::uuid AND status = 'active'
                      RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );

    if (updated === undefined) {
      const [current] = await deps.db.query(
        deps.db.raw.sql`SELECT instructor_account_id, status FROM instructor_affiliations WHERE id = ${affiliationId}::uuid`
          .returnsRow({ instructor_account_id: "pg/uuid@1", status: "pg/text@1" })
          .build(),
      );
      if (current === undefined) throw new HttpError("NOT_FOUND", DETAIL.affiliationNotFound);
      if (current.instructor_account_id !== instructorId) throw new HttpError("FORBIDDEN", DETAIL.notMine);
      throw HttpError.conflict("AFFILIATION_STATE_CONFLICT", DETAIL.notActive);
    }

    const result: AffiliationColorResponse = { affiliationId, colorIndex: body.colorIndex };
    return Response.json(result, { status: 200, headers: NO_STORE });
  });
}
