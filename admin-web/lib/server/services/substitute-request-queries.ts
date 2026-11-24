// S2-3.4(대타 요청 흐름) — 대타 경로들이 같이 쓰는 읽기. 쓰기는 substitute-requests.ts 에 있다.
//   계약: _workspace/03_contracts/11-instructor.md §8-1(후보 목록) · §8-2(요청 목록 모양)
//   데이터: data-model §8-5(substitute_requests · substitute_request_candidates)
//
// 여기 있는 것:
//   readSessionInfo        회차 한 줄 + 그 수업(학원·장르·제목) — 모든 대타 경로의 출발점
//   computeCandidates      후보 목록(계약 §8-1). 소속·장르는 SQL, 「그 시간에 일정이 있나」는 S2-1.5 의 순수 함수
//   readRequest            대타 요청 한 줄(잠그거나 그냥 읽거나)
//   listRequests           요청 목록(강사 「내가 한 요청·받은 요청」 · 대표 「확인을 기다리는 대타」)
// 후보 판정을 요청 때 · 수락 때 · 대표 확인 때 세 번 하는데, 셋 다 computeCandidates 하나를 쓴다 — 판정이 어긋나지 않게.
import { z } from "zod";

import type { InstructorScheduleItem } from "../../domain/instructor-schedule-overlap";
import { expandPersonalEvent } from "../../domain/schedule-preview";
import { judgeSubstituteCandidates, type SubstituteCandidate } from "../../domain/substitute-request";
import { toKstDate } from "../../domain/time";
import type { Tx } from "./staff-signup";
import type { Db } from "../../../prisma/db";

type Dbx = Db | Tx;

// ---- 회차 ------------------------------------------------------------------------------------

const SESSION_ROW = {
  session_id: "pg/text@1",
  offering_id: "pg/text@1",
  class_id: "pg/text@1",
  academy_id: "pg/text@1",
  class_title: "pg/text@1",
  genre: "pg/text@1",
  instructor_id: "pg/text@1",
  status: "pg/text@1",
  starts_at: "pg/text@1",
  ends_at: "pg/text@1",
  room_name: "pg/text@1",
} as const;

/** 회차 한 줄. 빈 칸은 빈 글자(담당 강사가 없는 옛 회차면 instructor_id = "") */
export type SessionInfo = { [K in keyof typeof SESSION_ROW]: string };

export async function readSessionInfo(db: Dbx, sessionId: string): Promise<SessionInfo | undefined> {
  const [row] = await db.query(
    db.raw.sql`SELECT s.id::text AS session_id, o.id::text AS offering_id, c.id::text AS class_id, c.academy_id::text AS academy_id,
                      c.title AS class_title, c.genre::text AS genre, COALESCE(s.instructor_account_id::text, '') AS instructor_id,
                      s.status::text AS status,
                      to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                      to_char(s.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
                      COALESCE(r.name, '') AS room_name
               FROM class_sessions s
               JOIN class_offerings o ON o.id = s.offering_id
               JOIN classes c ON c.id = o.class_id
               LEFT JOIN rooms r ON r.id = s.room_id
               WHERE s.id = ${sessionId}::uuid`
      .returnsRow(SESSION_ROW)
      .build(),
  );
  return row;
}

/** 회차 행을 잠근다(대표 확인·요청 만들기 트랜잭션 안에서 — 그 사이 휴강·변경이 끼지 않게) */
export async function lockSession(tx: Tx, sessionId: string): Promise<void> {
  await tx.query(
    tx.raw.sql`SELECT id::text AS id FROM class_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`.returnsRow({ id: "pg/text@1" }).build(),
  );
}

