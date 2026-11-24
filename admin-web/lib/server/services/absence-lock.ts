// S3-4.3b(결석 표시 48시간 확정 작업) — 끝난 지 48시간이 지난 회차를 「결석 표시 잠김」으로 기록한다.
//   계약: _workspace/03_contracts/04-me-calendar-notifications.md §7(`POST /api/internal/jobs/absence-lock`) · 열린 점 ⑥(칸 없이 시각 계산 + 감사 1행)
//   요구: FR-092e(결석 표시는 수업 뒤 48시간 안, 확정 2026-11-19) · 플랜 6-7
//   경로: POST /api/internal/jobs/absence-lock(매시간 — 추천값, cron → 내부 경로 — S0-4.4(시간 작업 실행기))
//
// 이 작업이 「잠금의 권위」는 아니다:
//   새 결석 표시를 막는 것은 S3-4.3a(강사·대표 결석 표시 API)의 시각 계산이다 — `지금 > 끝 + 48시간` 이면 그 경로가 409 로 거부한다.
//   이 작업이 늦게 돌거나 아예 못 돌아도 규칙은 새지 않는다. 그래서 이 작업은 「언제 확정됐고 그때 결석이 몇 명이었나」를
//   감사 기록으로 남기는 일만 한다(칸을 새로 만들지 않는다 — 열린 점 ⑥ 추천안).
//
// 어떻게 — 트랜잭션 하나에서:
//   ① 작업 전용 잠금(pg_advisory_xact_lock)을 잡는다. cron 이 겹쳐 두 번 돌아도 한쪽이 끝날 때까지 다른 쪽이 기다려,
//      「아직 잠금 기록이 없는 회차」를 둘이 동시에 골라 감사 행을 두 번 쓰는 일이 없다.
//   ② INSERT … SELECT 한 문장 — 끝 + 48시간이 지났고(지금 기준) 아직 `attendance.session_locked` 감사 행이 없는 회차마다
//      시스템 감사 1행을 쓴다. after = { markCount: 그 회차의 살아 있는(거두지 않은) 결석 수 }.
//      이미 기록이 있는 회차는 NOT EXISTS 에서 빠지므로 되풀이해 불러도 회차당 1행이다(멱등).
//   돌려받은 행 수가 이번에 잠근 회차 수다 → 응답 `{ "locked": n }`.
//
// 「지났다」의 기준: 표시 경로는 정확히 48시간째(지금 = 끝 + 48시간)까지 받는다(§6-1 #4 `now <= ends_at + 48h`).
//   그래서 이 작업은 그보다 늦은 순간(`끝 + 48시간 < 지금`)만 잠근다 — 두 판정이 같은 식을 쓰게 ABSENCE_LOCK_HOURS 를 재사용한다.
//
// 하지 않는 것: 휴강·폐강 회차를 따로 빼지 않는다(계약은 「잠길 시각이 지난 회차마다」라 상태로 나누지 않았다 — 결석이 없으면 markCount 0).
//   이의(§8)·대표의 잠긴 뒤 취소(§6-2)는 잠금과 별개라 여기서 다루지 않는다. 알림도 보내지 않는다(계약에 없다).
import { type Clock } from "../../domain/time";
import { ABSENCE_LOCK_HOURS } from "./staff-absence-marks";
import type { Db } from "../../../prisma/db";

/** 감사 기록의 행동 이름 — 계약 04 열린 점 ⑧ 의 새 값 */
export const ABSENCE_SESSION_LOCKED_ACTION = "attendance.session_locked";

/** 두 실행이 겹치지 않게 잡는 잠금 열쇠(트랜잭션이 끝나면 저절로 풀린다) */
const JOB_LOCK_KEY = "job:absence-lock";

export interface AbsenceLockDeps {
  readonly db: Db;
  readonly clock: Clock;
}

/** 경로 응답과 테스트가 읽는 결과 — 계약 04 §7 「응답 `{ "locked": 3 }`」 */
export interface AbsenceLockResult {
  /** 이번 실행에서 새로 잠금 기록을 남긴 회차 수 */
  readonly locked: number;
}

/**
 * 잠금 작업 한 번. 멱등이다 — 같은 시각에 두 번 불러도 두 번째는 locked 0 이다.
 */
export async function runAbsenceLock(deps: AbsenceLockDeps): Promise<AbsenceLockResult> {
  const now = deps.clock();
  // 「absenceLockedAt(끝) = 끝 + 48시간 < 지금」 ⇔ 「끝 < 지금 − 48시간」. 같은 상수(ABSENCE_LOCK_HOURS)로 기준 시각을 구한다
  const endedBefore = now.subtract({ hours: ABSENCE_LOCK_HOURS }).toString();

  const rows = await deps.db.transaction(async (tx) => {
    // ① 작업 잠금 — 겹친 실행은 여기서 줄을 선다
    await tx.query(
      tx.raw.sql`SELECT pg_advisory_xact_lock(hashtext(${JOB_LOCK_KEY}))::text AS locked`.returnsRow({ locked: "pg/text@1" }).build(),
    );
    // ② 아직 기록이 없는 지난 회차마다 시스템 감사 1행. 학원 칸은 회차 → 신청 단위 → 수업을 따라 채운다(학원별 감사 조회용)
    return tx.query(
      tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, academy_id, action, target_table, target_id, after)
                 SELECT uuidv7(), 'system', c.academy_id, ${ABSENCE_SESSION_LOCKED_ACTION}, 'class_sessions', s.id,
                        json_build_object('markCount',
                          (SELECT count(*)::int FROM attendance_marks m WHERE m.session_id = s.id AND m.cancelled_at IS NULL))
                   FROM class_sessions s
                   JOIN class_offerings o ON o.id = s.offering_id
                   JOIN classes c ON c.id = o.class_id
                  WHERE s.ends_at < ${endedBefore}::timestamptz
                    AND NOT EXISTS (SELECT 1 FROM audit_logs a
                                     WHERE a.target_table = 'class_sessions'
                                       AND a.target_id = s.id
                                       AND a.action = ${ABSENCE_SESSION_LOCKED_ACTION})
                 RETURNING target_id::text AS session_id`
        .returnsRow({ session_id: "pg/text@1" })
        .build(),
    );
  });

  return { locked: rows.length };
}
