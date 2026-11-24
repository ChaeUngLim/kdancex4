/**
 * 강사 가입 1/2 · 본인확인(보드 I31C) — S2-1.7(앱 강사 가입·소속·프로필 화면). 주소 `/instructor/signup/identity`.
 *
 * 강사 계정은 한 사람당 하나다(Q23(강사 본인확인 시점) 확정). 그래서 아이디를 만들기 전에 본인확인부터 한다.
 *  1. 휴대폰 본인확인 → 토큰. 실제 기관이 붙기 전에는 dev 경로 `POST /api/dev/identity/fake-verify`(01 §2)
 *  2. `POST /api/instructor/signup/identity-check`(11 §1-1) — 이미 강사 계정이 있나 · 만 19세 이상인가
 *     - 409 `INSTRUCTOR_ALREADY_REGISTERED` → 「이미 가입한 강사예요」 + 로그인으로 가는 버튼(새 계정은 만들지 않는다)
 *     - 422 `INSTRUCTOR_UNDER_19` → 가입할 수 없다는 문구
 *  3. 통과하면 토큰을 앱 메모리(signup-draft)에 두고 2/2(아이디 만들기)로 간다
 *
 * 서버 호출은 아래 버튼 핸들러 안에서만 한다(효과 훅 없음). 보드의 통신사 칩·인증번호 받기는 실제 본인확인 기관 화면으로
 * 바뀔 자리라, 시험 기간에는 회원 가입(app/identity.tsx)과 같은 가짜 본인확인 칸을 쓴다.
 * 보드 위쪽 「멤버십 1년 무료 체험」 상자는 체험을 실제로 붙이는 S6-1 전이라 넣지 않았다(약속을 미리 보이지 않는다).
 */
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { ApiError } from '../../../lib/api';
import { checkInstructorIdentity } from '../../../lib/instructor/staff-api';
import { setInstructorSignupDraft } from '../../../lib/instructor/signup-draft';
import { useAction } from '../../../lib/instructor/staff-ui';
import { Chip, ErrorBox, Field, OnboardingScreen, onboardingStyles, PrimaryButton, SecondaryButton, SectionLabel } from '../../../lib/onboarding/components';
import { GENDER_LABELS } from '../../../lib/onboarding/labels';
import { fakeVerifyIdentity } from '../../../lib/onboarding/members-api';
import type { FakeVerifyInput, Gender } from '../../../lib/onboarding/types';
import { digitsOnly, validateIdentity } from '../../../lib/onboarding/validation';

const GENDERS: readonly Gender[] = ['male', 'female'];

export default function InstructorIdentityScreen() {
  const { busy, error, run } = useAction();
  const [name, setName] = useState('');
  const [gender, setGender] = useState<Gender>('male');
  const [birthDate, setBirthDate] = useState('');
  const [phone, setPhone] = useState('');
  const [personKey, setPersonKey] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  // 이미 강사 계정이 있는 사람이면 문구 아래에 「로그인하러 가기」를 보인다
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);

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
    setAlreadyRegistered(false);
    if (problem) return;

    const checked = await run(async () => {
      const verified = await fakeVerifyIdentity(input);
      try {
        const result = await checkInstructorIdentity(verified.verificationToken);
        return { token: verified.verificationToken, result };
      } catch (caught: unknown) {
        // 이 갈래만 화면 모양이 달라진다(로그인 버튼). 문구는 서버 detail 을 그대로 쓴다
        if (caught instanceof ApiError && caught.code === 'INSTRUCTOR_ALREADY_REGISTERED') setAlreadyRegistered(true);
        throw caught;
      }
    });
    if (checked !== null) {
      setInstructorSignupDraft({
        verificationToken: checked.token,
        nameMasked: checked.result.nameMasked,
        phoneMasked: checked.result.phoneMasked,
      });
      router.push('/instructor/signup');
    }
  };

  return (
    <OnboardingScreen
      step="1 / 2"
      title="강사 가입 · 본인확인"
      subtitle="본인확인으로 이미 강사 계정이 있는지, 만 19세 이상인지 확인해요."
      footer={<PrimaryButton label="본인확인하고 다음 · 아이디 만들기" onPress={handleSubmit} loading={busy} />}
    >
      {/* 위 머리 줄(뒤로 가기)에 주소 대신 화면 이름이 보이게 한다 */}
      <Stack.Screen options={{ title: '강사 가입 · 본인확인' }} />
      <View style={onboardingStyles.card}>
        <Text style={onboardingStyles.body}>강사 계정은 한 사람당 하나예요</Text>
        <Text style={onboardingStyles.muted}>
          주민등록번호는 받지 않아요. 본인확인 결과(이름·생년월일)만 남겨요. 아이디·비밀번호 찾기에도 이 결과를 써요.
        </Text>
        <Text style={onboardingStyles.muted}>
          시험 기간용 가짜 본인확인이에요. 실제 본인확인 기관이 붙으면 아래 칸은 통신사 인증 화면으로 바뀌어요.
        </Text>
      </View>
      <Field label="이름" value={name} onChangeText={setName} autoComplete="name" placeholder="이준호" />
      <SectionLabel text="성별" hint="실제 본인확인에서는 결과로 자동 체크돼요" />
      <View style={onboardingStyles.row} accessibilityRole="radiogroup">
        {GENDERS.map((value) => (
          <Chip key={value} kind="radio" label={GENDER_LABELS[value]} selected={gender === value} onPress={() => setGender(value)} />
        ))}
      </View>
      <Field
        label="생년월일"
        hint="만 19세 미만이면 강사로 가입할 수 없어요"
        value={birthDate}
        onChangeText={setBirthDate}
        placeholder="1990-03-02"
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
        placeholder="seed-instructor-1"
      />
      <ErrorBox message={inputError ?? error} />
      {alreadyRegistered && <SecondaryButton label="그 아이디로 로그인하러 가기" onPress={() => router.replace('/staff-login')} />}
      {/* 계약 11 §1-1: 이미 가입한 사람은 로그인 또는 비밀번호 새로 정하기(I31B, S2-1.10)로 보낸다 */}
      {alreadyRegistered && (
        <SecondaryButton label="아이디 · 비밀번호 찾기" onPress={() => router.replace('/instructor/account-recovery')} />
      )}
    </OnboardingScreen>
  );
}