/** 회차의 결제 확정 수강생 수(성별 자리별) — 알림을 받을 사람 수이기도 하다(결제 대기·취소는 빼고 셈) */
export async function memberCountOf(db: Dbx, offeringId: string): Promise<{ male: number; female: number; any: number; total: number }> {
  const rows = await db.query(
    db.raw.sql`SELECT r.seat_kind::text AS seat_kind, count(DISTINCT r.member_id)::int4 AS n
               FROM reservations r WHERE r.offering_id = ${offeringId}::uuid AND r.status = 'confirmed'
               GROUP BY r.seat_kind`
      .returnsRow({ seat_kind: "pg/text@1", n: "pg/int4@1" })
      .build(),
  );
  const of = (kind: string) => rows.find((r) => r.seat_kind === kind)?.n ?? 0;
  const [total] = await db.query(
    db.raw.sql`SELECT count(DISTINCT r.member_id)::int4 AS n FROM reservations r
               WHERE r.offering_id = ${offeringId}::uuid AND r.status = 'confirmed'`
      .returnsRow({ n: "pg/int4@1" })
      .build(),
  );
  return { male: of("male"), female: of("female"), any: of("any"), total: total?.n ?? 0 };
}

// ---- 후보 판정 ---------------------------------------------------------------------------------

/** 그 학원 active 소속 강사(계정도 active) — 후보의 바탕. 장르·본인 제외는 순수 함수가 한다 */
async function readPool(db: Dbx, academyId: string) {
  const rows = await db.query(
    db.raw.sql`SELECT a.instructor_account_id::text AS account_id, sa.display_name, COALESCE(p.activity_genre::text, '') AS genre
               FROM instructor_affiliations a
               JOIN staff_accounts sa ON sa.id = a.instructor_account_id AND sa.status = 'active'
               LEFT JOIN instructor_profiles p ON p.staff_account_id = a.instructor_account_id
               WHERE a.academy_id = ${academyId}::uuid AND a.status = 'active'`
      .returnsRow({ account_id: "pg/text@1", display_name: "pg/text@1", genre: "pg/text@1" })
      .build(),
  );
  return rows.map((r) => ({ accountId: r.account_id, displayName: r.display_name, genre: r.genre === "" ? null : r.genre }));
}

/**
 * 후보들의 일정 중 그 회차 시간에 걸칠 수 있는 것 — 수업 회차(어느 학원이든, 예정만) + 개인 일정(반복은 펼친다).
 * 대타를 구하는 그 회차 자신은 뺀다(확정 직전에 대타 강사로 바뀌어도 자기 자신과 겹친다고 하지 않게).
 * 개인 레슨 「레슨 모집」 시간은 S2-4 가 표를 만들면 여기에 더한다.
 */
