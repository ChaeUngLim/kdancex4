// S2-3.4(대타 요청 흐름) — 대타 후보를 고를 수 있는지 판정하는 순수 함수와 알림 문구.
//   계약: _workspace/03_contracts/11-instructor.md §8-1(후보 목록) · §8-2(요청·수락·확인)
//   요구: FR-060(대타 요청) · I-10(요청 → 수락 → 대표 확인 → 공지) · 플랜 S2-3 수용 ①(같은 시간에 일정이 있는 강사는 고를 수 없다)
//
// 후보가 되는 사람 = 같은 학원 active 소속(이건 DB 에서 거른다) · 활동 장르가 그 수업 장르와 같음 · 요청한 강사 본인이 아님.
// 고를 수 있나(available) = 그 회차 시간에 다른 일정이 없음. 일정이 있으면 이유는 「busy」 하나만 준다 —
//   무슨 일정인지(어느 학원 수업·개인 일정)는 알려 주지 않는다(FR-053, 다른 강사의 사생활).
// 겹침 판정은 수업 등록과 같은 S2-1.5(강사 일정 겹침 판정)의 함수를 그대로 쓴다. 두 벌이면 「등록은 막히는데 후보는 된다」가 생긴다.
import { hasInstructorOverlap, type InstructorScheduleItem, type TimeRange } from "./instructor-schedule-overlap";

/** 대타 요청에 붙이는 한마디의 최대 길이(data-model §8-5 ck_substitute_msg) */
export const SUBSTITUTE_MESSAGE_MAX = 200;

/** 요청 화면의 진행 단계(I14B) — 요청 → 수락 → 대표 확인 → 수강생 알림 */
export const SUBSTITUTE_STEPS = ["requested", "accepted", "owner_confirmed", "members_notified"] as const;

/** 후보가 될 수 있는 강사 한 명(그 학원 active 소속으로 이미 걸러진 사람) */
export interface SubstitutePoolMember {
  readonly accountId: string;
  readonly displayName: string;
  /** 강사 프로필의 활동 장르. 프로필이 없으면 null(후보에서 빠진다) */
  readonly genre: string | null;
}

/** 후보 목록 한 줄(계약 11 §8-1 응답 items) */
export interface SubstituteCandidate {
  readonly accountId: string;
  readonly displayName: string;
  readonly genre: string;
  readonly available: boolean;
  /** 고를 수 없는 이유. busy(그 시간에 일정이 있어요) 하나뿐이다 */
  readonly unavailableReason: "busy" | null;
}

export interface SubstituteCandidateInput {
  /** 대타를 구하는 회차의 시간 */
  readonly session: TimeRange;
  /** 그 수업의 장르 — 활동 장르가 같은 강사만 후보다 */
  readonly classGenre: string;
  /** 요청한 강사(회차의 담당 강사). 본인은 후보에서 뺀다 */
  readonly requesterAccountId: string | null;
  readonly pool: readonly SubstitutePoolMember[];
  /** 후보들에게 이미 잡힌 일정(수업 회차 · 개인 일정). 학원은 묻지 않는다 */
  readonly schedule: readonly InstructorScheduleItem[];
}

/**
 * 후보 목록을 만든다. 장르가 다르거나 본인이면 목록에서 빠지고, 남은 사람은 겹침이 있으면 available=false · busy.
 * 순서는 고를 수 있는 사람 먼저, 그다음 이름순이다(화면 I14 에서 위에 있는 사람이 먼저 눈에 들어온다).
 */
export function judgeSubstituteCandidates(input: SubstituteCandidateInput): SubstituteCandidate[] {
  const items = input.pool
    .filter((p) => p.genre !== null && p.genre === input.classGenre && p.accountId !== input.requesterAccountId)
    .map((p): SubstituteCandidate => {
      // S2-1.5 판정 — 그 강사의 일정 중 이 회차 시간과 1분이라도 겹치면 busy(맞닿기만 하면 겹침이 아니다)
      const busy = hasInstructorOverlap(p.accountId, [input.session], input.schedule);
      return { accountId: p.accountId, displayName: p.displayName, genre: p.genre ?? "", available: !busy, unavailableReason: busy ? "busy" : null };
    });
  return [...items].sort((a, b) => Number(b.available) - Number(a.available) || a.displayName.localeCompare(b.displayName, "ko"));
}

/** 대표 알림 「김하나 강사가 대타를 수락했어요 · 확인하면 수강생 10명에게 알림이 가요」(계약 11 §8-2) */
export function substituteAcceptedMessage(substituteName: string, memberCount: number): string {
  return `${substituteName} 강사가 대타를 수락했어요 · 확인하면 수강생 ${memberCount}명에게 알림이 가요`;
}

/** 회원 알림 「이번 회차는 김하나 강사가 진행해요」(계약 11 §8-2) */
export function instructorChangedMessage(substituteName: string): string {
  return `이번 회차는 ${substituteName} 강사가 진행해요`;
}
