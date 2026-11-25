/**
 * 강사·대표 앱 로그인(보드 M1B 강사 · M1C 대표) — S2-1.7(앱 강사 가입·소속·프로필 화면). 주소 `/staff-login`.
 *
 * 회원 앱 로그인(`/login`)과 다른 입구다. 강사·대표는 같은 직원 계정 하나를 아이디·비밀번호로 쓴다(README §6-1).
 *  1. 위 두 탭으로 「Instructor 강사 / Owner 대표」 중 하나를 고른다. 처음 열면 강사가 골라져 있다
 *     (주소에 `?role=owner` 가 있으면 대표 탭으로 연다 — 대표 앱 안내 링크용)
 *  2. 「로그인」 → Better Auth 아이디 로그인 → `GET /api/staff/me` 로 고른 역할이 있는지 본다
 *  3. 역할이 없으면 바로 로그아웃시키고 「이 계정에는 강사 권한이 없어요」를 보인다(계약 11 §1)
 *  4. 있으면 강사는 학원 탭(I12), 대표는 대표 홈(O6)으로 간다
 *
 * 위쪽 배경 띠(FR-011a 「강사·대표 앱 첫 화면」): 고른 역할마다 그림이 바뀐다 — 강사는 페이 40대 귀족 그림,
 * 대표는 재즈 클럽 그림. 상태줄 아래부터 역할 버튼 바로 위까지 양옆을 꽉 채우고, 그림 위에는 그늘을 덮지 않는다.
 *
 * 서버 호출은 「로그인」 버튼 핸들러 안에서만 한다(효과 훅 없음).
 * 아이디·비밀번호 찾기(I31B)는 S2-1.10 이 강사 탭에 붙였다. 대표 가입·입점 신청은 관리자 웹(W2a) 흐름이라 「준비 중」.
 */
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  Image,
  type ImageSourcePropType,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ROLE_HOME, signInAs, type StaffRole } from '../lib/instructor/staff-api';
import { staffStyles, useAction } from '../lib/instructor/staff-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../lib/theme';

/** 탭마다 바뀌는 글자 — 보드 M1B·M1C 의 아래쪽 가입 버튼과 안내 한 줄 */
const ROLE_COPY: Readonly<Record<StaffRole, { english: string; korean: string; signup: string; note: string }>> = {
  instructor: {
    english: 'Instructor',
    korean: '강사',
    signup: '강사 회원가입',
    note: '누구나 가입 · 1년 무료 체험은 본인확인 1인 1회',
  },
  owner: {
    english: 'Owner',
    korean: '대표',
    signup: '대표 회원가입 · 입점 신청',
    note: '입점 신청을 운영자가 승인하면 계정이 열려요 · 로그인 때 휴대폰 인증',
  },
};

const ROLES: readonly StaffRole[] = ['instructor', 'owner'];

/**
 * 역할별 배경 띠 그림(원본 `docs/prototype/assets/login/*-login-bg-band.jpg`, 1170×1194 를 그대로 복사).
 * 원본이 이미 띠 비율(390×398)에 맞춰 잘려 있어 `cover` 로 깔면 강사는 머리부터 무릎 아래까지,
 * 대표는 두 인물의 얼굴이 보인다.
 */
const ROLE_BAND: Readonly<Record<StaffRole, ImageSourcePropType>> = {
  instructor: require('../assets/login/instructor-login-bg-band.jpg'),
  owner: require('../assets/login/owner-login-bg-band.jpg'),
};

/** 보드 M1B·M1C 의 띠 크기(폭 390 에 높이 398). 화면 폭이 달라도 이 비율을 지킨다 */
const BAND_ASPECT = 398 / 390;

/**
 * 띠 아래 끝을 바탕색으로 녹이는 겹친 띠들(아래로 갈수록 진하게). 새 패키지(그라데이션) 없이
 * 얇은 View 몇 겹으로 흉내 낸다. 그림 위쪽에는 아무것도 덮지 않는다(캐릭터가 잘 보이게).
 */
