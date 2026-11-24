/**
 * 강사 앱 소속 해제(보드 I28 · I28B)가 부르는 API · 응답 모양 · 화면 계산 — S2-3.8(앱 변경·대타·공지 화면).
 *
 * 부르는 서버 경로(계약 11 §3-3 · §9-1, 둘 다 이미 있다):
 *   POST /api/instructor/affiliations/{id}/release-preview    남은 회차·받는 회원 미리 계산(쓰지 않음, S2-3.6)
 *   POST /api/instructor/affiliations/{id}/release-requests   해제 요청 — Idempotency-Key 필수(S2-1.4)
 *
 * 강사는 해제를 「요청」만 한다(§3-3 「요청만 만든다」). 고른 값은 대표 화면(W3b·O39)에 미리 채워지는 의향이고,
 * 회원 알림과 실제 해제는 대표가 §9-2 의 release 로 끝낼 때 나간다. 그래서 확인 시트(I28B)의 문구도 「요청」이다.
 *
 * 서버의 남은 회차는 회차 하나하나다. 보드 I28 은 수업 단위(「① 이후 회차 · 왈츠(초급) · 남은 6회」)로 묶어 고르므로
 * 화면은 같은 수업의 회차를 한 카드로 묶고, 고른 값을 그 수업의 모든 회차에 똑같이 넣어 보낸다.
 */
import { apiFetch } from '../api';
import { parseInstant, toKstParts } from '../catalog/format';

export type ReleaseSessionAction = 'substitute' | 'cancel_session' | 'close';
export const RELEASE_SESSION_ACTIONS: readonly ReleaseSessionAction[] = ['substitute', 'cancel_session', 'close'];
export const RELEASE_SESSION_LABELS: Readonly<Record<ReleaseSessionAction, string>> = {
  substitute: '대체 강사',
  cancel_session: '휴강',
  close: '폐강',
};
/** 고른 값마다 카드 아래 한 줄 안내(보드 I28) */
export const RELEASE_SESSION_HINTS: Readonly<Record<ReleaseSessionAction, string>> = {
  substitute: '대체 강사는 대표가 정해요',
  cancel_session: '수강생이 7일 안에 다른 회차로 옮기거나 환불을 골라요',
  close: '남은 회차만큼 환불돼요',
};

export type ReleasePassAction = 'finish_first' | 'refund' | 'handover';
export const RELEASE_PASS_ACTIONS: readonly ReleasePassAction[] = ['finish_first', 'refund', 'handover'];
export const RELEASE_PASS_LABELS: Readonly<Record<ReleasePassAction, string>> = {
  finish_first: '해제 전에 마치기',
  refund: '환불',
  handover: '다른 강사에게',
};

/** `release-preview` 응답(§9-1, admin-web affiliation-release-sessions.ts 의 releasePreviewSchema) */
export interface ReleasePreview {
  affiliationId: string;
  instructor: { accountId: string; displayName: string };
  remaining: {
    sessions: {
      sessionId: string;
      classId: string;
      classTitle: string;
      startsAt: string;
      endsAt: string;
      roomName: string;
      memberCount: number;
      decision: { action: ReleaseSessionAction } | null;
    }[];
    /** 개인 레슨 수강권 — §10(개인 레슨)이 생기기 전까지 서버는 늘 빈 배열을 준다 */
    privateLessonPasses: { passId: string; memberDisplayName: string; remainingSessions: number }[];
  };
  bundles: {
    action: ReleaseSessionAction;
    sessionCount: number;
    memberCount: number;
    messagePreview: string;
    members: { displayName: string; payKind: 'paid' | 'pass' }[];
  }[];
  totals: { memberCount: number; notificationCount: number };
  undecided: string[];
  canRelease: boolean;
}

