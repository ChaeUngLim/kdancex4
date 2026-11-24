// S2-3.5(강사 수업 공지) — 강사(또는 대표)가 자기 수업의 확정 수강생에게 공지를 쓴다.
//   계약: _workspace/03_contracts/11-instructor.md §6-3(강사 공지, I13 · I13B · M8C) · §7(알림 종류)
//   경로: GET  /api/classes/{classId}/announcement-recipients   받는 사람 수(확정 수강생, 남·여)
//         POST /api/classes/{classId}/announcements             공지 보내기(Idempotency-Key 필수)
//         GET  /api/classes/{classId}/announcements             보낸 공지 목록(강사·대표)
//         GET  /api/me/classes/{classId}/announcements          회원이 보는 수업 상세의 「강사 공지」
//   데이터: data-model §8-5(class_announcements) · §8-7(알림 종류 class_announcement)
//   요구: FR-063(강사 수업 공지)
//
// 흐름 한눈에 — 공지 하나가 한 트랜잭션 안에서 「공지 행 → 회원마다 알림 행」을 함께 쓴다:
//   받는 사람 = 그 수업의 「결제 확정」 예약 회원(중복 제거). 결제 대기·대기 신청·취소 회원은 받지 않는다(I13).
//   회차를 골랐으면 그 회차가 속한 판매 단위의 확정 회원만 받는다. 다른 수업의 회원에게는 알림 행이 생기지 않는다.
//   알림 행은 delivery_status = pending 으로 남기만 한다(발송은 S7-1 의 NotificationSenderPort).
//   pushToo = false 면 발송 표시만 skipped 로 끈다 — 알림함에는 그대로 남는다(계약 11 §6-3).
//   공지 자체는 받는 사람이 0명이어도 남는다(recipient_count = 0). 수업 상세 「강사 공지」는 이 표에서 읽는다.
//
// 누가 쓸 수 있나(계약 11 §6 머리) — 그 수업의 올린 사람 · 담당 강사(수업 또는 고른 회차) · 그 학원 대표.
//   강사는 지금도 그 학원 active 소속이어야 한다(소속이 끝난 강사가 회원에게 알림을 보내지 못하게, 403 AFFILIATION_REQUIRED).
//   강사 멤버십이 끝나도 쓴다(14 §2 alwaysFree — 공지는 항상 무료).
import { z } from "zod";

import { CLASS_ANNOUNCEMENT_KINDS } from "../../domain/constants";
import { systemClock, type Clock } from "../../domain/time";
import { createGuards, type GuardDeps, type StaffAccountContext } from "../guards";
import { HttpError, parseJsonBody, readIdempotencyKey, withRoute } from "../http";
import { createClassAccess } from "./class-registration";
import type { Tx } from "./staff-signup";
import type { Db } from "../../../prisma/db";

// ---- 사람이 읽는 문장 --------------------------------------------------------------------------

const DETAIL = {
  notFound: "수업을 찾을 수 없어요",
  forbidden: "이 수업에 공지를 쓸 권한이 없어요",
  memberForbidden: "이 수업을 예약한 회원만 공지를 볼 수 있어요",
  affiliation: "이 학원 소속 강사만 공지를 쓸 수 있어요",
  notPublished: "공개된 수업에만 공지를 쓸 수 있어요",
  validation: "입력값을 확인해 주세요",
  excluded: "결제 대기·대기 신청은 받지 않아요",
} as const;

/** 제목·내용 글자 수(data-model §8-5 ck_announce_title · ck_announce_body — DB 가 최후 방어선) */
export const ANNOUNCEMENT_TITLE_MAX = 100;
export const ANNOUNCEMENT_BODY_MAX = 500;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청 본문 --------------------------------------------------------------------------------

/** 공지 보내기(계약 11 §6-3). 회차는 고르지 않아도 된다(수업 전체 공지) */
export const announcementBodySchema = z.strictObject({
  sessionId: z.uuid().nullish(),
  kind: z.enum(CLASS_ANNOUNCEMENT_KINDS),
  title: z.string().trim().min(1, "제목을 적어 주세요").max(ANNOUNCEMENT_TITLE_MAX, `제목은 ${ANNOUNCEMENT_TITLE_MAX}자까지예요`),
  body: z.string().trim().min(1, "내용을 적어 주세요").max(ANNOUNCEMENT_BODY_MAX, `내용은 ${ANNOUNCEMENT_BODY_MAX}자까지예요`),
  pushToo: z.boolean().default(true),
});
export type AnnouncementBody = z.infer<typeof announcementBodySchema>;

