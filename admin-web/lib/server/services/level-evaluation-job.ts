// S6-3.3(레벨 계산 작업) — 기간이 끝난 정규 수업마다 수강생의 완주·출석을 판정해, 조건을 채우면 세부 장르 레벨을 1칸 올리고 카드를 바로 발급한다.
//   계약: _workspace/03_contracts/14-membership-benefits.md §3(`POST /api/internal/jobs/level-evaluation`) · §5-1(레벨 계산 규칙, 결정 D7)
//   요구: spec FR-169a(출석률 반영 레벨) · FR-169e(본인 레벨업은 묻지 않고 바로 카드 발급) · FR-161(레벨 등급 구간)
//   설계: _workspace/03_data-model.md §11-4(course_completions · level_promotions · level_cards · member_genre_levels)
//   경로: POST /api/internal/jobs/level-evaluation(하루 한 번이면 충분 — 추천값, cron → 내부 경로 — S0-4.4(시간 작업 실행기))
//
// 흐름 한눈에:
//   ① 후보 고르기 — 정규 수업(class_kind='regular')의 기간 단위(enrollment_unit='term') 판매 단위 중
//      「기간 종료 + 48시간」이 지난 것(결석 표시가 확정된 뒤 — lib/domain/term-end.ts, S5-1.3 과 같은 판정)과
//      그 판매 단위에 한 번이라도 결제한 수강생. 아직 판정 기록(course_completions)이 없는 (판매 단위, 회원)만.
//   ② 후보마다 트랜잭션 하나 — (판매 단위, 회원) 잠금을 잡고 판정 기록이 없는지 다시 본 뒤,
//      회차·결석 표시·예약·주문 상태와 지금 레벨을 읽어 순수 함수 evaluateCompletion(S6-3.2)에 넘긴다.
//   ③ 오르면: 레벨 갱신(조건부 — 읽은 레벨 그대로일 때만) → 승급 기록 → 카드 1장 → 판정 기록 → 알림 level_up.
//      못 미치면: 판정 기록만(레벨은 그대로, 깎지 않는다).
//
// 멱등(두 번 불러도 같다): 판정은 (판매 단위, 회원) 한 번뿐이다. 이미 기록이 있으면 ①에서 빠지고 ②에서도 건너뛴다.
//   cron 이 겹쳐도 ②의 잠금이 줄을 세우고, 마지막 방어선은 DB 유니크(uq_completions_offering_member · uq_promotions_completion)다.
// 한 건이 실패해도(예: 그 사이 강사 승급으로 레벨이 바뀜) 그 건만 되돌리고 다음 후보로 간다 — 다음 실행이 다시 판정한다.
//
// 지키는 것: 출석 횟수·%는 판정 기록(서버 안 전용)에만 남기고 알림 본문에 넣지 않는다(결정 D7).
// 하지 않는 것: 개인 레슨 레벨 반영(FR-169b — 다른 표), 강사 레벨 제안(S6-3.4), 카드 화면(S6-3.6·S6-3.8).
import {
  evaluateCompletion,
  levelGenreOf,
  levelStageLabel,
  LEVEL_GENRE_LABEL_KO,
  type EvaluationAbsenceMark,
  type EvaluationSession,
} from "../../domain/level-evaluation";
import { isTermEnded, termEndedBefore } from "../../domain/term-end";
import type { Clock } from "../../domain/time";
import type {
  AttendanceDisputeStatus,
  AttendanceMarkedByKind,
  ClassDiscipline,
  ClassSessionStatus,
  ClassSubGenre,
  Genre,
  LevelDetailGenre,
  OrderStatus,
  ReservationStatus,
} from "../../domain/constants";
import { ABSENCE_LOCK_HOURS } from "./staff-absence-marks";
import type { NotificationSenderPort } from "../ports/notification-sender";
import type { Db } from "../../../prisma/db";

/** 알림 종류 — 계약 14 §5-1 「승급이면 … 알림 level_up」 */
export const LEVEL_UP_KIND = "level_up";

