/**
 * 회원 화면 공용 조각 — 화면 틀, 로딩·오류·빈 목록 상태, 버튼, 가격 내역, 정원 막대, 공지 상자.
 *
 * 화면 파일(app/**)은 「무엇을 불러 어떤 순서로 보여 주나」만 맡고,
 * 같은 모양이 여러 화면에 반복되는 것은 여기 둔다.
 */
import type { ReactNode } from 'react';
import { router, Stack } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ApiError } from '../api';
import { formatPriceLineAmount, orderPriceLines, seatLabel } from './format';
import { MemberTabBar, type MemberTabKey } from './tab-bar';
import { colors, font, MIN_TOUCH, radius, space } from '../theme';
import type { PriceLine, SeatPool } from './types';

// ---------------------------------------------------------------- 화면 틀

export interface DetailScreenProps {
  title: string;
  /** 들어온 영역 탭. 상세 화면에서도 하단 탭은 항상 보인다. */
  tab: MemberTabKey;
  children: ReactNode;
}

/** 탭 묶음 밖 상세 화면의 틀: 위 제목 줄(뒤로 가기) + 스크롤 본문 + 하단 탭. */
export function DetailScreen({ title, tab, children }: DetailScreenProps) {
  const insets = useSafeAreaInsets();
  const goBack = () => (router.canGoBack() ? router.back() : router.navigate('/home'));
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
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
      <MemberTabBar active={tab} />
    </View>
  );
}

// ---------------------------------------------------------------- 상태 표시