async function readBusySchedule(db: Dbx, accountIds: readonly string[], session: SessionInfo): Promise<InstructorScheduleItem[]> {
  if (accountIds.length === 0) return [];
  const ids = accountIds.join(",");
  const startsAt = Temporal.Instant.from(session.starts_at);
  const endsAt = Temporal.Instant.from(session.ends_at);
  const classRows = await db.query(
    db.raw.sql`SELECT s.instructor_account_id::text AS account_id,
                      to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                      to_char(s.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at
               FROM class_sessions s
               WHERE s.status = 'scheduled'
                 AND s.instructor_account_id::text = ANY(string_to_array(${ids}, ','))
                 AND s.id <> ${session.session_id}::uuid
                 AND tstzrange(s.starts_at, s.ends_at) && tstzrange(${session.starts_at}::timestamptz, ${session.ends_at}::timestamptz)`
      .returnsRow({ account_id: "pg/text@1", starts_at: "pg/text@1", ends_at: "pg/text@1" })
      .build(),
  );
  const personalRows = await db.query(
    db.raw.sql`SELECT staff_account_id::text AS account_id, title,
                      to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                      to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
                      repeat_rule::text AS repeat_rule, COALESCE(repeat_until::text, '') AS repeat_until
               FROM instructor_personal_events
               WHERE staff_account_id::text = ANY(string_to_array(${ids}, ','))
                 AND starts_at < ${session.ends_at}::timestamptz
                 AND (repeat_rule <> 'none' OR ends_at > ${session.starts_at}::timestamptz)
                 AND (repeat_until IS NULL OR repeat_until >= ${toKstDate(startsAt).toString()}::date)`
      .returnsRow({
        account_id: "pg/text@1",
        title: "pg/text@1",
        starts_at: "pg/text@1",
        ends_at: "pg/text@1",
        repeat_rule: "pg/text@1",
        repeat_until: "pg/text@1",
      })
      .build(),
  );

  const classItems = classRows.map(
    (r): InstructorScheduleItem => ({
      instructorAccountId: r.account_id,
      academyId: null,
      kind: "class_session",
      startsAt: Temporal.Instant.from(r.starts_at),
      endsAt: Temporal.Instant.from(r.ends_at),
      label: "",
    }),
  );
  // 반복 개인 일정은 한 행이라 회차 시간 안의 실제 시간으로 펼친다(수업 일정 미리보기 S2-2.8c 와 같은 함수)
  const personalItems = personalRows.flatMap((r) =>
    expandPersonalEvent(
      {
        title: r.title,
        startsAt: Temporal.Instant.from(r.starts_at),
        endsAt: Temporal.Instant.from(r.ends_at),
        repeat: r.repeat_rule === "weekly" || r.repeat_rule === "daily" ? r.repeat_rule : "none",
        repeatUntil: r.repeat_until === "" ? null : Temporal.PlainDate.from(r.repeat_until),
      },
      { startsAt, endsAt },
    ).map(
      (range): InstructorScheduleItem => ({
        instructorAccountId: r.account_id,
        academyId: null,
        kind: "personal_event",
        ...range,
        label: "",
      }),
    ),
  );
  return [...classItems, ...personalItems];
}

/**
 * 후보 목록(계약 11 §8-1). requester 는 후보에서 뺄 사람(요청한 강사 = 회차의 담당 강사).
 * 대표가 대체 강사를 고를 때(§9)도 같은 함수를 쓸 수 있게 requester 를 따로 받는다.
 */
export async function computeCandidates(db: Dbx, session: SessionInfo, requesterAccountId: string | null): Promise<SubstituteCandidate[]> {
  const pool = await readPool(db, session.academy_id);
  const schedule = await readBusySchedule(
    db,
    pool.map((p) => p.accountId),
    session,
  );
  return judgeSubstituteCandidates({
    session: { startsAt: Temporal.Instant.from(session.starts_at), endsAt: Temporal.Instant.from(session.ends_at) },
    classGenre: session.genre,
    requesterAccountId,
    pool,
    schedule,
  });
}

// ---- 대타 요청 -----------------------------------------------------------------------------------

const REQUEST_ROW = {
  id: "pg/text@1",
  session_id: "pg/text@1",
  requested_by: "pg/text@1",
  message: "pg/text@1",
  status: "pg/text@1",
  accepted_by: "pg/text@1",
  accepted_at: "pg/text@1",
  confirmed_at: "pg/text@1",
  cancelled_at: "pg/text@1",
  created_at: "pg/text@1",
} as const;

/** 대타 요청 한 줄. 빈 칸은 빈 글자 */
export type RequestRow = { [K in keyof typeof REQUEST_ROW]: string };

/** 요청을 읽는다. forUpdate 면 그 행을 잠근다(취소·대표 확인이 동시에 와도 하나씩) */
export async function readRequest(db: Dbx, requestId: string, forUpdate = false): Promise<RequestRow | undefined> {
  if (forUpdate) {
    await db.query(
      db.raw.sql`SELECT id::text AS id FROM substitute_requests WHERE id = ${requestId}::uuid FOR UPDATE`.returnsRow({ id: "pg/text@1" }).build(),
    );
  }
  const [row] = await db.query(
    db.raw.sql`SELECT id::text AS id, session_id::text AS session_id, requested_by_account_id::text AS requested_by,
                      COALESCE(message, '') AS message, status::text AS status,
                      COALESCE(accepted_candidate_account_id::text, '') AS accepted_by,
                      COALESCE(to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') AS accepted_at,
                      COALESCE(to_char(confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') AS confirmed_at,
                      COALESCE(to_char(cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') AS cancelled_at,
                      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
               FROM substitute_requests WHERE id = ${requestId}::uuid`
      .returnsRow(REQUEST_ROW)
      .build(),
  );
  return row;
}

