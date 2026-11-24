// S2-2.4(강사·강의실 충돌 거부) — 수업 등록 경로(임시 저장 · 승인 요청)에서 「같은 강사」·「같은 홀」의 시간 겹침을 막는다.
//   계약: _workspace/03_contracts/11-instructor.md §4-2(임시 저장 때도 겹침 확인) · §4-3(겹침 판정 · 오류 응답)
//   데이터: data-model §8 머리 · §8-2(ex_sessions_instructor · ex_sessions_room)
//   요구: FR-054(강사 일정 충돌 거부) · FR-072(강의실 중복 배정 거부) · 수용 ④ · SC-009(강사 중복 배정 0건)
//
// 겹침을 세 겹으로 막는다:
//   ① 앱 판정 — 이 파일. DB 에서 그 강사·그 홀의 「예정」 회차를 읽어 S2-1.5 의 순수 함수로 「무엇과 몇 분」을 계산하고
//      409 안내문을 만든다. 강사 판정은 학원을 묻지 않는다(몸은 하나라서 학원 A·B 수업이 같은 시각이면 겹침).
//   ② 잠금 — 승인 요청(회차를 실제로 만드는 때)은 같은 강사·같은 홀의 트랜잭션 잠금(pg_advisory_xact_lock) 안에서 ① 을 한다.
//      두 학원에 동시에 눌러도 뒤에 온 쪽이 앞의 회차를 보고 거부된다.
//   ③ DB — class_sessions 의 EXCLUDE 제약 두 개가 마지막으로 막는다. 잠금을 거치지 않는 길이 생겨도 같은 시각 두 회차는 못 들어간다.
//      그 위반(23P01)도 같은 409 코드로 돌려준다(이때는 무엇과 겹쳤는지 모르므로 conflicts 는 빈 배열).
//
// S2-2.8c(수업 일정 겹침 미리보기)가 이 파일의 읽기(readScheduledSessions)와 계산(computeScheduleConflicts)을 그대로 빌려 간다 —
//   미리보기와 저장 판정이 같은 함수를 써야 「미리보기는 통과, 저장은 409」가 생기지 않는다.
//
// 이 파일이 하지 않는 것: 개인 레슨 「레슨 모집」 시간과의 겹침(그 테이블은 S2-4 가 만든다) · 409 본문의 빈 시간 추천 칩
//   (suggestions — 추천 계산은 미리보기 class-schedule-check.ts 에만 있고, 409 에는 아직 빈 배열) · 개인 일정(겹침 사유가 아니다, 열린 점 ②)
import {
  findInstructorOverlaps,
  overlapMinutes,
  type InstructorScheduleItem,
  type TimeRange,
} from "../../domain/instructor-schedule-overlap";
import { formatTimeOfDay, toKstTimeOfDay } from "../../domain/time";
import { HttpError } from "../http";
import type { Tx } from "./staff-signup";
import type { Db } from "../../../prisma/db";

/** 409 본문의 겹침 한 줄(11 §4-3) */
export type ScheduleConflict = { startsAt: string; endsAt: string; overlapMinutes: number; label: string };

/** 다른 학원 수업은 이름을 밝히지 않는다(FR-054 ①) · 대표가 대신 올리면 무엇과 겹치는지 밝히지 않는다(11 §4-1 · §4-3) */
const LABEL_OTHER_ACADEMY = "다른 학원 일정";
const LABEL_INSTRUCTOR = "강사 일정";
const DETAIL_RACE = "다른 일정과 겹쳐요. 시간을 다시 골라 주세요";

export type ScheduleCheckInput = {
  /** 이 수업의 학원 — 라벨을 가릴 때만 쓴다(판정에는 쓰지 않는다) */
  academyId: string;
  instructorAccountId: string;
  /** 홀을 아직 안 골랐으면 null — 홀 겹침은 보지 않는다 */
  roomId: string | null;
  /** 새로 만들 회차들 */
  sessions: readonly TimeRange[];
  /** 대표가 부르면 겹친 상대를 「강사 일정」으로만 보인다 */
  callerIsOwner: boolean;
  /** 이 회차 하나는 빼고 본다(S2-3.2 회차 시간·장소 변경 — 옮기는 회차가 자기 자신과 겹친다고 하지 않게) */
  excludeSessionId?: string | null;
  /** 이 수업의 회차는 모두 빼고 본다(S2-3.12 공개 뒤 요일·시간·기간 수정 — 옮길 회차들이 자기 옛 시각과 겹친다고 하지 않게) */
  excludeClass?: { classId: string; academyId: string } | null;
};