/** 한 번 실행에서 판정할 후보 수의 상한. 넘치면 다음 실행이 이어서 한다(하나씩 트랜잭션이라 길게 붙잡지 않으려고) */
export const LEVEL_EVALUATION_BATCH = 500;

export interface LevelEvaluationDeps {
  readonly db: Db;
  readonly clock: Clock;
  /** 알림 발송기 — 없으면 알림함 행만 남긴다(발송은 재시도 작업이 받는다) */
  readonly notificationSender?: NotificationSenderPort;
}

/** 경로 응답 — 계약 14 §3 「`{ "processed": 12 }`(… `promoted` 같은 칸을 더해도 된다)」 */
export interface LevelEvaluationResult {
  /** 이번 실행에서 새로 판정 기록을 남긴 (판매 단위, 회원) 수 */
  readonly processed: number;
  /** 그중 레벨이 올라 카드가 발급된 수 */
  readonly promoted: number;
  /** 오류로 되돌린 수(다음 실행이 다시 판정한다) */
  readonly failed: number;
}

/** ① 에서 고른 후보 한 줄 */
type Candidate = {
  offeringId: string;
  memberId: string;
  reservationId: string;
  orderId: string;
  academyId: string;
  classTitle: string;
  genre: Genre;
  subGenre: ClassSubGenre | null;
  discipline: ClassDiscipline | null;
  termEnd: Temporal.Instant;
};

/** 한 후보의 결과 — 이미 판정됐으면 skipped */
type CandidateOutcome = { kind: "skipped" } | { kind: "evaluated"; awarded: boolean; notificationId: string | null };

/** 그 사이 레벨이 바뀌어 조건부 갱신이 0행이면 던진다 — 이 후보만 되돌리고 다음 실행이 다시 판정한다 */
class LevelChangedConcurrently extends Error {
  override readonly name = "LevelChangedConcurrently";
}

/**
 * 레벨 계산 작업 한 번. 멱등이다 — 같은 시각에 두 번 불러도 두 번째는 processed 0 이다.
 */
