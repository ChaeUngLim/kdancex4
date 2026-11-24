/**
 * 대표 앱 「약관·동의 기록」(보드 O35) — S1-1.34(대표 앱 약관·수수료 변경 안내).
 *
 * 이 화면이 하는 일
 *  1. 내가 대표인 학원을 고른다(`GET /api/staff/me`)
 *  2. 그 학원의 동의 기록과 「아직 시행 전인 약관 변경 통지」를 읽는다(`GET .../consents`)
 *  3. 통지가 있으면 맨 위 안내 상자에 「무엇이 · 언제부터 바뀌는지」와 30일 전 통지·해지 안내를 보이고,
 *     대표가 「읽었어요」를 누르면 서버에 읽음을 남긴다(`POST .../terms-notices/{id}/read`)
 *
 * 읽음은 버튼의 onPress 안에서 바로 보낸다(화면이 뜰 때 저절로 도는 효과 훅을 쓰지 않는 규칙). 서버가 돌려준 줄(처음 읽은 시각이
 * 들어 있다)로 화면의 그 줄만 바꾼다 — 다시 불러오지 않아도 「읽음」 상태가 바로 보인다.
 *
 * 범위 밖: 줄을 눌러 동의한 판본 전문을 여는 것, 대표 앱 하단 탭(대표 앱 틀은 FR-011a(역할별 화면·강사·대표 입구)
 * 의 열린 점이라 아직 없다), 시행일 뒤 재동의(S7-3).
 */
import type { ReactNode } from 'react';
import { useState } from 'react';
import { router, Stack } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ApiError } from '../../lib/api';
import { formatKstDateTime } from '../../lib/catalog/format';
import { toApiError, useApiResource } from '../../lib/catalog/use-api-resource';
import {
  Card,
  EmptyView,
  ErrorView,
  InlineError,
  LoadingView,
  NoticeBox,
  SectionTitle,
} from '../../lib/catalog/ui';
import {
  consentsPath,
  daysUntil,
  markTermsNoticeRead,
  pickOwnerAcademy,
  termsLabel,
  type AcademyConsents,
  type ConsentItem,
  type StaffMe,
  type TermsNotice,
} from '../../lib/owner/terms-api';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';

// 보드 O35 아래 안내 상자 문구(FR-259(입점 약관 변경 통지), 2026-11-19 개정)
const NOTICE_RULE_TEXT = '약관이 바뀌면 적용 30일 전에 따로 알려요. 동의하지 않으면 적용일 전까지 입점을 해지할 수 있어요.';

// 입점 때 동의한 「약관」 두 가지. 나머지는 입점 때 알려 드린 항목(고지)이다 — 보드의 두 묶음과 같다
const TERMS_GROUP = new Set(['merchant_terms', 'merchant_privacy_collection', 'privacy_policy']);

export default function OwnerTermsScreen() {
  const me = useApiResource<StaffMe>('/api/staff/me');
  const academy = me.state.status === 'ready' ? pickOwnerAcademy(me.state.data) : null;
  // 학원을 고른 뒤에만 동의 기록을 부른다(null 이면 부르지 않는다)
  const consents = useApiResource<AcademyConsents>(academy === null ? null : consentsPath(academy.academyId));

  return (
    <OwnerScreen title="약관 · 동의 기록">
      {renderBody(me.state, academy, consents.state, me.reload, consents.reload)}
    </OwnerScreen>
  );
}

/**
 * 대표 앱 화면 틀: 위 제목 줄(뒤로 가기) + 스크롤 본문.
 * 회원 화면 틀(DetailScreen)은 회원 하단 탭(AI 플래너 등)을 붙이므로 쓰지 않는다.
 * 대표 앱 하단 탭은 대표 앱 틀을 정하는 Task 가 붙인다.
 */
function OwnerScreen({ title, children }: { title: string; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const goBack = () => (router.canGoBack() ? router.back() : router.navigate('/'));
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable onPress={goBack} style={styles.back} accessibilityRole="button" accessibilityLabel="뒤로 가기">
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.body}>{children}</ScrollView>
    </View>
  );
}

/** 불러오기 단계마다 보일 것을 고른다 — 내 정보 → 학원 → 동의 기록 순서 */
function renderBody(
  meState: ReturnType<typeof useApiResource<StaffMe>>['state'],
  academy: { academyId: string; name: string } | null,
  consentsState: ReturnType<typeof useApiResource<AcademyConsents>>['state'],
  reloadMe: () => void,
  reloadConsents: () => void,
) {
  if (meState.status === 'loading') {
    return <LoadingView label="내 학원을 확인하고 있어요" />;
  }
  if (meState.status === 'error') {
    return <ErrorView error={meState.error} onRetry={reloadMe} />;
  }
  if (academy === null) {
    return <EmptyView title="대표로 있는 학원이 없어요" hint="입점 승인이 끝나면 동의 기록이 여기 보여요." />;
  }
  if (consentsState.status === 'loading') {
    return <LoadingView label="동의 기록을 불러오고 있어요" />;
  }
  if (consentsState.status === 'error') {
    return <ErrorView error={consentsState.error} onRetry={reloadConsents} />;
  }
  return <ConsentsView academyId={academy.academyId} data={consentsState.data} />;
}

interface ConsentsViewProps {
  academyId: string;
  data: AcademyConsents;
}