/** 후보 한 명의 상태(invited·accepted·declined·closed). 후보가 아니면 undefined */
export async function readCandidateStatus(db: Dbx, requestId: string, accountId: string): Promise<string | undefined> {
  const [row] = await db.query(
    db.raw.sql`SELECT status::text AS status FROM substitute_request_candidates
               WHERE request_id = ${requestId}::uuid AND candidate_account_id = ${accountId}::uuid`
      .returnsRow({ status: "pg/text@1" })
      .build(),
  );
  return row?.status;
}

/** 요청의 후보들(이름 포함, 이름순) */
export async function readCandidates(db: Dbx, requestId: string): Promise<{ accountId: string; displayName: string; status: string }[]> {
  const rows = await db.query(
    db.raw.sql`SELECT c.candidate_account_id::text AS account_id, sa.display_name, c.status::text AS status
               FROM substitute_request_candidates c JOIN staff_accounts sa ON sa.id = c.candidate_account_id
               WHERE c.request_id = ${requestId}::uuid ORDER BY sa.display_name, c.candidate_account_id`
      .returnsRow({ account_id: "pg/text@1", display_name: "pg/text@1", status: "pg/text@1" })
      .build(),
  );
  return rows.map((r) => ({ accountId: r.account_id, displayName: r.display_name, status: r.status }));
}

export async function displayNameOf(db: Dbx, accountId: string): Promise<string> {
  if (accountId === "") return "";
  const [row] = await db.query(
    db.raw.sql`SELECT display_name FROM staff_accounts WHERE id = ${accountId}::uuid`.returnsRow({ display_name: "pg/text@1" }).build(),
  );
  return row?.display_name ?? "";
}

// ---- 목록(계약 11 §8 표의 GET 두 개) ---------------------------------------------------------

const personOut = z.strictObject({ accountId: z.string(), displayName: z.string() });
const sessionOut = z.strictObject({
  sessionId: z.string(),
  classId: z.string(),
  classTitle: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  roomName: z.string(),
  memberCount: z.strictObject({ male: z.number().int(), female: z.number().int(), any: z.number().int() }),
});
const timelineOut = z.array(z.strictObject({ step: z.string(), at: z.string() }));

/** 목록 한 줄 — 강사(requested·received)와 대표(확인 대기)가 같은 모양을 쓰고, 받은 요청만 candidateStatus 가 있다 */
export const substituteRequestItemSchema = z.strictObject({
  requestId: z.string(),
  session: sessionOut,
  status: z.string(),
  candidateStatus: z.string().nullable(),
  requestedBy: personOut,
  acceptedBy: personOut.nullable(),
  message: z.string().nullable(),
  timeline: timelineOut,
});
export const substituteRequestListSchema = z.strictObject({ items: z.array(substituteRequestItemSchema) });
export type SubstituteRequestItem = z.infer<typeof substituteRequestItemSchema>;

export type ListFilter =
  | { kind: "requested"; accountId: string; status: string | null }
  | { kind: "received"; accountId: string; status: string | null }
  | { kind: "academy"; academyId: string; status: string };

const LIST_ROW = {
  ...REQUEST_ROW,
  requested_name: "pg/text@1",
  accepted_name: "pg/text@1",
  candidate_status: "pg/text@1",
  offering_id: "pg/text@1",
  class_id: "pg/text@1",
  class_title: "pg/text@1",
  starts_at: "pg/text@1",
  ends_at: "pg/text@1",
  room_name: "pg/text@1",
} as const;