const EXISTING_ROW = {
  starts_at: "pg/text@1",
  ends_at: "pg/text@1",
  academy_id: "pg/uuid@1",
  instructor_id: "pg/text@1",
  room_id: "pg/text@1",
  room_name: "pg/text@1",
  title: "pg/text@1",
} as const;

/** 이미 잡힌 「예정」 회차 한 줄(그 강사 것이거나 그 홀 것). 시각은 「…Z」 글자 */
export type ScheduledSessionRow = {
  starts_at: string;
  ends_at: string;
  academy_id: string;
  /** 담당 강사가 없는 옛 회차면 빈 글자 */
  instructor_id: string;
  /** 홀이 없는 회차면 빈 글자 */
  room_id: string;
  room_name: string;
  title: string;
};

export type ScheduledSessionQuery = {
  /** 그 강사의 회차를 읽는다. null 이면 강사 쪽은 읽지 않는다(대표가 담당 강사를 아직 안 고른 미리보기) */
  instructorAccountId: string | null;
  /** 그 홀의 회차를 읽는다. null 이면 홀 쪽은 읽지 않는다 */
  roomId: string | null;
  /** 읽을 기간 [from, to) — 「…Z」 글자 */
  from: string;
  to: string;
  /**
   * 이 수업의 회차는 빼고 읽는다(S2-2.8c 일정 미리보기 — 이미 공개된 수업을 고칠 때 자기 회차와 겹친다고 하지 않게).
   * 같은 학원 수업일 때만 뺀다 — 남의 학원 수업 id 를 넣어 그 회차를 가리지 못하게.
   */
  exclude?: { classId: string; academyId: string } | null;
  /** 이 회차 하나만 빼고 읽는다(S2-3.2 회차 변경). 같은 수업의 다른 회차와 겹치는지는 그대로 본다 */
  excludeSessionId?: string | null;
};

/**
 * 그 강사 또는 그 홀의 「예정」 회차 중 기간 [from, to) 에 걸친 것만 읽는다.
 * 휴강·폐강 회차는 시간을 점유하지 않는다(EXCLUDE 의 WHERE status = 'scheduled' 와 같은 기준).
 * S2-2.4(겹침 거부)와 S2-2.8c(일정 겹침 미리보기)가 같은 읽기를 쓴다 — 두 벌이면 「미리보기는 통과, 저장은 409」가 생긴다.
 */
export async function readScheduledSessions(db: Db | Tx, query: ScheduledSessionQuery): Promise<ScheduledSessionRow[]> {
  return db.query(
    db.raw.sql`SELECT to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                      to_char(s.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
                      c.academy_id, COALESCE(s.instructor_account_id::text, '') AS instructor_id,
                      COALESCE(s.room_id::text, '') AS room_id, COALESCE(r.name, '') AS room_name, c.title
               FROM class_sessions s
               JOIN class_offerings o ON o.id = s.offering_id
               JOIN classes c ON c.id = o.class_id
               LEFT JOIN rooms r ON r.id = s.room_id
               WHERE s.status = 'scheduled'
                 AND (s.instructor_account_id = NULLIF(${query.instructorAccountId ?? ""}, '')::uuid
                      OR s.room_id = NULLIF(${query.roomId ?? ""}, '')::uuid)
                 AND tstzrange(s.starts_at, s.ends_at) && tstzrange(${query.from}::timestamptz, ${query.to}::timestamptz)
                 -- 뺄 수업이 없으면 비교가 NULL 이 된다. NOT NULL 도 NULL 이라 전부 걸러지므로 IS NOT TRUE 로 쓴다
                 AND (c.id = NULLIF(${query.exclude?.classId ?? ""}, '')::uuid
                      AND c.academy_id = NULLIF(${query.exclude?.academyId ?? ""}, '')::uuid) IS NOT TRUE
                 AND (s.id = NULLIF(${query.excludeSessionId ?? ""}, '')::uuid) IS NOT TRUE
               ORDER BY s.starts_at`
      .returnsRow(EXISTING_ROW)
      .build(),
  );
}