// ---- 응답 모양(계약 11 §6-3) — 테스트가 이 스키마로 응답을 parse 한다 ----------------------------

export const announcementRecipientsSchema = z.strictObject({
  recipientCount: z.number().int(),
  male: z.number().int(),
  female: z.number().int(),
  excluded: z.string(),
});
export const announcementCreatedSchema = z.strictObject({
  announcementId: z.string(),
  recipientCount: z.number().int(),
  createdAt: z.string(),
});
export const staffAnnouncementListSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      announcementId: z.string(),
      kind: z.enum(CLASS_ANNOUNCEMENT_KINDS),
      title: z.string(),
      body: z.string(),
      sessionId: z.string().nullable(),
      authorName: z.string(),
      recipientCount: z.number().int(),
      createdAt: z.string(),
    }),
  ),
});
/** 회원용 — 받은 사람 수(recipientCount)와 회차 id 는 넣지 않는다 */
export const memberAnnouncementListSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      announcementId: z.string(),
      kind: z.enum(CLASS_ANNOUNCEMENT_KINDS),
      title: z.string(),
      body: z.string(),
      authorName: z.string(),
      createdAt: z.string(),
    }),
  ),
});
type Created = z.infer<typeof announcementCreatedSchema>;

// ---- 수업 읽기 --------------------------------------------------------------------------------

type ClassRow = { class_id: string; academy_id: string; title: string; status: string; created_by: string; instructor_id: string };

async function readClass(db: Db | Tx, classId: string): Promise<ClassRow | undefined> {
  const [row] = await db.query(
    db.raw.sql`SELECT c.id::text AS class_id, c.academy_id::text AS academy_id, c.title, c.status,
                      COALESCE(c.created_by_account_id::text, '') AS created_by,
                      COALESCE(c.instructor_account_id::text, '') AS instructor_id
               FROM classes c WHERE c.id = ${classId}::uuid`
      .returnsRow({
        class_id: "pg/text@1",
        academy_id: "pg/text@1",
        title: "pg/text@1",
        status: "pg/text@1",
        created_by: "pg/text@1",
        instructor_id: "pg/text@1",
      })
      .build(),
  );
  return row;
}

/** 그 수업의 회차인지 확인하고 담당 강사 id 를 돌려준다(없거나 다른 수업 회차면 undefined) */
async function readSessionOfClass(db: Db | Tx, classId: string, sessionId: string): Promise<{ instructor_id: string } | undefined> {
  const [row] = await db.query(
    db.raw.sql`SELECT COALESCE(s.instructor_account_id::text, '') AS instructor_id
               FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id
               WHERE s.id = ${sessionId}::uuid AND o.class_id = ${classId}::uuid`
      .returnsRow({ instructor_id: "pg/text@1" })
      .build(),
  );
  return row;
}

// 받는 회원을 고르는 조건 — 셈(countRecipients)과 실제 알림 행(create 의 ②)이 같은 조건을 쓴다(셈과 행 수가 어긋나지 않게).
//   회차를 골랐으면 그 회차의 판매 단위, 아니면 그 수업의 모든 판매 단위에서 결제 확정 예약만(중복 제거).
//   쿼리 빌더가 SQL 조각을 끼워 넣지 못해 두 곳에 같은 WHERE 를 적었다 — 한쪽을 고치면 다른 쪽도 고친다.

