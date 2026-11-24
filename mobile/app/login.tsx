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
import { useState } from 'react';
import { Text } from 'react-native';

import { ApiError } from '../lib/api';
import { ErrorBox, Field, OnboardingScreen, onboardingStyles, PrimaryButton } from '../lib/onboarding/components';
import { nextOnboardingRoute, SIGNUP_START_ROUTE } from '../lib/onboarding/flow';
import { fetchMe, signInWithEmail } from '../lib/onboarding/members-api';
import { useRequest } from '../lib/onboarding/use-request';

const WRONG_CREDENTIALS = '이메일 또는 비밀번호가 맞지 않아요.';

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

  const canSubmit = email.trim().length > 0 && password.length > 0;

  const handleSubmit = async () => {
    const route = await run(() => signInAndResolveRoute(email.trim(), password));
    if (route) {
      router.replace(route);
    }
  };

  return (
    <OnboardingScreen
      title={'오늘 밤,\n어떤 춤을 출까요?'}
      subtitle="장르를 고르면 가까운 수업과 파티를 찾아 드려요. 시험 기간에는 안내받은 계정으로 로그인해요."
      footer={<PrimaryButton label="로그인" onPress={handleSubmit} disabled={!canSubmit} loading={loading} />}
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
  );
}
