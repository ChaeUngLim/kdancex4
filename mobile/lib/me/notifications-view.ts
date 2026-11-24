/**
 * 회원 알림함(보드 M21 · 계약 04 §2) 화면 계산 — 종류 칩 · 날짜 묶음 · 줄 글자 · 행동 문구.
 *
 * 서버(`GET /api/me/notifications`)는 알림 행을 최신순으로 줄 뿐, 칩 거르기와 읽음 처리는
 * 계약이 범위 밖으로 두었다(계약 04 열린 점 ⑨). 그래서 칩은 앱이 `kind` 로 나눠 받은 목록 안에서 거른다.
 *
 * payload 모양은 알림 종류마다 다르다(쓰는 쪽 Task 가 정함). 대부분 `title`·`body` 가 있고,
 * 결제 확인(`payment_confirmed_member`)은 `title`=수업 제목 · `amount`, 입금 기한 임박은
 * `offeringTitle`·`amount`·`dueAt` 을 준다. 여기서 종류별로 한 줄 제목·설명을 만든다.
 */
import type { MemberNotification } from '../catalog/types';
import { formatKstDateTime, formatWon, toKstDateKey, toKstParts } from '../catalog/format';

export type NotificationChip = 'all' | 'class' | 'payment' | 'academy' | 'waitlist';

/** 칩 다섯 — 보드 M21 순서(전체 · 수업 · 결제·쿠폰 · 학원 소식 · 대기). */
export const NOTIFICATION_CHIPS: readonly { key: NotificationChip; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'class', label: '수업' },
  { key: 'payment', label: '결제·쿠폰' },
  { key: 'academy', label: '학원 소식' },
  { key: 'waitlist', label: '대기' },
];

/** 알림 종류 → 아이콘 원의 종류(색) */
export type NotificationIcon = 'schedule' | 'change' | 'waitlist' | 'payment' | 'academy' | 'other';

/** 종류 → 칩. 표에 없는 종류는 「전체」에서만 보인다(새 종류가 생겨도 알림이 사라지지 않는다). */
function chipOf(kind: string): NotificationChip | null {
  if (kind.startsWith('payment_') || kind.startsWith('refund_') || kind === 'reservation_cancelled') return 'payment';
  if (kind.startsWith('waitlist_')) return 'waitlist';
  if (kind.startsWith('academy_')) return 'academy';
  if (
    kind.startsWith('session_') ||
    kind.startsWith('class_') ||
    kind.startsWith('private_lesson_') ||
    kind.startsWith('absence_') ||
    kind === 'instructor_changed'
  ) {
    return 'class';
  }
  return null;
}

function iconOf(kind: string): NotificationIcon {
  const chip = chipOf(kind);
  if (chip === 'payment') return 'payment';
  if (chip === 'waitlist') return 'waitlist';
  if (chip === 'academy') return 'academy';
  if (kind === 'session_cancelled' || kind === 'class_closed' || kind.endsWith('_changed')) return 'change';
  if (chip === 'class') return 'schedule';
  return 'other';
}

/** 고른 칩에 맞는 알림만 남긴 새 배열. */
export function filterByChip(items: readonly MemberNotification[], chip: NotificationChip): MemberNotification[] {
  return chip === 'all' ? [...items] : items.filter((item) => chipOf(item.kind) === chip);
}

function text(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function amount(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? formatWon(value) : null;
}

/** 할 일이 있는 알림의 플럼 글씨 행동 문구와 갈 곳(보드 M21). 갈 화면이 아직 없는 종류는 붙이지 않는다. */
export interface NotificationAction {
  label: string;
  href: string;
}

/** 알림 한 줄이 그릴 것. */
export interface NotificationRowView {
  id: string;
  title: string;
  description: string | null;
  icon: NotificationIcon;
  unread: boolean;
  timeLabel: string;
  action: NotificationAction | null;
}

/**
 * 알림 한 행 → 줄 모양.
 * 결제 확인은 서버 payload 의 `title` 이 수업 제목이라(S3-4.5 증거 열린 점) 「결제 완료 · 수업명」을 앱이 만든다.
 */
export function notificationRow(item: MemberNotification, now: Date): NotificationRowView {
  const p = item.payload;
  const base = {
    id: item.id,
    icon: iconOf(item.kind),
    unread: item.readAt === null,
    timeLabel: timeLabel(item.createdAt, now),
  };
  if (item.kind === 'payment_confirmed_member') {
    const first = text(p, 'firstSessionStartsAt');
    return {
      ...base,
      title: `결제 완료 · ${text(p, 'title') ?? text(p, 'offeringTitle') ?? '수업'}`,
      description: [amount(p, 'amount'), first ? `첫 수업 ${formatKstDateTime(first)}` : null].filter(Boolean).join(' · ') || null,
      action: { label: '캘린더 보기', href: '/calendar' },
    };
  }
  if (item.kind === 'payment_deadline_soon') {
    const due = text(p, 'dueAt');
    return {
      ...base,
      title: text(p, 'title') ?? '입금 기한이 곧 끝나요',
      description: [text(p, 'offeringTitle'), amount(p, 'amount'), due ? `${formatKstDateTime(due)}까지` : null].filter(Boolean).join(' · ') || null,
      action: item.orderId ? { label: '계좌 보기', href: `/checkout/${encodeURIComponent(item.orderId)}` } : null,
    };
  }
  const isAbsence = item.kind.startsWith('absence_');
  return {
    ...base,
    title: text(p, 'title') ?? text(p, 'offeringTitle') ?? '새 알림',
    description: text(p, 'body') ?? text(p, 'classTitle'),
    action: isAbsence ? { label: '캘린더 보기', href: '/calendar' } : null,
  };
}

/** 묶음 이름 — 오늘 · 어제 · 이번 주(7일 안) · 지난 알림. KST 달력 날짜로 센다. */
export type NotificationGroupKey = 'today' | 'yesterday' | 'week' | 'older';

export const GROUP_LABELS: Readonly<Record<NotificationGroupKey, string>> = {
  today: '오늘',
  yesterday: '어제',
  week: '이번 주',
  older: '지난 알림',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** KST 날짜 차이(일). 같은 날이면 0. */
function kstDayDiff(iso: string, now: Date): number {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return Number.POSITIVE_INFINITY;
  const a = Date.parse(`${toKstDateKey(now)}T00:00:00Z`);
  const b = Date.parse(`${toKstDateKey(at)}T00:00:00Z`);
  return Math.round((a - b) / DAY_MS);
}

function groupOf(iso: string, now: Date): NotificationGroupKey {
  const diff = kstDayDiff(iso, now);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff < 7) return 'week';
  return 'older';
}

/** 오늘·어제는 「19:30」, 그보다 전은 「10/15」(보드 M21 오른쪽 시각). */
function timeLabel(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const p = toKstParts(at);
  if (kstDayDiff(iso, now) <= 1) {
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  }
  return `${p.month}/${p.day}`;
}

/** 최신순 목록을 묶음 순서(오늘 → 지난 알림)대로 나눈 새 배열. 빈 묶음은 빠진다. */
export function groupNotifications(
  items: readonly MemberNotification[],
  now: Date,
): { key: NotificationGroupKey; label: string; rows: NotificationRowView[] }[] {
  const order: readonly NotificationGroupKey[] = ['today', 'yesterday', 'week', 'older'];
  return order
    .map((key) => ({
      key,
      label: GROUP_LABELS[key],
      rows: items.filter((item) => groupOf(item.createdAt, now) === key).map((item) => notificationRow(item, now)),
    }))
    .filter((group) => group.rows.length > 0);
}