async function countRecipients(db: Db | Tx, classId: string, sessionId: string | null): Promise<{ total: number; male: number; female: number }> {
  const [row] = await db.query(
    db.raw.sql`SELECT count(*)::int4 AS total,
                      count(*) FILTER (WHERE m.gender = 'male')::int4 AS male,
                      count(*) FILTER (WHERE m.gender = 'female')::int4 AS female
               FROM members m
               WHERE m.id IN (SELECT r.member_id
                              FROM reservations r JOIN class_offerings o ON o.id = r.offering_id
                              WHERE r.status = 'confirmed' AND o.class_id = ${classId}::uuid
                                AND (${sessionId ?? ""} = ''
                                     OR r.offering_id = (SELECT s.offering_id FROM class_sessions s
                                                         WHERE s.id = NULLIF(${sessionId ?? ""}, '')::uuid)))`
      .returnsRow({ total: "pg/int4@1", male: "pg/int4@1", female: "pg/int4@1" })
      .build(),
  );
  return { total: row?.total ?? 0, male: row?.male ?? 0, female: row?.female ?? 0 };
}

// ---- 경로 -------------------------------------------------------------------------------------

type Caller = { accountId: string; isOwner: boolean };
type Params = { params: Promise<{ classId: string }> };

export type ClassAnnouncementDeps = GuardDeps & { clock?: Clock };

