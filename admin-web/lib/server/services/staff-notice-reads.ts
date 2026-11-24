// S1-4.4(소속 강사 공지 조회·읽음 API) — 학원 공지(소속 강사 전용)를 읽는 쪽 경로 셋.
//   계약: _workspace/03_contracts/09-owner-notices.md §3(학원 공지) · 수용 시나리오 5(해제된 강사는 받지 않고 목록도 비어 있다)
//   데이터: data-model §7-6 끝 `academy_staff_notices` · `academy_staff_notice_recipients`(read_at)
//   요구: FR-063a(소속 강사 공지) · 보드 W5(대표 「지난 공지」) · I39(강사 학원 공지)
//
// 무엇을 하나:
//   - GET  /api/academies/{academyId}/staff-notices?status=published&cursor=   대표가 보는 지난 공지(W5) — 받은 사람 수·읽은 사람 수
//   - GET  /api/instructor/staff-notices?academyId=&category=&cursor=           강사가 보는 학원 공지(I39), 최신순
//   - POST /api/instructor/staff-notices/{noticeId}/read                        강사가 읽음 표시(두 번 눌러도 처음 시각 그대로)
//
// 강사 쪽 「보이는 공지」 판정(이 Task 의 핵심 — 두 조건을 같은 WHERE 에 함께 건다):
//   ① 그 공지의 받는 사람이다 — 올리는 순간 active 소속이던 강사만 받는 사람 행이 있다(S1-4.3 이 고정).
//      그래서 공지를 올린 뒤에 소속된 강사는 그 옛 공지를 보지 못한다.
//   ② 지금도 그 학원에 active 소속이다 — 해제된 강사는 받아 둔 옛 공지도 더는 못 본다(I39, 데이터 모델 「거르기는 조회 API 가 맡는다」).
//   읽음 처리도 같은 두 조건으로 거른다. 조건에 맞지 않으면 「그 공지가 있는지」를 알리지 않고 404 다.
//
// 권한:
//   - 대표 목록: owner + 관리자 웹 2단계(createConsoleRoute). 위임 강사는 403 — 학원 공지는 위임 2종 밖이다(쓰기와 같은 기준).
//   - 강사 두 경로: instructor 역할 + 강사 앱. 2단계 인증은 묻지 않는다(FR-303 은 관리자 웹에만 건다, 소속 신청 경로와 같은 기준).
import { z } from "zod";

import { STAFF_NOTICE_CATEGORIES } from "../../domain/constants";
import { createConsoleRoute } from "../console-route";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, parseWith, withRoute } from "../http";
import { decodeNotificationCursor, encodeNotificationCursor } from "./staff-notifications";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

/** 한 쪽 기본 개수와 최대 개수 — 직원 알림함과 같은 값(추천값) */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
// SQL 에서 시각을 글자로 읽는 형식. 마이크로초까지 읽어야 커서가 DB 의 값과 정확히 같아진다
const ISO_US_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
// 커서가 없을 때 쓰는 「가장 뒤」 값 — 모든 행이 이 앞이다
const NO_CURSOR_TIME = "infinity";
const NO_CURSOR_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

const DETAIL = {
  forbidden: "강사 계정으로만 학원 공지를 볼 수 있어요",
  academyNotFound: "학원을 찾을 수 없어요",
  notFound: "공지를 찾을 수 없어요",
  badCursor: "목록 위치(cursor)가 올바르지 않아요. 처음부터 다시 불러 주세요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청 스키마 ------------------------------------------------------------------------------

// 커서 = 「이 쪽에서 마지막으로 본 (올린 시각, 공지 id)」. 알림함의 커서와 모양이 같아 같은 함수로 감싸고 푼다.
// 최신순이라 다음 쪽은 그보다 앞선 행이다: (published_at, id) < (커서 시각, 커서 id)
const cursorField = z
  .string()
  .max(200)
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === "") return undefined;
    const decoded = decodeNotificationCursor(value);
    if (decoded === null) {
      ctx.addIssue({ code: "custom", message: DETAIL.badCursor });
      return z.NEVER;
    }
    return decoded;
  });
