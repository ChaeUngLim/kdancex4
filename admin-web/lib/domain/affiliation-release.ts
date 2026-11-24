// S2-3.6(소속 해제의 남은 회차 처리와 받는 회원 수) — 해제할 때 쓰는 순수 함수 모음(DB·시계를 직접 만지지 않는다).
//   계약: _workspace/03_contracts/11-instructor.md §9-1(release-preview) · §9-2(release) · 열린 점 ⑯(「받는 회원 M명 · 알림은 회원마다 1건」)
//   수용: S2-3 ⑤ — 확인 창의 「받는 회원 M명」은 회차별 예약 회원의 중복을 뺀 수와 같고, 세 회차를 예약한 회원은 알림을 한 건만 받는다
//
// 여기 있는 것:
//   ① countDistinctMembers — 받는 회원 수(회차마다 회원을 모은 뒤 중복을 뺀다)
//   ② findUndecided        — 남은 회차 중 처리를 정하지 않은 것
//   ③ bundleByAction       — 확인 창의 묶음(대체·휴강·폐강별 회차 수와 받는 회원)
//   ④ groupByMember        — 회원마다 걸린 회차 목록(알림을 회원마다 1건으로 묶을 때)
//   ⑤ 회원 알림 문구       — 묶음 미리 보기 문구와 회원 한 명에게 가는 한 건의 문구
// 미리 보기(release-preview)와 실제 해제(release)가 같은 함수를 써야 「창에 보인 M명」과 「실제 알림 행 수」가 어긋나지 않는다.
import { RELEASE_SESSION_ACTIONS, type ReleaseSessionAction } from "./constants";
import { formatKstMonthDay } from "./session-change";

/** 남은 회차 하나를 어떻게 처리할지(계약 11 §9-2) — 대체 강사 · 휴강 · 폐강. 값의 원본은 constants.ts(강사 해제 요청과 같은 값) */
export { RELEASE_SESSION_ACTIONS, type ReleaseSessionAction };

/** 휴강·폐강으로 닫는 회차에 남기는 사유(회원에게 보인다). 대표가 따로 적지 않으므로 정해 둔 문장을 쓴다 */
export const RELEASE_CLOSE_REASON = "담당 강사의 학원 소속이 끝났어요";

/** 회차 하나와 그 회차의 받는 회원(결제 확정 예약 회원) id 목록 */
export type SessionMembers = { readonly sessionId: string; readonly memberIds: readonly string[] };

/** 처리를 정한 회차 하나 */
export type DecidedSession = SessionMembers & { readonly action: ReleaseSessionAction };

/**
 * 받는 회원 수 — 회차마다 회원을 모은 뒤 중복을 뺀 수.
 * 왜 회차별 수를 더하지 않나: 세 회차를 예약한 회원을 세 번 세면 「받는 회원 M명」이 실제 사람 수보다 커진다(수용 ⑤).
 * 알림도 회원마다 1건이라 이 값이 곧 알림 건수다(열린 점 ⑯).
 */
export function countDistinctMembers(sessions: readonly SessionMembers[]): number {
  const seen = new Set<string>();
  for (const session of sessions) for (const id of session.memberIds) seen.add(id);
  return seen.size;
}

/** 남은 회차 id 중 decisions 에 없는 것(남은 회차 순서 그대로). 하나라도 있으면 해제할 수 없다(I28 「정하기 전엔 해제 못 해요」) */
export function findUndecided(remainingSessionIds: readonly string[], decidedSessionIds: readonly string[]): string[] {
  const decided = new Set(decidedSessionIds);
  return remainingSessionIds.filter((id) => !decided.has(id));
}

/** 확인 창의 묶음 하나(계약 11 §9-1 bundles) — 회원 목록은 중복을 뺀 id(처음 나온 순서) */
export type ActionBundle = { action: ReleaseSessionAction; sessionCount: number; memberIds: string[] };

/**
 * 처리별 묶음 — 대체 → 휴강 → 폐강 순서. 회차가 없는 처리는 빼고 돌려준다.
 * 묶음 안의 회원 수도 중복을 뺀다. 묶음끼리는 같은 회원이 겹칠 수 있다(합계는 countDistinctMembers 로 따로 센다).
 */
export function bundleByAction(sessions: readonly DecidedSession[]): ActionBundle[] {
  return RELEASE_SESSION_ACTIONS.flatMap((action) => {
    const mine = sessions.filter((s) => s.action === action);
    if (mine.length === 0) return [];
    const memberIds = [...new Set(mine.flatMap((s) => s.memberIds))];
    return [{ action, sessionCount: mine.length, memberIds }];
  });
}

/**
 * 회원마다 걸린 회차 목록 — 알림을 회원마다 1건으로 묶을 때 쓴다.
 * 회원 순서는 처음 나온 순서, 회차 순서는 들어온 순서(호출하는 쪽이 시간순으로 넘긴다).
 */
