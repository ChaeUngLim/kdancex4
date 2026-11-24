// S2-1.5(강사 일정 겹침 판정) — FR-054(강사 일정 충돌 거부) · 계약 11 §4-1(schedule-check)·§4-3(겹침 판정)·§10(대타 후보)
//
// 이 파일이 하는 일: 「새로 넣으려는 시간들」이 「그 강사에게 이미 있는 일정들」과 겹치는지,
// 겹치면 무엇과 몇 분 겹치는지를 계산한다. DB·화면을 모르는 순수 함수라서 schedule-check(I2C 미리 보기),
// 수업 저장·submit 의 서버 판정, 대타 후보 판정(busy)이 모두 이 함수 하나를 같이 쓴다.
//
// 규칙(FR-054, 플랜 S2-1 수용 ③):
//   - 겹침은 **강사 한 사람 기준**이다. 학원(academyId)은 판정에 쓰지 않는다 — 몸은 하나라서
//     학원 A 수업과 학원 B 수업이 같은 시각이면 겹침이다. 다른 강사의 일정은 보지 않는다.
//   - 구간은 [시작, 끝) 반열린 구간이다. 앞 수업 끝 시각에 바로 다음 수업이 시작하면 겹침이 아니다.
//   - 학원 사이 이동 여유 시간은 두지 않는다(2026-10-11 사용자 결정). 실제 수업 시간끼리만 본다.
//   - 결과의 라벨을 누구에게 얼마나 보일지(「다른 학원 일정」·「강사 일정」으로 가리기)는 호출하는 쪽이 정한다.
//     이 함수는 겹친 상대 항목을 그대로 돌려줄 뿐이다.
//
// 시각은 순간(`Temporal.Instant`)끼리 비교한다 — 시간대가 끼지 않는다(time.ts 규칙과 같다).
import "./time";

/** 시간 구간 하나 — [startsAt, endsAt) */
export interface TimeRange {
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
}

/** 이미 있는 강사 일정의 종류(계약 11 §4-3: 수업 회차·개인 레슨 「레슨 모집」 시간) */
// personal_event(개인 일정)는 수업 등록을 막지 않지만(열린 점 ②) 대타 후보에서는 busy 로 본다(S2-3.4(대타 요청 흐름), 계약 11 §8-1)
export type InstructorScheduleKind = "class_session" | "private_lesson_slot" | "personal_event";

/** 강사에게 이미 잡혀 있는 일정 하나 */
export interface InstructorScheduleItem extends TimeRange {
  readonly instructorAccountId: string;
  /** 어느 학원 일정인지 — 판정에는 쓰지 않고, 호출자가 라벨을 가릴 때만 쓴다 */
  readonly academyId: string | null;
  readonly kind: InstructorScheduleKind;
  /** 화면에 보일 이름(예: 「쌈바(입문)」) */
  readonly label: string;
}

/** 겹침 하나 — 새 구간 몇 번째가 어떤 기존 일정과 몇 분 겹치는가 */
export interface InstructorScheduleOverlap {
  /** 입력한 candidates 배열에서의 위치 */
  readonly candidateIndex: number;
  readonly candidate: TimeRange;
  readonly existing: InstructorScheduleItem;
  /** 겹친 길이(분). 「15:00 쌈바(입문)과 30분 겹쳐요」의 30 */
  readonly overlapMinutes: number;
}

const MS_PER_MINUTE = 60_000;

// 끝이 시작보다 늦지 않은 구간은 잘못 만든 값이다. 조용히 「안 겹침」으로 넘기면 겹침을 놓치므로 바로 멈춘다.
function assertValidRange(range: TimeRange): void {
  if (Temporal.Instant.compare(range.endsAt, range.startsAt) <= 0) {
    throw new RangeError(
      `시간 구간은 끝이 시작보다 늦어야 한다: ${range.startsAt.toString()} ~ ${range.endsAt.toString()}`,
    );
  }
}

/**
 * 두 구간이 겹치는 길이(분). 맞닿거나 떨어져 있으면 0.
 * 겹친 부분 = [늦은 시작, 이른 끝). 그 길이가 0 이하면 겹치지 않은 것이다.
 */
export function overlapMinutes(a: TimeRange, b: TimeRange): number {
  assertValidRange(a);
  assertValidRange(b);
  const laterStartMs = Math.max(a.startsAt.epochMilliseconds, b.startsAt.epochMilliseconds);
  const earlierEndMs = Math.min(a.endsAt.epochMilliseconds, b.endsAt.epochMilliseconds);
  const overlapMs = earlierEndMs - laterStartMs;
  return overlapMs > 0 ? Math.floor(overlapMs / MS_PER_MINUTE) : 0;
}

// 1분 미만으로만 겹치는 경우도 겹침이다(분 단위로 내리면 0 이 되지만 실제로는 겹친다).
// 시각은 10분 단위로 받으므로 실제로는 생기지 않지만, 판정이 반올림에 기대지 않게 밀리초로 본다.
function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  return (
    Temporal.Instant.compare(a.startsAt, b.endsAt) < 0 && Temporal.Instant.compare(b.startsAt, a.endsAt) < 0
  );
}

/**
 * 한 강사 기준 겹침 목록(FR-054).
 *
 * @param instructorAccountId 판정할 강사. existing 중 이 강사의 일정만 본다(학원은 가리지 않는다)
 * @param candidates 새로 넣으려는 시간 구간들(반복 수업이면 회차마다 하나)
 * @param existing 이미 있는 일정들. 다른 강사 것이 섞여 있어도 걸러 낸다
 * @returns 겹침 목록 — 새 구간의 시작 순, 같으면 기존 일정의 시작 순. 겹침이 없으면 빈 배열
 */
export function findInstructorOverlaps(
  instructorAccountId: string,
  candidates: readonly TimeRange[],
  existing: readonly InstructorScheduleItem[],
): InstructorScheduleOverlap[] {
  candidates.forEach(assertValidRange);
  // 학원은 묻지 않고 강사 id 로만 고른다 — 이것이 「여러 학원에 소속돼도 한 강사 기준」이다
  const mine = existing.filter((item) => item.instructorAccountId === instructorAccountId);
  mine.forEach(assertValidRange);

  const overlaps = candidates.flatMap((candidate, candidateIndex) =>
    mine
      .filter((item) => rangesOverlap(candidate, item))
      .map((item) => ({
        candidateIndex,
        candidate,
        existing: item,
        overlapMinutes: overlapMinutes(candidate, item),
      })),
  );

  // 화면 안내(「무엇과 몇 분」)가 시간 순으로 읽히도록 정렬한다. 원본 배열은 건드리지 않는다
  return [...overlaps].sort(
    (x, y) =>
      Temporal.Instant.compare(x.candidate.startsAt, y.candidate.startsAt) ||
      Temporal.Instant.compare(x.existing.startsAt, y.existing.startsAt),
  );
}

/** 겹침이 하나라도 있는가 — 대타 후보의 `available=false`(busy) 같은 예·아니오 판정용 */
export function hasInstructorOverlap(
  instructorAccountId: string,
  candidates: readonly TimeRange[],
  existing: readonly InstructorScheduleItem[],
): boolean {
  return findInstructorOverlaps(instructorAccountId, candidates, existing).length > 0;
}
