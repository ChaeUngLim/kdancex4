// S1-4.3(학원 공지 초안·수정·올리기 API) — 소속 강사 전용 학원 공지의 쓰기 경로 셋.
//   계약: _workspace/03_contracts/09-owner-notices.md §3(학원 공지) · 열린 점 ③(제목 100자, 올린 뒤 고치기·지우기 없음)
//   데이터: data-model §7-6 끝 `academy_staff_notices` · `academy_staff_notice_recipients`, §7-7 `notifications`
//   요구: FR-063a(소속 강사 공지) · FR-078(공지 직접 작성 — 글만 받는다) · 보드 W5(학원 공지) · O28(대표 앱 공지 쓰기)
//
// 무엇을 하나:
//   - POST  …/staff-notices                      초안을 만든다. 본문에 `"publish": true` 를 넣으면 같은 요청에서 바로 올린다(O28)
//   - PATCH …/staff-notices/{noticeId}           초안만 고친다. 이미 올린 공지는 409 NOTICE_ALREADY_PUBLISHED
//   - POST  …/staff-notices/{noticeId}/publish   올린다. 이미 올렸으면 아무것도 바꾸지 않고 같은 본문 200(두 번 눌러도 안전)
//
// 올리기 한 트랜잭션(계약 §3 「올리기 트랜잭션」):
//   ① 공지 행을 FOR UPDATE 로 잠근다 — 두 화면이 동시에 「올리기」를 눌러도 한 줄씩 선다.
//      늦게 온 쪽은 이미 published 인 행을 보고 그대로 200 을 돌려준다(상태 조건부 갱신이 멱등의 근거)
//   ② 그 순간 active 소속 강사를 받는 사람으로 고정한다. 0명이면 409 NO_RECIPIENTS(아무것도 바뀌지 않는다)
//   ③ draft → published, published_at·recipient_count 를 함께 적는다(DB 제약 ck_staff_notice_published 가 둘을 묶는다)
//   ④ 받는 사람 행 + 강사마다 알림 `staff_notice_published`(category `operations`)
//      dedupe_key 는 `staff_notice:<공지id>:<강사id>` — 유니크 uq_notifications_dedupe 가 (kind, dedupe_key) 라서
//      받는 사람 id 를 넣어야 강사마다 한 건씩 들어간다(data-model §7-x 행사 알림과 같은 방식). 같은 공지·같은 강사는 DB 가 1건으로 막는다
//
// 권한: 대표(owner)만 — 위임 강사는 학원 공지를 쓸 수 없다(위임 2종 밖, 계약 §3). 관리자 웹 2단계 인증 세션(createConsoleRoute).
//   계약은 「웹·앱 모두」라고 적었지만 지금 직원 쓰기 경로는 모두 관리자 웹 기준이다. 대표 앱(O28)에서 bearer 로 부르게 할지는
//   앱 공지 쓰기 화면 Task 가 정한다(대시보드 S1-4.5 · 알림함 S1-4.6 과 같은 처리).
import { z } from "zod";

import { STAFF_NOTICE_CATEGORIES, STAFF_NOTICE_STATUSES } from "../../domain/constants";
import type { Db } from "../../../prisma/db";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody } from "../http";
import type { Tx } from "./staff-signup";

// ---- 요청·응답 계약(09 §3) -------------------------------------------------------------------

// 제목 1~100자(2026-11-19 확정, DB 제약 ck_staff_notice_title_length 와 같은 값)
export const STAFF_NOTICE_TITLE_MAX = 100;
// 본문 상한(추천값) — 휴강·일정 안내 몇 문단이 들어가는 길이. DB 에는 상한이 없어 요청 검사에서만 막는다
export const STAFF_NOTICE_BODY_MAX = 5_000;

const titleField = z.string().trim().min(1, "제목을 적어 주세요").max(STAFF_NOTICE_TITLE_MAX, "제목은 100자까지 쓸 수 있어요");
const bodyField = z.string().trim().min(1, "내용을 적어 주세요").max(STAFF_NOTICE_BODY_MAX, "내용은 5,000자까지 쓸 수 있어요");
const categoryField = z.enum(STAFF_NOTICE_CATEGORIES);

/** 초안 만들기 본문. 글만 받는다(이미지·포스터 칸 없음, FR-078). publish=true 면 바로 올린다(O28) */
export const createStaffNoticeRequestSchema = z.strictObject({
  category: categoryField,
  title: titleField,
  body: bodyField,
  publish: z.boolean().optional(),
});
export type CreateStaffNoticeRequest = z.infer<typeof createStaffNoticeRequestSchema>;

