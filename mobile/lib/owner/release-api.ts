/**
 * 대표 앱 「소속 해제」(보드 O39 · O39B) 가 부르는 API · 응답 모양 · 화면 계산 — S2-3.10(관리자 웹·대표 앱 해제 확인 화면).
 *
 * 부르는 서버 경로(계약 11 §8-1 · §9-1 · §9-2, 모두 이미 있다 — 관리자 웹 W3b·W3b2 와 같은 API):
 *   GET  /api/sessions/{sessionId}/substitute-candidates                   대체 강사 후보(그 시간이 비었는지)
 *   POST /api/academies/{academyId}/affiliations/{id}/release-preview      남은 회차·받는 회원 미리 계산(쓰지 않음)
 *   POST /api/academies/{academyId}/affiliations/{id}/release              해제 실행 — Idempotency-Key 필수
 *
 * 강사 앱(I28)은 수업 단위로 고르지만, 대표는 회차마다 고른다(보드 O39 — 카드 한 장 = 회차 하나).
 * 대체 강사는 대표가 바로 배정한다(수락 단계 없음, 2026-11-13). 그래서 대체 강사를 고른 회차는 사람까지 골라야 「정했다」.
 * 계산 규칙은 화면과 나눠 두어 버튼 모양을 바꿔도 그대로다. 날짜는 Intl 에 기대지 않고 lib/catalog/format.ts 로 KST 를 읽는다.
 */
import { apiFetch } from '../api';
import { parseInstant, toKstParts } from '../catalog/format';
import type { ReleaseSessionAction } from '../instructor/release-api';

export { RELEASE_SESSION_ACTIONS, RELEASE_SESSION_LABELS, type ReleaseSessionAction } from '../instructor/release-api';

/** `release-preview` 응답(§9-1) — 대표 쪽은 회차마다 대체 강사 이름·가능 여부가 함께 온다 */
export interface OwnerReleasePreview {
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
      decision: {
        action: ReleaseSessionAction;
        substituteAccountId: string | null;
        substituteName: string | null;
        substituteAvailable: boolean | null;
      } | null;
    }[];
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

export type RemainingSession = OwnerReleasePreview['remaining']['sessions'][number];

/** 대체 강사 후보 한 명(§8-1). 바쁜 이유는 「그 시간에 일정이 있어요」 하나뿐 — 무슨 일정인지는 오지 않는다 */
export interface SubstituteCandidate {
  accountId: string;
  displayName: string;
  available: boolean;
}

/** 대표가 한 회차에 정한 처리 */
export interface SessionChoice {
  action: ReleaseSessionAction;
  substituteAccountId: string | null;
  substituteName: string | null;
}
export type Choices = Readonly<Record<string, SessionChoice>>;

/** `release` 응답(§9-2) */
export interface ReleasedAffiliation {
  status: 'released';
  releasedAt: string;
  sessions: { substituted: number; cancelled: number; closed: number };
  notified: { memberCount: number; notificationCount: number };
}

/** 확인 시트 묶음 머리의 배지 — 회원이 받는 알림 이름(보드 O39B 「강사 변경 · 휴강 · 폐강」) */
export const RELEASE_BUNDLE_BADGES: Readonly<Record<ReleaseSessionAction, string>> = {
  substitute: '강사 변경',
  cancel_session: '휴강',
  close: '폐강',
};

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 카드 제목 「11월 18일 (수) · 차차차 입문」 */
export function sessionTitle(session: RemainingSession): string {
  const s = parseInstant(session.startsAt);
  if (s === null) return session.classTitle;
  const p = toKstParts(s);
  return `${p.month}월 ${p.day}일 (${WEEKDAYS[p.weekday]}) · ${session.classTitle}`;
}

/** 카드 둘째 줄 「수 20:00–21:30 · A실 · 예약 9명」 */
export function sessionSubline(session: RemainingSession): string {
  const s = parseInstant(session.startsAt);
  const e = parseInstant(session.endsAt);
  if (s === null || e === null) return `${session.roomName} · 예약 ${session.memberCount}명`;
  const a = toKstParts(s);
  const b = toKstParts(e);
  return `${WEEKDAYS[a.weekday]} ${pad2(a.hour)}:${pad2(a.minute)}–${pad2(b.hour)}:${pad2(b.minute)} · ${session.roomName} · 예약 ${session.memberCount}명`;
}

