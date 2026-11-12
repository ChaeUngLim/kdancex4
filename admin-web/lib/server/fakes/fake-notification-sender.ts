// T-M3-5(본인확인·알림 포트와 가짜 구현) — 공유 계약 §4.10 NotificationSenderPort 의 가짜 구현
//
// 옛 `backend/app/adapters/notification.py` 의 FakeNotificationSender 를 이었다.
// **실제로 아무것도 보내지 않는다.** 1회차는 `notifications.delivery_status` 가 `pending` 으로
// 남고, 실제 발송은 SCH-38(알림) 몫이다(06-ports.md 표 · 03_data-model.md §3).
import type { NotificationSenderPort } from "../ports/notification-sender";

export class FakeNotificationSender implements NotificationSenderPort {
  #calls: (readonly string[])[] = [];

  /** deliver 호출 기록(호출 순서 그대로). 각 항목은 호출 당시 배열의 얼린 복사본이다 */
  get calls(): readonly (readonly string[])[] {
    return [...this.#calls];
  }

  async deliver(notificationIds: readonly string[]): Promise<void> {
    if (notificationIds.length === 0) {
      return;
    }
    // 복사해서 얼린다 — 호출자가 나중에 배열을 바꿔도 과거 기록이 오염되지 않게
    this.#calls = [...this.#calls, Object.freeze([...notificationIds])];
  }

  /** 모든 호출의 id 를 순서대로 편 목록 */
  deliveredIds(): string[] {
    return this.#calls.flat();
  }

  reset(): void {
    this.#calls = [];
  }
}