export function groupByMember(sessions: readonly DecidedSession[]): { memberId: string; sessionIds: string[] }[] {
  const byMember = new Map<string, string[]>();
  for (const session of sessions) {
    for (const memberId of session.memberIds) {
      const list = byMember.get(memberId) ?? [];
      if (!list.includes(session.sessionId)) list.push(session.sessionId);
      byMember.set(memberId, list);
    }
  }
  return [...byMember.entries()].map(([memberId, sessionIds]) => ({ memberId, sessionIds }));
}

// ---- 회원 알림 문구 ---------------------------------------------------------------------------

/** 문구에 쓰는 회차 한 줄 */
export type ReleaseNoticeItem = {
  readonly classTitle: string;
  readonly startsAt: Temporal.Instant;
  readonly action: ReleaseSessionAction;
  /** 대체일 때만 — 새로 맡는 강사 이름 */
  readonly substituteName: string | null;
};

/** 휴강·폐강·강사 변경 뒤 회원이 할 수 있는 일(계약 11 §9-1 예시 「원하면 환불을 요청할 수 있어요」) */
const REFUND_HINT = "원하면 환불을 요청할 수 있어요";

/**
 * 회차 한 줄 문장.
 *   대체 → 「11/18 (수) 차차차 입문은 박서윤 강사 대신 이준호 강사가 진행해요」(계약 §9-1 예시)
 *   휴강 → 「11/18 (수) 차차차 입문은 휴강해요」 · 폐강 → 「11/18 (수) 차차차 입문은 폐강돼요」
 */
export function releaseItemSentence(item: ReleaseNoticeItem, instructorName: string): string {
  const head = `${formatKstMonthDay(item.startsAt)} ${withTopic(item.classTitle)}`;
  if (item.action === "substitute") return `${head} ${instructorName} 강사 대신 ${item.substituteName ?? ""} 강사가 진행해요`;
  if (item.action === "cancel_session") return `${head} 휴강해요`;
  return `${head} 폐강돼요`;
}

/** 「차차차 입문은」 · 「쌈바(입문)은」 · 「살사는」 — 끝 글자 받침으로 은/는을 고른다(괄호는 건너뛴다, 한글이 아니면 「은」) */
function withTopic(word: string): string {
  const letters = word.replace(/[)\]」\s]+$/u, "");
  const last = letters.charCodeAt(letters.length - 1);
  const isHangul = last >= 0xac00 && last <= 0xd7a3;
  return `${word}${!isHangul || (last - 0xac00) % 28 !== 0 ? "은" : "는"}`;
}

/** 확인 창 묶음의 미리 보기 문구 — 그 묶음의 첫 회차로 만든다(계약 §9-1 messagePreview, 「…」로 감싼다) */
export function releaseBundlePreview(first: ReleaseNoticeItem, instructorName: string): string {
  return `「${releaseItemSentence(first, instructorName)}. ${REFUND_HINT}.」`;
}

/**
 * 회원 한 명에게 가는 알림 한 건의 문구 — 그 회원이 예약한 회차를 모두 담는다.
 * 대표가 한 줄(ownerNote)을 덧붙이면 끝에 붙인다. 회원을 빼고 보낼 수는 없다(계약 §9-1).
 */
export function releaseMemberMessage(
  items: readonly ReleaseNoticeItem[],
  input: { instructorName: string; academyName: string; ownerNote: string | null },
): { title: string; body: string; refundHint: string } {
  const lines = items.map((item) => releaseItemSentence(item, input.instructorName));
  const note = input.ownerNote === null || input.ownerNote === "" ? [] : [`학원 한마디: ${input.ownerNote}`];
  return {
    title: `수업 강사 변경 안내 · ${input.academyName}`,
    body: [...lines, ...note].join("\n"),
    refundHint: REFUND_HINT,
  };
}

// ---- 대체 강사 알림 문구 ----------------------------------------------------------------------

/**
 * 대체 강사에게 가는 배정 알림 한 건의 문구(S2-3.7(대체 강사 배정 알림), 계약 11 §9-2 · §12 substitute_assigned).
 * 대체 강사는 수락 단계 없이 대표가 바로 정하므로(2026-11-13) 「맡게 됐다」는 사실과 「내 일정에 들어갔다」는 것을 함께 알린다.
 *   예) 제목 「대체 강사 배정 · 라온댄스」 · 본문 「12/1 (화) 차차차 입문은 junho 강사 대신 mina 강사가 진행해요. 내 일정에 들어갔어요.」
 * 회원 알림과 같은 회차 한 줄 문장(releaseItemSentence)을 써서 두 쪽 문구가 어긋나지 않게 한다.
 */
export function substituteAssignedMessage(
  item: ReleaseNoticeItem,
  input: { instructorName: string; academyName: string },
): { title: string; body: string } {
  return {
    title: `대체 강사 배정 · ${input.academyName}`,
    body: `${releaseItemSentence(item, input.instructorName)}. 내 일정에 들어갔어요.`,
  };
}
