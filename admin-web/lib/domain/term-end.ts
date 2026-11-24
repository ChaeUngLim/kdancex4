// 수업 「기간 종료」 판정 — 정규 수업 한 기간(판매 단위 class_offerings 한 줄)이 언제 끝났다고 보는지의 단일 원본.
//   쓰는 곳: S6-3.3(레벨 계산 작업) · S5-1.3(정산 단계 전이 작업 — 「기간 종료 시각 → 정산 완료」, 계약 13 §0)
//   로드맵 S6-3.3 method 「기간 종료 판정은 S5-1.3 과 같은 것을 쓴다」 — 두 작업이 서로 다른 「끝」을 쓰면
//   정산은 끝났는데 레벨은 아직(또는 반대)인 어긋남이 생긴다. 그래서 규칙을 여기 한 곳에 둔다.
//
// 기간 종료 시각 = 「판매 단위에 적힌 마지막 회차 끝(last_session_ends_at)」과 「그 판매 단위 회차들의 끝(ends_at) 중 가장 늦은 것」 중 더 늦은 쪽.
//   왜 둘 다 보나: 회차 시간을 바꾸는 경로(S2-3.2(시간·장소 변경과 휴강 알림))는 class_sessions.ends_at 만 고치고
//   판매 단위의 last_session_ends_at 은 그대로 둔다. 한쪽만 보면 늦춰진 마지막 회차가 끝나기 전에 「끝났다」고 잘못 볼 수 있다.
//   더 늦은 쪽을 고르면 일찍 판정하는 일은 없다(늦게 판정하는 것은 다음 실행이 받는다).
//   휴강 회차도 끝 시각 후보에 넣는다 — 휴강해도 기간 자체가 그 날까지라는 사실은 같다.
//
// 「끝났다」 = 지금이 (기간 종료 시각 + 여유 시간)보다 **뒤**일 때. 여유 시간은 작업마다 다르다:
//   레벨 계산은 결석 표시가 확정되는 48시간(ABSENCE_LOCK_HOURS)을 기다린다(계약 14 §5-1 「마지막 회차 종료 + 48시간」).
//   결석 표시 경로가 정확히 48시간째까지 받으므로(`지금 <= 끝 + 48시간`) 그보다 늦은 순간부터 판정해야 표시가 판정 뒤에 생기지 않는다.
import "temporal-polyfill/full/global";

/** 기간 종료 시각을 구하는 데 쓰는 값 */
export type TermEndSource = {
  /** class_offerings.last_session_ends_at */
  lastSessionEndsAt: Temporal.Instant;
  /** 그 판매 단위 모든 회차(휴강 포함)의 ends_at */
  sessionEndsAts: readonly Temporal.Instant[];
};

/** 기간 종료 시각 — 위 두 값 중 가장 늦은 순간 */
export function termEndsAt(source: TermEndSource): Temporal.Instant {
  return source.sessionEndsAts.reduce(
    (latest, endsAt) => (Temporal.Instant.compare(endsAt, latest) > 0 ? endsAt : latest),
    source.lastSessionEndsAt,
  );
}

/**
 * 기간이 (여유 시간까지) 끝났는가 — `지금 > 기간 종료 + graceHours`.
 * graceHours 는 0 이상 정수 시간. 정각(같은 순간)은 아직 끝나지 않은 것으로 본다.
 */
export function isTermEnded(termEnd: Temporal.Instant, now: Temporal.Instant, graceHours = 0): boolean {
  if (!Number.isInteger(graceHours) || graceHours < 0) {
    throw new RangeError(`graceHours 는 0 이상 정수여야 한다: ${graceHours}`);
  }
  return Temporal.Instant.compare(now, termEnd.add({ hours: graceHours })) > 0;
}

/**
 * SQL 로 후보를 고를 때 쓰는 기준 시각 — 「기간 종료 < 이 값」인 판매 단위가 끝난 것이다.
 * isTermEnded 와 같은 식이다: 지금 > 끝 + 여유 ⇔ 끝 < 지금 − 여유.
 */
export function termEndedBefore(now: Temporal.Instant, graceHours = 0): Temporal.Instant {
  if (!Number.isInteger(graceHours) || graceHours < 0) {
    throw new RangeError(`graceHours 는 0 이상 정수여야 한다: ${graceHours}`);
  }
  return now.subtract({ hours: graceHours });
}
