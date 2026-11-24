/**
 * 대표 앱 화면 틀 — 위 제목 줄(뒤로 가기) + 스크롤 본문. S1-2.16(대표 앱 강사 소속·위임 화면)이 쓴다.
 *
 * 약관 화면(app/owner/terms.tsx)에 같은 모양의 틀이 안에 들어 있다. 그 화면은 이 Task 범위 밖이라
 * 그대로 두고, 강사 관리(O37)·강사 권한(O38) 두 화면이 이 파일을 같이 쓴다.
 * 회원 화면 틀(DetailScreen)은 회원 하단 탭을 붙이므로 쓰지 않는다. 대표 앱 하단 탭은 대표 앱 틀을 정하는 Task 몫이다.
 */
import type { ReactNode } from 'react';
import { router, Stack } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, font, MIN_TOUCH, space } from '../theme';

interface OwnerScreenProps {
  title: string;
  /** 제목 아래 흐린 안내 한 줄(보드 O37 「웹 강사 관리와 같은 규칙이에요」 같은 것) */
  subtitle?: string;
  /** 제목 줄 오른쪽 자리(알림 O21 의 「모두 읽음」 같은 것). 없으면 비운다 */
  headerRight?: ReactNode;
  children: ReactNode;
}

export function OwnerScreen({ title, subtitle, headerRight, children }: OwnerScreenProps) {
  const insets = useSafeAreaInsets();
  // 앞 화면이 없으면(딥링크로 바로 들어옴) 첫 화면으로 보낸다
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
        {headerRight}
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {subtitle !== undefined && <Text style={styles.subtitle}>{subtitle}</Text>}
        {children}
      </ScrollView>
    </View>
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
  body: { padding: space.lg, paddingTop: space.xs, paddingBottom: space.xl * 2, gap: space.md },
  subtitle: { color: colors.ink3, fontSize: font.small },
});