/** 끝 글자에 받침이 있나 — 조사(과/와 · 은/는)를 고를 때 쓴다. 괄호로 끝나면 괄호 앞 글자를 본다 */
function hasBatchim(word: string): boolean {
  const letters = word.replace(/[)\]」\s]+$/u, "");
  const last = letters.charCodeAt(letters.length - 1);
  const isHangul = last >= 0xac00 && last <= 0xd7a3;
  // 한글이 아니면(영문·숫자) 받침이 있다고 본다 — 화면 문구에서 드물다
  return !isHangul || (last - 0xac00) % 28 !== 0;
}

/** 「쌈바(입문)과」 · 「강사 일정과」 */
const withGwa = (label: string): string => `${label}${hasBatchim(label) ? "과" : "와"}`;
/** 「A홀은」 · 「스튜디오는」 */
const withEun = (name: string): string => `${name}${hasBatchim(name) ? "은" : "는"}`;

const kstClock = (at: string) => formatTimeOfDay(toKstTimeOfDay(Temporal.Instant.from(at)));

/**
 * 이미 있는 회차의 이름을 누가 보느냐에 따라 가린다(11 §4-1 · §4-3).
 *   대표가 부르면 「강사 일정」(무엇인지 밝히지 않는다) · 강사 본인은 같은 학원이면 수업 이름, 다른 학원이면 「다른 학원 일정」
 */
export function sessionLabelFor(row: ScheduledSessionRow, academyId: string, callerIsOwner: boolean): string {
  if (callerIsOwner) return LABEL_INSTRUCTOR;
  return row.academy_id === academyId ? row.title : LABEL_OTHER_ACADEMY;
}

/** 홀 겹침 한 줄 — 안내문 앞머리(「A홀은」)를 만들려고 홀 이름을 함께 둔다 */
export type RoomConflict = ScheduleConflict & { room: string };

/**
 * 읽어 온 회차들로 겹침을 계산한다(던지지 않는다).
 *   conflicts — 같은 강사(학원을 묻지 않는다, S2-1.5 판정 그대로) · roomConflicts — 같은 홀(강사가 누구든, 이름은 그대로)
 * S2-2.4 의 409 판정과 S2-2.8c 의 미리보기가 이 함수 하나를 같이 쓴다.
 */
export function computeScheduleConflicts(
  input: Omit<ScheduleCheckInput, "instructorAccountId"> & { instructorAccountId: string | null },
  rows: readonly ScheduledSessionRow[],
): { conflicts: ScheduleConflict[]; roomConflicts: RoomConflict[] } {
  // ① 강사 겹침 — 학원은 묻지 않고 강사 id 로만 본다(S2-1.5 판정을 그대로 쓴다)
  const instructorId = input.instructorAccountId;
  const conflicts: ScheduleConflict[] =
    instructorId === null
      ? []
      : findInstructorOverlaps(
          instructorId,
          input.sessions,
          rows
            .filter((r) => r.instructor_id === instructorId)
            .map(
              (r): InstructorScheduleItem => ({
                instructorAccountId: r.instructor_id,
                academyId: r.academy_id,
                kind: "class_session",
                startsAt: Temporal.Instant.from(r.starts_at),
                endsAt: Temporal.Instant.from(r.ends_at),
                label: sessionLabelFor(r, input.academyId, input.callerIsOwner),
              }),
            ),
        ).map((o) => ({
          startsAt: o.existing.startsAt.toString(),
          endsAt: o.existing.endsAt.toString(),
          overlapMinutes: o.overlapMinutes,
          label: o.existing.label,
        }));

  // ② 홀 겹침 — 같은 홀의 다른 회차(강사가 누구든). 홀은 그 학원 것이라 수업 이름을 그대로 보인다
  const roomId = input.roomId;
  const roomRows = roomId === null ? [] : rows.filter((r) => r.room_id === roomId);
  const roomConflicts = input.sessions.flatMap((candidate) =>
    roomRows
      .map((r) => ({ r, range: { startsAt: Temporal.Instant.from(r.starts_at), endsAt: Temporal.Instant.from(r.ends_at) } }))
      .map(({ r, range }) => ({ r, minutes: overlapMinutes(candidate, range) }))
      .filter(({ minutes }) => minutes > 0)
      .map(({ r, minutes }) => ({ startsAt: r.starts_at, endsAt: r.ends_at, overlapMinutes: minutes, label: r.title, room: r.room_name })),
  );
  return { conflicts, roomConflicts };
}