const limitField = z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional();

/** 대표 목록 쿼리. 지금은 「지난 공지(올린 것)」만 내준다 — 초안 목록은 계약에 없다 */
export const academyNoticeListQuerySchema = z.strictObject({
  status: z.literal("published").optional(),
  cursor: cursorField,
  limit: limitField,
});

/** 강사 목록 쿼리. 학원·분류는 비우면 전체 */
export const instructorNoticeListQuerySchema = z.strictObject({
  academyId: z.uuid().optional(),
  category: z.enum(STAFF_NOTICE_CATEGORIES).optional(),
  cursor: cursorField,
  limit: limitField,
});

// ---- 응답 스키마(09 §3) — 테스트가 본문을 이 스키마로 parse 한다(strict: 모르는 키가 섞이면 실패) ----

const isoInstant = z.iso.datetime({ offset: true });

/** 대표 「지난 공지」 한 줄(W5 「강사 3명에게 보냄 · 2명 읽음」) */
export const academyNoticeListItemSchema = z.strictObject({
  noticeId: z.uuid(),
  category: z.enum(STAFF_NOTICE_CATEGORIES),
  title: z.string(),
  publishedAt: isoInstant,
  recipientCount: z.int().min(0),
  readCount: z.int().min(0),
});
export const academyNoticeListSchema = z.strictObject({
  items: z.array(academyNoticeListItemSchema),
  nextCursor: z.string().nullable(),
});

/** 강사 「학원 공지」 한 장(I39). 본문까지 준다 — 화면이 목록에서 바로 펼친다 */
export const instructorNoticeSchema = z.strictObject({
  noticeId: z.uuid(),
  academyId: z.uuid(),
  academyName: z.string(),
  category: z.enum(STAFF_NOTICE_CATEGORIES),
  title: z.string(),
  body: z.string(),
  publishedAt: isoInstant,
  readAt: isoInstant.nullable(),
});
export type InstructorNotice = z.infer<typeof instructorNoticeSchema>;
export const instructorNoticeListSchema = z.strictObject({
  items: z.array(instructorNoticeSchema),
  nextCursor: z.string().nullable(),
});

/** 읽음 응답 — 처음 읽은 시각. 두 번째 요청도 같은 시각이다 */
export const noticeReadResponseSchema = z.strictObject({ noticeId: z.uuid(), readAt: isoInstant });

// ---- 공통 도우미 ------------------------------------------------------------------------------

/** 쿼리 문자열을 객체로. 같은 이름이 두 번 오면 마지막 값을 쓴다 */
const queryOf = (request: Request) => Object.fromEntries(new URL(request.url).searchParams);

/** 경로 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다) */
function parseUuidOr404(value: string, detail: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new HttpError("NOT_FOUND", detail);
  return parsed.data;
}

/** 「limit + 1」 개를 읽은 결과를 한 쪽과 다음 커서로 나눈다. 넘친 하나가 있으면 이 쪽의 마지막 행이 다음 커서다 */
function splitPage<T extends { id: string; published_at: string }>(picked: T[], pageSize: number) {
  const page = picked.slice(0, pageSize);
  const last = page.at(-1);
  const nextCursor =
    picked.length > pageSize && last !== undefined ? encodeNotificationCursor({ createdAt: last.published_at, id: last.id }) : null;
  return { page, nextCursor };
}

