/**
 * 강사 앱 회차 화면(보드 I6B · I13 · I13B · I14 · I14B · I14C)이 부르는 API · 응답 모양 · 화면 계산
 * — S2-3.8(앱 변경·대타·공지 화면).
 *
 * 부르는 서버 경로(계약 11):
 *   GET  /api/classes/{classId}                                   수업 상세(제목·학원·정원, §4-2) — 이미 있다
 *   GET  /api/classes/{classId}/sessions                          회차 목록(§4-6) — **아직 서버에 없다**(맡은 Task 없음, 증거에 적음)
 *   GET  /api/classes/{classId}/announcement-recipients?sessionId= 공지 받는 사람 수(§6-3, S2-3.5)
 *   POST /api/classes/{classId}/announcements                     공지 보내기 — Idempotency-Key 필수(§6-3, S2-3.5)
 *   GET  /api/sessions/{sessionId}/substitute-candidates          대타 후보(§8-1, S2-3.4)
 *   POST /api/instructor/substitute-requests                      대타 요청 — Idempotency-Key 필수(§8-2, S2-3.4)
 *   GET  /api/instructor/substitute-requests?role=requested|received  내 요청 · 받은 요청(§8-2, S2-3.4)
 *   POST /api/instructor/substitute-requests/{id}/accept|decline|cancel  수락 · 거절 · 취소(§8-2, S2-3.4)
 *
 * 흐름 한눈에:
 *   I6B 회차 상세 ─「수강생 공지 보내기」→ I13 쓰기 ─「미리보기」→ I13B ─「N명에게 보내기」→ 보낸 뒤
 *              └「대타 요청」→ I14 후보 고르기 ─「N명에게 대타 요청 보내기」→ I14B 진행 상황(대표 확인 전 취소 가능)
 *   후보 강사는 알림을 눌러 I14C 로 들어와 수락·거절한다.
 *
 * 응답 모양은 admin-web 의 zod 스키마(substitute-requests.ts · substitute-request-queries.ts · class-announcements.ts)에서
 * 화면이 읽는 칸만 옮겼다. 모두 입력을 바꾸지 않는 순수 함수와 호출 함수다.
 */
import { apiFetch } from '../api';
import { parseInstant, toKstParts } from '../catalog/format';

// ---- 회차 목록(§4-6) ----------------------------------------------------------------------

export type SessionStatus = 'scheduled' | 'cancelled' | 'closed' | 'completed' | (string & {});

export interface ClassSession {
  sessionId: string;
  seq: number;
  startsAt: string;
  endsAt: string;
  status: SessionStatus;
  room: { roomId: string; name: string } | null;
  instructor: { accountId: string; displayName: string } | null;
  isSubstitute: boolean;
  /** 결제 완료 회원 수(결제 대기·대기 신청은 세지 않는다) */
  confirmedMemberCount: number;
  /** 이 회차에 열린 대타 요청. 계약은 null 예시만 있어 화면은 requestId·status 두 칸만 읽는다 */
  substituteRequest: { requestId: string; status: string } | null;
}

export const sessionsPath = (classId: string): string => `/api/classes/${encodeURIComponent(classId)}/sessions`;

// ---- 날짜 글자 ---------------------------------------------------------------------------

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;
const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 회차 시각 한 줄 — 「10/14 (수) 20:30–21:30」(보드 I6B·I14 머리).
 * 서버는 UTC(…Z)만 주므로 한국 시각(UTC+9)으로 바꿔 쓴다(format.ts 의 toKstParts).
 */
export function sessionWhen(startsAt: string, endsAt: string): string {
  const start = parseInstant(startsAt);
  const end = parseInstant(endsAt);
  if (start === null || end === null) return '-';
  const s = toKstParts(start);
  const e = toKstParts(end);
  return `${s.month}/${s.day} (${WEEKDAYS[s.weekday]}) ${pad2(s.hour)}:${pad2(s.minute)}–${pad2(e.hour)}:${pad2(e.minute)}`;
}