const BAND_FADE_STEP_COUNT = 16;
const BAND_FADE_STEP_HEIGHT = 2;
/** 겹마다의 진하기 — 0 에서 1 까지 부드럽게(제곱 곡선) 올라가 줄무늬가 덜 보이게 한다 */
const BAND_FADE_STEPS: readonly number[] = Array.from({ length: BAND_FADE_STEP_COUNT }, (_, index) => ((index + 1) / BAND_FADE_STEP_COUNT) ** 2);

export default function StaffLoginScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ role?: string }>();
  // 처음 한 번만 주소에서 고른다. 그 뒤로는 탭을 누른 값이 이긴다
  const [role, setRole] = useState<StaffRole>(() => (params.role === 'owner' ? 'owner' : 'instructor'));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run, setError } = useAction();

  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy;
  const copy = ROLE_COPY[role];

  const handleLogin = async () => {
    if (!canSubmit) return;
    const me = await run(() => signInAs(role, username.trim(), password));
    // 성공하면 로그인 화면을 기록에서 지우고 역할 첫 화면으로 바꿔 끼운다(뒤로 가기로 로그인에 돌아오지 않게)
    if (me !== null) router.replace(ROLE_HOME[role]);
  };

  const pickRole = (next: StaffRole) => {
    setRole(next);
    setError(null);
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.body, { paddingTop: insets.top, paddingBottom: insets.bottom + space.xl }]}
          keyboardShouldPersistTaps="handled"
        >
          {/* 위쪽 배경 띠 — 상태줄 바로 아래부터 역할 버튼 위까지. 큰 제목·안내 알약은 두지 않는다(2026-10-09 결정) */}
          <View
            style={[styles.band, { height: width * BAND_ASPECT }]}
            accessible
            accessibilityRole="header"
            accessibilityLabel={`K-DanceX4 강사·대표 앱, ${copy.korean} 로그인`}
          >
            <Image source={ROLE_BAND[role]} style={styles.bandImage} resizeMode="cover" />
            {/* 띠 끝만 바탕색으로 짧게 녹인다 — 맨 아래 겹이 가장 진하다 */}
            <View style={styles.bandFade} pointerEvents="none">
              {BAND_FADE_STEPS.map((opacity, index) => (
                <View key={index} style={[styles.bandFadeStep, { opacity }]} />
              ))}
            </View>
          </View>

          {/* 역할 두 탭 — 반반 버튼(보드 M1B·M1C) */}
          <View style={styles.roleTabs} accessibilityRole="tablist">
            {ROLES.map((value) => {
              const selected = value === role;
              return (
                <Pressable
                  key={value}
                  style={[styles.roleTab, selected && styles.roleTabSelected]}
                  onPress={() => pickRole(value)}
                  accessibilityRole="tab"
                  accessibilityLabel={`${ROLE_COPY[value].english} ${ROLE_COPY[value].korean}`}
                  accessibilityState={{ selected }}
                >
                  <Text style={[styles.roleEnglish, selected && styles.roleTextSelected]}>{ROLE_COPY[value].english}</Text>
                  <Text style={[styles.roleKorean, selected && styles.roleTextSelected]}>{ROLE_COPY[value].korean}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.form}>
            <Text style={styles.label}>아이디</Text>
            <TextInput
              style={styles.input}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="username"
              textContentType="username"
              placeholder="영문 소문자·숫자"
              placeholderTextColor={colors.ink3}
              accessibilityLabel="아이디"
            />
            <Text style={styles.label}>비밀번호</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="password"
              textContentType="password"
              onSubmitEditing={handleLogin}
              placeholderTextColor={colors.ink3}
              accessibilityLabel="비밀번호"
            />
            {error !== null && (
              <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">
                {error}
              </Text>
            )}
            <Pressable
              style={[styles.primary, !canSubmit && styles.primaryDisabled]}
              onPress={handleLogin}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityLabel="로그인"
              accessibilityState={{ disabled: !canSubmit, busy }}
            >
              <Text style={[styles.primaryText, !canSubmit && styles.primaryTextDisabled]}>{busy ? '확인하고 있어요…' : '로그인'}</Text>
            </Pressable>

            {/* 아이디·비밀번호 찾기(I31B, S2-1.10) — 강사 계정만. 대표 계정 찾기는 관리자 웹 흐름이라 대표 탭에서는 준비 중 */}
            {role === 'instructor' ? (
              <Pressable
                style={styles.findRow}
                onPress={() => router.push('/instructor/account-recovery')}
                accessibilityRole="button"
                accessibilityLabel="아이디 찾기, 비밀번호 찾기"
              >
                <Text style={styles.findTextOn}>아이디 찾기</Text>
                <Text style={styles.findBar}>|</Text>
                <Text style={styles.findTextOn}>비밀번호 찾기</Text>
              </Pressable>
            ) : (
              <View style={styles.findRow} accessible accessibilityLabel="아이디 찾기, 비밀번호 찾기, 준비 중">
                <Text style={styles.findText}>아이디 찾기</Text>
                <Text style={styles.findBar}>|</Text>
                <Text style={styles.findText}>비밀번호 찾기</Text>
                <Text style={staffStyles.pendingBadge}>준비 중</Text>
              </View>
            )}
          </View>

          <View style={styles.bottom}>
            {role === 'instructor' ? (
              <Pressable
                style={styles.secondary}
                onPress={() => router.push('/instructor/signup/identity')}
                accessibilityRole="button"
                accessibilityLabel={copy.signup}
              >
                <Text style={styles.secondaryText}>{copy.signup}</Text>
              </Pressable>
            ) : (
              // 대표 가입·입점 신청은 관리자 웹 흐름(W2a)이다. 앱 화면은 아직 없다
              <View style={[styles.secondary, styles.secondaryDisabled]} accessible accessibilityLabel={`${copy.signup}, 준비 중`}>
                <Text style={styles.secondaryTextDisabled}>{copy.signup}</Text>
                <Text style={staffStyles.pendingBadge}>준비 중</Text>
              </View>
            )}
            <Text style={styles.note}>{copy.note}</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  body: { flexGrow: 1, paddingHorizontal: space.xl, gap: space.lg },
  // 띠는 본문 좌우 여백을 넘어 화면 양옆까지 꽉 채운다
  band: { marginHorizontal: -space.xl, overflow: 'hidden', backgroundColor: colors.bg },
  bandImage: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
  bandFade: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  bandFadeStep: { height: BAND_FADE_STEP_HEIGHT, backgroundColor: colors.bg },
  roleTabs: {
    flexDirection: 'row',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    padding: 4,
    gap: 4,
  },
  roleTab: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 64, borderRadius: radius.sm },
  roleTabSelected: { backgroundColor: colors.brown },
  roleEnglish: { fontSize: font.body, fontWeight: '700', color: colors.ink3 },
  roleKorean: { fontSize: font.small, color: colors.ink3 },
  roleTextSelected: { color: colors.surface },
  form: { gap: space.sm },
  label: { fontSize: font.body, fontWeight: '700', color: colors.ink, marginTop: space.sm },
  input: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    paddingHorizontal: space.md,
    fontSize: 16,
    color: colors.ink,
  },
  error: { color: colors.danger, fontSize: font.body, lineHeight: 20, marginTop: space.xs },
  primary: {
    marginTop: space.md,
    minHeight: 52,
    borderRadius: radius.md,
    backgroundColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryDisabled: { backgroundColor: colors.disabled },
  primaryText: { color: colors.surface, fontSize: 16, fontWeight: '700' },
  primaryTextDisabled: { color: colors.disabledInk },
  findRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: space.sm, marginTop: space.sm, minHeight: MIN_TOUCH },
  findText: { color: colors.disabledInk, fontSize: font.small },
  findTextOn: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  findBar: { color: colors.line },
  bottom: { marginTop: 'auto', gap: space.sm },
  secondary: {
    minHeight: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.brown,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: space.sm,
  },
  secondaryDisabled: { borderColor: colors.line },
  secondaryText: { color: colors.brown, fontSize: 16, fontWeight: '700' },
  secondaryTextDisabled: { color: colors.disabledInk, fontSize: 16, fontWeight: '700' },
  note: { color: colors.ink3, fontSize: font.small, textAlign: 'center' },
});
