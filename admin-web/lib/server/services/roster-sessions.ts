// S3-5.7(관리자 웹 주문·명단 화면) — 예약·명단 화면(보드 W6)의 「회차 고르기」 목록을 읽는다.
//   보드: W6 위쪽 줄 「‹ 11/12 (목) 19:00 살사 온원 입문 › · 오늘 · 이번 주」
//
// 왜 API 경로가 아니라 화면 전용 읽기인가:
//   계약 18 에는 「학원의 회차를 시간 순서로 고르는」 경로가 없다(§7 오늘 인원은 하루치이고 아직 만들지 않았다).
//   이 목록에는 수업 제목·시각·홀·강사 이름만 있고 회원 정보는 하나도 없다. 명단·회원·연락처는 모두 계약 경로(§3·§4·§5)를
//   쿠키를 실어 그대로 불러 그 경로의 권한 판정을 다시 거친다. 이 함수를 부르기 전에 화면이 「이 학원에 예약·명단 메뉴가 있는
//   직원인가(대표 또는 roster_manage 위임 강사)」를 staff/me 로 먼저 확인한다.
//
// 무엇을 읽나: 그 학원의 공개된 수업(published)의 회차 중 휴강·폐강이 아닌 것. 오늘 기준 앞뒤 일정 기간만(아래 상수).
//   seq·sessionCount 는 기간과 상관없이 판매 단위 전체에서 센다(「정규 4회 중 2회차」가 잘리지 않게).
import { CLASS_KINDS, type ClassKind } from "../../domain/constants";
import { kstDateRangeToInstants, toKstDate } from "../../domain/time";
import type { RosterSessionOption } from "../../roster-view";
import type { Db } from "../../../prisma/db";
import { CLASS_KIND_NAMES } from "./owner-orders";

/** 회차 고르기에 담는 기간 — 지난 회차는 결석 표시(끝 + 48시간)와 확인용으로 35일, 앞으로는 다음 시즌까지 120일 */
export const ROSTER_SESSIONS_PAST_DAYS = 35;
export const ROSTER_SESSIONS_FUTURE_DAYS = 120;

const ISO_S_SQL = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

export async function readRosterSessionOptions(db: Db, academyId: string, now: Temporal.Instant): Promise<RosterSessionOption[]> {
  const today = toKstDate(now);
  const window = kstDateRangeToInstants(today.subtract({ days: ROSTER_SESSIONS_PAST_DAYS }), today.add({ days: ROSTER_SESSIONS_FUTURE_DAYS }));
  const rows = await db.query(
    db.raw.sql`SELECT x.session_id, x.class_id, x.title, x.class_kind, x.starts_at, x.ends_at, x.room_name, x.instructor_name,
                      x.seq::text AS seq, x.session_count::text AS session_count
               FROM (
                 SELECT s.id::text AS session_id, c.id::text AS class_id, c.title, c.class_kind::text AS class_kind, s.starts_at AS raw_starts,
                        to_char(s.starts_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS starts_at,
                        to_char(s.ends_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS ends_at,
                        COALESCE(rs.name, rc.name, '') AS room_name,
                        COALESCE(st.display_name, '') AS instructor_name,
                        s.status::text AS status, s.id AS raw_id,
                        row_number() OVER (PARTITION BY s.offering_id ORDER BY s.starts_at, s.id) AS seq,
                        count(*) OVER (PARTITION BY s.offering_id) AS session_count
                 FROM class_sessions s
                 JOIN class_offerings o ON o.id = s.offering_id
                 JOIN classes c ON c.id = o.class_id
                 LEFT JOIN staff_accounts st ON st.id = COALESCE(s.instructor_account_id, c.instructor_account_id)
                 LEFT JOIN rooms rs ON rs.id = s.room_id
                 LEFT JOIN rooms rc ON rc.id = c.room_id
                 WHERE c.academy_id = ${academyId}::uuid AND c.status = 'published'
               ) x
               WHERE x.status <> 'cancelled'
                 AND x.raw_starts >= ${window.start.toString()}::timestamptz AND x.raw_starts < ${window.endExclusive.toString()}::timestamptz
               ORDER BY x.raw_starts, x.raw_id
               LIMIT 500`
      .returnsRow({
        session_id: "pg/text@1",
        class_id: "pg/text@1",
        title: "pg/text@1",
        class_kind: "pg/text@1",
        starts_at: "pg/text@1",
        ends_at: "pg/text@1",
        room_name: "pg/text@1",
        instructor_name: "pg/text@1",
        seq: "pg/text@1",
        session_count: "pg/text@1",
      })
      .build(),
  );
  return rows.map((row) => {
    const kind = (CLASS_KINDS as readonly string[]).includes(row.class_kind) ? (row.class_kind as ClassKind) : null;
    return {
      sessionId: row.session_id,
      classId: row.class_id,
      title: row.title,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      roomName: row.room_name === "" ? null : row.room_name,
      instructorName: row.instructor_name === "" ? null : row.instructor_name,
      kindName: kind === null ? row.class_kind : CLASS_KIND_NAMES[kind],
      seq: Number(row.seq),
      sessionCount: Number(row.session_count),
    };
  });
}
