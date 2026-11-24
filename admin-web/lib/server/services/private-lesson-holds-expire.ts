// S2-4.9(개인 레슨 잡아 둔 시간 만료 작업) — 결제 대기(`held`)로 잡아 둔 레슨 모집 시간 가운데
// `held_until` 이 지난 것을 다시 `open`(레슨 모집)으로 돌린다.
//   계약: _workspace/03_contracts/11-instructor.md §12(시간 작업 표 `private-lesson-holds-expire`) · 열린 점 ⑫(M3 와 만나는 곳)
//   데이터 모델: _workspace/03_data-model.md §8-6 `private_lesson_slots`(「기한이 지나면 open 으로 돌린다」) · §8-8 슬롯 전이 `held → open`
//   경로: POST /api/internal/jobs/private-lesson-holds-expire(매 10분, cron → 내부 경로 — S0-4.4)
//
// 왜 필요한가:
//   회원이 개인 레슨 첫 시간을 골라 결제를 시작하면 그 시간은 `held`(결제 대기)로 잡힌다(I10 「결제 대기 · 10/17 23:59까지」).
//   결제를 끝내지 않고 떠나면 그 시간이 영영 잡힌 채로 남아 다른 회원이 고를 수 없다. 그래서 기한이 지나면
//   시간 작업이 풀어 다시 「레슨 모집」으로 내놓는다.
//
// 어떻게 — 조건부 갱신 한 문장:
//   UPDATE private_lesson_slots SET status = 'open', held_until = NULL
//   WHERE status = 'held' AND held_until <= 지금
//   `held_until` 을 함께 비우는 이유: DB 제약 ck_pl_slot_held 가 「held 일 때만 기한이 있다」를 강제한다.
//   기한 전인 `held`, 그리고 `open`·`booked`·`closed` 는 조건에서 빠지므로 건드리지 않는다.
//   같은 시각에 두 번 불러도 두 번째는 고를 행이 없어 processed 0 이다(멱등). cron 이 겹쳐 돌거나
//   결제 확정(held → booked, M3)과 겹쳐도 DB 행 잠금 때문에 먼저 온 쪽 하나만 바꾼다 — 결제 확정 쪽도
//   `… WHERE status = 'held'` 조건부 갱신으로 쓰면 둘 중 하나만 이긴다.
//   held → open 은 겹침 거부(ex_pl_slots_instructor · ex_pl_slots_room)의 대상 상태 안에서 움직이는 것이라
//   새로 겹침이 생기지 않는다.
//
// 하지 않는 것(열린 점 ⑫ — M3 와 조율):
//   계약 §12 의 「pending_payment 수강권 정리」는 이 작업에서 하지 않는다. 지금 스키마에는
//   ① 잡아 둔 시간과 결제 대기 수강권을 잇는 칸이 없고(시간에는 회원·수강권 칸이 없다),
//   ② 결제 전 수강권이 갈 끝 상태가 없다(`expired` 는 ck_pl_pass_active 가 결제 시각·유효기간을 요구한다).
//   그래서 수강권 정리는 「결제 대기 만료는 M3 의 주문 만료와 한 묶음」(Task method)대로 M3 의 주문 만료 작업에 맡긴다.
//   알림·감사 행도 계약 §12 에 없어 쓰지 않는다.
import { type Clock } from "../../domain/time";
import type { Db } from "../../../prisma/db";

export interface PrivateLessonHoldsExpireDeps {
  readonly db: Db;
  readonly clock: Clock;
}

/** 경로 응답과 테스트가 읽는 결과 — 계약 11 §12 「응답 200 `{ "processed": n }`」 */
export interface PrivateLessonHoldsExpireResult {
  /** 이번 회차에 held → open 으로 돌린 시간 수 */
  readonly processed: number;
}

/**
 * 만료 한 회차를 돈다. 멱등이다 — 같은 시각에 두 번 불러도 두 번째는 processed 0 이다.
 * 「지났다」의 기준은 `held_until` 과 **같거나** 늦은 지금이다(기한 시각에 이르면 더는 잡아 두지 않는다).
 */
export async function runPrivateLessonHoldsExpire(deps: PrivateLessonHoldsExpireDeps): Promise<PrivateLessonHoldsExpireResult> {
  const nowText = deps.clock().toString();

  // 조건부 갱신 한 문장 — 고르기와 되돌리기를 한 번에. 돌려받은 행 수가 이번에 푼 시간 수다
  const reopened = await deps.db.query(
    deps.db.raw.sql`UPDATE private_lesson_slots
                    SET status = 'open', held_until = NULL
                    WHERE status = 'held'
                      AND held_until <= ${nowText}::timestamptz
                    RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );

  return { processed: reopened.length };
}