/** 수업 하나로 묶은 남은 회차 — 보드 I28 카드 한 장 */
export interface RemainingClassGroup {
  classId: string;
  classTitle: string;
  sessionIds: string[];
  /** 첫 회차의 요일·시간 「화 21:10–22:10」 */
  firstWhen: string;
  /** 회차 중 가장 많은 수강생 수 — 서버는 회차별 수만 준다(수업 단위 중복 제거 수는 없다) */
  maxMemberCount: number;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;
const pad2 = (n: number): string => String(n).padStart(2, '0');

function weekdayTime(startsAt: string, endsAt: string): string {
  const s = parseInstant(startsAt);
  const e = parseInstant(endsAt);
  if (s === null || e === null) return '';
  const a = toKstParts(s);
  const b = toKstParts(e);
  return `${WEEKDAYS[a.weekday]} ${pad2(a.hour)}:${pad2(a.minute)}–${pad2(b.hour)}:${pad2(b.minute)}`;
}

/** 서버의 회차 목록을 수업별로 묶는다. 서버가 준 순서(시작 시각 순)를 그대로 지킨다 */
export function groupRemainingByClass(sessions: ReleasePreview['remaining']['sessions']): RemainingClassGroup[] {
  const groups: RemainingClassGroup[] = [];
  for (const session of sessions) {
    const found = groups.find((g) => g.classId === session.classId);
    if (found === undefined) {
      groups.push({
        classId: session.classId,
        classTitle: session.classTitle,
        sessionIds: [session.sessionId],
        firstWhen: weekdayTime(session.startsAt, session.endsAt),
        maxMemberCount: session.memberCount,
      });
    } else {
      // 새 객체로 바꿔 끼운다(원래 값을 고치지 않는다)
      groups[groups.indexOf(found)] = {
        ...found,
        sessionIds: [...found.sessionIds, session.sessionId],
        maxMemberCount: Math.max(found.maxMemberCount, session.memberCount),
      };
    }
  }
  return groups;
}

export interface ReleaseChoices {
  /** 수업 id → 고른 처리 */
  classActions: Readonly<Record<string, ReleaseSessionAction>>;
  /** 수강권 id → 고른 처리 */
  passActions: Readonly<Record<string, ReleasePassAction>>;
}

/** 아직 안 정한 것의 수 — 0 이어야 「해제 요청」 버튼이 켜진다(보드 I28 「2가지를 정하면 해제할 수 있어요」) */
export function undecidedCount(groups: readonly RemainingClassGroup[], preview: ReleasePreview, choices: ReleaseChoices): number {
  const classes = groups.filter((g) => choices.classActions[g.classId] === undefined).length;
  const passes = preview.remaining.privateLessonPasses.filter((p) => choices.passActions[p.passId] === undefined).length;
  return classes + passes;
}

/** 수업 단위 선택 → 서버가 받는 회차 단위 목록(수업의 모든 회차에 같은 값) */
export function sessionChoicesOf(groups: readonly RemainingClassGroup[], choices: ReleaseChoices): { sessionId: string; action: ReleaseSessionAction }[] {
  return groups.flatMap((g) => {
    const action = choices.classActions[g.classId];
    return action === undefined ? [] : g.sessionIds.map((sessionId) => ({ sessionId, action }));
  });
}

export function passChoicesOf(preview: ReleasePreview, choices: ReleaseChoices): { passId: string; action: ReleasePassAction }[] {
  return preview.remaining.privateLessonPasses.flatMap((p) => {
    const action = choices.passActions[p.passId];
    return action === undefined ? [] : [{ passId: p.passId, action }];
  });
}

const releasePath = (affiliationId: string, verb: 'release-preview' | 'release-requests'): string =>
  `/api/instructor/affiliations/${encodeURIComponent(affiliationId)}/${verb}`;

/** 미리 보기 — 처음 열 때는 빈 선택으로(남은 것 목록만), 확인 시트를 열 때는 고른 값으로 부른다 */
export function previewRelease(
  affiliationId: string,
  sessionDecisions: readonly { sessionId: string; action: ReleaseSessionAction }[],
  privateLessonDecisions: readonly { passId: string; action: ReleasePassAction }[],
): Promise<ReleasePreview> {
  return apiFetch<ReleasePreview>(releasePath(affiliationId, 'release-preview'), {
    method: 'POST',
    body: { sessionDecisions, privateLessonDecisions },
  });
}

export interface ReleaseRequested {
  requestId: string;
  status: 'requested';
  requestedAt: string;
  remainingSessionCount: number;
}

export function requestRelease(
  affiliationId: string,
  sessionChoices: readonly { sessionId: string; action: ReleaseSessionAction }[],
  privateLessonChoices: readonly { passId: string; action: ReleasePassAction }[],
  idempotencyKey: string,
): Promise<ReleaseRequested> {
  return apiFetch<ReleaseRequested>(releasePath(affiliationId, 'release-requests'), {
    method: 'POST',
    body: { sessionChoices, privateLessonChoices, note: null },
    idempotencyKey,
  });
}
