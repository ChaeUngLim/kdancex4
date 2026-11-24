// S7-1.7(수업 전 알림 작업) — 수업 전, 회원이 고른 시점에 「곧 수업이 시작해요」 알림을 회차마다 **한 번만** 만든다.
//   계약: _workspace/03_contracts/15-ops.md §1-4 `POST /api/internal/jobs/notifications/pre-class` · 수용 ⑤(두 번 돌아도 회원당 1건)
//   요구: FR-140(수업 전 알림 시점) · data-model §12-9(`pre_class_reminder` 는 service 분류)
//   경로: POST /api/internal/jobs/notifications/pre-class(5분마다 — 추천값, cron → 내부 경로 — S0-4.4(시간 작업 실행기))
//
// 흐름 한눈에:
//   ① 앞으로 24시간 안에 시작하는 「예정」 회차와, 그 회차의 확정 예약(예약 confirmed + 주문 paid·partially_refunded)을 고른다.
//      24시간인 이유: 가장 이른 시점이 「하루 전」이라 그만큼 앞을 봐야 한다(계약 「24시간 앞까지 훑는다」).
//   ② 회원마다 알림 설정의 시점(없으면 1시간 전)을 붙이고, 「수업 시작 − 시점 ≤ 지금 < 수업 시작」인 줄만 남긴다.
//   ③ 회원이 그 회차에 결석을 미리 알렸으면(살아 있는 attendance_marks) 빼고 — 안 오는 수업을 알릴 까닭이 없다.
//   ④ 알림 행을 쓴다. 열쇠 `preclass:<회차>:<회원>:<시점>` 이 같으면 DB 가 한 번만 넣는다(ON CONFLICT DO NOTHING).
//      cron 이 겹쳐 두 번 돌아도, 5분 뒤 다시 돌아도 1건이다.
//   ⑤ 커밋 뒤 이번에 새로 만든 행만 발송기(NotificationSenderPort, S7-1.5)에 넘긴다. 발송기도 pending→sending
//      조건부 갱신으로 선점하므로 휴대폰에도 한 번만 간다. 발송이 실패해도 알림함 행은 남는다(재시도는 S7-1.6).
//
// order_id 칸을 비우는 이유: 여러 회차 수업은 주문 하나에 회차가 여럿이다. 주문 칸을 채우면
//   uq_notifications_kind_order_recipient(종류·주문·회원 유니크)가 둘째 회차 알림을 막는다. 그래서 예약 칸만 채운다.
//
// 하지 않는 것: 개인 레슨 회차(private_lesson_bookings — 다른 표라 그 슬라이스 몫), 자녀 예약을 보호자에게 돌리기
//   (자녀 계정 표가 아직 없다 — S7-3 자녀 Task 가 받는 사람을 바꾼다).
import { PRE_CLASS_LEAD_MINUTES, PRE_CLASS_SCAN_MINUTES, DEFAULT_PRE_CLASS_LEAD } from "../../domain/pre-class-reminder";
import type { Clock } from "../../domain/time";
import type { NotificationSenderPort } from "../ports/notification-sender";
import type { Db } from "../../../prisma/db";

/** 알림 종류 — 계약 15 §1-4 · data-model §12-9 */
export const PRE_CLASS_REMINDER_KIND = "pre_class_reminder";

/** 알림 화면·휴대폰 알림 제목. 시점과 상관없이 같은 문장이라 늦게 만든 알림(추천안 2)도 사실과 어긋나지 않는다 */
const REMINDER_TITLE = "곧 수업이 시작해요";

export interface PreClassReminderDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly notificationSender: NotificationSenderPort;
}

/** 경로 응답과 테스트가 읽는 결과 — 계약 15 §1-4 「200 `{ "created": 37 }`」 */
export interface PreClassReminderResult {
  /** 이번 실행에서 새로 만든 알림 행 수 */
  readonly created: number;
}

/** 시점 표를 SQL 이 읽을 JSON 으로 — `[{ "lead": "one_hour", "minutes": 60 }, …]` */
const LEADS_JSON = JSON.stringify(
  Object.entries(PRE_CLASS_LEAD_MINUTES).map(([lead, minutes]) => ({ lead, minutes })),
);

/**
 * 수업 전 알림 작업 한 번. 멱등이다 — 같은 시각에 두 번 불러도 두 번째는 created 0 이다.
 */
export async function runPreClassReminders(deps: PreClassReminderDeps): Promise<PreClassReminderResult> {
  const now = deps.clock();
  const nowText = now.toString();
  const horizonText = now.add({ minutes: PRE_CLASS_SCAN_MINUTES }).toString();

  // ①~④ 를 문장 하나로 — 고르기와 쓰기 사이에 틈이 없어 겹쳐 돌아도 열쇠 유니크 하나로 충분하다.
  // 본문(payload)은 앱 알림함 줄과 휴대폰 알림이 같이 읽는 title·body 와, 누르면 갈 회차 정보(sessionId·startsAt)다.
  // 시각 글자는 KST 로 만든다(「12월 1일 19:00 시작」) — 회원은 한국 시각으로 읽는다.
  const rows = await deps.db.query(
    deps.db.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, reservation_id, dedupe_key, payload)
                    SELECT uuidv7(), r.member_id, c.academy_id, ${PRE_CLASS_REMINDER_KIND}, r.id,
                           'preclass:' || s.id::text || ':' || r.member_id::text || ':' || l.lead,
                           json_build_object(
                             'title', ${REMINDER_TITLE}::text,
                             'body', c.title || ' · '
                                     || to_char(s.starts_at AT TIME ZONE 'Asia/Seoul', 'FMMM"월" FMDD"일" HH24:MI') || ' 시작',
                             'classTitle', c.title,
                             'sessionId', s.id,
                             'startsAt', to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                             'lead', l.lead)
                      FROM class_sessions s
                      JOIN class_offerings co ON co.id = s.offering_id
                      JOIN classes c ON c.id = co.class_id
                      JOIN reservations r ON r.offering_id = s.offering_id AND r.status = 'confirmed'
                      JOIN orders o ON o.id = r.order_id AND o.status IN ('paid', 'partially_refunded')
                      LEFT JOIN notification_settings ns ON ns.member_id = r.member_id
                      JOIN json_to_recordset(${LEADS_JSON}::json) AS l(lead text, minutes int)
                        ON l.lead = COALESCE(ns.pre_class_lead, ${DEFAULT_PRE_CLASS_LEAD}::text)
                     WHERE s.status = 'scheduled'
                       AND s.starts_at > ${nowText}::timestamptz
                       AND s.starts_at <= ${horizonText}::timestamptz
                       AND s.starts_at - make_interval(mins => l.minutes) <= ${nowText}::timestamptz
                       AND NOT EXISTS (
                             SELECT 1 FROM attendance_marks am
                              WHERE am.reservation_id = r.id AND am.session_id = s.id AND am.cancelled_at IS NULL)
                    ON CONFLICT DO NOTHING
                    RETURNING id::text AS id`
      .returnsRow({ id: "pg/text@1" })
      .build(),
  );

  const ids = rows.map((row) => row.id);
  // ⑤ 커밋 뒤 발송. 실패해도 알림 행은 이미 남았고 재시도 작업이 다시 보낸다 — 작업 결과는 그대로 돌려준다
  if (ids.length > 0) {
    await deps.notificationSender.deliver(ids).catch((error: unknown) => {
      console.warn("[pre-class-reminders] 알림 발송 실패 — 알림함 행은 그대로", error);
    });
  }
  return { created: ids.length };
}
