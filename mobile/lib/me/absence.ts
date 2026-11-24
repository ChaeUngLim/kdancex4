/**
 * 캘린더의 결석 예정 토글(보드 M11 · FR-092e(결석 예정 미리 알리기) · 계약 04 §5).
 *
 * 회차마다 `참석 | 결석` 토글 하나다. 기본은 참석이고, 결석으로 바꾸면 그 회차만 「결석 예정」이 된다.
 * 서버 경로는 둘이다 — 결석으로 바꿀 때 `PUT`, 참석으로 되돌릴 때 `DELETE`. 본문은 없다.
 *
 * 「지금 토글을 누를 수 있나」는 화면이 따로 계산하지 않고 서버가 준 `canToggle` 과
 * 회차 시작 시각만 본다. 규칙(내가 켠 것만 · 시작 전만)이 서버와 어긋나지 않게 하려는 것이다.
 */
import { apiFetch } from '../api';
import type { AbsenceMark, CalendarEntry } from '../catalog/types';

/** 토글 한 칸이 화면에 그릴 모양. */
export interface AbsenceToggleView {
  /** 지금 결석 쪽이 켜져 있나 */
  absent: boolean;
  /** 누를 수 있나 */
  enabled: boolean;
  /** 토글 아래 한 줄 안내. 없으면 null */
  note: string | null;
  /** 결석 쪽 태그 글자 — 내가 알린 것은 「결석 예정」, 강사·대표가 표시한 것은 「결석」 */
  absentTag: string;
}

const STAFF_ROLE_LABELS: Readonly<Record<string, string>> = { instructor: '강사', owner: '대표' };

/**
 * 회차 한 줄 → 토글 모양.
 * - 결석 행이 없고 시작 전: 참석 상태, 누를 수 있다
 * - 결석 행이 있고 `canToggle`: 내가 켠 결석 예정, 되돌릴 수 있다
 * - 직원이 표시한 결석: 역할만 보이고(이름은 아님, 계약 04 열린 점 ③) 회원은 끌 수 없다 — 이의 신청 경로로만
 * - 시작한 회차: 아무도(회원은) 바꿀 수 없다
 */
export function absenceToggleView(entry: CalendarEntry, now: Date): AbsenceToggleView {
  const absence = entry.absence ?? null;
  const started = new Date(entry.startsAt).getTime() <= now.getTime();
  if (absence === null) {
    return { absent: false, enabled: !started, note: started ? '시작한 수업은 바꿀 수 없어요' : null, absentTag: '결석 예정' };
  }
  const staffRole = STAFF_ROLE_LABELS[absence.markedByKind];
  if (staffRole !== undefined) {
    return { absent: true, enabled: false, note: `${staffRole}가 결석으로 표시했어요`, absentTag: '결석' };
  }
  return {
    absent: true,
    enabled: absence.canToggle,
    note: absence.canToggle ? '강사에게 미리 알려요. 자리와 결제는 그대로예요' : '시작한 수업은 바꿀 수 없어요',
    absentTag: '결석 예정',
  };
}

/** 결석 예정으로 바꾼다(`PUT`, 이미 결석이면 서버가 200 으로 같은 행을 준다). */
export function markAbsent(sessionId: string): Promise<AbsenceMark> {
  return apiFetch<AbsenceMark>(`/api/me/sessions/${encodeURIComponent(sessionId)}/absence`, { method: 'PUT' });
}

/** 참석으로 되돌린다(`DELETE`, 이미 없으면 서버가 200). */
export function markPresent(sessionId: string): Promise<{ sessionId: string; absence: null }> {
  return apiFetch(`/api/me/sessions/${encodeURIComponent(sessionId)}/absence`, { method: 'DELETE' });
}