export function createClassAnnouncementRoutes(deps: ClassAnnouncementDeps) {
  const { readStaff } = createClassAccess(deps);
  const guards = createGuards(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;

  /** 대표면 통과. 강사면 올린 사람·담당 강사(수업 또는 고른 회차)이고 지금 active 소속이어야 한다 */
  async function requireCaller(staff: StaffAccountContext, row: ClassRow, sessionInstructorId: string): Promise<Caller> {
    if (staff.actor.ownedAcademyIds.includes(row.academy_id)) return { accountId: staff.staffAccountId, isOwner: true };
    const me = staff.staffAccountId;
    if (![row.created_by, row.instructor_id, sessionInstructorId].includes(me)) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    const [aff] = await db.query(
      db.raw.sql`SELECT id FROM instructor_affiliations
                 WHERE academy_id = ${row.academy_id}::uuid AND instructor_account_id = ${me}::uuid AND status = 'active'`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (aff === undefined) throw HttpError.forbidden("AFFILIATION_REQUIRED", DETAIL.affiliation);
    return { accountId: me, isOwner: false };
  }

  /** 순서: 인증 → 수업 있음(404) → 회차가 그 수업 것인지(422) → 권한(403) */
  async function load(staff: StaffAccountContext, context: Params, sessionId: string | null): Promise<{ row: ClassRow; caller: Caller }> {
    const ids = z.object({ classId: z.uuid() }).safeParse(await context.params);
    if (!ids.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const row = await readClass(db, ids.data.classId);
    if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    let sessionInstructorId = "";
    if (sessionId !== null) {
      const session = await readSessionOfClass(db, row.class_id, sessionId);
      if (session === undefined) {
        throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path: "sessionId", message: "이 수업의 회차가 아니에요" }] });
      }
      sessionInstructorId = session.instructor_id;
    }
    return { row, caller: await requireCaller(staff, row, sessionInstructorId) };
  }

  /** 쿼리의 sessionId — 비었으면 null, 모양이 틀리면 422 */
  function sessionIdFromQuery(request: Request): string | null {
    const raw = new URL(request.url).searchParams.get("sessionId");
    if (raw === null || raw === "") return null;
    const parsed = z.uuid().safeParse(raw);
    if (!parsed.success) throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path: "sessionId", message: "회차 id 모양이 아니에요" }] });
    return parsed.data;
  }

  // ---- 받는 사람 수(I13 「받는 사람 11명 · 남 5 · 여 6」) ----------------------------------------
  const recipients = withRoute<Params>(async (request, context) => {
    const staff = await readStaff(request);
    const sessionId = sessionIdFromQuery(request);
    const { row } = await load(staff, context, sessionId);
    const n = await countRecipients(db, row.class_id, sessionId);
    return Response.json({ recipientCount: n.total, male: n.male, female: n.female, excluded: DETAIL.excluded }, { headers: NO_STORE });
  });

  // ---- 공지 보내기 --------------------------------------------------------------------------
  const create = withRoute<Params>(async (request, context) => {
    // 순서: 인증(401·403) → 키(400) → 본문(422) → 수업·권한 — 로그인 안 한 요청이 키 오류부터 보지 않게
    const staff = await readStaff(request);
    const key = readIdempotencyKey(request, { required: true });
    const body = await parseJsonBody(request, announcementBodySchema);
    const sessionId = body.sessionId ?? null;
    const { row, caller } = await load(staff, context, sessionId);

    // 같은 키로 다시 왔으면 아무것도 쓰지 않고 처음 결과(README §5 — 본문이 달라도 처음 것)
    const replay = await findByKey(db, caller.accountId, key);
    if (replay !== null) return Response.json(replay, { status: 201, headers: NO_STORE });

    // 공개된 수업에만 쓴다(임시 저장·승인 대기·폐강한 수업에는 수강생이 없거나 더는 받지 않는다)
    if (row.status !== "published") throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.notPublished);

    const nowIso = clock().toString();
    const result = await db
      .transaction(async (tx): Promise<Created> => {
        // 트랜잭션 안에서 다시 본다 — 그 사이 폐강됐으면 409
        const fresh = await readClass(tx, row.class_id);
        if (fresh === undefined || fresh.status !== "published") throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.notPublished);

        // ① 공지 행 — 받는 사람 수는 보낼 때의 확정 수강생으로 고정한다
        const count = await countRecipients(tx, row.class_id, sessionId);
        const [inserted] = await tx.query(
          tx.raw.sql`INSERT INTO class_announcements (id, class_id, session_id, author_account_id, kind, title, body,
                                                      push_requested, recipient_count, idempotency_key, created_at)
                     VALUES (uuidv7(), ${row.class_id}::uuid, NULLIF(${sessionId ?? ""}, '')::uuid, ${caller.accountId}::uuid,
                             ${body.kind}, ${body.title}, ${body.body}, ${body.pushToo ? "true" : "false"}::boolean,
                             ${count.total}, ${key}, ${nowIso}::timestamptz)
                     RETURNING id::text AS id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at`
            .returnsRow({ id: "pg/text@1", created_at: "pg/text@1" })
            .build(),
        );
        if (inserted === undefined) throw new Error("공지 행을 쓰지 못했다");

        // ② 받는 회원마다 알림 1행 — 열쇠가 회원마다 달라 같은 공지를 다시 처리해도 한 건이다.
        //    푸시를 끄면 발송 표시만 skipped(알림함에는 남는다)
        const payload = JSON.stringify({
          classId: row.class_id,
          sessionId,
          announcementId: inserted.id,
          announcementKind: body.kind,
          classTitle: row.title,
          title: body.title,
          body: body.body,
        });
        await tx.execute(
          tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, dedupe_key, payload, delivery_status)
                     SELECT uuidv7(), m.member_id, ${row.academy_id}::uuid, 'class_announcement',
                            ${`announcement:${inserted.id}:`} || m.member_id::text, ${payload}::jsonb, ${body.pushToo ? "pending" : "skipped"}
                     FROM (SELECT DISTINCT r.member_id
                           FROM reservations r JOIN class_offerings o ON o.id = r.offering_id
                           WHERE r.status = 'confirmed' AND o.class_id = ${row.class_id}::uuid
                             AND (${sessionId ?? ""} = ''
                                  OR r.offering_id = (SELECT s.offering_id FROM class_sessions s
                                                      WHERE s.id = NULLIF(${sessionId ?? ""}, '')::uuid))) m
                     ON CONFLICT DO NOTHING`
            .affectedCount()
            .build(),
        );
        return { announcementId: inserted.id, recipientCount: count.total, createdAt: inserted.created_at };
      })
      .catch(async (error: unknown) => {
        // 같은 키 두 요청이 동시에 왔다 — 먼저 들어간 쪽 결과로 수렴한다(uq_announce_idem)
        if (isUniqueViolation(error, "uq_announce_idem")) {
          const raced = await findByKey(db, caller.accountId, key);
          if (raced !== null) return raced;
        }
        throw error;
      });
    return Response.json(result, { status: 201, headers: NO_STORE });
  });

  // ---- 보낸 공지 목록(강사·대표, I13B) --------------------------------------------------------
  const list = withRoute<Params>(async (request, context) => {
    const { row } = await load(await readStaff(request), context, null);
    const items = await readAnnouncements(db, row.class_id);
    return Response.json(
      {
        items: items.map((a) => ({
          announcementId: a.id,
          kind: a.kind,
          title: a.title,
          body: a.body,
          sessionId: a.session_id === "" ? null : a.session_id,
          authorName: a.author_name,
          recipientCount: a.recipient_count,
          createdAt: a.created_at,
        })),
      },
      { headers: NO_STORE },
    );
  });

  // ---- 회원이 보는 「강사 공지」(M8C) — 그 수업 확정 예약이 있는 회원만 ------------------------------
  const listForMember = withRoute<Params>(async (request, context) => {
    const member = await guards.requireMember(request);
    const ids = z.object({ classId: z.uuid() }).safeParse(await context.params);
    if (!ids.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const row = await readClass(db, ids.data.classId);
    if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const [booked] = await db.query(
      db.raw.sql`SELECT 1::int4 AS one FROM reservations r JOIN class_offerings o ON o.id = r.offering_id
                 WHERE o.class_id = ${row.class_id}::uuid AND r.member_id = ${member.memberId}::uuid AND r.status = 'confirmed'
                 LIMIT 1`
        .returnsRow({ one: "pg/int4@1" })
        .build(),
    );
    if (booked === undefined) throw new HttpError("FORBIDDEN", DETAIL.memberForbidden);
    const items = await readAnnouncements(db, row.class_id);
    return Response.json(
      {
        items: items.map((a) => ({
          announcementId: a.id,
          kind: a.kind,
          title: a.title,
          body: a.body,
          authorName: a.author_name,
          createdAt: a.created_at,
        })),
      },
      { headers: NO_STORE },
    );
  });

  return { recipients, create, list, listForMember };
}

// ---- 읽기 도우미 ------------------------------------------------------------------------------

type AnnouncementRow = {
  id: string;
  kind: (typeof CLASS_ANNOUNCEMENT_KINDS)[number];
  title: string;
  body: string;
  session_id: string;
  author_name: string;
  recipient_count: number;
  created_at: string;
};

/** 그 수업의 공지 최신순(같은 시각이면 나중에 쓴 것 먼저 — id 가 uuidv7 이라 시간순이다) */
async function readAnnouncements(db: Db | Tx, classId: string): Promise<AnnouncementRow[]> {
  const rows = await db.query(
    db.raw.sql`SELECT a.id::text AS id, a.kind, a.title, a.body, COALESCE(a.session_id::text, '') AS session_id,
                      s.display_name AS author_name, a.recipient_count::int4 AS recipient_count,
                      to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
               FROM class_announcements a JOIN staff_accounts s ON s.id = a.author_account_id
               WHERE a.class_id = ${classId}::uuid
               ORDER BY a.created_at DESC, a.id DESC`
      .returnsRow({
        id: "pg/text@1",
        kind: "pg/text@1",
        title: "pg/text@1",
        body: "pg/text@1",
        session_id: "pg/text@1",
        author_name: "pg/text@1",
        recipient_count: "pg/int4@1",
        created_at: "pg/text@1",
      })
      .build(),
  );
  return rows as AnnouncementRow[];
}

/** 같은 강사·같은 키로 쓴 공지의 처음 결과 */
async function findByKey(db: Db | Tx, accountId: string, key: string): Promise<Created | null> {
  const [row] = await db.query(
    db.raw.sql`SELECT id::text AS id, recipient_count::int4 AS recipient_count,
                      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
               FROM class_announcements WHERE author_account_id = ${accountId}::uuid AND idempotency_key = ${key}`
      .returnsRow({ id: "pg/text@1", recipient_count: "pg/int4@1", created_at: "pg/text@1" })
      .build(),
  );
  return row === undefined ? null : { announcementId: row.id, recipientCount: row.recipient_count, createdAt: row.created_at };
}

/** 유니크 위반(23505)이 그 제약 이름 때문인가 — 드라이버가 감싼 cause 를 따라 내려간다 */
function isUniqueViolation(error: unknown, constraintPrefix: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
    const e = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    const text = `${String(e.constraint ?? "")} ${String(e.message ?? "")}`;
    if (e.code === "23505" && text.includes(constraintPrefix)) return true;
    if (text.includes("duplicate key") && text.includes(constraintPrefix)) return true;
    current = e.cause;
  }
  return false;
}