/** 강사 앱 경로의 문지기 — 세션 + 켜진 직원 계정 + instructor 역할. 2단계는 보지 않는다(강사 앱) */
function createRequireInstructor(deps: GuardDeps) {
  const guards = createGuards(deps);
  return async (request: Request): Promise<string> => {
    const staff = await guards.requireStaffAccount(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    return staff.staffAccountId;
  };
}

// ---- ① 대표 「지난 공지」 --------------------------------------------------------------------

type AcademyParams = { params: Promise<{ academyId: string }> };

/** `GET /api/academies/{academyId}/staff-notices` — 대표만. 올린 공지 최신순 + 받은 사람 수·읽은 사람 수 */
export function createListAcademyStaffNoticesRoute(deps: GuardDeps) {
  const consoleRoute = createConsoleRoute(deps);
  const { db } = deps;
  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (request, context) => {
      const academyId = parseUuidOr404((await context.params).academyId, DETAIL.academyNotFound);
      const query = parseWith(academyNoticeListQuerySchema, queryOf(request));
      const pageSize = query.limit ?? DEFAULT_PAGE_SIZE;
      const beforeTime = query.cursor?.createdAt ?? NO_CURSOR_TIME;
      const beforeId = query.cursor?.id ?? NO_CURSOR_ID;

      // 읽은 사람 수는 받는 사람 행에서 바로 센다 — 받은 사람 수(recipient_count)는 올린 순간 고정한 값이다.
      // 해제된 강사가 전에 읽었던 표시도 그대로 센다(그 사람이 실제로 읽었으니까)
      const picked = await db.query(
        db.raw.sql`SELECT n.id, n.category, n.title,
                          to_char(n.published_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS published_at,
                          n.recipient_count,
                          (SELECT count(*)::int FROM academy_staff_notice_recipients r
                           WHERE r.notice_id = n.id AND r.read_at IS NOT NULL) AS read_count
                   FROM academy_staff_notices n
                   WHERE n.academy_id = ${academyId}::uuid
                     AND n.status = 'published'
                     AND (n.published_at, n.id) < (${beforeTime}::timestamptz, ${beforeId}::uuid)
                   ORDER BY n.published_at DESC, n.id DESC
                   LIMIT ${pageSize + 1}::int`
          .returnsRow({
            id: "pg/uuid@1",
            category: "pg/text@1",
            title: "pg/text@1",
            published_at: "pg/text@1",
            recipient_count: "pg/int4@1",
            read_count: "pg/int4@1",
          })
          .build(),
      );

      const { page, nextCursor } = splitPage(picked, pageSize);
      // DB 값이 계약의 값 집합 밖이면 여기서 멈춘다(500) — 화면이 모르는 분류를 조용히 내보내지 않는다
      const body = parseWith(academyNoticeListSchema, {
        items: page.map((r) => ({
          noticeId: r.id,
          category: r.category,
          title: r.title,
          publishedAt: r.published_at,
          recipientCount: r.recipient_count,
          readCount: r.read_count,
        })),
        nextCursor,
      });
      return Response.json(body, { status: 200, headers: NO_STORE });
    },
  );
}

// ---- ② 강사 「학원 공지」 --------------------------------------------------------------------

