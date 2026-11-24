// S3-5.10(역할 불균형 알림 작업) — 수업 전날 18:00(KST)에 내일 회차를 훑어, 남·여 결제 인원 차이가 3명 이상이면
// 그 회차의 담당 강사와 학원 대표에게 직원 알림 `gender_imbalance` 를 **한 번만** 쓴다(FR-107(역할 불균형 경보)).
//   계약: _workspace/03_contracts/18-after-payment-views.md §7 「알림 작업」 · data-model §15-4 ⑤
//   경로: POST /api/internal/jobs/gender-imbalance-check(cron → 내부 경로 — S0-4.4(시간 작업 실행기))
//   판정: S3-5.5(오늘 인원 계산) 의 evaluateGenderImbalance — 기준 GENDER_GAP_THRESHOLD = 3(Q38(인원 차이 알림 기준) 임시 확정)
//
// 흐름 한눈에:
//   ① 지금이 KST 18:00 앞이면 아무것도 하지 않는다 — cron 을 매시간 걸어도 「전날 18:00 뒤」에만 돈다
//   ② 내일(KST 달력) 시작하는 회차 중 남·여 정원을 나눈 공개 수업의 예정 회차를 고르고, 판매 단위의 남·여 결제 확정 인원을 함께 읽는다
//   ③ 회차마다 evaluateGenderImbalance 로 판정한다. 불균형이면 담당 강사 + active 대표에게 알림 행을 쓴다
//      열쇠 dedupe_key = `imbalance:<sessionId>:<받는 직원 id>` 가 같으면 DB 가 한 번만 넣는다(uq_notifications_dedupe)
//      → 작업을 두 번 불러도, cron 이 겹쳐 동시에 돌아도 같은 회차·같은 사람에게는 1건뿐이다.
//   실제 푸시 발송은 S7-1(알림 발송) 이 한다. 여기서는 행만 쓴다(delivery_status pending).
//
// 열쇠에 받는 사람 id 를 붙인 이유(추천안 — 증거 EVIDENCE.md 「추천안·사후 확인」):
//   uq_notifications_dedupe 는 (kind, dedupe_key) 유니크라, 계약 원문 그대로 `imbalance:<sessionId>` 만 쓰면
//   강사 알림이 들어간 뒤 대표 알림이 같은 열쇠로 막힌다. 대타 확정 알림(`substitute:<id>:confirmed:<recipient>`)과 같은 방식이다.
//   담당 강사가 곧 대표인 1인 학원은 받는 사람이 같아서 저절로 1건이 된다.
import { evaluateGenderImbalance, type GenderImbalance } from "../../domain/headcount";
import { kstDateRangeToInstants, toKstDate, toKstTimeOfDay, type Clock } from "../../domain/time";
import type { Db } from "../../../prisma/db";

/** 알림 종류 — notifications.kind 값(계약 18 §7) */
export const GENDER_IMBALANCE_KIND = "gender_imbalance";

/** 이 시각(KST) 앞에는 돌지 않는다 — FR-107 「수업 전날 18:00」 */
export const GENDER_IMBALANCE_CHECK_FROM_HOUR = 18;

const ISO_S_SQL = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

export interface GenderImbalanceCheckDeps {
  readonly db: Db;
  readonly clock: Clock;
}

/** 경로 응답과 테스트가 읽는 결과 */
export interface GenderImbalanceCheckResult {
  /** 이번에 불균형으로 판정된 내일 회차 수(이미 알림이 간 회차도 센다 — 판정 결과라서) */
  readonly imbalancedSessions: number;
  /** 이번 호출에서 새로 쓴 알림 행 수(두 번째 호출이면 0) */
  readonly notified: number;
}

/** 알림 본문 — 계약 §7 「부족한 성별·차이·회차 시각만」. 회원 이름·연락처는 넣지 않는다 */
export interface GenderImbalancePayload {
  readonly sessionId: string;
  readonly classId: string;
  readonly classTitle: string;
  readonly startsAt: string;
  readonly shortKind: NonNullable<GenderImbalance["shortKind"]>;
  readonly gap: number;
}

