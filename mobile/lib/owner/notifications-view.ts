/**
 * 대표 앱 「알림」(보드 O21·O21B) 이 부르는 API 와 화면 글자 규칙 — S1-4.10(대표 앱 알림함 화면 O21·O21B).
 *
 * 서버는 직원 알림함 API(S1-4.6, 계약 10 §2)를 그대로 쓴다.
 *   GET  /api/staff/notifications?academyId=&category=&cursor=&limit=20   내 알림 최신순(커서로 다음 쪽)
 *   POST /api/staff/notifications/{id}/read                               읽음(이미 읽었으면 같은 답)
 *   POST /api/staff/notifications/read-all  { category }                  「모두 읽음」 → { updated }
 *
 * 화면과 나눠 둔 이유: 「어느 칩이 어느 category 인가」, 「소속 신청 알림은 앱의 어느 화면으로 가나」,
 * 「오늘·어제 묶음」 같은 규칙은 버튼 모양과 상관이 없다. 순수 함수로 두면 화면을 바꿔도 규칙이 그대로다.
 * 휴대폰 엔진(Hermes)에 기대지 않으려고 Intl·Temporal 은 쓰지 않고, KST 는 lib/catalog/format.ts 처럼 9시간을 더해 읽는다.
 */
import { parseInstant, toKstDateKey, toKstParts } from '../catalog/format';
import { classSubmittedText } from './class-approval';

/** 계약 10 §2 의 category 다섯(웹 `NOTIFICATION_CATEGORIES` 와 같은 값) */
export type NotificationCategory = 'approval' | 'signup_close' | 'inquiry' | 'settlement' | 'operations';

/** 알림 한 줄(계약 10 §2 항목 모양). payload 는 쓰는 쪽이 정한 화면 재료라 실행 중에 하나씩 확인해 읽는다 */
export interface StaffNotification {
  id: string;
  kind: string;
  category: NotificationCategory | null;
  academyId: string | null;
  createdAt: string;
  readAt: string | null;
  payload: Record<string, unknown>;
}

export interface StaffNotificationList {
  items: StaffNotification[];
  nextCursor: string | null;
}

/**
 * 종류 칩 — 보드 O21 의 다섯(전체·승인·신청·마감·문의·정산)에 O21B 의 「운영」을 더한 여섯.
 * `전체` 는 category 를 보내지 않는다(서버가 칩 전체를 준다).
 */
export const NOTIFICATION_CHIPS: readonly { key: NotificationCategory | null; label: string }[] = [
  { key: null, label: '전체' },
  { key: 'approval', label: '승인' },
  { key: 'signup_close', label: '신청·마감' },
  { key: 'inquiry', label: '문의' },
  { key: 'settlement', label: '정산' },
  { key: 'operations', label: '운영' },
];

/** 한 쪽에 받는 개수(계약 기본값 20) */
export const NOTIFICATION_PAGE_SIZE = 20;

/** 목록 경로. 학원을 고른 뒤 그 학원 알림만 받는다. 칩이 `전체` 면 category 를 빼고, 다음 쪽이면 cursor 를 붙인다 */
export function notificationsPath(academyId: string, category: NotificationCategory | null, cursor: string | null = null): string {
  const params = [`academyId=${encodeURIComponent(academyId)}`, `limit=${NOTIFICATION_PAGE_SIZE}`];
  if (category !== null) params.push(`category=${category}`);
  if (cursor !== null) params.push(`cursor=${encodeURIComponent(cursor)}`);
  return `/api/staff/notifications?${params.join('&')}`;
}

export function readNotificationPath(id: string): string {
  return `/api/staff/notifications/${encodeURIComponent(id)}/read`;
}

export const READ_ALL_PATH = '/api/staff/notifications/read-all';

