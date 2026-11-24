/**
 * 오늘 결석자 화면(보드 I26)이 부르는 API · 응답 모양 · 화면 글자 계산 — S3-5.9b(앱 강사 결석 표시 화면).
 *
 * 부르는 서버 경로
 *   GET  /api/classes/{classId}/sessions/{sessionId}/absences                  오늘 결석 목록(계약 18 §8)
 *   POST /api/classes/{classId}/sessions/{sessionId}/absences                  결석 표시(계약 04 §6-1) — 본문 { memberId }
 *   POST /api/classes/{classId}/sessions/{sessionId}/absences/{markId}/cancel  표시 취소(계약 04 §6-2) — 본문 { reason? }
 *   POST /api/attendance-marks/{markId}/dispute/resolve                        이의 처리(계약 04 §8-2) — 본문 { decision }
 *   GET  …/roster(계약 18 §4)   「다른 수강생 결석 표시」 시트에 띄울 결제 완료 수강생
 *   GET  /api/instructor/headcount?date=(계약 18 §7)   머리글 「‹ 이전 · 다음 ›」 — 같은 날 앞뒤 수업
 *
 * 화면 흐름 한눈에:
 *   회차 상세(I6B·I23) ─「오늘 결석자」→ I26 ─ 줄의 스위치를 끄면 표시 취소
 *                                        ├「+ 다른 수강생 결석 표시」→ 시트에서 한 명 고르기 → 표시
 *                                        └ 이의가 들어온 줄 →「결석 취소(받아들이기)」·「결석 유지」
 *   이의 결과: 유지하면 그 줄에 「이의 결과 · 결석 유지」, 받아들이면 줄이 아래 「이의로 취소된 결석」으로 옮겨 간다.
 *
 * 무엇을 언제 할 수 있는지(시작 전 · 열림 · 잠김)는 서버가 `window` 로 판정해 준다 — 앱이 48시간 식을 따로 갖지 않는다.
 * 쓰기 호출(표시·취소·이의 처리)은 absence-actions.ts 에 따로 둔다 — 이 파일을 Expo 없이(admin-web 단위 시험) 불러 쓰려고.
 * 응답 모양은 admin-web 의 zod 스키마(staff-absence-marks.ts 의 sessionAbsenceListSchema)에서 화면이 읽는 칸만 옮겼다.
 * 이 파일의 계산 함수는 모두 입력을 바꾸지 않는 순수 함수다 — 렌더 중에 바로 불러 쓴다.
 */
import { parseInstant, toKstParts } from '../catalog/format';
import type { HeadcountItem, RosterMember, SessionRoster } from './headcount-api';

// ---- 응답 모양(계약 18 §8) ---------------------------------------------------------------------

export type AbsenceWindow = 'before_start' | 'open' | 'locked';
export type MarkedByKind = 'member' | 'instructor' | 'owner';
export type DisputeStatus = 'none' | 'requested' | 'accepted' | 'rejected';

export interface AbsenceItem {
  markId: string;
  memberId: string;
  nickname: string;
  gender: 'male' | 'female';
  monthsEnrolled: number;
  markedByKind: MarkedByKind;
  markedAt: string;
  disputeStatus: DisputeStatus;
  disputeReason: string | null;
  canResolveDispute: boolean;
}

export interface AcceptedDispute {
  markId: string;
  memberId: string;
  nickname: string;
  gender: 'male' | 'female';
  disputeReason: string | null;
  resolvedAt: string;
}

export interface SessionAbsenceList {
  sessionId: string;
  classId: string;
  academyId: string;
  academyName: string;
  title: string;
  roomName: string | null;
  startsAt: string;
  endsAt: string;
  sessionStatus: 'scheduled' | 'cancelled' | 'closed';
  lockedAt: string;
  window: AbsenceWindow;
  viewerRole: 'owner' | 'instructor';
  seatCount: number;
  absenceCount: { male: number; female: number; any: number; total: number };
  items: AbsenceItem[];
  acceptedDisputes: AcceptedDispute[];
}

// ---- 경로와 호출 -------------------------------------------------------------------------------

const sessionBase = (classId: string, sessionId: string) =>
  `/api/classes/${encodeURIComponent(classId)}/sessions/${encodeURIComponent(sessionId)}`;

export function absencesPath(classId: string, sessionId: string): string {
  return `${sessionBase(classId, sessionId)}/absences`;
}

/** 이 화면의 주소 — 회차 상세에서 들어올 때 쓴다 */
export function absenceScreenHref(classId: string, sessionId: string): string {
  return `/instructor/sessions/${encodeURIComponent(sessionId)}/absences?classId=${encodeURIComponent(classId)}`;
}

// ---- 화면 글자(보드 I26) --------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;
const GENDER_LABEL = { male: '남', female: '여' } as const;
const MARKER_LABEL = { instructor: '강사', owner: '대표' } as const;

/** KST 달력 날짜를 「YYYY-MM-DD」로 — 오늘·어제를 가르는 데 쓴다 */
function kstDateKey(at: Date): string {
  const p = toKstParts(at);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 화면이 그려지는 순간을 기준으로 「오늘 17:40」 · 「어제 21:05」 · 「11/20 (금) 09:00」 */
export function relativeWhen(iso: string, now: Date): string {
  const at = parseInstant(iso);
  if (at === null) return '';
  const p = toKstParts(at);
  const time = `${pad2(p.hour)}:${pad2(p.minute)}`;
  const day = kstDateKey(at);
  if (day === kstDateKey(now)) return `오늘 ${time}`;
  if (day === kstDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000))) return `어제 ${time}`;
  return `${p.month}/${p.day} (${WEEKDAYS[p.weekday]}) ${time}`;
}

