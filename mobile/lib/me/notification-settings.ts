/**
 * 알림 설정 화면(보드 C1A)이 주고받는 값과 글자 계산 — 계약 15 §1-1 `GET`·`PUT /api/me/notification-settings`.
 *
 * 화면 파일(`app/my/notification-settings.tsx`)은 「무엇을 어떤 순서로 그리나」만 맡고,
 * 서버 모양 ↔ 저장 본문 변환과 날짜 글자는 여기 둔다. 서버 쪽 원본은
 * `admin-web/lib/server/services/member-notification-settings.ts` 이다 — 앱은 다른 패키지라 import 할 수 없어
 * 같은 값을 다시 적었다. 값이 바뀌면 두 곳을 같이 고친다.
 */

/** 수업 전 알림 시점 4값(FR-140(수업 전 알림 시점)). 서버 `PRE_CLASS_LEADS` 와 같다. */
export const PRE_CLASS_LEADS = ['day_before', 'two_hours', 'one_hour', 'thirty_min'] as const;
export type PreClassLead = (typeof PRE_CLASS_LEADS)[number];

/** 보드 C1A 의 네 칸 글자 — 왼쪽부터 먼 시점 순서. */
export const PRE_CLASS_LEAD_LABELS: Readonly<Record<PreClassLead, string>> = {
  day_before: '하루 전',
  two_hours: '2시간 전',
  one_hour: '1시간 전',
  thirty_min: '30분 전',
};

/** 휴대폰 알림 권한 상태. `denied` 일 때만 화면 맨 위 띠를 띄운다(S7-1 수용 ②). */
export type PushPermission = 'granted' | 'denied' | 'unknown';

/** GET·PUT 응답(계약 15 §1-1). */
export interface NotificationSettings {
  readonly preClassLead: PreClassLead;
  readonly marketing: {
    readonly agreed: boolean;
    /** 동의 중일 때만 시각이 온다. 거둔 동의는 null */
    readonly agreedAt: string | null;
    readonly quietHours: { readonly from: string; readonly to: string };
  };
  readonly couponExpiryNotice: boolean;
  readonly waitlistNotice: boolean;
  /** 거래 알림은 끌 수 없다 — 늘 true 로 온다 */
  readonly transactional: { readonly alwaysOn: true };
  readonly pushPermission: PushPermission;
}

/** PUT 본문 — 전체 교체라 네 칸을 늘 함께 보낸다. 거래 알림 칸은 보내지 않는다(끌 수 없으니 보낼 뜻이 없다). */
export interface NotificationSettingsInput {
  readonly preClassLead: PreClassLead;
  readonly marketingAgreed: boolean;
  readonly couponExpiryNotice: boolean;
  readonly waitlistNotice: boolean;
}

/** 지금 보이는 설정에서 저장 본문을 만든다. `change` 에 바꾼 칸만 넣으면 나머지는 지금 값 그대로 간다. */
export function toSettingsInput(
  current: NotificationSettings,
  change: Partial<NotificationSettingsInput>,
): NotificationSettingsInput {
  return {
    preClassLead: current.preClassLead,
    marketingAgreed: current.marketing.agreed,
    couponExpiryNotice: current.couponExpiryNotice,
    waitlistNotice: current.waitlistNotice,
    ...change,
  };
}

/**
 * 저장을 기다리는 동안 화면에 먼저 보일 값 — 누른 즉시 토글이 움직이게 한다.
 * 서버가 다른 값을 돌려주면(예: 동의 시각) 응답으로 갈아 끼운다.
 */
export function applyInput(current: NotificationSettings, input: NotificationSettingsInput): NotificationSettings {
  const agreedChanged = input.marketingAgreed !== current.marketing.agreed;
  return {
    ...current,
    preClassLead: input.preClassLead,
    marketing: {
      ...current.marketing,
      agreed: input.marketingAgreed,
      // 끄면 동의 시각을 바로 지운다. 켤 때 시각은 서버 응답이 채운다
      agreedAt: input.marketingAgreed ? (agreedChanged ? null : current.marketing.agreedAt) : null,
    },
    couponExpiryNotice: input.couponExpiryNotice,
    waitlistNotice: input.waitlistNotice,
  };
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 동의 시각 → 「11/24」(한국 날짜). 읽을 수 없는 값이면 null. */
export function formatAgreedDate(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const kst = new Date(ms + KST_OFFSET_MS);
  return `${kst.getUTCMonth() + 1}/${kst.getUTCDate()}`;
}

/** 「21:00」 → 「21시」, 「08:30」 → 「8시 30분」. 밤 시간 안내 글자에 쓴다. */
function hourLabel(hhmm: string): string {
  const [h = '0', m = '00'] = hhmm.split(':');
  const hour = Number(h);
  return m === '00' ? `${hour}시` : `${hour}시 ${Number(m)}분`;
}

/**
 * 광고성 알림 줄 아래 안내 — 「밤(21시~8시)엔 안 보내요 · 11/24 동의 · 언제든 끌 수 있어요」.
 * 동의하지 않았으면 동의 날짜 칸을 뺀다.
 */
export function marketingNote(settings: NotificationSettings): string {
  const { quietHours, agreed, agreedAt } = settings.marketing;
  const parts = [`밤(${hourLabel(quietHours.from)}~${hourLabel(quietHours.to)})엔 안 보내요`];
  const date = agreed ? formatAgreedDate(agreedAt) : null;
  if (date !== null) parts.push(`${date} 동의`);
  parts.push('언제든 끌 수 있어요');
  return parts.join(' · ');
}
