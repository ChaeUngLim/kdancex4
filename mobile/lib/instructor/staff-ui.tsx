/**
 * 강사 앱 화면 틀과 작은 부품 — S2-1.7(앱 강사 가입·소속·프로필 화면).
 *
 *  - `InstructorShell`: 제목 줄 + 스크롤 본문 + 강사 하단 5탭(홈·캘린더·수업·학원·마이, 보드 I9·I12).
 *    탭 아래 화면(I27·I27B·I9E, S2-1.10)은 `onBack` 을 넘겨 제목 왼쪽에 뒤로 가기를 단다
 *  - `MenuGroup`·`MenuRow`: 마이(I9)의 흰 카드 안 줄 목록. 아직 화면이 없는 줄은 「준비 중」으로 눌리지 않게 둔다
 *  - `StaffErrorView`: 오류 문장 + 다음 행동. 로그인이 풀렸으면(401) 강사·대표 로그인으로 보낸다
 *    (회원 화면의 ErrorView 는 회원 로그인으로 보내므로 쓰지 않는다)
 *  - `useAction`: 버튼 한 번 누르는 동안의 「진행 중·오류 문구」. 효과 훅 없이 핸들러 안에서만 돈다
 *
 * 색·크기는 `lib/theme.ts` 만 쓴다. 보드는 딥 플럼이지만 theme.ts 의 강조색 교체는 별도 작업이라
 * (S1-2.16 과 같은 판단) 여기서 토큰을 바꾸지 않는다.
 */
import { router, Stack, type Href } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError } from '../api';
import { toApiError } from '../catalog/use-api-resource';
import { colors, font, MIN_TOUCH, radius, space } from '../theme';

// ---- 하단 탭 -----------------------------------------------------------------------------

export type InstructorTabKey = 'home' | 'calendar' | 'classes' | 'academy' | 'my';

/** 보드 I9·I12 의 탭 순서. href 가 null 이면 그 화면을 만드는 Task(I1·I5·I19 등) 전이라 눌리지 않는다 */
const TABS: readonly { key: InstructorTabKey; label: string; href: Href | null }[] = [
  // 강사 홈(I1)은 S2-4.6 이 만들었다
  { key: 'home', label: '홈', href: '/instructor' },
  { key: 'calendar', label: '캘린더', href: null },
  // 수업 탭 목록(I19)이 생기기 전까지는 수업 만들기(I2, S2-2.9)로 바로 연다
  { key: 'classes', label: '수업', href: '/instructor/classes/new' },
  { key: 'academy', label: '학원', href: '/instructor/academy' },
  { key: 'my', label: '마이', href: '/instructor/my' },
];