/** 이 회차는 다 정했나 — 대체 강사면 사람까지 골라야 한다 */
export function isDecided(choice: SessionChoice | undefined): boolean {
  if (choice === undefined) return false;
  return choice.action !== 'substitute' || choice.substituteAccountId !== null;
}

/** 아직 덜 정한 회차 수 — 0 이어야 버튼이 켜진다(보드 O39 「1개 남았어요」) */
export function remainingCount(sessions: readonly RemainingSession[], choices: Choices): number {
  return sessions.filter((s) => !isDecided(choices[s.sessionId])).length;
}

/** 서버로 보낼 회차 결정 목록. 고르지 않은 회차는 빼고, 대체 강사는 고른 사람만 싣는다 */
export function sessionDecisionsOf(
  sessions: readonly RemainingSession[],
  choices: Choices,
): { sessionId: string; action: ReleaseSessionAction; substituteAccountId?: string }[] {
  return sessions.flatMap((s) => {
    const choice = choices[s.sessionId];
    if (choice === undefined) return [];
    return choice.substituteAccountId === null
      ? [{ sessionId: s.sessionId, action: choice.action }]
      : [{ sessionId: s.sessionId, action: choice.action, substituteAccountId: choice.substituteAccountId }];
  });
}

const NOTICE_NAMES: Readonly<Record<ReleaseSessionAction, string>> = { substitute: '강사 변경', cancel_session: '휴강', close: '폐강' };

/** 카드 아래 「예약한 9명에게 강사 변경 알림」 */
export function noticeLine(memberCount: number, action: ReleaseSessionAction): string {
  return `예약한 ${memberCount}명에게 ${NOTICE_NAMES[action]} 알림`;
}

/** 확인 시트 합계 — 열린 점 ⑯ 추천안. 보드의 「알림 21건 · 받는 회원 12명」은 회원마다 1건 규칙과 맞지 않아 쓰지 않는다 */
export function totalsLine(totals: OwnerReleasePreview['totals']): string {
  return `받는 회원 ${totals.memberCount}명 · 알림은 회원마다 1건`;
}

/** 시트 묶음 머리 「11월 18일 (수) · 9명」 — 회차가 여럿이면 「회차 2개 · 9명」 */
export function bundleHeading(bundle: OwnerReleasePreview['bundles'][number], sessions: readonly RemainingSession[], choices: Choices): string {
  const mine = sessions.filter((s) => choices[s.sessionId]?.action === bundle.action);
  const first = mine[0];
  const when = mine.length === 1 && first !== undefined ? sessionTitle(first).split(' · ')[0] : `회차 ${bundle.sessionCount}개`;
  return `${when} · ${bundle.memberCount}명`;
}

const affiliationPath = (academyId: string, affiliationId: string, verb: 'release-preview' | 'release'): string =>
  `/api/academies/${encodeURIComponent(academyId)}/affiliations/${encodeURIComponent(affiliationId)}/${verb}`;

/** 처음 미리 보기 주소 — 화면이 공용 `useApiResource`(POST 미리 보기 모드)로 읽는다 */
export function previewPath(academyId: string, affiliationId: string): string {
  return affiliationPath(academyId, affiliationId, 'release-preview');
}

export async function fetchCandidates(sessionId: string): Promise<SubstituteCandidate[]> {
  const res = await apiFetch<{ items: SubstituteCandidate[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/substitute-candidates`);
  return res.items;
}

export function previewRelease(
  academyId: string,
  affiliationId: string,
  sessionDecisions: ReturnType<typeof sessionDecisionsOf>,
): Promise<OwnerReleasePreview> {
  return apiFetch<OwnerReleasePreview>(affiliationPath(academyId, affiliationId, 'release-preview'), {
    method: 'POST',
    body: { sessionDecisions, privateLessonDecisions: [] },
  });
}

/** 해제 실행. 같은 시트에서 다시 누르면 같은 키라 서버가 한 번만 처리한다 */
export function releaseAffiliation(
  academyId: string,
  affiliationId: string,
  sessionDecisions: ReturnType<typeof sessionDecisionsOf>,
  idempotencyKey: string,
): Promise<ReleasedAffiliation> {
  return apiFetch<ReleasedAffiliation>(affiliationPath(academyId, affiliationId, 'release'), {
    method: 'POST',
    body: { sessionDecisions, privateLessonDecisions: [] },
    idempotencyKey,
  });
}