export function LoadingView({ label = '불러오는 중이에요' }: { label?: string }) {
  return (
    <View style={styles.center} accessibilityLiveRegion="polite">
      <ActivityIndicator color={colors.brown} />
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

export function EmptyView({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={styles.center}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {hint !== undefined && <Text style={styles.muted}>{hint}</Text>}
    </View>
  );
}

/**
 * 오류 코드별로 사용자가 할 수 있는 다음 행동. 로그인·가입·기준 장르 화면은
 * T-A5-2(가입·취향 화면 5종)가 만든다(`/login`·`/signup`·`/base-genre`).
 */
const ERROR_ACTIONS: Readonly<Record<string, { label: string; href: '/login' | '/signup' | '/base-genre' }>> = {
  UNAUTHENTICATED: { label: '로그인하기', href: '/login' },
  SIGNUP_INCOMPLETE: { label: '가입 마저 하기', href: '/signup' },
  BASE_GENRE_REQUIRED: { label: '기준 장르 고르기', href: '/base-genre' },
};

export interface ErrorViewProps {
  error: ApiError;
  onRetry?: () => void;
}

/** 서버 `detail` 문장을 그대로 보여 주고, `code` 로 다음 행동 버튼을 고른다(§4.8(오류 응답 형식)). */
export function ErrorView({ error, onRetry }: ErrorViewProps) {
  const action = ERROR_ACTIONS[error.code];
  return (
    <View style={styles.center} accessibilityLiveRegion="polite">
      <Text style={styles.errorText}>{error.detail}</Text>
      {action !== undefined && <PrimaryButton label={action.label} onPress={() => router.push(action.href)} />}
      {action === undefined && onRetry !== undefined && <SecondaryButton label="다시 시도" onPress={onRetry} />}
    </View>
  );
}

/** 오류 문장 한 줄(폼 아래 등). */
export function InlineError({ message }: { message: string | null }) {
  if (message === null) {
    return null;
  }
  return (
    <Text style={styles.errorText} accessibilityLiveRegion="polite">
      {message}
    </Text>
  );
}

// ---------------------------------------------------------------- 버튼

export interface ButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** 화면 낭독기용. 버튼 글자만으로 뜻이 부족할 때. */
  hint?: string;
}

export function PrimaryButton({ label, onPress, disabled = false, hint }: ButtonProps) {
  return (
    <Pressable
      style={[styles.primary, disabled && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityHint={hint}
    >
      <Text style={[styles.primaryText, disabled && styles.buttonDisabledText]}>{label}</Text>
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress, disabled = false, hint }: ButtonProps) {
  return (
    <Pressable
      style={[styles.secondary, disabled && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityHint={hint}
    >
      <Text style={[styles.secondaryText, disabled && styles.buttonDisabledText]}>{label}</Text>
    </Pressable>
  );
}

export interface CheckRowProps {
  checked: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}

/** 체크박스 라이브러리 없이 만든 확인 줄 — 새 의존성을 늘리지 않는다. */
export function CheckRow({ checked, disabled, label, onToggle }: CheckRowProps) {
  return (
    <Pressable
      style={styles.checkRow}
      onPress={onToggle}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
    >
      <View style={[styles.checkbox, checked && styles.checkboxOn]}>
        {checked && <Text style={styles.checkMark}>✓</Text>}
      </View>
      <Text style={[styles.checkLabel, disabled && styles.buttonDisabledText]}>{label}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------- 카드·공지

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.sectionTitle} accessibilityRole="header">
      {children}
    </Text>
  );
}

/** 공지 상자 — 갈색 왼쪽 막대(확정 디자인). 환불 공지·중개자 고지·가상계좌 안내에 쓴다. */
export function NoticeBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.notice}>
      <Text style={styles.noticeTitle}>{title}</Text>
      {typeof children === 'string' ? <Text style={styles.noticeBody}>{children}</Text> : children}
    </View>
  );
}

// ---------------------------------------------------------------- 가격 내역

/**
 * 가격 내역 — 정가 → 혜택 할인 → 쿠폰 → (예매 수수료) → 최종 결제액 순서(FR-117(체크아웃 가격 내역)·
 * FR-283(결제액 계산 순서)). 할인 줄은 0 원이어도 보인다.
 */
export function PriceBreakdown({ lines }: { lines: readonly PriceLine[] | null | undefined }) {
  const ordered = orderPriceLines(lines);
  if (ordered.length === 0) {
    return <Text style={styles.muted}>가격 내역을 받지 못했어요.</Text>;
  }
  return (
    <View style={styles.priceList}>
      {ordered.map((line) => {
        const isFinal = line.kind === 'final';
        return (
          <View key={line.kind} style={[styles.priceRow, isFinal && styles.priceFinalRow]} accessible>
            <Text style={isFinal ? styles.priceFinalLabel : styles.priceLabel}>{line.label}</Text>
            <Text style={isFinal ? styles.priceFinalAmount : styles.priceAmount}>{formatPriceLineAmount(line)}</Text>
          </View>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------- 정원

/** 자리별 남은 수 — 「남 2/6 · 여 마감」. 마감은 색만이 아니라 글자로도 알린다. */
export function PoolSummary({ pools }: { pools: readonly SeatPool[] }) {
  const text = pools
    .map((pool) => {
      const name = pool.seatKind === 'any' ? '잔여' : seatLabel(pool.seatKind);
      return pool.remaining <= 0 ? `${name} 마감` : `${name} ${pool.remaining}/${pool.capacity} 남음`;
    })
    .join(' · ');
  return <Text style={styles.muted}>{text}</Text>;
}

/** 신청 인원 막대(FR-090(정원·신청 인원 표시)). */
export function CapacityBar({ enrolled, total }: { enrolled: number; total: number }) {
  const ratio = total > 0 ? Math.min(enrolled / total, 1) : 0;
  return (
    <View
      style={styles.barTrack}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`정원 ${total}명 중 ${enrolled}명 신청`}
    >
      <View style={[styles.barFill, { flex: ratio }]} />
      <View style={{ flex: 1 - ratio }} />
    </View>
  );
}

export function isSoldOut(pools: readonly SeatPool[]): boolean {
  return pools.length > 0 && pools.every((pool) => pool.remaining <= 0);
}

export const shared = StyleSheet.create({
  muted: { fontSize: font.small, color: colors.ink3 },
  body: { fontSize: font.body, color: colors.ink, lineHeight: 20 },
  title: { fontSize: font.h2, fontWeight: '700', color: colors.ink },
  tag: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    fontSize: font.tiny,
    fontWeight: '700',
    overflow: 'hidden',
  },
  tagClosed: { backgroundColor: colors.night, color: colors.surface },
  tagOk: { backgroundColor: colors.okSoft, color: colors.ok },
  tagWarn: { backgroundColor: colors.brownSoft, color: colors.brown },
  tagDanger: { backgroundColor: colors.dangerSoft, color: colors.danger },
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.sm,
    paddingBottom: space.sm,
    backgroundColor: colors.bg,
  },
  back: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  backText: { fontSize: 30, color: colors.ink, lineHeight: 32 },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: colors.ink },
  body: { padding: space.lg, gap: space.md, paddingBottom: space.xl },
  center: { alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  muted: { fontSize: font.small, color: colors.ink3, textAlign: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.ink },
  errorText: { fontSize: font.body, color: colors.danger, textAlign: 'center' },
  primary: {
    minHeight: MIN_TOUCH + 4,
    borderRadius: radius.md,
    backgroundColor: colors.flame,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    alignSelf: 'stretch',
  },
  primaryText: { color: colors.surface, fontSize: 16, fontWeight: '700' },
  secondary: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    alignSelf: 'stretch',
  },
  secondaryText: { color: colors.ink, fontSize: font.body, fontWeight: '600' },
  buttonDisabled: { backgroundColor: colors.disabled, borderColor: colors.disabled },
  buttonDisabledText: { color: colors.disabledInk },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: MIN_TOUCH },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.ink3,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  checkboxOn: { backgroundColor: colors.brown, borderColor: colors.brown },
  checkMark: { color: colors.surface, fontSize: 14, fontWeight: '800' },
  checkLabel: { flex: 1, fontSize: font.body, color: colors.ink },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: colors.ink },
  notice: {
    backgroundColor: colors.surface,
    borderLeftWidth: 4,
    borderLeftColor: colors.brown,
    borderRadius: radius.sm,
    padding: space.md,
    gap: space.xs,
  },
  noticeTitle: { fontSize: font.small, fontWeight: '700', color: colors.brown },
  noticeBody: { fontSize: font.small, color: colors.ink, lineHeight: 19 },
  priceList: { gap: space.sm },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between' },
  priceFinalRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingTop: space.sm },
  priceLabel: { fontSize: font.body, color: colors.ink3 },
  priceAmount: { fontSize: font.body, color: colors.ink },
  priceFinalLabel: { fontSize: 16, fontWeight: '700', color: colors.ink },
  priceFinalAmount: { fontSize: 22, fontWeight: '800', color: colors.ink },
  barTrack: { flexDirection: 'row', height: 6, borderRadius: 3, backgroundColor: colors.line, overflow: 'hidden' },
  barFill: { backgroundColor: colors.night },
});