function ConsentsView({ academyId, data }: ConsentsViewProps) {
  // 읽음 처리 결과로 바뀐 통지 줄. 서버 응답으로 덮어써서 보여 준다(원래 목록은 고치지 않는다)
  const [readOverrides, setReadOverrides] = useState<Readonly<Record<string, TermsNotice>>>({});
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const notices = data.pendingChanges.map((notice) => readOverrides[notice.noticeId] ?? notice);
  const termsItems = data.items.filter((item) => TERMS_GROUP.has(item.item));
  const disclosureItems = data.items.filter((item) => !TERMS_GROUP.has(item.item));
  const now = new Date();

  /** 「읽었어요」 — 누른 그 순간 서버에 읽음을 보낸다. 실패하면 줄은 그대로 두고 이유를 보인다 */
  async function handleRead(noticeId: string) {
    setSendingId(noticeId);
    setReadError(null);
    try {
      const updated = await markTermsNoticeRead(academyId, noticeId);
      setReadOverrides((prev) => ({ ...prev, [noticeId]: updated }));
    } catch (error: unknown) {
      const apiError: ApiError = toApiError(error);
      setReadError(apiError.detail);
    } finally {
      setSendingId(null);
    }
  }

  return (
    <View style={styles.stack}>
      {notices.length > 0 && (
        <NoticeBox title="바뀌는 약관이 있어요">
          <View style={styles.stack}>
            {notices.map((notice) => (
              <NoticeRow
                key={notice.noticeId}
                notice={notice}
                now={now}
                sending={sendingId === notice.noticeId}
                onRead={() => void handleRead(notice.noticeId)}
              />
            ))}
            <Text style={styles.noticeRule}>{NOTICE_RULE_TEXT}</Text>
            <InlineError message={readError} />
          </View>
        </NoticeBox>
      )}

      <SectionTitle>내가 동의한 약관</SectionTitle>
      <Text style={styles.muted}>동의한 판본과 동의한 시각이 함께 남아 있어요.</Text>
      <ConsentList items={termsItems} suffix="동의" />

      <SectionTitle>입점 때 알려 드린 항목</SectionTitle>
      <Text style={styles.muted}>항목마다 동의한 시각을 따로 남겨요.</Text>
      <ConsentList items={disclosureItems} suffix="확인" />

      {notices.length === 0 && (
        <View style={styles.ruleBox}>
          <Text style={styles.ruleText}>{NOTICE_RULE_TEXT}</Text>
        </View>
      )}
    </View>
  );
}

interface NoticeRowProps {
  notice: TermsNotice;
  now: Date;
  sending: boolean;
  onRead: () => void;
}

/** 통지 한 줄 — 무엇이 언제부터 바뀌는지 + 읽음 버튼(읽었으면 읽은 시각) */
function NoticeRow({ notice, now, sending, onRead }: NoticeRowProps) {
  const left = daysUntil(notice.effectiveAt, now);
  return (
    <View style={styles.noticeRow} accessible={false}>
      <Text style={styles.noticeItem}>
        {termsLabel(notice.item)} {notice.version}
      </Text>
      <Text style={styles.noticeBody}>
        {formatKstDateTime(notice.effectiveAt)}부터 적용돼요{left === null ? '' : ` (D-${left})`}
      </Text>
      <Text style={styles.muted}>알린 날 {formatKstDateTime(notice.notifiedAt)}</Text>
      {notice.readAt === null ? (
        <Pressable
          style={[styles.readButton, sending && styles.readButtonBusy]}
          onPress={onRead}
          disabled={sending}
          accessibilityRole="button"
          accessibilityLabel={`${termsLabel(notice.item)} 변경 안내 읽음`}
          accessibilityState={{ disabled: sending, busy: sending }}
        >
          <Text style={styles.readButtonText}>{sending ? '보내는 중…' : '읽었어요'}</Text>
        </Pressable>
      ) : (
        <Text style={styles.readDone} accessibilityLiveRegion="polite">
          읽음 · {formatKstDateTime(notice.readAt)}
        </Text>
      )}
    </View>
  );
}

/** 동의 기록 목록 — 줄마다 항목 이름·판본, 아래에 동의(확인) 시각 */
function ConsentList({ items, suffix }: { items: readonly ConsentItem[]; suffix: string }) {
  if (items.length === 0) {
    return <Text style={styles.muted}>남은 기록이 없어요.</Text>;
  }
  return (
    <Card>
      {items.map((item, index) => (
        <View key={item.item} style={[styles.consentRow, index > 0 && styles.consentDivider]} accessible>
          <Text style={styles.consentTitle}>
            {termsLabel(item.item)} {item.version}
          </Text>
          <Text style={styles.muted}>
            {formatKstDateTime(item.agreedAt)} {suffix}
          </Text>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  back: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, justifyContent: 'center' },
  backText: { fontSize: font.h1, color: colors.ink },
  headerTitle: { flex: 1, fontSize: font.h2, fontWeight: '700', color: colors.ink },
  body: { padding: space.lg, paddingBottom: space.xl * 2 },
  stack: { gap: space.md },
  muted: { color: colors.ink3, fontSize: font.small },
  noticeRow: {
    gap: space.xs,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  noticeItem: { color: colors.ink, fontSize: font.body, fontWeight: '700' },
  noticeBody: { color: colors.ink, fontSize: font.body },
  noticeRule: { color: colors.ink, fontSize: font.small, lineHeight: 19 },
  readButton: {
    marginTop: space.sm,
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    backgroundColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
  },
  readButtonBusy: { backgroundColor: colors.disabled },
  readButtonText: { color: colors.surface, fontSize: font.body, fontWeight: '700' },
  readDone: { marginTop: space.sm, color: colors.ok, fontSize: font.small, fontWeight: '700' },
  consentRow: { paddingVertical: space.md, gap: space.xs },
  consentDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  consentTitle: { color: colors.ink, fontSize: font.body, fontWeight: '700' },
  ruleBox: {
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  ruleText: { color: colors.ink, fontSize: font.small, lineHeight: 19 },
});