/** 진행 단계 시각 — 「11/12 (목) 10:20」(보드 I14B) */
export function stepWhen(iso: string): string {
  const at = parseInstant(iso);
  if (at === null) return '';
  const p = toKstParts(at);
  return `${p.month}/${p.day} (${WEEKDAYS[p.weekday]}) ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** 수강생 수 한 줄 — 남·여로 나뉜 수업은 「남 4 · 여 6」, 레이디 스타일처럼 한 칸이면 「6명」 */
export function memberCountLine(count: { male: number; female: number; any: number }): string {
  if (count.male === 0 && count.female === 0) return `${count.any}명`;
  const split = `남 ${count.male} · 여 ${count.female}`;
  return count.any > 0 ? `${split} · ${count.any}명` : split;
}

// ---- 강사 공지(§6-3, I13 · I13B) ---------------------------------------------------------

export type AnnouncementKind = 'general' | 'supplies' | 'progress';
export const ANNOUNCEMENT_KINDS: readonly AnnouncementKind[] = ['general', 'supplies', 'progress'];
export const ANNOUNCEMENT_KIND_LABELS: Readonly<Record<AnnouncementKind, string>> = {
  general: '일반',
  supplies: '준비물',
  progress: '진도·복습',
};
/** 서버 class-announcements.ts 와 같은 한도 — 화면이 미리 막아 서버에 틀린 값을 보내지 않는다 */
export const ANNOUNCEMENT_TITLE_MAX = 100;
export const ANNOUNCEMENT_BODY_MAX = 500;

export interface AnnouncementRecipients {
  recipientCount: number;
  male: number;
  female: number;
  /** 「결제 대기·대기 신청은 받지 않아요」 */
  excluded: string;
}

export function recipientsPath(classId: string, sessionId: string): string {
  return `/api/classes/${encodeURIComponent(classId)}/announcement-recipients?sessionId=${encodeURIComponent(sessionId)}`;
}

export interface AnnouncementDraft {
  sessionId: string;
  kind: AnnouncementKind;
  title: string;
  body: string;
  pushToo: boolean;
}

/** 쓰기 칸 검사 — 맞으면 null. 앞뒤 공백은 서버도 떼므로(trim) 떼고 센다 */
export function announcementProblem(draft: Pick<AnnouncementDraft, 'title' | 'body'>): string | null {
  const title = draft.title.trim();
  const body = draft.body.trim();
  if (title === '') return '제목을 적어 주세요.';
  if (title.length > ANNOUNCEMENT_TITLE_MAX) return `제목은 ${ANNOUNCEMENT_TITLE_MAX}자까지예요.`;
  if (body === '') return '내용을 적어 주세요.';
  if (body.length > ANNOUNCEMENT_BODY_MAX) return `내용은 ${ANNOUNCEMENT_BODY_MAX}자까지예요.`;
  return null;
}

export interface AnnouncementCreated {
  announcementId: string;
  recipientCount: number;
  createdAt: string;
}

export function sendAnnouncement(classId: string, draft: AnnouncementDraft, idempotencyKey: string): Promise<AnnouncementCreated> {
  return apiFetch<AnnouncementCreated>(`/api/classes/${encodeURIComponent(classId)}/announcements`, {
    method: 'POST',
    // 공백을 뗀 값으로 보낸다 — 미리보기에서 본 글자와 저장되는 글자를 같게
    body: { sessionId: draft.sessionId, kind: draft.kind, title: draft.title.trim(), body: draft.body.trim(), pushToo: draft.pushToo },
    idempotencyKey,
  });
}

// ---- 대타(§8, I14 · I14B · I14C) ---------------------------------------------------------

export const SUBSTITUTE_MESSAGE_MAX = 200;

export interface SubstituteCandidate {
  accountId: string;
  displayName: string;
  genre: string;
  available: boolean;
  /** 고를 수 없는 이유는 「busy」 하나 — 무슨 일정인지는 서버가 주지 않는다(FR-053) */
  unavailableReason: 'busy' | null;
}

export const candidatesPath = (sessionId: string): string => `/api/sessions/${encodeURIComponent(sessionId)}/substitute-candidates`;

export interface SubstituteRequestCreated {
  requestId: string;
  sessionId: string;
  status: string;
  candidates: { accountId: string; displayName: string; status: string }[];
}

export function requestSubstitute(
  sessionId: string,
  candidateAccountIds: readonly string[],
  message: string,
  idempotencyKey: string,
): Promise<SubstituteRequestCreated> {
  const trimmed = message.trim();
  return apiFetch<SubstituteRequestCreated>('/api/instructor/substitute-requests', {
    method: 'POST',
    body: { sessionId, candidateAccountIds, message: trimmed === '' ? null : trimmed },
    idempotencyKey,
  });
}

/** 요청 목록 한 줄(§8-2) — 내가 한 요청(requested)과 받은 요청(received)이 같은 모양이다 */
export interface SubstituteRequestItem {
  requestId: string;
  session: {
    sessionId: string;
    classId: string;
    classTitle: string;
    startsAt: string;
    endsAt: string;
    roomName: string;
    memberCount: { male: number; female: number; any: number };
  };
  /** 요청 상태: open · accepted · confirmed · cancelled · expired */
  status: string;
  /** 받은 요청에서 내 후보 상태: invited · accepted · declined · closed. 내가 한 요청이면 null */
  candidateStatus: string | null;
  requestedBy: { accountId: string; displayName: string };
  acceptedBy: { accountId: string; displayName: string } | null;
  message: string | null;
  timeline: { step: string; at: string }[];
}

export const requestedListPath = '/api/instructor/substitute-requests?role=requested';
export const receivedListPath = '/api/instructor/substitute-requests?role=received';

const substituteVerb = (requestId: string, verb: 'accept' | 'decline' | 'cancel'): Promise<{ requestId: string; status: string }> =>
  apiFetch(`/api/instructor/substitute-requests/${encodeURIComponent(requestId)}/${verb}`, { method: 'POST', body: {} });

export const acceptSubstitute = (requestId: string) => substituteVerb(requestId, 'accept');
export const declineSubstitute = (requestId: string) => substituteVerb(requestId, 'decline');
export const cancelSubstitute = (requestId: string) => substituteVerb(requestId, 'cancel');

/**
 * 한 회차의 가장 최근 요청을 고른다. 회차당 열린 요청은 하나지만(uq_substitute_active),
 * 취소된 옛 요청이 목록에 같이 올 수 있어 열린 것(open·accepted·confirmed)을 먼저 본다.
 */
export function latestRequestOf(items: readonly SubstituteRequestItem[], sessionId: string): SubstituteRequestItem | null {
  const mine = items.filter((item) => item.session.sessionId === sessionId);
  return mine.find((item) => ['open', 'accepted', 'confirmed'].includes(item.status)) ?? mine[mine.length - 1] ?? null;
}

export type StepState = 'done' | 'current' | 'todo';

export interface TimelineStep {
  key: string;
  title: string;
  detail: string;
  state: StepState;
}

/**
 * I14B 의 네 단계(요청 → 대타 수락 → 대표 확인 → 수강생 공지)를 서버 timeline 으로 칠한다.
 * 지나간 단계는 done, 바로 다음 단계 하나는 current(지금 기다리는 것), 나머지는 todo.
 * 취소·만료된 요청은 current 를 두지 않는다 — 더 기다릴 단계가 없어서다.
 */
export function substituteTimeline(item: SubstituteRequestItem, academyName: string | null): TimelineStep[] {
  const at = (step: string) => item.timeline.find((t) => t.step === step)?.at ?? null;
  const accepted = item.acceptedBy?.displayName ?? null;
  const total = item.session.memberCount.male + item.session.memberCount.female + item.session.memberCount.any;
  const rows = [
    { key: 'requested', title: '요청을 보냈어요', detail: stepWhen(at('requested') ?? '') },
    {
      key: 'accepted',
      title: accepted === null ? '대타 강사의 수락을 기다려요' : `${accepted} 강사가 수락했어요`,
      detail: at('accepted') === null ? '먼저 수락한 강사로 정해져요' : `${stepWhen(at('accepted') ?? '')} · 먼저 수락한 강사로 정해졌어요`,
    },
    {
      key: 'owner_confirmed',
      title: at('owner_confirmed') === null ? '대표 확인을 기다려요' : '대표가 확인했어요',
      detail: at('owner_confirmed') === null ? `${academyName ?? '학원'} 대표에게 알림이 갔어요` : stepWhen(at('owner_confirmed') ?? ''),
    },
    {
      key: 'members_notified',
      title: '수강생 공지',
      detail:
        at('members_notified') === null
          ? `대표가 확인하면 수강생 ${total}명에게 「이번 회차는 ${accepted ?? '대타'} 강사가 진행해요」 알림이 가요`
          : `수강생 ${total}명에게 알림이 갔어요`,
    },
  ];
  const closed = item.status === 'cancelled' || item.status === 'expired';
  // 대표 확인 단계는 수락 전에는 「기다려요」가 아니다 — 수락이 먼저라 다음 단계 하나만 current 로 둔다
  const firstTodo = rows.findIndex((row) => at(row.key) === null);
  return rows.map((row, index) => {
    const done = at(row.key) !== null;
    const state: StepState = done ? 'done' : !closed && index === firstTodo ? 'current' : 'todo';
    // 수락 전이면 대표 확인 줄은 아직 알림이 안 갔으니 설명을 바꾼다
    const detail = row.key === 'owner_confirmed' && !done && at('accepted') === null ? '수락하면 대표에게 알림이 가요' : row.detail;
    return { ...row, detail, state };
  });
}

export const SUBSTITUTE_STATUS_LABELS: Readonly<Record<string, string>> = {
  open: '수락을 기다려요',
  accepted: '대표 확인을 기다려요',
  confirmed: '대타가 정해졌어요',
  cancelled: '요청을 취소했어요',
  expired: '수업 시간이 지나 닫혔어요',
};
