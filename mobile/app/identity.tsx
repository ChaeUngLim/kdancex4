/**
 * 휴대폰 본인확인 화면(가짜) — T-A5-2(가입·취향 화면 5종) 중 2번째.
 *
 * FR-003(본인확인 계정 식별): 본인확인을 거친 사람 하나에 계정 하나.
 * 1회차에는 실제 본인확인 기관이 없어서 계약 §2 의 dev 경로 `POST /api/dev/identity/fake-verify` 를
 * 부른다(plan D10(인증)). 기관이 생기면 이 화면은 기관 창을 여는 화면으로 바뀌고,
 * 성별·생년월일을 사람이 고르는 칸은 사라진다(FR-002: 성별은 본인확인 결과로 자동 체크).
 *
 * 받은 토큰은 주소에 싣지 않고 `flow.ts` 의 메모리에 두고 가입 화면으로 넘어간다.
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { Chip, ErrorBox, Field, OnboardingScreen, onboardingStyles, PrimaryButton, SectionLabel } from '../lib/onboarding/components';
import { setVerifiedIdentity } from '../lib/onboarding/flow';
import { GENDER_LABELS } from '../lib/onboarding/labels';
import { fakeVerifyIdentity } from '../lib/onboarding/members-api';
import type { FakeVerifyInput, Gender } from '../lib/onboarding/types';
import { useRequest } from '../lib/onboarding/use-request';
import { digitsOnly, validateIdentity } from '../lib/onboarding/validation';

const GENDERS: readonly Gender[] = ['male', 'female'];

export default function IdentityScreen() {
  const router = useRouter();
  const { loading, error, run } = useRequest();
  const [name, setName] = useState('');
  const [gender, setGender] = useState<Gender>('female');
  const [birthDate, setBirthDate] = useState('');
  const [phone, setPhone] = useState('');
  const [personKey, setPersonKey] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const input: FakeVerifyInput = {
      name: name.trim(),
      gender,
      birthDate: birthDate.trim(),
      phone: digitsOnly(phone),
      personKey: personKey.trim(),
    };
    const problem = validateIdentity(input);
    setInputError(problem);
    if (problem) {
      return;
    }
    const result = await run(() => fakeVerifyIdentity(input));
    if (result) {
      setVerifiedIdentity({ input, result });
      router.push('/signup');
    }
  };

  return (
    <OnboardingScreen
      step="1 / 4"
      title={'본인확인 한 번이면\n한 사람 한 계정'}
      subtitle="본인확인 결과로 중복 가입을 막아요. 주민등록번호는 받지 않아요."
      footer={<PrimaryButton label="다음 · 가입 정보" onPress={handleSubmit} loading={loading} />}
    >
      <View style={onboardingStyles.card}>
        <Text style={onboardingStyles.muted}>
          시험 기간용 가짜 본인확인이에요. 실제 본인확인 기관이 붙으면 이 칸들은 기관 화면으로 바뀌어요.
        </Text>
      </View>
      <Field label="이름" value={name} onChangeText={setName} autoComplete="name" placeholder="김회원" />
      <SectionLabel text="성별" hint="실제 본인확인에서는 결과로 자동 체크돼요" />
      <View style={onboardingStyles.row} accessibilityRole="radiogroup">
        {GENDERS.map((value) => (
          <Chip
            key={value}
            kind="radio"
            label={GENDER_LABELS[value]}
            selected={gender === value}
            onPress={() => setGender(value)}
          />
        ))}
      </View>
      <Field
        label="생년월일"
        value={birthDate}
        onChangeText={setBirthDate}
        placeholder="1995-03-02"
        keyboardType="numbers-and-punctuation"
        maxLength={10}
      />
      <Field
        label="휴대폰 번호"
        value={phone}
        onChangeText={setPhone}
        placeholder="01012345678"
        keyboardType="phone-pad"
        autoComplete="tel"
        maxLength={13}
      />
      <Field
        label="시험용 사람 키"
        hint="같은 키는 같은 사람으로 봐요(1인 1계정 시험용)"
        value={personKey}
        onChangeText={setPersonKey}
        autoCapitalize="none"
        placeholder="seed-member-1"
      />
      <ErrorBox message={inputError ?? error} />
    </OnboardingScreen>
  );
}
