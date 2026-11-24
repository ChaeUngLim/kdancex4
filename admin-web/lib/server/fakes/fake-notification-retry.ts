// S7-1.6(발송 재시도 작업) — 개발 PC 기본(PUSH_DELIVERY=fake)일 때의 재시도 포트.
// 가짜 발송기(FakeNotificationSender)는 행 상태를 바꾸지 않아 retry_wait 행이 생기지 않는다 → 늘 0건이다.
import type { NotificationRetryPort, NotificationRetryReport } from "../ports/notification-retry";

export class FakeNotificationRetry implements NotificationRetryPort {
  #calls = 0;

  get calls(): number {
    return this.#calls;
  }

  async retryDue(): Promise<NotificationRetryReport> {
    this.#calls += 1;
    return { retried: 0, sent: 0, failed: 0 };
  }
}