/** payload 에서 글자 칸 하나를 읽는다. 글자가 아니거나 비면 null(서버 값이 이상해도 화면이 깨지지 않게) */
function payloadText(item: StaffNotification, key: string): string | null {
  const value = item.payload[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * 알림의 앱 안 갈 곳. payload.link 는 관리자 웹 주소(예: `/staff/instructors?status=pending`)라 앱에서는 못 쓴다.
 * 그래서 kind 로 앱 화면을 고른다 — 웹 링크 글자를 앱이 해석하지 않는다(모르는 주소로 보내지 않기 위해).
 *  - 소속 신청 → 강사 관리(O37). 보드 O21 「확인하고 승인 ›」이 이어지는 곳(2026-11-18 결정)
 *  - 약관 변경 통지 → 약관 확인(O35)
 *  - 수업 등록 → 그 수업의 승인 화면(O5). 휴대폰 알림(O5P)을 눌렀을 때와 같은 곳(S2-2.11)
 * 앱 화면이 아직 없는 종류는 null — 화면에서 「관리자 웹에서 확인해요」로 보인다.
 */
export type NotificationRoute = '/owner/instructors' | '/owner/terms' | `/owner/classes/${string}`;

export function notificationAppRoute(item: StaffNotification): NotificationRoute | null {
  if (item.kind === 'affiliation_requested') return '/owner/instructors';
  if (item.kind === 'class_submitted') return classSubmittedText(item.payload).route;
  if (item.kind === 'terms_change_notice') return '/owner/terms';
  return null;
}

/** 왼쪽 네모 배지 글자 — 보드 O21B 처럼 두 글자로 종류를 보인다(색만으로 구별하지 않게) */
const KIND_BADGE: Readonly<Record<string, string>> = {
  affiliation_requested: '소속',
  class_submitted: '수업',
  terms_change_notice: '약관',
  substitute_accepted: '대타',
  payout_account_changed: '계좌',
  restriction_notice: '제한',
  merchant_application_approved: '입점',
  merchant_application_rejected: '입점',
};

const CATEGORY_BADGE: Readonly<Record<NotificationCategory, string>> = {
  approval: '승인',
  signup_close: '마감',
  inquiry: '문의',
  settlement: '정산',
  operations: '운영',
};

/** 화면 한 줄에 필요한 글자를 모두 만든다 */
export interface NotificationRowView {
  id: string;
  badge: string;
  category: NotificationCategory | null;
  title: string;
  body: string | null;
  time: string;
  unread: boolean;
  /** 「확인하고 승인 ›」 같은 행동 글자. 앱에 갈 화면이 없으면 null */
  actionLabel: string | null;
  route: NotificationRoute | null;
  /** 행동 글자는 있는데 앱 화면이 없을 때 보이는 안내 */
  webOnlyNote: string | null;
  /** 대타 수락 알림(O21B 「대타」)이면 「확인하기 ›」로 확정할 요청. 그 밖의 알림은 null */
  confirmRequestId: string | null;
}

/** 대타 확인 경로(계약 11 §8-2) — 대표 확인 → 회차 강사 교체 + 수강생 공지 */
export function confirmSubstitutePath(academyId: string, requestId: string): string {
  return `/api/academies/${encodeURIComponent(academyId)}/substitute-requests/${encodeURIComponent(requestId)}/confirm`;
}

/**
 * 대타 수락 알림의 글자 — 보드 O21B 맨 위 줄.
 * 서버(S2-3.4)의 payload 는 재료(classTitle · startsAt · requestId)와 문장 하나(body: 「김하나 강사가 대타를 수락했어요 · 확인하면 수강생 10명에게 알림이 가요」)다.
 * 그 문장의 앞 마디를 제목 뒤에 붙이고(「11/18 쌈바(입문) · 김하나 강사가 대타를 수락했어요」) 나머지를 내용으로 쓴다.
 */
function substituteAcceptedText(item: StaffNotification): { title: string; body: string | null; requestId: string | null } {
  const sentence = payloadText(item, 'body') ?? '대타를 수락했어요';
  const [head, ...rest] = sentence.split(' · ');
  const startsAt = payloadText(item, 'startsAt');
  const date = startsAt === null ? null : parseInstant(startsAt);
  const day = date === null ? '' : `${toKstParts(date).month}/${toKstParts(date).day} `;
  const classTitle = payloadText(item, 'classTitle') ?? '';
  return {
    title: `${day}${classTitle} · ${head ?? sentence}`.trim(),
    body: rest.length > 0 ? rest.join(' · ') : null,
    requestId: payloadText(item, 'requestId'),
  };
}

export function notificationRowView(item: StaffNotification, now: Date, readLocally: ReadonlySet<string>): NotificationRowView {
  const route = notificationAppRoute(item);
  // 수업 등록 알림은 payload 가 글자가 아니라 재료(강사·수업명·일정·금액)다 — 휴대폰 알림(O5P)과 같은 글자로 만든다
  if (item.kind === 'class_submitted') {
    const text = classSubmittedText(item.payload);
    return {
      id: item.id,
      badge: KIND_BADGE[item.kind] ?? '수업',
      category: item.category,
      title: text.title,
      body: text.price === null ? text.body : `${text.body}\n${text.price}`,
      time: notificationTimeLabel(item.createdAt, now),
      unread: item.readAt === null && !readLocally.has(item.id),
      actionLabel: route !== null ? '확인하고 승인 ›' : null,
      route,
      webOnlyNote: null,
      confirmRequestId: null,
    };
  }
  // 대타 수락 — 앱 안에서 바로 확인한다(갈 화면이 따로 없다). 이미 읽은 알림이어도 확인 버튼은 남긴다(확인은 서버가 멱등)
  if (item.kind === 'substitute_accepted') {
    const text = substituteAcceptedText(item);
    return {
      id: item.id,
      badge: KIND_BADGE[item.kind] ?? '대타',
      category: item.category,
      title: text.title,
      body: text.body,
      time: notificationTimeLabel(item.createdAt, now),
      unread: item.readAt === null && !readLocally.has(item.id),
      actionLabel: text.requestId === null ? null : '확인하기 ›',
      route: null,
      webOnlyNote: null,
      confirmRequestId: text.requestId,
    };
  }
  const action = payloadText(item, 'actionLabel');
  return {
    id: item.id,
    badge: KIND_BADGE[item.kind] ?? (item.category === null ? '알림' : CATEGORY_BADGE[item.category]),
    category: item.category,
    title: payloadText(item, 'title') ?? '새 알림이 왔어요',
    body: payloadText(item, 'body'),
    time: notificationTimeLabel(item.createdAt, now),
    unread: item.readAt === null && !readLocally.has(item.id),
    actionLabel: route !== null && action !== null ? `${action} ›` : null,
    route,
    webOnlyNote: route === null && action !== null ? '관리자 웹에서 확인해요' : null,
    confirmRequestId: null,
  };
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 묶음 제목 — 오늘 · 어제 · 「11월 18일 (화)」(KST 날짜 기준) */
export function notificationDayLabel(iso: string, now: Date): string {
  const date = parseInstant(iso);
  if (date === null) return '날짜 없음';
  const key = toKstDateKey(date);
  if (key === toKstDateKey(now)) return '오늘';
  if (key === toKstDateKey(new Date(now.getTime() - DAY_MS))) return '어제';
  const p = toKstParts(date);
  return `${p.month}월 ${p.day}일 (${WEEKDAYS[p.weekday]})`;
}

/** 오른쪽 위 시각 — 오늘이면 「10:02」, 그 전이면 「어제」·「11/18」(보드 O21B) */
function notificationTimeLabel(iso: string, now: Date): string {
  const date = parseInstant(iso);
  if (date === null) return '';
  const day = notificationDayLabel(iso, now);
  const p = toKstParts(date);
  if (day === '오늘') return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  if (day === '어제') return '어제';
  return `${p.month}/${p.day}`;
}

/**
 * 최신순 목록을 날짜 묶음으로 나눈다(보드 O21 「오늘」·「어제」 소제목).
 * 서버가 이미 최신순으로 주므로 순서를 바꾸지 않고, 날짜가 바뀌는 곳에서만 새 묶음을 연다.
 */
export function groupByDay(items: readonly StaffNotification[], now: Date): { label: string; items: StaffNotification[] }[] {
  return items.reduce<{ label: string; items: StaffNotification[] }[]>((groups, item) => {
    const label = notificationDayLabel(item.createdAt, now);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) {
      return [...groups.slice(0, -1), { label, items: [...last.items, item] }];
    }
    return [...groups, { label, items: [item] }];
  }, []);
}

/** 빈 목록 안내 — 칩마다 무엇이 없는지 말한다 */
export function emptyNotificationText(category: NotificationCategory | null): string {
  const chip = NOTIFICATION_CHIPS.find((c) => c.key === category);
  return category === null ? '아직 받은 알림이 없어요' : `「${chip?.label ?? ''}」 알림이 없어요`;
}