/**
 * 겹침이 있으면 409 를 던진다 — 강사 겹침(SCHEDULE_CONFLICT)을 먼저, 그다음 홀 겹침(ROOM_CONFLICT).
 * 안내문은 첫 겹침 하나로 만든다(「20:00 쌈바(입문)과 30분 겹쳐요」), 나머지는 conflicts 목록에 시간순으로 담는다.
 */
export async function assertNoScheduleConflict(db: Db | Tx, input: ScheduleCheckInput): Promise<void> {
  const first = input.sessions[0];
  const last = input.sessions[input.sessions.length - 1];
  if (first === undefined || last === undefined) return;

  const rows = await readScheduledSessions(db, {
    instructorAccountId: input.instructorAccountId,
    roomId: input.roomId,
    from: first.startsAt.toString(),
    to: last.endsAt.toString(),
    excludeSessionId: input.excludeSessionId ?? null,
    exclude: input.excludeClass ?? null,
  });
  const { conflicts, roomConflicts } = computeScheduleConflicts(input, rows);
  if (conflicts.length > 0) throw conflictError("SCHEDULE_CONFLICT", conflicts, "");
  if (roomConflicts.length > 0) {
    const roomName = roomConflicts[0]?.room ?? "";
    throw conflictError(
      "ROOM_CONFLICT",
      roomConflicts.map(({ room: _room, ...rest }) => rest),
      roomName === "" ? "" : `${withEun(roomName)} `,
    );
  }
}

/**
 * S2-4.10(개인 레슨 「레슨 모집」 시간 열기)가 같은 409 본문·안내문을 쓰려고 빌려 간다.
 * roomName 을 주면 안내문 앞에 「A홀은 」을 붙인다(홀 겹침). 강사 겹침은 빈 글자를 준다.
 */
export function scheduleConflictError(code: "SCHEDULE_CONFLICT" | "ROOM_CONFLICT", conflicts: ScheduleConflict[], roomName: string): HttpError {
  return conflictError(code, conflicts, roomName === "" ? "" : `${withEun(roomName)} `);
}

function conflictError(code: "SCHEDULE_CONFLICT" | "ROOM_CONFLICT", conflicts: ScheduleConflict[], prefix: string): HttpError {
  const head = conflicts[0];
  const detail = head === undefined ? DETAIL_RACE : `${prefix}${kstClock(head.startsAt)} ${withGwa(head.label)} ${head.overlapMinutes}분 겹쳐요`;
  // suggestions(빈 시간 칩)는 미리보기(schedule-check §4-1, class-schedule-check.ts)가 계산한다 — 409 본문에는 아직 빈 배열
  return HttpError.conflict(code, detail, { conflicts, suggestions: [] });
}

/**
 * 승인 요청 트랜잭션 안에서 부른다 — 같은 강사 · 같은 홀의 잠금을 잡는다. 트랜잭션이 끝나면 저절로 풀린다.
 * 순서는 늘 강사 → 홀이다(두 요청이 서로의 잠금을 기다리며 멈추지 않게).
 */
export async function lockScheduleOwners(tx: Tx, instructorAccountId: string, roomId: string | null): Promise<void> {
  await tx.query(
    tx.raw.sql`SELECT pg_advisory_xact_lock(hashtext(${`instructor:${instructorAccountId}`}))::text AS locked`
      .returnsRow({ locked: "pg/text@1" })
      .build(),
  );
  if (roomId === null) return;
  await tx.query(
    tx.raw.sql`SELECT pg_advisory_xact_lock(hashtext(${`room:${roomId}`}))::text AS locked`.returnsRow({ locked: "pg/text@1" }).build(),
  );
}

/**
 * DB 의 EXCLUDE 위반(23P01)을 409 로 바꾼다. 아니면 null(호출한 쪽이 원래 오류를 다시 던진다).
 * 드라이버가 오류를 몇 겹 감싸도 찾도록 cause 를 따라 내려가며 제약 이름을 본다.
 */
export function toScheduleConflictFromDb(error: unknown): HttpError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
    const e = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    const text = `${String(e.constraint ?? "")} ${String(e.message ?? "")}`;
    if (e.code === "23P01" || text.includes("ex_sessions_")) {
      if (text.includes("ex_sessions_room")) return conflictError("ROOM_CONFLICT", [], "");
      if (text.includes("ex_sessions_instructor")) return conflictError("SCHEDULE_CONFLICT", [], "");
    }
    current = e.cause;
  }
  return null;
}