export async function runLevelEvaluation(deps: LevelEvaluationDeps): Promise<LevelEvaluationResult> {
  const now = deps.clock();
  const candidates = await selectCandidates(deps.db, now);

  let processed = 0;
  let promoted = 0;
  let failed = 0;
  const notificationIds: string[] = [];
  for (const candidate of candidates) {
    // SQL 로 고른 것을 같은 순수 함수로 한 번 더 확인한다 — 「기간 종료」 규칙이 lib/domain/term-end.ts 한 곳에만 있게
    if (!isTermEnded(candidate.termEnd, now, ABSENCE_LOCK_HOURS)) continue;
    try {
      const outcome = await evaluateOne(deps.db, candidate, now);
      if (outcome.kind === "skipped") continue;
      processed += 1;
      if (outcome.awarded) promoted += 1;
      if (outcome.notificationId !== null) notificationIds.push(outcome.notificationId);
    } catch (error: unknown) {
      // 한 건의 오류는 그 건만 실패로 센다 — 다른 수강생의 판정을 막지 않는다(계약 14 §3 내부 작업 공통)
      failed += 1;
      console.warn("[level-evaluation] 판정 실패 — 다음 실행이 다시 판정한다", {
        offeringId: candidate.offeringId,
        memberId: candidate.memberId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 커밋 뒤 발송. 실패해도 알림함 행은 남고 재시도 작업(S7-1.6)이 다시 보낸다
  if (notificationIds.length > 0 && deps.notificationSender !== undefined) {
    await deps.notificationSender.deliver(notificationIds).catch((error: unknown) => {
      console.warn("[level-evaluation] 알림 발송 실패 — 알림함 행은 그대로", error);
    });
  }
  return { processed, promoted, failed };
}

/**
 * ① 후보 고르기. 기간 종료 = 판매 단위의 last_session_ends_at 과 회차 끝 중 가장 늦은 것(lib/domain/term-end.ts).
 * 수강생 = 그 판매 단위에 예약이 있고 주문이 한 번이라도 결제된 사람(결제 전 만료·취소는 수강한 적이 없어 판정하지 않는다).
 * 같은 사람이 예약을 여러 번 했으면 「확정 + 결제 완료」인 예약을 먼저, 그다음 최근 것을 고른다(DISTINCT ON).
 */
async function selectCandidates(db: Db, now: Temporal.Instant): Promise<Candidate[]> {
  const endedBefore = termEndedBefore(now, ABSENCE_LOCK_HOURS).toString();
  const rows = await db.query(
    db.raw.sql`SELECT * FROM (
                 SELECT DISTINCT ON (o.id, r.member_id)
                        o.id::text AS offering_id, r.member_id::text AS member_id, r.id::text AS reservation_id,
                        ord.id::text AS order_id, c.academy_id::text AS academy_id, c.title AS class_title,
                        c.genre::text AS genre, c.sub_genre::text AS sub_genre, c.discipline::text AS discipline,
                        to_char(GREATEST(o.last_session_ends_at,
                                         (SELECT max(s.ends_at) FROM class_sessions s WHERE s.offering_id = o.id))
                                AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS term_end
                   FROM class_offerings o
                   JOIN classes c ON c.id = o.class_id AND c.class_kind = 'regular'
                   JOIN reservations r ON r.offering_id = o.id
                   JOIN orders ord ON ord.id = r.order_id
                  WHERE o.enrollment_unit = 'term'
                    AND GREATEST(o.last_session_ends_at,
                                 (SELECT max(s.ends_at) FROM class_sessions s WHERE s.offering_id = o.id))
                        < ${endedBefore}::timestamptz
                    AND (ord.paid_at IS NOT NULL OR ord.status IN ('paid', 'partially_refunded', 'refunded'))
                    AND NOT EXISTS (SELECT 1 FROM course_completions cc
                                     WHERE cc.offering_id = o.id AND cc.member_id = r.member_id)
                  ORDER BY o.id, r.member_id,
                           (r.status = 'confirmed' AND ord.status = 'paid') DESC, r.created_at DESC
               ) picked
               ORDER BY term_end, offering_id, member_id
               LIMIT ${LEVEL_EVALUATION_BATCH}`
      .returnsRow({
        offering_id: "pg/text@1",
        member_id: "pg/text@1",
        reservation_id: "pg/text@1",
        order_id: "pg/text@1",
        academy_id: "pg/text@1",
        class_title: "pg/text@1",
        genre: "pg/text@1",
        sub_genre: "pg/text@1",
        discipline: "pg/text@1",
        term_end: "pg/text@1",
      })
      .build(),
  );
  return rows.map((row) => ({
    offeringId: row.offering_id,
    memberId: row.member_id,
    reservationId: row.reservation_id,
    orderId: row.order_id,
    academyId: row.academy_id,
    classTitle: row.class_title,
    genre: row.genre as Genre,
    subGenre: (row.sub_genre ?? null) as ClassSubGenre | null,
    discipline: (row.discipline ?? null) as ClassDiscipline | null,
    termEnd: Temporal.Instant.from(row.term_end),
  }));
}

/** ②③ 후보 한 명의 판정 — 트랜잭션 하나 */
async function evaluateOne(db: Db, candidate: Candidate, now: Temporal.Instant): Promise<CandidateOutcome> {
  const nowText = now.toString();
  const detailGenre = levelGenreOf({ genre: candidate.genre, subGenre: candidate.subGenre, discipline: candidate.discipline });

  return db.transaction(async (tx) => {
    // (판매 단위, 회원) 잠금 — 겹친 실행은 여기서 기다렸다가 아래 「이미 판정됨」 확인에서 빠진다
    await tx.query(
      tx.raw.sql`SELECT pg_advisory_xact_lock(hashtext(${`level-eval:${candidate.offeringId}:${candidate.memberId}`}))::text AS locked`
        .returnsRow({ locked: "pg/text@1" })
        .build(),
    );
    const done = await tx.query(
      tx.raw.sql`SELECT 1::int AS one FROM course_completions WHERE offering_id = ${candidate.offeringId}::uuid AND member_id = ${candidate.memberId}::uuid`
        .returnsRow({ one: "pg/int4@1" })
        .build(),
    );
    if (done.length > 0) return { kind: "skipped" } as const;

    // 판정 입력 모으기 — 고른 예약·주문의 지금 상태, 그 판매 단위의 모든 회차, 그 회원의 결석 표시(누가 표시했든)
    const [state] = await tx.query(
      tx.raw.sql`SELECT r.status::text AS reservation_status, ord.status::text AS order_status
                   FROM reservations r JOIN orders ord ON ord.id = r.order_id
                  WHERE r.id = ${candidate.reservationId}::uuid`
        .returnsRow({ reservation_status: "pg/text@1", order_status: "pg/text@1" })
        .build(),
    );
    if (state === undefined) throw new Error("예약을 찾지 못했다");
    const sessionRows = await tx.query(
      tx.raw.sql`SELECT id::text AS id, status::text AS status FROM class_sessions WHERE offering_id = ${candidate.offeringId}::uuid`
        .returnsRow({ id: "pg/text@1", status: "pg/text@1" })
        .build(),
    );
    const markRows = await tx.query(
      tx.raw.sql`SELECT m.session_id::text AS session_id, m.marked_by_kind::text AS marked_by_kind,
                        CASE WHEN m.cancelled_at IS NULL THEN NULL
                             ELSE to_char(m.cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END AS cancelled_at,
                        m.dispute_status::text AS dispute_status
                   FROM attendance_marks m JOIN class_sessions s ON s.id = m.session_id
                  WHERE m.member_id = ${candidate.memberId}::uuid AND s.offering_id = ${candidate.offeringId}::uuid`
        .returnsRow({ session_id: "pg/text@1", marked_by_kind: "pg/text@1", cancelled_at: "pg/text@1", dispute_status: "pg/text@1" })
        .build(),
    );
    // 지금 레벨 — 행이 있으면 잠근다(그 사이 다른 쓰기가 끼지 않게). 없으면 0(S6-3.2 「행이 없으면 0」)
    const levelRows =
      detailGenre === null
        ? []
        : await tx.query(
            tx.raw.sql`SELECT level FROM member_genre_levels
                        WHERE member_id = ${candidate.memberId}::uuid AND detail_genre = ${detailGenre}
                        FOR UPDATE`
              .returnsRow({ level: "pg/int4@1" })
              .build(),
          );
    const currentLevel = levelRows[0]?.level ?? 0;

    const sessions: EvaluationSession[] = sessionRows.map((s) => ({ id: s.id, status: s.status as ClassSessionStatus }));
    const absenceMarks: EvaluationAbsenceMark[] = markRows.map((m) => ({
      sessionId: m.session_id,
      markedByKind: m.marked_by_kind as AttendanceMarkedByKind,
      cancelledAt: m.cancelled_at ?? null,
      disputeStatus: m.dispute_status as AttendanceDisputeStatus,
    }));
    const result = evaluateCompletion({
      currentLevel,
      reservationStatus: state.reservation_status as ReservationStatus,
      orderStatus: state.order_status as OrderStatus,
      sessions,
      absenceMarks,
    });
    // 레벨 세부 장르를 정할 수 없는 수업(예: 종목 없이 「라틴」만 고른 댄스스포츠)은 판정 기록만 남기고 올리지 않는다
    const awarded = result.levelAwarded && detailGenre !== null;

    let promotionId: string | null = null;
    let notificationId: string | null = null;
    if (awarded && detailGenre !== null) {
      // ③-1 레벨 갱신 — 읽은 레벨 그대로일 때만(없던 행이면 새로 넣는다). 0행이면 그 사이 바뀐 것이라 이 건을 되돌린다
      const changed = await tx.execute(
        tx.raw.sql`INSERT INTO member_genre_levels (member_id, detail_genre, level, updated_at)
                   VALUES (${candidate.memberId}::uuid, ${detailGenre}, ${result.toLevel}, ${nowText}::timestamptz)
                   ON CONFLICT (member_id, detail_genre) DO UPDATE
                      SET level = EXCLUDED.level, updated_at = EXCLUDED.updated_at
                    WHERE member_genre_levels.level = ${result.fromLevel}`
          .affectedCount()
          .build(),
      );
      if (changed.affectedRows !== 1) throw new LevelChangedConcurrently("판정 중 레벨이 바뀌었다");

      // ③-2 승급 기록(완주 — 판매 단위가 있고 제안은 없다, 한 번에 1칸)
      const [promotion] = await tx.query(
        tx.raw.sql`INSERT INTO level_promotions (id, member_id, detail_genre, from_level, to_level, source, offering_id, created_at)
                   VALUES (uuidv7(), ${candidate.memberId}::uuid, ${detailGenre}, ${result.fromLevel}, ${result.toLevel},
                           'course_completion', ${candidate.offeringId}::uuid, ${nowText}::timestamptz)
                   RETURNING id::text AS id`
          .returnsRow({ id: "pg/text@1" })
          .build(),
      );
      if (promotion === undefined) throw new Error("승급 기록을 쓰지 못했다");
      promotionId = promotion.id;

      // ③-3 카드 한 장 — 본인 레벨업은 묻지 않고 바로 발급(FR-169e). 연출을 아직 안 봤으니 revealed_at 은 비워 둔다
      const [card] = await tx.query(
        tx.raw.sql`INSERT INTO level_cards (id, member_id, detail_genre, level, promotion_id, created_at)
                   VALUES (uuidv7(), ${candidate.memberId}::uuid, ${detailGenre}, ${result.toLevel}, ${promotionId}::uuid, ${nowText}::timestamptz)
                   RETURNING id::text AS id`
          .returnsRow({ id: "pg/text@1" })
          .build(),
      );
      if (card === undefined) throw new Error("카드를 쓰지 못했다");

      // ③-5 알림 — 본문은 「쌈바 Lv.4 (초중급)」처럼 레벨 번호 + 단계 이름만. 출석 숫자는 넣지 않는다(결정 D7)
      const stageLabel = levelStageLabel(result.toLevel);
      const payload = JSON.stringify({
        title: "레벨이 올랐어요",
        body: levelUpBody(detailGenre, result.toLevel),
        classTitle: candidate.classTitle,
        detailGenre,
        level: result.toLevel,
        stageLabel,
        cardId: card.id,
        reason: "course_completion",
      });
      const [notification] = await tx.query(
        tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, dedupe_key, reservation_id, payload, created_at)
                   VALUES (uuidv7(), ${candidate.memberId}::uuid, ${candidate.academyId}::uuid, ${LEVEL_UP_KIND},
                           ${`level-card:${card.id}:issued`}, ${candidate.reservationId}::uuid, ${payload}::jsonb, ${nowText}::timestamptz)
                   ON CONFLICT DO NOTHING
                   RETURNING id::text AS id`
          .returnsRow({ id: "pg/text@1" })
          .build(),
      );
      notificationId = notification?.id ?? null;
    }

    // ③-4 판정 기록 — 오르든 아니든 한 줄(회차·출석 수는 서버 안 전용)
    await tx.execute(
      tx.raw.sql`INSERT INTO course_completions (id, offering_id, member_id, reservation_id, order_id, completed,
                                                 attended_sessions, total_sessions, level_awarded, promotion_id, evaluated_at)
                 VALUES (uuidv7(), ${candidate.offeringId}::uuid, ${candidate.memberId}::uuid, ${candidate.reservationId}::uuid,
                         ${candidate.orderId}::uuid, ${result.completed}, ${result.attendedSessions}, ${result.totalSessions},
                         ${awarded}, NULLIF(${promotionId ?? ""}, '')::uuid, ${nowText}::timestamptz)`
        .affectedCount()
        .build(),
    );
    return { kind: "evaluated", awarded, notificationId } as const;
  });
}

/** level_up 알림 본문 — 「쌈바 Lv.4 (초중급) 카드를 받았어요」. 레벨 번호 + 괄호 안 단계 이름(FR-161)만 쓰고 출석 숫자는 없다 */
export function levelUpBody(detailGenre: LevelDetailGenre, level: number): string {
  return `${LEVEL_GENRE_LABEL_KO[detailGenre]} Lv.${level} (${levelStageLabel(level)}) 카드를 받았어요`;
}