/**
 * 위 요약 상자 — 「자리 19명 · 오늘 결석 2명 (남 1 · 여 1)」.
 * 숫자는 서버가 홈 표(I1)와 같은 쿼리로 센 값이라 그대로 쓴다. 단일 정원이면 성별 괄호를 붙이지 않는다.
 */
export function absenceSummaryLine(list: SessionAbsenceList): string {
  const { male, female, any, total } = list.absenceCount;
  const head = `자리 ${list.seatCount}명 · 오늘 결석 ${total}명`;
  if (total === 0 || any > 0) return head;
  return `${head} (남 ${male} · 여 ${female})`;
}

/**
 * 줄 둘째 줄 — 「여 · 3개월째 · 어제 21:05 알림」(회원이 알림) / 「남 · 2개월째 · 강사가 오늘 17:40 표시」.
 * 출석률은 적지 않는다(Q15). 누가 표시했는지는 역할까지만(이름은 쓰지 않는다 — 회원 화면과 같은 기준).
 */
export function absenceSubLine(item: AbsenceItem, now: Date): string {
  const when = relativeWhen(item.markedAt, now);
  const who = item.markedByKind === 'member' ? `${when} 알림` : `${MARKER_LABEL[item.markedByKind]}가 ${when} 표시`;
  return `${GENDER_LABEL[item.gender]} · ${item.monthsEnrolled}개월째 · ${who}`;
}

/**
 * 이의 상태 한 줄 — 걸려 있으면 회원이 쓴 사유를, 유지했으면 결과를 보여 준다. 이의가 없으면 null.
 * 받아들인 이의는 이 줄이 아니라 「이의로 취소된 결석」 칸에 나온다(목록에서 빠지므로).
 */
export function disputeLine(item: AbsenceItem): { tone: 'pending' | 'result'; text: string } | null {
  if (item.disputeStatus === 'requested') {
    const reason = item.disputeReason === null ? '' : ` 「${item.disputeReason}」`;
    return { tone: 'pending', text: `이의 신청이 들어왔어요${reason}` };
  }
  if (item.disputeStatus === 'rejected') return { tone: 'result', text: '이의 결과 · 결석 유지(회원에게 알렸어요)' };
  return null;
}

/** 이의로 취소된 결석 한 줄 — 「정우진 · 남 · 오늘 10:55 결석 취소」 */
export function acceptedLine(item: AcceptedDispute, now: Date): string {
  return `${GENDER_LABEL[item.gender]} · ${relativeWhen(item.resolvedAt, now)} 이의를 받아들여 출석으로 돌렸어요`;
}

/** 지금 표시·취소를 할 수 있나. 잠긴 뒤 취소는 대표만이라 강사 앱은 막는다(대표는 관리자 웹·대표 앱에서) */
export function canEditMarks(list: SessionAbsenceList): boolean {
  return list.sessionStatus === 'scheduled' && list.window === 'open';
}

/** 표시 구간 안내 — 시작 전 · 잠김이면 왜 스위치가 막혔는지 한 줄로 */
export function windowNotice(list: SessionAbsenceList, now: Date): string | null {
  if (list.sessionStatus !== 'scheduled') return '휴강·폐강된 회차라 결석을 표시할 수 없어요.';
  if (list.window === 'before_start') return '수업이 시작하면 결석을 표시할 수 있어요. 그 전에는 회원이 직접 결석 예정을 바꿔요.';
  if (list.window === 'locked') return `수업이 끝나고 48시간이 지나 잠겼어요(${relativeWhen(list.lockedAt, now)}). 고치려면 대표에게 사유와 함께 요청해 주세요.`;
  return null;
}

/** 「다른 수강생 결석 표시」 시트의 후보 — 결제 완료 명단에서 이미 결석인 사람을 뺀다(명단 순서 그대로) */
export function markableMembers(roster: SessionRoster, list: SessionAbsenceList): RosterMember[] {
  const absent = new Set(list.items.map((item) => item.memberId));
  return roster.members.filter((member) => !absent.has(member.memberId));
}

/** 회차의 KST 날짜(YYYY-MM-DD) — 같은 날 앞뒤 수업을 찾을 하루 인원표 날짜 */
export function sessionDateKey(startsAt: string): string | null {
  const at = parseInstant(startsAt);
  return at === null ? null : kstDateKey(at);
}

/**
 * 머리글 「‹ 이전 · 다음 ›」 — 하루 인원표에서 같은 날 내 단체 수업 중 이 회차 바로 앞·뒤.
 * 개인 레슨은 이 화면(회차 결석)과 맞지 않아 건너뛴다. 없으면 null.
 */
export function neighborSessions(
  items: readonly HeadcountItem[],
  sessionId: string,
): { prev: { classId: string; sessionId: string } | null; next: { classId: string; sessionId: string } | null } {
  const classes = items.flatMap((item) => (item.kind === 'class' ? [{ classId: item.classId, sessionId: item.sessionId }] : []));
  const index = classes.findIndex((item) => item.sessionId === sessionId);
  if (index < 0) return { prev: null, next: null };
  return { prev: classes[index - 1] ?? null, next: classes[index + 1] ?? null };
}
