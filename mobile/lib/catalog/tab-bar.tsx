/**
 * 회원 하단 탭 — 홈 · 학원 · AI 플래너 · 캘린더 · 마이.
 *
 * 하단 탭은 상세 화면을 포함한 앱 안 모든 화면에 보여야 한다(보드 01-3·01-4 규칙).
 * 그래서 탭 묶음(`app/(tabs)/_layout.tsx`)의 탭바와 상세 화면(수업 상세·결제 대기·취소)
 * 아래쪽이 이 컴포넌트 하나를 같이 쓴다. 두 곳의 모양이 어긋나지 않게 하기 위해서다.
 *
 * 이번 회차에 있는 화면은 홈·캘린더·마이(내 예약·결제 내역 M16, S3-4.7)·AI 플래너(M10, SX-5.7)다. 학원은 자리만 두고
 * 「준비 중」으로 눌리지 않게 한다 — 탭 개수가 바뀌면 사용자가 위치를 다시 익혀야 해서다.
 * 마이 탭은 마이 첫 화면(보드 M12, `/my`)으로 간다 — S7-1.8(앱 알림 설정·권한 화면)에서 생겼다. 그 전에는 「내 예약 · 결제 내역」으로 바로 보냈다.
 */
import { router, type Href } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, font, MIN_TOUCH, space } from '../theme';

export type MemberTabKey = 'home' | 'academy' | 'planner' | 'calendar' | 'my';

interface TabDef {
  key: MemberTabKey;
  label: string;
  href: Href | null; // null = 아직 화면 없음
}

const TABS: readonly TabDef[] = [
  { key: 'home', label: '홈', href: '/home' },
  { key: 'academy', label: '학원', href: null },
  { key: 'planner', label: 'AI 플래너', href: '/planner' }, // SX-5.7(앱 말로 찾기 화면)에서 열림
  { key: 'calendar', label: '캘린더', href: '/calendar' },
  { key: 'my', label: '마이', href: '/my' },
];

export interface MemberTabBarProps {
  /** 지금 화면이 속한 영역. 상세 화면은 들어온 영역 탭을 켠다(수업 상세·결제 → 홈, 취소 → 캘린더). */
  active: MemberTabKey;
}

export function MemberTabBar({ active }: MemberTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space.sm) }]}
      accessibilityRole="tablist"
    >
      {TABS.map((tab) => (
        <TabButton key={tab.key} tab={tab} selected={tab.key === active} />
      ))}
    </View>
  );
}

interface TabButtonProps {
  tab: TabDef;
  selected: boolean;
}

function TabButton({ tab, selected }: TabButtonProps) {
  const disabled = tab.href === null;
  const onPress = () => {
    if (tab.href !== null && !selected) {
      router.navigate(tab.href);
    }
  };
  return (
    <Pressable
      style={styles.tab}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="tab"
      accessibilityLabel={disabled ? `${tab.label}, 준비 중` : tab.label}
      accessibilityState={{ selected, disabled }}
    >
      <View style={[styles.dot, selected && styles.dotActive, disabled && styles.dotDisabled]} />
      <Text style={[styles.label, selected && styles.labelActive, disabled && styles.labelDisabled]}>
        {tab.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
  label: { fontSize: font.tiny, color: colors.ink3 },
  labelActive: { color: colors.ink, fontWeight: '700' },
  labelDisabled: { color: colors.disabledInk },
});
