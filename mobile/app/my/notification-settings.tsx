/**
 * 마이 › 알림 설정(보드 C1A, 계약 15 §1-1 `GET`·`PUT /api/me/notification-settings`) — S7-1.8(앱 알림 설정·권한 화면).
 *
 * 위에서부터
 *  ① 휴대폰 알림 권한이 꺼진 기기(`pushPermission: denied`)에서만 보이는 띠 + `설정 열기`(휴대폰 설정 앱으로 보낸다)
 *  ② 수업 전 알림 네 칸 중 하나(FR-140(수업 전 알림 시점))
 *  ③ 광고성 알림 묶음 — 광고성 동의 토글(동의 날짜·밤엔 안 보냄), 쿠폰 알림, 학원 소식(학원별 설정 안내)
 *  ④ 서비스 알림 묶음 — 대기 자리 토글, 그리고 토글 없이 「항상 받아요」인 거래 알림(S7-1 수용 ①)
 * 거래 알림과 광고성 알림을 다른 묶음으로 나눠야 FR-146(광고성 알림 동의)의 「따로 받는 동의」가 회원 눈에 보인다.
 *
 * 저장은 누르는 즉시 한다(버튼 없음). 계약이 전체 교체(PUT)라 바꾼 칸 하나만이 아니라 네 칸을 늘 함께 보낸다.
 * 누르면 화면을 먼저 바꾸고(기다리지 않게), 서버가 실패하면 원래 값으로 되돌리고 그 자리에 오류 한 줄을 보인다.
 */
