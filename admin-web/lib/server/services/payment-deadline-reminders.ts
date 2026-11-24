// S3-4.4(입금 기한 임박 알림 작업) — 입금 기한이 다가온 가상계좌 주문의 회원에게 알림 기록을 한 번만 남긴다.
//   계약: _workspace/03_contracts/04-me-calendar-notifications.md §10(`POST /api/internal/jobs/payment-deadline-reminders`)
//   요구: FR-114a(입금 기한 임박 알림) · 플랜 S3-4 수용 ③(「입금 기한 1시간 전(추천값) 알림 기록이 한 번만 생긴다」)
//   경로: POST /api/internal/jobs/payment-deadline-reminders(10분마다 — 추천값, cron → 내부 경로 — S0-4.4(시간 작업 실행기))
//
// 한 줄로: 가상계좌를 받아 놓고 아직 입금하지 않은 회원이 기한을 놓치지 않게, 기한 1시간 전에 「곧 끝나요」 알림 행을 만든다.
//
// 언제 보내나(FR-114a):
//   - 보통은 「기한 − 1시간」부터 기한 직전까지 사이에 작업이 돌면 보낸다.
//   - 계좌 발급부터 기한까지가 1시간보다 짧으면(첫 회차가 코앞이라 기한이 당겨진 경우 — payment-deadline.ts 의 cutoff)
//     「기한 − 1시간」이 발급보다 앞이라 발급하자마자 울리게 된다. 그래서 그때는 발급~기한의 절반이 지난 때부터 보낸다.
//   - 기한이 이미 지났으면 보내지 않는다 — 그 주문은 만료 정리(order-expiry.ts)가 닫을 몫이다.
//
// 왜 한 번만 생기나(멱등):
//   이 알림은 주문에 딸린 회원 알림이라 기존 유니크 `uq_notifications_kind_order_recipient (kind, order_id, recipient_member_id)` 가
//   주문·회원마다 1행만 허락한다. INSERT … ON CONFLICT DO NOTHING 이라 작업을 몇 번 불러도, 두 실행이 겹쳐도 1행이다.
//   (dedupe_key 를 따로 쓰지 않는다 — 주문 id 가 이미 열쇠 역할을 한다)
//
// 알림 본문(payload)에 넣지 않는 것: 입금 계좌번호·은행·예금주. 계약 04 §2 「금액 외 결제 정보(계좌번호 등)는 넣지 않는다」를 따른다.
//   알림을 누르면 앱이 주문 조회(`GET /api/orders/{orderId}` 의 `virtualAccount`)로 계좌를 보여 준다 — 그래서 orderId 를 함께 둔다.
//
// 하지 않는 것: 실제 푸시·문자 발송(delivery_status 는 pending 으로 남는다 — 발송은 SCH-38(알림)). 카드·간편결제는 결제창 기한이
//   15분이라 대상이 아니다. 점검으로 기한이 늘어난 뒤 다시 알리는 일도 하지 않는다(주문당 1건).
import type { Clock } from "../../domain/time";
import type { Db } from "../../../prisma/db";

/** 기한 몇 분 전에 알리나 — FR-114a 추천값 1시간(플랜 「입금 기한 임박 알림 | 기한 1시간 전(추천값)」) */
export const PAYMENT_DEADLINE_REMINDER_MINUTES = 60;

/** 알림 종류 — 계약 04 §10 · data-model §15-4 ⑧ 의 새 값 */
export const PAYMENT_DEADLINE_SOON_KIND = "payment_deadline_soon";

/** 알림 화면 제목(문구 재료) */
const REMINDER_TITLE = "입금 기한이 곧 끝나요";

export interface PaymentDeadlineReminderDeps {
  readonly db: Db;
  readonly clock: Clock;
}

/** 경로 응답과 테스트가 읽는 결과 — 계약 04 §10 「응답 `{ "notified": 2 }`」 */
export interface PaymentDeadlineReminderResult {
  /** 이번 실행에서 새로 만든 알림 행 수 */
  readonly notified: number;
}

/**
 * 입금 기한 임박 알림 작업 한 번. 멱등이다 — 같은 시각에 두 번 불러도 두 번째는 notified 0 이다.
 */
export async function runPaymentDeadlineReminders(deps: PaymentDeadlineReminderDeps): Promise<PaymentDeadlineReminderResult> {
  const now = deps.clock().toString();
  const leadMinutes = String(PAYMENT_DEADLINE_REMINDER_MINUTES);

  // 문장 하나로 고르고 쓴다. 고르는 조건:
  //   주문 pending · 살아 있는 결제(ready) · 수단 가상계좌 · 아직 기한 전(due_at > 지금) · 알릴 시각(send_at) ≤ 지금.
  //   send_at = 발급~기한이 1시간 이상이면 「기한 − 1시간」, 더 짧으면 「발급 + (기한 − 발급) ÷ 2」(FR-114a).
  //   발급 시각은 결제 행이 생긴 시각(payments.created_at)이다 — 주문 생성 트랜잭션이 계좌 발급 결과와 함께 쓴다.
  // 학원 칸은 결제 → 주문 → 신청 단위 → 수업을 따라 채운다(다른 주문 알림과 같게).
  const rows = await deps.db.query(
    deps.db.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, order_id, payload)
                    SELECT uuidv7(), o.member_id, c.academy_id, ${PAYMENT_DEADLINE_SOON_KIND}, o.id,
                           json_build_object(
                             'title', ${REMINDER_TITLE}::text,
                             'offeringTitle', c.title,
                             'amount', p.amount,
                             'dueAt', to_char(p.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))::jsonb
                      FROM payments p
                      JOIN orders o ON o.id = p.order_id
                      JOIN class_offerings co ON co.id = o.offering_id
                      JOIN classes c ON c.id = co.class_id
                     WHERE o.status = 'pending'
                       AND p.status = 'ready'
                       AND p.method = 'virtual_account'
                       AND p.due_at > ${now}::timestamptz
                       AND ${now}::timestamptz >= CASE
                             WHEN p.due_at - p.created_at >= make_interval(mins => ${leadMinutes}::int)
                               THEN p.due_at - make_interval(mins => ${leadMinutes}::int)
                             ELSE p.created_at + (p.due_at - p.created_at) / 2
                           END
                    ON CONFLICT DO NOTHING
                    RETURNING order_id::text AS order_id`
      .returnsRow({ order_id: "pg/text@1" })
      .build(),
  );

  return { notified: rows.length };
}
