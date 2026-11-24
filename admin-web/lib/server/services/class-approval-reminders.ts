// S2-2.12(수업 승인 24시간 재알림 작업) — 강사가 수업을 승인 요청한 뒤 24시간 동안 대표가 답하지 않으면
// 그 학원 대표에게 같은 알림을 **한 번만** 더 보낸다(FR-050a(수업 등록 승인)).
//   계약: _workspace/03_contracts/11-instructor.md §7(알림 종류 `class_approval_reminder`) · §12(시간 작업 표)
//   경로: POST /api/internal/jobs/class-approval-reminders(매시간, cron → 내부 경로 — S0-4.4)
//
// 흐름 한눈에:
//   ① 대상 수업 고르기 + 「보냈다」 표시를 **조건부 갱신 한 문장**으로 같이 한다
//        UPDATE classes SET approval_reminded_at = 지금
//        WHERE status = 'pending_approval' AND submitted_at ≤ 지금 − 24시간 AND (아직 안 보냄)
//      cron 이 겹쳐 두 번 돌아도 DB 가 한 번만 통과시킨다 — 먼저 표시한 쪽만 행을 돌려받는다.
//   ② 돌려받은 수업마다 그 학원의 대표(academy_owners active)에게 알림 행 1개를 같은 트랜잭션에 쓴다.
//      dedupe_key `class:<id>:rev<n>:reminder` 가 같으면 DB 가 한 번만 넣는다(uq_notifications_dedupe — 두 번째 안전장치).
//      실제 푸시 발송은 커밋 뒤 S7-1 이 한다. 여기서는 행만 쓴다.
//
// 「아직 안 보냄」을 `approval_reminded_at IS NULL` 하나로 두지 않은 이유:
//   대표가 수정 요청(반려)하면 강사가 고쳐서 다시 승인 요청한다(제출 번호 rev2, rev3 …). 다시 낸 요청도 새 승인 요청이라
//   24시간 재알림이 한 번 가야 한다(알림 열쇠가 제출 번호마다 다른 이유 — 계약 11 §7). 그런데 다시 낼 때 표시 칸을
//   비우지 않으므로, 「표시가 없거나, 표시가 이번 제출보다 앞선다」로 판정한다. 같은 제출 안에서는 여전히 한 번뿐이다.
import { type Clock } from "../../domain/time";
import type { Db } from "../../../prisma/db";

/** 승인 요청 뒤 이만큼 답이 없으면 재알림한다(FR-050a 「24시간」) */
export const CLASS_APPROVAL_REMINDER_AFTER_HOURS = 24;

export interface ClassApprovalReminderDeps {
  readonly db: Db;
  readonly clock: Clock;
}

/** 경로 응답과 테스트가 읽는 결과 — 계약 11 §12 「응답 200 `{ "processed": n }`」 */
export interface ClassApprovalReminderResult {
  /** 이번 회차에 재알림 표시를 한 수업 수 */
  readonly processed: number;
}

/**
 * 재알림 한 회차를 돈다. 멱등이다 — 같은 시각에 두 번 불러도 두 번째는 processed 0 이다.
 * 대표가 없는 학원(대표 해지 등)의 수업도 표시는 한다: 알림 받을 사람이 없을 뿐이고, 매시간 다시 고르지 않게 하려는 것이다.
 */
export async function runClassApprovalReminders(deps: ClassApprovalReminderDeps): Promise<ClassApprovalReminderResult> {
  const now = deps.clock();
  const nowText = now.toString();
  // 기준 시각 — 이 시각과 같거나 앞서 승인 요청한 수업이 대상이다(정확히 24시간 지난 수업도 포함, 계약 「≤ now − 24시간」)
  const dueBefore = now.subtract({ hours: CLASS_APPROVAL_REMINDER_AFTER_HOURS }).toString();

  return deps.db.transaction(async (tx) => {
    // ① 조건부 갱신 한 문장 — 고르기와 표시를 한 번에. 돌려받은 행만 이번 회차가 알림을 쓴다
    const due = await tx.query(
      tx.raw.sql`UPDATE classes
                 SET approval_reminded_at = ${nowText}::timestamptz, updated_at = now()
                 WHERE status = 'pending_approval'
                   AND submitted_at IS NOT NULL
                   AND submitted_at <= ${dueBefore}::timestamptz
                   AND (approval_reminded_at IS NULL OR approval_reminded_at < submitted_at)
                 RETURNING id, academy_id, title, instructor_name,
                           to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at`
        .returnsRow({
          id: "pg/uuid@1",
          academy_id: "pg/uuid@1",
          title: "pg/text@1",
          instructor_name: "pg/text@1",
          submitted_at: "pg/text@1",
        })
        .build(),
    );

    // ② 수업마다 대표 알림 1행. 열쇠의 제출 번호는 마지막 승인 요청 번호(class_approvals 의 submitted)다
    for (const row of due) {
      const payload = JSON.stringify({
        classId: row.id,
        title: row.title,
        instructorName: row.instructor_name,
        submittedAt: row.submitted_at,
      });
      await tx.execute(
        tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
                   SELECT uuidv7(), o.staff_account_id, o.academy_id, 'approval', 'class_approval_reminder',
                          'class:' || ${row.id} || ':rev' || COALESCE(
                            (SELECT max(a.revision_no) FROM class_approvals a
                             WHERE a.class_id = ${row.id}::uuid AND a.action = 'submitted'), 1)::text || ':reminder',
                          ${payload}::jsonb
                   FROM academy_owners o
                   WHERE o.academy_id = ${row.academy_id}::uuid AND o.status = 'active'
                   ON CONFLICT DO NOTHING`
          .affectedCount()
          .build(),
      );
    }

    return { processed: due.length };
  });
}