/**
 * 역할 불균형 점검 한 회차를 돈다. 멱등이다 — 같은 날 두 번 불러도 두 번째는 notified 0 이다.
 */
export async function runGenderImbalanceCheck(deps: GenderImbalanceCheckDeps): Promise<GenderImbalanceCheckResult> {
  const now = deps.clock();
  // ① 18:00(KST) 앞이면 「전날 18:00」이 아직 오지 않았다 — 일찍 알리지 않는다
  if (toKstTimeOfDay(now).hour < GENDER_IMBALANCE_CHECK_FROM_HOUR) return { imbalancedSessions: 0, notified: 0 };

  // ② 「내일」 = 지금의 KST 날짜 + 1일. 그날 00:00~다음 날 00:00(KST)에 시작하는 회차가 대상이다
  const tomorrow = toKstDate(now).add({ days: 1 });
  const { start, endExclusive } = kstDateRangeToInstants(tomorrow, tomorrow);
  const sessions = await deps.db.query(
    deps.db.raw.sql`SELECT s.id::text AS session_id, c.id::text AS class_id, c.academy_id::text AS academy_id, c.title,
                           to_char(s.starts_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS starts_at,
                           COALESCE(s.instructor_account_id::text, c.instructor_account_id::text, '') AS instructor_id,
                           COALESCE((SELECT p.confirmed_count FROM seat_pools p WHERE p.offering_id = o.id AND p.seat_kind = 'male'), 0)::int4 AS male,
                           COALESCE((SELECT p.confirmed_count FROM seat_pools p WHERE p.offering_id = o.id AND p.seat_kind = 'female'), 0)::int4 AS female
                    FROM class_sessions s
                    JOIN class_offerings o ON o.id = s.offering_id
                    JOIN classes c ON c.id = o.class_id
                    WHERE s.status = 'scheduled' AND c.status = 'published' AND c.seat_mode = 'gender_split'
                      AND s.starts_at >= ${start.toString()}::timestamptz AND s.starts_at < ${endExclusive.toString()}::timestamptz
                    ORDER BY s.starts_at, s.id`
      .returnsRow({
        session_id: "pg/text@1",
        class_id: "pg/text@1",
        academy_id: "pg/text@1",
        title: "pg/text@1",
        starts_at: "pg/text@1",
        instructor_id: "pg/text@1",
        male: "pg/int4@1",
        female: "pg/int4@1",
      })
      .build(),
  );

  let imbalancedSessions = 0;
  let notified = 0;
  for (const row of sessions) {
    // ③ 결제 확정 인원(seat_pools.confirmed_count)만 넣는다 — 결석 예정·현장 인원은 판정에 쓰지 않는다(계약 §7)
    const verdict = evaluateGenderImbalance({ male: row.male, female: row.female });
    if (!verdict.imbalanced || verdict.shortKind === null) continue;
    imbalancedSessions += 1;
    const payload: GenderImbalancePayload = {
      sessionId: row.session_id,
      classId: row.class_id,
      classTitle: row.title,
      startsAt: row.starts_at,
      shortKind: verdict.shortKind,
      gap: verdict.gap,
    };
    // 받는 사람 = 담당 강사(회차 담당, 없으면 수업 담당) + 그 학원 active 대표. UNION 이라 강사 = 대표면 한 번만 나온다
    const inserted = await deps.db.execute(
      deps.db.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
                      SELECT uuidv7(), r.staff_id, ${row.academy_id}::uuid, 'operations', 'gender_imbalance',
                             'imbalance:' || ${row.session_id} || ':' || r.staff_id::text, ${JSON.stringify(payload)}::jsonb
                      FROM (
                        SELECT NULLIF(${row.instructor_id}, '')::uuid AS staff_id
                        UNION
                        SELECT ao.staff_account_id FROM academy_owners ao
                        WHERE ao.academy_id = ${row.academy_id}::uuid AND ao.status = 'active'
                      ) r
                      WHERE r.staff_id IS NOT NULL
                      ON CONFLICT DO NOTHING`
        .affectedCount()
        .build(),
    );
    // 열쇠가 겹쳐 막힌 행(이미 보낸 알림)은 세지 않는다
    notified += inserted.affectedRows;
  }
  return { imbalancedSessions, notified };
}