/** 요청 목록 — 회차 시작이 가까운 순. 누구의 목록인지는 filter 가 정한다 */
export async function listRequests(db: Db, filter: ListFilter): Promise<SubstituteRequestItem[]> {
  const me = filter.kind === "academy" ? "" : filter.accountId;
  const academy = filter.kind === "academy" ? filter.academyId : "";
  const status = filter.status ?? "";
  const rows = await db.query(
    db.raw.sql`SELECT q.id::text AS id, q.session_id::text AS session_id, q.requested_by_account_id::text AS requested_by,
                      COALESCE(q.message, '') AS message, q.status::text AS status,
                      COALESCE(q.accepted_candidate_account_id::text, '') AS accepted_by,
                      COALESCE(to_char(q.accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') AS accepted_at,
                      COALESCE(to_char(q.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') AS confirmed_at,
                      COALESCE(to_char(q.cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') AS cancelled_at,
                      to_char(q.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
                      rq.display_name AS requested_name, COALESCE(ac.display_name, '') AS accepted_name,
                      COALESCE(mine.status::text, '') AS candidate_status,
                      o.id::text AS offering_id, c.id::text AS class_id, c.title AS class_title,
                      to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                      to_char(s.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
                      COALESCE(r.name, '') AS room_name
               FROM substitute_requests q
               JOIN class_sessions s ON s.id = q.session_id
               JOIN class_offerings o ON o.id = s.offering_id
               JOIN classes c ON c.id = o.class_id
               LEFT JOIN rooms r ON r.id = s.room_id
               JOIN staff_accounts rq ON rq.id = q.requested_by_account_id
               LEFT JOIN staff_accounts ac ON ac.id = q.accepted_candidate_account_id
               LEFT JOIN substitute_request_candidates mine
                      ON mine.request_id = q.id AND mine.candidate_account_id = NULLIF(${me}, '')::uuid
               WHERE (${filter.kind} <> 'requested' OR q.requested_by_account_id = NULLIF(${me}, '')::uuid)
                 AND (${filter.kind} <> 'received' OR mine.request_id IS NOT NULL)
                 AND (${filter.kind} <> 'academy' OR c.academy_id = NULLIF(${academy}, '')::uuid)
                 AND (${status} = '' OR q.status::text = ${status})
               ORDER BY s.starts_at, q.id
               LIMIT 200`
      .returnsRow(LIST_ROW)
      .build(),
  );
  const items: SubstituteRequestItem[] = [];
  for (const row of rows) {
    const count = await memberCountOf(db, row.offering_id);
    items.push({
      requestId: row.id,
      session: {
        sessionId: row.session_id,
        classId: row.class_id,
        classTitle: row.class_title,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        roomName: row.room_name,
        memberCount: { male: count.male, female: count.female, any: count.any },
      },
      status: row.status,
      candidateStatus: filter.kind === "received" ? row.candidate_status : null,
      requestedBy: { accountId: row.requested_by, displayName: row.requested_name },
      acceptedBy: row.accepted_by === "" ? null : { accountId: row.accepted_by, displayName: row.accepted_name },
      message: row.message === "" ? null : row.message,
      timeline: timelineOf(row),
    });
  }
  return items;
}

/** I14B 진행 단계 — 지나간 단계만 시각과 함께. 대표 확인과 수강생 알림은 한 트랜잭션이라 같은 시각이다 */
export function timelineOf(row: Pick<RequestRow, "created_at" | "accepted_at" | "confirmed_at" | "cancelled_at" | "status">): { step: string; at: string }[] {
  const steps = [
    { step: "requested", at: row.created_at },
    { step: "accepted", at: row.accepted_at },
    { step: "owner_confirmed", at: row.confirmed_at },
    { step: "members_notified", at: row.confirmed_at },
    { step: "cancelled", at: row.cancelled_at },
  ];
  return steps.filter((s) => s.at !== "");
}