/** `GET /api/instructor/staff-notices` — 받은 공지 중 지금 active 소속 학원의 것만, 최신순 */
export function createListInstructorStaffNoticesRoute(deps: GuardDeps) {
  const requireInstructor = createRequireInstructor(deps);
  const { db } = deps;
  return withRoute<unknown>(async (request) => {
    const instructorId = await requireInstructor(request);
    const query = parseWith(instructorNoticeListQuerySchema, queryOf(request));
    const pageSize = query.limit ?? DEFAULT_PAGE_SIZE;
    // raw 레인은 null 을 매개변수로 받지 않는다 — 거르지 않을 때는 빈 글자를 넣고 SQL 에서 「빈 글자면 통과」로 본다
    const academyId = query.academyId ?? "";
    const category = query.category ?? "";
    const beforeTime = query.cursor?.createdAt ?? NO_CURSOR_TIME;
    const beforeId = query.cursor?.id ?? NO_CURSOR_ID;

    // 받는 사람 행(①)에서 출발해, 지금도 active 소속인지(②)를 EXISTS 로 함께 건다
    const picked = await db.query(
      db.raw.sql`SELECT n.id, n.academy_id, a.name AS academy_name, n.category, n.title, n.body,
                        to_char(n.published_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS published_at,
                        COALESCE(to_char(r.read_at AT TIME ZONE 'UTC', ${ISO_US_SQL}), '') AS read_at
                 FROM academy_staff_notice_recipients r
                 JOIN academy_staff_notices n ON n.id = r.notice_id
                 JOIN academies a ON a.id = n.academy_id
                 WHERE r.instructor_account_id = ${instructorId}::uuid
                   AND n.status = 'published'
                   AND EXISTS (SELECT 1 FROM instructor_affiliations f
                               WHERE f.academy_id = n.academy_id
                                 AND f.instructor_account_id = ${instructorId}::uuid
                                 AND f.status = 'active')
                   AND (${academyId} = '' OR n.academy_id = NULLIF(${academyId}, '')::uuid)
                   AND (${category} = '' OR n.category = ${category})
                   AND (n.published_at, n.id) < (${beforeTime}::timestamptz, ${beforeId}::uuid)
                 ORDER BY n.published_at DESC, n.id DESC
                 LIMIT ${pageSize + 1}::int`
        .returnsRow({
          id: "pg/uuid@1",
          academy_id: "pg/uuid@1",
          academy_name: "pg/text@1",
          category: "pg/text@1",
          title: "pg/text@1",
          body: "pg/text@1",
          published_at: "pg/text@1",
          read_at: "pg/text@1",
        })
        .build(),
    );

    const { page, nextCursor } = splitPage(picked, pageSize);
    const body = parseWith(instructorNoticeListSchema, {
      items: page.map((r) => ({
        noticeId: r.id,
        academyId: r.academy_id,
        academyName: r.academy_name,
        category: r.category,
        title: r.title,
        body: r.body,
        publishedAt: r.published_at,
        readAt: r.read_at === "" ? null : r.read_at,
      })),
      nextCursor,
    });
    return Response.json(body, { status: 200, headers: NO_STORE });
  });
}

type NoticeParams = { params: Promise<{ noticeId: string }> };

/** `POST /api/instructor/staff-notices/{noticeId}/read` — 읽음. 받는 사람이 아니거나 해제됐으면 404 */
export function createReadInstructorStaffNoticeRoute(deps: GuardDeps) {
  const requireInstructor = createRequireInstructor(deps);
  const { db } = deps;
  return withRoute<NoticeParams>(async (request, context) => {
    const instructorId = await requireInstructor(request);
    const noticeId = parseUuidOr404((await context.params).noticeId, DETAIL.notFound);

    // 처음 읽은 시각을 지킨다(COALESCE) — 두 번째 요청은 시각을 바꾸지 않고 같은 값을 돌려준다(멱등).
    // 목록과 같은 두 조건(받는 사람 + 지금 active 소속)을 같은 UPDATE 에 걸어, 못 보는 공지는 고쳐지지도 않는다
    const [row] = await db.query(
      db.raw.sql`UPDATE academy_staff_notice_recipients r
                 SET read_at = COALESCE(r.read_at, now())
                 FROM academy_staff_notices n
                 WHERE r.notice_id = ${noticeId}::uuid
                   AND r.instructor_account_id = ${instructorId}::uuid
                   AND n.id = r.notice_id
                   AND n.status = 'published'
                   AND EXISTS (SELECT 1 FROM instructor_affiliations f
                               WHERE f.academy_id = n.academy_id
                                 AND f.instructor_account_id = ${instructorId}::uuid
                                 AND f.status = 'active')
                 RETURNING to_char(r.read_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS read_at`
        .returnsRow({ read_at: "pg/text@1" })
        .build(),
    );
    if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);

    const body = parseWith(noticeReadResponseSchema, { noticeId, readAt: row.read_at });
    return Response.json(body, { status: 200, headers: NO_STORE });
  });
}