/** 초안 고치기 본문 — 바꿀 칸만 보낸다. 하나도 없으면 422 */
export const updateStaffNoticeRequestSchema = z
  .strictObject({ category: categoryField.optional(), title: titleField.optional(), body: bodyField.optional() })
  .refine((v) => v.category !== undefined || v.title !== undefined || v.body !== undefined, {
    message: "고칠 칸을 하나 이상 보내 주세요",
  });
export type UpdateStaffNoticeRequest = z.infer<typeof updateStaffNoticeRequestSchema>;

/** 공지 한 건 — 세 경로의 응답이 모두 이 모양이다. 테스트가 이 스키마로 parse 한다(strict) */
export const staffNoticeSchema = z.strictObject({
  noticeId: z.uuid(),
  academyId: z.uuid(),
  category: categoryField,
  title: z.string(),
  body: z.string(),
  status: z.enum(STAFF_NOTICE_STATUSES),
  // 초안이면 둘 다 null, 올린 공지면 둘 다 있다
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  recipientCount: z.int().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type StaffNotice = z.infer<typeof staffNoticeSchema>;

const DETAIL = {
  academyNotFound: "학원을 찾을 수 없어요",
  notFound: "공지를 찾을 수 없어요",
  alreadyPublished: "이미 올린 공지는 고칠 수 없어요. 새 공지로 올려 주세요",
  noRecipients: "공지를 받을 소속 강사가 없어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
// 강사 앱의 학원 공지 화면(I39, 화면은 S2-1) — 알림을 누르면 이리로 간다
const INSTRUCTOR_STAFF_NOTICES_LINK = "/instructor/staff-notices";

// ---- 읽기 ------------------------------------------------------------------------------------

// 빈 칸(초안의 published_at·recipient_count)은 COALESCE 로 빈 글자·-1 로 읽고 toNotice 에서 null 로 되돌린다.
// 칸 목록은 두 SELECT(잠금 있음·없음)에 같은 글자로 적는다 — 원시 SQL 태그는 문자열 조각을 끼울 수 없다
const NOTICE_ROW = {
  id: "pg/uuid@1",
  academy_id: "pg/uuid@1",
  category: "pg/text@1",
  title: "pg/text@1",
  body: "pg/text@1",
  status: "pg/text@1",
  published_at: "pg/text@1",
  recipient_count: "pg/int4@1",
  created_at: "pg/text@1",
  updated_at: "pg/text@1",
} as const;
type NoticeRow = {
  id: string;
  academy_id: string;
  category: string;
  title: string;
  body: string;
  status: string;
  published_at: string;
  recipient_count: number;
  created_at: string;
  updated_at: string;
};

function toNotice(row: NoticeRow): StaffNotice {
  return {
    noticeId: row.id,
    academyId: row.academy_id,
    category: categoryField.parse(row.category),
    title: row.title,
    body: row.body,
    status: row.status === "published" ? "published" : "draft",
    publishedAt: row.published_at === "" ? null : Temporal.Instant.from(row.published_at).toString(),
    recipientCount: row.recipient_count < 0 ? null : row.recipient_count,
    createdAt: Temporal.Instant.from(row.created_at).toString(),
    updatedAt: Temporal.Instant.from(row.updated_at).toString(),
  };
}

/** 이 학원의 공지 하나. 다른 학원 공지·없는 공지는 null. lock=true 면 행을 잠근다(고치기·올리기) */
async function findNotice(db: Db | Tx, academyId: string, noticeId: string, lock: boolean): Promise<StaffNotice | null> {
  const [row] = lock
    ? await db.query(
        db.raw.sql`SELECT id, academy_id, category, title, body, status,
                          COALESCE(to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS published_at,
                          COALESCE(recipient_count, -1) AS recipient_count,
                          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                          to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
                   FROM academy_staff_notices
                   WHERE id = ${noticeId}::uuid AND academy_id = ${academyId}::uuid
                   FOR UPDATE`
          .returnsRow(NOTICE_ROW)
          .build(),
      )
    : await db.query(
        db.raw.sql`SELECT id, academy_id, category, title, body, status,
                          COALESCE(to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS published_at,
                          COALESCE(recipient_count, -1) AS recipient_count,
                          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                          to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
                   FROM academy_staff_notices
                   WHERE id = ${noticeId}::uuid AND academy_id = ${academyId}::uuid`
          .returnsRow(NOTICE_ROW)
          .build(),
      );
  return row === undefined ? null : toNotice(row);
}

// ---- 쓰기 ------------------------------------------------------------------------------------

/**
 * 잠근 초안을 올린다(호출하는 쪽이 이미 트랜잭션 안에서 공지 행을 FOR UPDATE 로 잠갔다).
 *   이미 올린 공지면 아무것도 하지 않는다 — 두 번째 「올리기」는 같은 본문 200 이 된다.
 *   받는 사람은 「지금 active 인 소속 강사」로 고정한다. 해제·대기·거절된 소속은 받지 않는다(계약 수용 5).
 */
async function publishLockedNotice(tx: Tx, academyId: string, notice: StaffNotice): Promise<void> {
  if (notice.status === "published") return;

  // ② 받는 사람 = 이 학원의 active 소속 강사(한 강사가 같은 학원에 소속 행을 둘 가질 수 없지만 DISTINCT 로 한 번 더 막는다)
  const instructors = await tx.query(
    tx.raw.sql`SELECT DISTINCT instructor_account_id
               FROM instructor_affiliations
               WHERE academy_id = ${academyId}::uuid AND status = 'active'`
      .returnsRow({ instructor_account_id: "pg/uuid@1" })
      .build(),
  );
  if (instructors.length === 0) throw HttpError.conflict("NO_RECIPIENTS", DETAIL.noRecipients);

  // ③ 상태 조건부 갱신 — WHERE status = 'draft' 라서 이미 올린 행은 다시 바뀌지 않는다
  await tx.execute(
    tx.raw.sql`UPDATE academy_staff_notices
               SET status = 'published', published_at = now(), recipient_count = ${instructors.length}::int4, updated_at = now()
               WHERE id = ${notice.noticeId}::uuid AND status = 'draft'`
      .affectedCount()
      .build(),
  );

  // ④-1 받는 사람 행. 위 SELECT 와 같은 조건이라 같은 트랜잭션 안에서 같은 강사들이 들어간다
  await tx.execute(
    tx.raw.sql`INSERT INTO academy_staff_notice_recipients (notice_id, instructor_account_id)
               SELECT DISTINCT ${notice.noticeId}::uuid, instructor_account_id
               FROM instructor_affiliations
               WHERE academy_id = ${academyId}::uuid AND status = 'active'
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );

  // ④-2 강사마다 알림 1건. 화면에 보일 문장(제목·본문·버튼·이동 주소)을 payload 에 함께 싣는다(다른 직원 알림과 같은 모양)
  const [academy] = await tx.query(
    tx.raw.sql`SELECT name FROM academies WHERE id = ${academyId}::uuid`.returnsRow({ name: "pg/text@1" }).build(),
  );
  const academyName = academy?.name ?? "";
  const payload = {
    noticeId: notice.noticeId,
    academyId,
    academyName,
    category: notice.category,
    title: `${academyName} 새 공지`,
    body: notice.title,
    actionLabel: "공지 보기",
    link: INSTRUCTOR_STAFF_NOTICES_LINK,
  };
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               SELECT uuidv7(), r.instructor_account_id, ${academyId}::uuid, 'operations', 'staff_notice_published',
                      'staff_notice:' || ${notice.noticeId} || ':' || r.instructor_account_id::text, ${JSON.stringify(payload)}::jsonb
               FROM academy_staff_notice_recipients r
               WHERE r.notice_id = ${notice.noticeId}::uuid
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/** 초안을 만든다. publish=true 면 같은 트랜잭션에서 바로 올린다 — 받는 사람이 0명이면 초안도 남지 않는다 */
async function createNotice(db: Db, academyId: string, authorId: string, body: CreateStaffNoticeRequest): Promise<StaffNotice> {
  return db.transaction(async (tx) => {
    const [inserted] = await tx.query(
      tx.raw.sql`INSERT INTO academy_staff_notices (id, academy_id, author_account_id, category, title, body, updated_at)
                 VALUES (uuidv7(), ${academyId}::uuid, ${authorId}::uuid, ${body.category}, ${body.title}, ${body.body}, now())
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (inserted === undefined) throw new Error("academy_staff_notices INSERT 가 행을 돌려주지 않았다");

    if (body.publish === true) {
      const draft = await findNotice(tx, academyId, inserted.id, true);
      if (draft === null) throw new Error("방금 만든 공지를 다시 읽지 못했다");
      await publishLockedNotice(tx, academyId, draft);
    }
    const notice = await findNotice(tx, academyId, inserted.id, false);
    if (notice === null) throw new Error("방금 만든 공지를 다시 읽지 못했다");
    return notice;
  });
}

/** 초안을 고친다. 행을 잠근 뒤 올린 공지면 409 — 올리기와 동시에 들어와도 「올린 뒤 고쳐짐」이 생기지 않는다 */
async function updateNotice(db: Db, academyId: string, noticeId: string, body: UpdateStaffNoticeRequest): Promise<StaffNotice> {
  return db.transaction(async (tx) => {
    const current = await findNotice(tx, academyId, noticeId, true);
    if (current === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    if (current.status === "published") throw HttpError.conflict("NOTICE_ALREADY_PUBLISHED", DETAIL.alreadyPublished);

    // 보내지 않은 칸은 지금 값을 그대로 둔다
    await tx.execute(
      tx.raw.sql`UPDATE academy_staff_notices
                 SET category = ${body.category ?? current.category}, title = ${body.title ?? current.title},
                     body = ${body.body ?? current.body}, updated_at = now()
                 WHERE id = ${noticeId}::uuid AND status = 'draft'`
        .affectedCount()
        .build(),
    );
    const updated = await findNotice(tx, academyId, noticeId, false);
    if (updated === null) throw new Error("방금 고친 공지를 다시 읽지 못했다");
    return updated;
  });
}

/** 공지를 올린다. 이미 올렸으면 그대로 돌려준다(멱등) */
async function publishNotice(db: Db, academyId: string, noticeId: string): Promise<StaffNotice> {
  return db.transaction(async (tx) => {
    const current = await findNotice(tx, academyId, noticeId, true);
    if (current === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    await publishLockedNotice(tx, academyId, current);
    const published = await findNotice(tx, academyId, noticeId, false);
    if (published === null) throw new Error("방금 올린 공지를 다시 읽지 못했다");
    return published;
  });
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

type AcademyParams = { params: Promise<{ academyId: string }> };
type NoticeParams = { params: Promise<{ academyId: string; noticeId: string }> };

/** 경로 id 모양 검사 — 틀리면 DB 에 넘기지 않고 404(형 변환 오류 500 을 막는다) */
function parseUuidOr404(value: string, detail: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new HttpError("NOT_FOUND", detail);
  return parsed.data;
}

/** `POST /api/academies/{academyId}/staff-notices` — 대표만. 201 + 만든 공지(publish=true 면 올린 공지) */
export function createCreateStaffNoticeRoute(deps: GuardDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (request, context, staff) => {
      const academyId = parseUuidOr404((await context.params).academyId, DETAIL.academyNotFound);
      // 본문: JSON 이 아니면 400, 칸이 틀리면(제목 101자 등) 422 fields
      const body = await parseJsonBody(request, createStaffNoticeRequestSchema);
      const notice = await createNotice(deps.db, academyId, staff.staffAccountId, body);
      return Response.json(notice, { status: 201, headers: NO_STORE });
    },
  );
}

/** `PATCH /api/academies/{academyId}/staff-notices/{noticeId}` — 대표만. 200 + 고친 초안, 올린 공지는 409 */
export function createUpdateStaffNoticeRoute(deps: GuardDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<NoticeParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (request, context) => {
      const params = await context.params;
      const academyId = parseUuidOr404(params.academyId, DETAIL.academyNotFound);
      const body = await parseJsonBody(request, updateStaffNoticeRequestSchema);
      const noticeId = parseUuidOr404(params.noticeId, DETAIL.notFound);
      const notice = await updateNotice(deps.db, academyId, noticeId, body);
      return Response.json(notice, { status: 200, headers: NO_STORE });
    },
  );
}

/** `POST /api/academies/{academyId}/staff-notices/{noticeId}/publish` — 대표만. 200 + 올린 공지(두 번째도 같은 본문) */
export function createPublishStaffNoticeRoute(deps: GuardDeps) {
  const consoleRoute = createConsoleRoute(deps);
  return consoleRoute<NoticeParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId },
    async (_request, context) => {
      const params = await context.params;
      const academyId = parseUuidOr404(params.academyId, DETAIL.academyNotFound);
      const noticeId = parseUuidOr404(params.noticeId, DETAIL.notFound);
      const notice = await publishNotice(deps.db, academyId, noticeId);
      return Response.json(notice, { status: 200, headers: NO_STORE });
    },
  );
}