function InstructorTabBar({ active }: { active: InstructorTabKey }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space.sm) }]} accessibilityRole="tablist">
      {TABS.map((tab) => {
        const selected = tab.key === active;
        const disabled = tab.href === null;
        return (
          <Pressable
            key={tab.key}
            style={styles.tab}
            disabled={disabled}
            onPress={() => {
              // 지금 탭을 다시 누르면 아무것도 하지 않는다. 탭끼리는 쌓지 않고 바꿔 끼운다
              if (tab.href !== null && !selected) router.replace(tab.href);
            }}
            accessibilityRole="tab"
            accessibilityLabel={disabled ? `${tab.label}, 준비 중` : tab.label}
            accessibilityState={{ selected, disabled }}
            // 웹(react-native-web)은 accessibilityState 를 aria-selected 로 옮기지 않아 직접 준다(대표 알림함 칩과 같은 방법)
            aria-selected={selected}
          >
            <View style={[styles.dot, selected && styles.dotActive, disabled && styles.dotDisabled]} />
            <Text style={[styles.tabLabel, selected && styles.tabLabelActive, disabled && styles.tabLabelDisabled]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---- 화면 틀 -----------------------------------------------------------------------------

interface ShellProps {
  title: string;
  /** 제목 위에 붙는 줄(학원 탭의 「학원 표시 · 학원 이름 · 이준호 강사」 머리) */
  top?: ReactNode;
  subtitle?: string;
  active: InstructorTabKey;
  /** 탭 아래 화면(I27·I27B·I9E)이면 제목 왼쪽에 「‹」 뒤로 가기를 둔다. 누르면 할 일 */
  onBack?: () => void;
  children: ReactNode;
}

export function InstructorShell({ title, top, subtitle, active, onBack, children }: ShellProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView contentContainerStyle={[styles.body, { paddingTop: insets.top + space.md }]}>
        {top}
        <View style={styles.titleRow}>
          {onBack !== undefined && (
            <Pressable style={styles.back} onPress={onBack} accessibilityRole="button" accessibilityLabel="뒤로 가기" hitSlop={6}>
              <Text style={styles.backText}>‹</Text>
            </Pressable>
          )}
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
        </View>
        {subtitle !== undefined && <Text style={styles.subtitle}>{subtitle}</Text>}
        {children}
      </ScrollView>
      <InstructorTabBar active={active} />
    </View>
  );
}

/**
 * 뒤로 가기 — 쌓인 화면이 있으면 꺼내고, 주소로 바로 들어와 쌓인 게 없으면 정해 둔 화면으로 바꿔 끼운다.
 * (알림을 눌러 I27B 로 바로 들어온 경우처럼 앞 화면이 없을 때 막히지 않게)
 */
export function goBack(fallback: Href): void {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}

// ---- 줄 목록(마이) -------------------------------------------------------------------------

export function MenuGroup({ children }: { children: ReactNode }) {
  return <View style={styles.group}>{children}</View>;
}

interface MenuRowProps {
  title: string;
  detail?: string;
  /** 누르면 할 일. 없으면 화살표 없이 정보만 보이는 줄(보드 I9 「활동 장르」) */
  onPress?: () => void;
  /** 이 줄의 화면을 만드는 Task 전이면 true — 「준비 중」 배지를 달고 눌리지 않는다 */
  pending?: boolean;
  divided?: boolean;
}

export function MenuRow({ title, detail, onPress, pending = false, divided = false }: MenuRowProps) {
  const pressable = onPress !== undefined && !pending;
  const content = (
    <>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {detail !== undefined && <Text style={styles.rowDetail}>{detail}</Text>}
      </View>
      {pending && <Text style={staffStyles.pendingBadge}>준비 중</Text>}
      {pressable && <Text style={styles.chevron}>›</Text>}
    </>
  );
  if (onPress === undefined && !pending) {
    return <View style={[styles.row, divided && styles.divider]}>{content}</View>;
  }
  return (
    <Pressable
      style={[styles.row, divided && styles.divider]}
      onPress={onPress}
      disabled={!pressable}
      accessibilityRole="button"
      accessibilityLabel={pending ? `${title}, 준비 중` : title}
      accessibilityState={{ disabled: !pressable }}
    >
      {content}
    </Pressable>
  );
}

// ---- 오류 ---------------------------------------------------------------------------------

/** 로그인이 풀렸으면(401) 강사·대표 로그인으로, 아니면 다시 시도 */
export function StaffErrorView({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const signedOut = error.code === 'UNAUTHENTICATED' || error.status === 401;
  return (
    <View style={styles.errorBox} accessibilityLiveRegion="polite">
      <Text style={styles.errorText}>{signedOut ? '로그인이 풀렸어요. 다시 로그인해 주세요.' : error.detail}</Text>
      <Pressable
        style={styles.errorButton}
        onPress={signedOut ? () => router.replace('/staff-login') : onRetry}
        accessibilityRole="button"
      >
        <Text style={styles.errorButtonText}>{signedOut ? '로그인하러 가기' : '다시 시도'}</Text>
      </Pressable>
    </View>
  );
}

// ---- 버튼 한 번의 진행 상태 -------------------------------------------------------------------

export interface ActionState {
  busy: boolean;
  error: string | null;
  /** 작업을 돌린다. 실패하면 문구를 채우고 null, 성공하면 결과 */
  run: <T>(task: () => Promise<T>) => Promise<T | null>;
  setError: (message: string | null) => void;
}

/**
 * 누르는 순간 시작해서 끝나면 상태를 되돌린다. 화면을 여는 시점의 자동 실행(효과 훅)은 없다 —
 * 언제 서버를 부르는지가 버튼 핸들러에 그대로 보이게 하려는 것이다.
 */
export function useAction(): ActionState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(task: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await task();
    } catch (caught: unknown) {
      const apiError = toApiError(caught);
      // 칸별 사유가 있으면(422 VALIDATION_FAILED) 그것을 줄바꿈으로 보인다
      setError(apiError.fields.length > 0 ? apiError.fields.map((f) => f.message).join('\n') : apiError.detail);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export const staffStyles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.lg,
    gap: space.sm,
  },
  muted: { color: colors.ink3, fontSize: font.small, lineHeight: 18 },
  sectionTitle: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.brownSoft,
    color: colors.brown,
    fontSize: font.tiny,
    fontWeight: '700',
    overflow: 'hidden',
  },
  pendingBadge: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.disabled,
    color: colors.disabledInk,
    fontSize: font.tiny,
    fontWeight: '700',
    overflow: 'hidden',
  },
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { paddingHorizontal: space.lg, paddingBottom: space.xl * 2, gap: space.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  back: {
    width: MIN_TOUCH - 8,
    height: MIN_TOUCH - 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: { fontSize: font.h2, color: colors.ink, lineHeight: 24 },
  title: { fontSize: font.h1 - 4, fontWeight: '800', color: colors.ink, flexShrink: 1 },
  subtitle: { color: colors.ink3, fontSize: font.small, marginTop: -space.sm },
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    paddingTop: space.sm,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: MIN_TOUCH, gap: 4 },
  dot: { width: 18, height: 18, borderRadius: 6, backgroundColor: colors.line },
  dotActive: { backgroundColor: colors.brown },
  dotDisabled: { backgroundColor: colors.disabled },
  tabLabel: { fontSize: font.tiny, color: colors.ink3 },
  tabLabelActive: { color: colors.ink, fontWeight: '700' },
  tabLabelDisabled: { color: colors.disabledInk },
  group: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.lg,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: MIN_TOUCH + 8, paddingVertical: space.md },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  rowDetail: { color: colors.ink3, fontSize: font.small },
  chevron: { color: colors.ink3, fontSize: font.h2 },
  errorBox: { padding: space.lg, gap: space.md, alignItems: 'center' },
  errorText: { color: colors.danger, fontSize: font.body, textAlign: 'center', lineHeight: 20 },
  errorButton: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: space.xl,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.brown,
    justifyContent: 'center',
  },
  errorButtonText: { color: colors.brown, fontWeight: '700' },
});

