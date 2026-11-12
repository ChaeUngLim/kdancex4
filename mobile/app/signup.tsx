/**
 * 가입 정보 확인·가입 완료 화면 — T-A5-2(가입·취향 화면 5종) 중 3번째.
 *
 * FR-002(가입 정보 수집·고지): 생년월일·성별·연락처 3가지를 왜 받는지 이 화면에서 알리고,
 * 확인을 받아야 가입한다. 세 값은 본인확인 결과에서 오므로 앱이 고칠 수 없고 보여 주기만 한다.
 * 서버에 보내는 것은 계약 §3 대로 `verificationToken` 과 `noticeAcknowledged` 둘뿐이다.
 *
 * 오류 처리
 *  - 409 `IDENTITY_ALREADY_USED`(FR-003) → 문구만 보여 준다
 *  - 422 `VALIDATION_FAILED`(토큰 만료 등) → 문구 + 본인확인 다시 하기 버튼
 *  - 401 → 로그인 화면(`useRequest` 가 처리)
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { Chip, ErrorBox, OnboardingScreen, onboardingStyles, PrimaryButton, SecondaryButton } from '../lib/onboarding/components';
import { clearVerifiedIdentity, getVerifiedIdentity, isVerificationExpired, nextOnboardingRoute } from '../lib/onboarding/flow';
import { GENDER_LABELS, SIGNUP_PURPOSES } from '../lib/onboarding/labels';
import { completeSignup } from '../lib/onboarding/members-api';
import { useRequest } from '../lib/onboarding/use-request';

/** 01012345678 → 010-****-5678. 가입 전이라 서버의 `phoneMasked` 가 아직 없어 앱이 가린다. */
function maskPhone(phone: string): string {
  if (phone.length < 8) {
    return phone;
  }
  return `${phone.slice(0, 3)}-****-${phone.slice(-4)}`;
}

function NoIdentity({ onRestart }: { onRestart: () => void }) {
  return (
    <OnboardingScreen
      step="2 / 4"
      title="본인확인이 필요해요"
      subtitle="본인확인 결과가 없거나 10분이 지나 만료됐어요. 다시 확인해 주세요."
      footer={<PrimaryButton label="본인확인 하러 가기" onPress={onRestart} />}
    >
      {null}
    </OnboardingScreen>
  );
}

export default function SignupScreen() {
  const router = useRouter();
  const { loading, error, run } = useRequest();
  const [acknowledged, setAcknowledged] = useState(false);
  // 화면을 여는 순간의 값을 고정한다. 메모리 값은 가입이 끝나면 지운다.
  const [identity] = useState(getVerifiedIdentity);

  const restart = () => router.replace('/identity');

  if (!identity || isVerificationExpired(identity)) {
    return <NoIdentity onRestart={restart} />;
  }

  const { input, result } = identity;
  const values: Readonly<Record<string, string>> = {
    생년월일: input.birthDate,
    성별: `${GENDER_LABELS[input.gender]} · 자동 체크`,
    연락처: maskPhone(input.phone),
  };

  const handleSubmit = async () => {
    const member = await run(() => completeSignup(result.verificationToken));
    if (member) {
      clearVerifiedIdentity();
      router.replace(nextOnboardingRoute(member));
    }
  };

  return (
    <OnboardingScreen
      step="2 / 4"
      title="필수 3가지만 받아요"
      subtitle={`${input.name}님, 나이·성별·연락처는 필수예요. 각 항목을 왜 받는지 아래에 적어 뒀어요.`}
      footer={
        <PrimaryButton label="가입 완료 · 관심 장르" onPress={handleSubmit} disabled={!acknowledged} loading={loading} />
      }
    >
      {SIGNUP_PURPOSES.map(({ field, purpose }) => (
        <View key={field} style={onboardingStyles.card} accessible>
          <Text style={onboardingStyles.muted}>
            {field} · {purpose}
          </Text>
          <Text style={onboardingStyles.body}>{values[field]}</Text>
        </View>
      ))}
      <View style={onboardingStyles.spacedRow}>
        <Chip
          label="위 3가지를 수집하는 목적을 확인했어요"
          selected={acknowledged}
          onPress={() => setAcknowledged((previous) => !previous)}
        />
      </View>
      <ErrorBox message={error} />
      {error ? <SecondaryButton label="본인확인 다시 하기" onPress={restart} /> : null}
    </OnboardingScreen>
  );
}
