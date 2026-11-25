/**
 * 로그인 화면 — T-A5-2(가입·취향 화면 5종) 중 1번째.
 *
 * 계약 `01-member-onboarding.md` §1(로그인): 1회차는 시드가 만든 계정의 이메일·비밀번호로만
 * 로그인한다(plan D10(인증)). 보드 M1 의 카카오·구글·네이버 버튼은 소셜 로그인이 붙을 때 바꾼다.
 *
 * 로그인 뒤 `GET /api/me` 로 어디까지 했는지 보고 다음 화면을 고른다.
 *  - 403 `SIGNUP_INCOMPLETE` → 약관 동의(consent, 보드 C14A) → 본인확인(identity) 순서로 가입을 시작한다
 *  - 가입 끝 → 취향 / 기준 장르 / 홈 중 남은 곳(`nextOnboardingRoute`)
 */
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { type GestureResponderEvent, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../lib/api';
import { ErrorBox, Field, OnboardingScreen, onboardingStyles, PrimaryButton } from '../lib/onboarding/components';
import { nextOnboardingRoute, SIGNUP_START_ROUTE } from '../lib/onboarding/flow';
import { fetchMe, signInWithEmail } from '../lib/onboarding/members-api';
import { useRequest } from '../lib/onboarding/use-request';

const WRONG_CREDENTIALS = '이메일 또는 비밀번호가 맞지 않아요.';

/**
 * 강사·대표 로그인 지름길 — FR-011a(역할별 화면·강사·대표 입구), 2026-11-25 사용자 결정(시연용).
 * 앱이 하나인 동안(베타·시연)만 둔다. 입력칸·버튼이 아닌 바탕을 이 시간 안에 이 횟수만큼 누르면
 * 강사·대표 로그인(`/staff-login`, 강사 탭 기본)으로 간다. 스토어 출시 때 앱을 나누면 뺀다.
 */
const STAFF_ENTRY_TAPS = 3;
const STAFF_ENTRY_WINDOW_MS = 600;
/** 로그인 버튼 자리. 웹에서 꺼진 버튼은 역할(role) 표시가 없어 이 이름으로 알아본다 */
const LOGIN_FOOTER_ID = 'login-footer';

/**
 * 웹에서 입력칸·버튼을 누른 것인지 본다. 웹(react-native-web)에서는 입력칸과 꺼진 버튼이 누름을
 * 가로채지 않고 바탕까지 올려 보내기 때문에, 누른 자리의 HTML 요소를 직접 확인한다.
 */
function isWebControlTap(event: GestureResponderEvent): boolean {
  if (Platform.OS !== 'web') return false;
  const target = event.target as unknown as { closest?: (selector: string) => unknown } | null;
  return Boolean(target?.closest?.(`input, textarea, button, [role="button"], #${LOGIN_FOOTER_ID}`));
}

/**
 * Better Auth 의 로그인 실패 본문은 §4.8(오류 응답 형식) 모양이 아니라서
 * `apiFetch` 가 `UNEXPECTED_RESPONSE` 로 바꾼다. 상태가 401 이면 계정 문제로 보고 문구만 바꾼다.
 */
function toLoginError(error: unknown): unknown {
  if (error instanceof ApiError && error.status === 401) {
    return new ApiError(401, 'BAD_REQUEST', WRONG_CREDENTIALS);
  }
  return error;
}

/** 로그인 → 내 정보 확인 → 다음 화면 주소. 가입 전이면 약관 동의 화면. */
async function signInAndResolveRoute(email: string, password: string) {
  try {
    await signInWithEmail(email, password);
  } catch (error: unknown) {
    throw toLoginError(error);
  }
  try {
    return nextOnboardingRoute(await fetchMe());
  } catch (error: unknown) {
    if (error instanceof ApiError && error.code === 'SIGNUP_INCOMPLETE') {
      return SIGNUP_START_ROUTE;
    }
    throw error;
  }
}

export default function LoginScreen() {
  const router = useRouter();
  const { loading, error, run } = useRequest();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // 바탕을 누른 최근 시각들. 화면을 다시 그릴 필요가 없는 값이라 상태(state)가 아니라 ref 에 둔다
  const backgroundTapTimes = useRef<number[]>([]);

  const canSubmit = email.trim().length > 0 && password.length > 0;

  /**
   * 바탕을 누를 때마다 부른다. 0.6초보다 오래된 시각은 버리고 이번 시각을 더해,
   * 남은 것이 세 개가 되면 강사·대표 로그인으로 보낸다. 입력칸·버튼은 자기가 누름을 먼저 받으므로
   * 여기까지 오지 않는다 — 그래서 로그인하려고 칸을 누르는 동작은 세지 않는다(웹은 따로 거른다).
   */
  const handleBackgroundPress = (event: GestureResponderEvent) => {
    if (isWebControlTap(event)) return;
    const now = Date.now();
    const recent = [...backgroundTapTimes.current.filter((time) => now - time < STAFF_ENTRY_WINDOW_MS), now];
    if (recent.length >= STAFF_ENTRY_TAPS) {
      backgroundTapTimes.current = [];
      router.push('/staff-login');
      return;
    }
    backgroundTapTimes.current = recent;
  };

  const handleSubmit = async () => {
    const route = await run(() => signInAndResolveRoute(email.trim(), password));
    if (route) {
      router.replace(route);
    }
  };

  return (
    // 화면 전체를 감싼 누름 영역 — 보이는 것은 하나도 늘리지 않는다(숨은 지름길). 읽어 주기에서도 버튼으로 잡히지 않게 한다
    <Pressable style={styles.tapArea} onPress={handleBackgroundPress} accessible={false}>
      <OnboardingScreen
        title={'오늘 밤,\n어떤 춤을 출까요?'}
        subtitle="장르를 고르면 가까운 수업과 파티를 찾아 드려요. 시험 기간에는 안내받은 계정으로 로그인해요."
        footer={
          // 로그인 버튼 자리는 세지 않는다 — 꺼진(disabled) 버튼은 누름을 받지 않고 바탕까지 올려 보낸다.
          // 휴대폰에서는 이 View 가 먼저 누름을 받아 막고, 웹에서는 id 로 알아봐 거른다
          <View id={LOGIN_FOOTER_ID} onStartShouldSetResponder={() => true}>
            <PrimaryButton label="로그인" onPress={handleSubmit} disabled={!canSubmit} loading={loading} />
          </View>
        }
      >
        <Field
          label="이메일"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
          placeholder="member@example.com"
        />
        <Field
          label="비밀번호"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="password"
          textContentType="password"
          onSubmitEditing={canSubmit ? handleSubmit : undefined}
        />
        <ErrorBox message={error} />
        {/* 보드 M1(로그인) 아래 안내 한 줄 — 가입해야 쓸 수 있고, 19세 미만은 보호자 계정의 자녀로 등록한다(Q17) */}
        <Text style={onboardingStyles.muted}>가입 뒤에만 이용할 수 있어요 · 만 19세 미만은 보호자 계정에서 자녀로 등록</Text>
      </OnboardingScreen>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // 웹에서 바탕에 손가락 모양 커서가 뜨지 않게 기본 커서로 둔다
  tapArea: { flex: 1, cursor: 'auto' },
});