import { useState, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { apiFetch } from '../../lib/api';
import { Card, DetailScreen, ErrorView, InlineError, LoadingView } from '../../lib/catalog/ui';
import { toApiError, useApiResource } from '../../lib/catalog/use-api-resource';
import {
  applyInput,
  marketingNote,
  PRE_CLASS_LEAD_LABELS,
  PRE_CLASS_LEADS,
  toSettingsInput,
  type NotificationSettings,
  type NotificationSettingsInput,
  type PreClassLead,
} from '../../lib/me/notification-settings';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';

const PATH = '/api/me/notification-settings';

/** react-native-web 전용 Switch 속성(휴대폰 앱은 무시한다). 타입 정의에 없는 이름이라 객체로 펼쳐 넣는다. */
const WEB_SWITCH_COLORS = { activeThumbColor: colors.surface, activeTrackColor: colors.brown } as Record<string, string>;

export default function NotificationSettingsScreen() {
  const { state, reload } = useApiResource<NotificationSettings>(PATH);
  // 사용자가 한 번이라도 바꾼 뒤의 값. null 이면 서버에서 처음 읽은 값을 그대로 보인다
  const [edited, setEdited] = useState<NotificationSettings | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (state.status === 'loading') {
    return (
      <DetailScreen title="알림 설정" tab="my">
        <LoadingView />
      </DetailScreen>
    );
  }
  if (state.status === 'error') {
    return (
      <DetailScreen title="알림 설정" tab="my">
        <ErrorView error={state.error} onRetry={reload} />
      </DetailScreen>
    );
  }

  const settings = edited ?? state.data;

  /**
   * 한 칸을 바꿔 바로 저장한다. 화면은 먼저 바꾸고, 실패하면 누르기 전 값으로 되돌린다.
   * 저장 중에 또 누르면 받지 않는다 — 두 요청이 엇갈려 늦게 온 응답이 새 값을 덮는 일을 막는다.
   */
  const save = async (change: Partial<NotificationSettingsInput>) => {
    if (saving) return;
    const before = settings;
    const input = toSettingsInput(before, change);
    setEdited(applyInput(before, input));
    setSaveError(null);
    setSaving(true);
    try {
      const saved = await apiFetch<NotificationSettings>(PATH, { method: 'PUT', body: input });
      setEdited(saved);
    } catch (error: unknown) {
      setEdited(before);
      setSaveError(toApiError(error).detail);
    } finally {
      setSaving(false);
    }
  };

  const marketingOn = settings.marketing.agreed;

  return (
    <DetailScreen title="알림 설정" tab="my">
      {settings.pushPermission === 'denied' && <PermissionBanner />}
      <InlineError message={saveError} />

      <Section title="수업 전 알림" hint="예약한 수업이 시작하기 전에 한 번 알려요">
        <LeadChoices value={settings.preClassLead} onChange={(lead) => save({ preClassLead: lead })} disabled={saving} />
      </Section>

      <Section title="광고성 알림">
        <Card>
          <ToggleRow
            title="광고성 알림 받기"
            body="관심 강사 새 수업 · 쿠폰 · 이벤트"
            note={marketingNote(settings)}
            value={marketingOn}
            onChange={(next) => save({ marketingAgreed: next })}
            disabled={saving}
          />
          <ToggleRow
            title="쿠폰 알림"
            body={marketingOn ? '쿠폰이 사라지기 7일 전에 한 번 알려요' : '광고성 알림을 켜면 받을 수 있어요'}
            value={settings.couponExpiryNotice}
            onChange={(next) => save({ couponExpiryNotice: next })}
            // 광고성 동의가 없으면 쿠폰 알림도 가지 않는다 — 켜 둔 값은 남기되 눌러 바꾸지는 못하게 한다
            disabled={saving || !marketingOn}
            divided
          />
          <InfoRow
            title="학원 소식 알림"
            body="구독한 학원마다 소리·무음·끔을 따로 정해요"
            badge="학원별로"
            divided
          />
        </Card>
      </Section>

      <Section title="서비스 알림">
        <Card>
          <ToggleRow
            title="대기 자리 알림"
            body="내 자리 대기 1번이 되면 바로 알려요"
            value={settings.waitlistNotice}
            onChange={(next) => save({ waitlistNotice: next })}
            disabled={saving}
          />
          <InfoRow title="거래 알림" body="예약·결제·환불·수업 변경 알림은 끌 수 없어요" badge="항상 받아요" divided />
        </Card>
      </Section>

      <Text style={styles.footer}>
        광고성 알림을 끄면 쿠폰·학원 소식 알림도 함께 멈춰요. 거래 알림과 앱 알림함은 그대로예요.
      </Text>
    </DetailScreen>
  );
}

/**
 * 휴대폰 알림 권한이 꺼진 기기 띠(S7-1 수용 ② — 그런 기기에는 알림함에만 쌓인다).
 * 앱이 권한을 다시 켤 수는 없어서, 휴대폰 설정 앱의 이 앱 화면을 연다.
 */
function PermissionBanner() {
  const openSettings = () => {
    // 설정 앱을 못 여는 환경(웹 등)에서는 조용히 넘어간다 — 띠의 안내 글이 이미 할 일을 말해 준다
    Linking.openSettings().catch(() => undefined);
  };
  return (
    <View style={styles.banner} accessibilityRole="alert">
      <View style={styles.bannerText}>
        <Text style={styles.bannerTitle}>휴대폰 알림이 꺼져 있어요</Text>
        <Text style={styles.bannerBody}>지금은 앱 알림함으로만 알려요</Text>
      </View>
      <Pressable style={styles.bannerButton} onPress={openSettings} accessibilityRole="button" accessibilityLabel="휴대폰 설정 열기">
        <Text style={styles.bannerButtonText}>설정 열기</Text>
      </Pressable>
    </View>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      {hint !== undefined && <Text style={styles.muted}>{hint}</Text>}
      {children}
    </View>
  );
}

interface LeadChoicesProps {
  value: PreClassLead;
  onChange: (lead: PreClassLead) => void;
  disabled: boolean;
}

/** 수업 전 알림 네 칸 — 하나만 고른다(라디오). */
function LeadChoices({ value, onChange, disabled }: LeadChoicesProps) {
  return (
    <View style={styles.leads} accessibilityRole="radiogroup">
      {PRE_CLASS_LEADS.map((lead) => {
        const selected = lead === value;
        return (
          <Pressable
            key={lead}
            style={[styles.lead, selected && styles.leadOn]}
            onPress={() => {
              if (!selected) onChange(lead);
            }}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityLabel={`수업 ${PRE_CLASS_LEAD_LABELS[lead]} 알림`}
            accessibilityState={{ selected, disabled }}
          >
            <Text style={[styles.leadText, selected && styles.leadTextOn]}>{PRE_CLASS_LEAD_LABELS[lead]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

interface ToggleRowProps {
  title: string;
  body: string;
  note?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
  divided?: boolean;
}

function ToggleRow({ title, body, note, value, onChange, disabled, divided = false }: ToggleRowProps) {
  return (
    <View style={[styles.row, divided && styles.rowLine]}>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.muted}>{body}</Text>
        {note !== undefined && <Text style={styles.note}>{note}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: colors.line, true: colors.brown }}
        thumbColor={colors.surface}
        // 웹(react-native-web)은 켜진 손잡이 색을 따로 받는다 — 안 주면 기본 청록색이 보인다
        {...WEB_SWITCH_COLORS}
        accessibilityLabel={title}
        accessibilityState={{ checked: value, disabled }}
      />
    </View>
  );
}

/** 토글이 없는 줄 — 끌 수 없거나(거래) 다른 화면에서 정하는(학원 소식) 알림. 오른쪽에 회색 꼬리표만 둔다. */
function InfoRow({ title, body, badge, divided = false }: { title: string; body: string; badge: string; divided?: boolean }) {
  return (
    <View style={[styles.row, divided && styles.rowLine]} accessible accessibilityLabel={`${title}, ${badge}. ${body}`}>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.muted}>{body}</Text>
      </View>
      <View style={styles.badge}>
        <Text style={styles.badgeText}>{badge}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    backgroundColor: colors.dangerSoft,
  },
  bannerText: { flex: 1, gap: 2 },
  bannerTitle: { fontSize: font.body, fontWeight: '700', color: colors.danger },
  bannerBody: { fontSize: font.small, color: colors.ink },
  bannerButton: {
    minHeight: 40,
    paddingHorizontal: space.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    justifyContent: 'center',
  },
  bannerButtonText: { fontSize: font.small, fontWeight: '700', color: colors.ink },
  section: { gap: space.sm },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: colors.ink },
  muted: { fontSize: font.small, color: colors.ink3 },
  leads: { flexDirection: 'row', gap: space.sm },
  lead: {
    flex: 1,
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  leadOn: { backgroundColor: colors.brownSoft, borderColor: colors.brown },
  leadText: { fontSize: font.body, color: colors.ink },
  leadTextOn: { fontWeight: '700', color: colors.brown },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, minHeight: MIN_TOUCH },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, fontWeight: '700', color: colors.ink },
  note: { fontSize: font.small, color: colors.ink, marginTop: space.xs },
  badge: { paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.disabled },
  badgeText: { fontSize: font.small, fontWeight: '700', color: colors.disabledInk },
  footer: { fontSize: font.small, color: colors.ink3, lineHeight: 19 },
});
