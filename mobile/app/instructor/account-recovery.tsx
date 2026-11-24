/**
 * 강사 아이디·비밀번호 찾기(보드 I31B) — S2-1.10. 주소 `/instructor/account-recovery`.
 * 강사·대표 로그인(M1B)의 「아이디 찾기 | 비밀번호 찾기」와 가입 본인확인의 「이미 가입한 강사예요」에서 들어온다.
 *
 * 찾는 수단은 휴대폰 본인확인 하나뿐이다(가입 때 이메일·전화번호를 받지 않는다, 계약 11 §1-4).
 *  1단계 본인확인 → `POST /api/dev/identity/fake-verify`(가짜 기관) → 토큰
 *        → `POST /api/instructor/account-recovery/lookup` → 찾은 계정 하나(아이디만 그대로, 이름·전화는 가린 값)
 *        · 404 면 「강사로 가입한 적이 없어요」 + 강사 회원가입 버튼
 *  2단계 찾은 계정 카드 · 「이 아이디로 로그인」 · 새 비밀번호 두 칸
 *        → `POST …/reset-password` → 그 계정의 모든 로그인(다른 기기 포함)이 끝난다(FR-191)
 *        → 새 비밀번호로 바로 로그인해 학원 탭으로. 로그인이 안 되면(웹·연결 끊김) 완료 안내 + 로그인 화면 버튼
 *
 * 화면 상태는 「어느 단계인가」 하나(useState)로만 갈린다. 서버 호출은 모두 버튼 핸들러 안에 있다(효과 훅 없음).
 * 본인확인 토큰은 한 번 쓰면 다시 못 쓴다 — 비밀번호 바꾸기가 토큰 문제로 실패하면 1단계로 돌려보낸다.
 *
 * 보드는 「같은 본인확인으로 만든 강사 계정이 여럿이면 모두 보여요」였지만, 계약(Q23 확정)이 「강사 계정은 한 사람당
 * 하나」라 찾은 계정 하나만 보이고 그 문장을 안내로 바꿨다(보드 내보내기 PNG 도 「한 사람당 하나예요」).
 */
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../../lib/api';
import {
  dateWithWeekday,
  lookupInstructorAccount,
  resetInstructorPassword,
  type RecoveredAccount,
} from '../../lib/instructor/affiliation-api';
import { passwordProblem } from '../../lib/instructor/password-rule';
import { signInAs } from '../../lib/instructor/staff-api';
import { useAction } from '../../lib/instructor/staff-ui';
import {
  Chip,
  ErrorBox,
  Field,
  OnboardingScreen,
  onboardingStyles,
  PrimaryButton,
  SecondaryButton,
  SectionLabel,
} from '../../lib/onboarding/components';
import { GENDER_LABELS } from '../../lib/onboarding/labels';
import { fakeVerifyIdentity } from '../../lib/onboarding/members-api';
import type { FakeVerifyInput, Gender } from '../../lib/onboarding/types';
import { digitsOnly, validateIdentity } from '../../lib/onboarding/validation';
import { colors, font, radius, space } from '../../lib/theme';

const GENDERS: readonly Gender[] = ['male', 'female'];

/** 화면 단계. found 는 찾은 계정과 그 계정을 찾은 본인확인 토큰을 함께 든다 */
type Step =
  | { kind: 'identity' }
  | { kind: 'found'; token: string; account: RecoveredAccount }
  | { kind: 'done'; username: string; sessionsRevoked: number };

export default function InstructorAccountRecoveryScreen() {
  const [step, setStep] = useState<Step>({ kind: 'identity' });

  if (step.kind === 'identity') {
    return <IdentityStep onFound={(token, account) => setStep({ kind: 'found', token, account })} />;
  }
  if (step.kind === 'found') {
    return (
      <FoundStep
        token={step.token}
        account={step.account}
        onTokenSpent={() => setStep({ kind: 'identity' })}
        onDone={(sessionsRevoked) => setStep({ kind: 'done', username: step.account.username, sessionsRevoked })}
      />
    );
  }
  return <DoneStep username={step.username} sessionsRevoked={step.sessionsRevoked} />;
}

// ---- 1단계 · 본인확인 ---------------------------------------------------------------------------

function IdentityStep({ onFound }: { onFound: (token: string, account: RecoveredAccount) => void }) {
  const { busy, error, run } = useAction();
  const [name, setName] = useState('');
  const [gender, setGender] = useState<Gender>('male');
  const [birthDate, setBirthDate] = useState('');
  const [phone, setPhone] = useState('');
  const [personKey, setPersonKey] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  // 본인확인은 됐는데 강사로 가입한 적이 없는 사람(404) — 문구 아래 「강사 회원가입」을 보인다
  const [notRegistered, setNotRegistered] = useState(false);

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
    setNotRegistered(false);
    if (problem) return;

    const found = await run(async () => {
      const verified = await fakeVerifyIdentity(input);
      try {
        const account = await lookupInstructorAccount(verified.verificationToken);
        return { token: verified.verificationToken, account };
      } catch (caught: unknown) {
        if (caught instanceof ApiError && caught.status === 404) {
          setNotRegistered(true);
          throw new ApiError(404, 'NOT_FOUND', '본인확인한 분으로 가입한 강사 계정이 없어요.');
        }
        throw caught;
      }
    });
    if (found !== null) onFound(found.token, found.account);
  };

  return (
    <OnboardingScreen
      step="1 본인확인 › 2 계정 확인 · 비밀번호"
      title="아이디 · 비밀번호 찾기"
      subtitle="휴대폰 본인확인으로 내 강사 계정을 찾고, 비밀번호를 그 자리에서 새로 정해요."
      footer={<PrimaryButton label="본인확인하고 계정 찾기" onPress={handleSubmit} loading={busy} />}
    >
      <Stack.Screen options={{ title: '아이디 · 비밀번호 찾기' }} />
      <View style={onboardingStyles.card}>
        <Text style={onboardingStyles.body}>찾는 방법은 휴대폰 본인확인 하나예요</Text>
        <Text style={onboardingStyles.muted}>
          가입 때 이메일·전화번호를 따로 받지 않아서, 가입할 때 한 본인확인 결과로 계정을 찾아요. 휴대폰 번호가 바뀌었어도 같은 분이면 찾을 수 있어요.
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
        hint="가입할 때 넣은 키와 같아야 같은 사람으로 봐요"
        value={personKey}
        onChangeText={setPersonKey}
        autoCapitalize="none"
        placeholder="seed-instructor-1"
      />
      <ErrorBox message={inputError ?? error} />
      {notRegistered && <SecondaryButton label="강사 회원가입하러 가기" onPress={() => router.replace('/instructor/signup/identity')} />}
    </OnboardingScreen>
  );
}

// ---- 2단계 · 찾은 계정 + 비밀번호 새로 정하기 --------------------------------------------------------

interface FoundStepProps {
  token: string;
  account: RecoveredAccount;
  /** 토큰을 이미 썼거나 만료돼 다시 본인확인해야 할 때 */
  onTokenSpent: () => void;
  onDone: (sessionsRevoked: number) => void;
}

function FoundStep({ token, account, onTokenSpent, onDone }: FoundStepProps) {
  const { busy, error, run, setError } = useAction();
  const [password, setPassword] = useState('');
  const [passwordAgain, setPasswordAgain] = useState('');
  // 본인확인 토큰을 이미 썼거나 만료됐다는 422(fields.path = verificationToken) — 「본인확인 다시 하기」를 보인다
  const [tokenSpent, setTokenSpent] = useState(false);

  // 렌더 중에 바로 계산: 규칙 위반 문구 · 두 칸 일치 · 버튼을 켤지
  const problem = password.length === 0 ? null : passwordProblem(password, account.username);
  const matches = passwordAgain.length > 0 && password === passwordAgain;
  const canSubmit = password.length > 0 && problem === null && matches;
  const academyLine =
    account.academyCount === 0
      ? '아직 소속 학원 없음'
      : account.academyCount === 1
        ? account.academyNames[0] ?? '소속 학원 1곳'
        : `${account.academyNames[0] ?? '소속 학원'} 외 ${account.academyCount - 1}`;

  const handleReset = async () => {
    if (!canSubmit) return;
    setTokenSpent(false);
    const result = await run(async () => {
      try {
        return await resetInstructorPassword(token, password);
      } catch (caught: unknown) {
        if (caught instanceof ApiError && caught.fields.some((field) => field.path === 'verificationToken')) setTokenSpent(true);
        throw caught;
      }
    });
    if (result === null) return;
    // 비밀번호가 바뀌었다 — 이 기기는 새 비밀번호로 바로 로그인한다. 실패하면(웹·연결 끊김) 완료 안내로 간다
    const me = await run(() => signInAs('instructor', account.username, password));
    if (me !== null) {
      router.replace('/instructor/academy');
      return;
    }
    setError(null);
    onDone(result.sessionsRevoked);
  };

  return (
    <OnboardingScreen
      step="1 본인확인 › 2 계정 확인 · 비밀번호"
      title="아이디 · 비밀번호 찾기"
      footer={<PrimaryButton label="비밀번호 바꾸고 로그인" onPress={handleReset} disabled={!canSubmit} loading={busy} />}
    >
      <Stack.Screen options={{ title: '아이디 · 비밀번호 찾기' }} />
      <View style={styles.foundBox}>
        <Text style={styles.foundTitle}>본인확인한 분의 강사 계정을 찾았어요</Text>
        <Text style={onboardingStyles.muted}>{`${account.nameMasked} · ${account.phoneMasked}`}</Text>
      </View>

      <SectionLabel text="찾은 계정" />
      <View style={styles.accountCard} accessible accessibilityLabel={`찾은 아이디 ${account.username}`}>
        <View style={styles.accountHead}>
          <Text style={styles.username} selectable>
            {account.username}
          </Text>
          <Text style={styles.roleBadge}>강사 계정</Text>
        </View>
        <Text style={onboardingStyles.muted}>{`${dateWithWeekday(account.joinedOn)} 가입 · ${academyLine}`}</Text>
      </View>
      <Text style={onboardingStyles.muted}>강사 계정은 한 사람당 하나예요.</Text>
      <SecondaryButton label="이 아이디로 로그인" onPress={() => router.replace('/staff-login')} />

      <Text style={styles.sectionTitle}>비밀번호를 잊었다면 새로 정해요</Text>
      <Field label="새 비밀번호" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" />
      <Field
        label="새 비밀번호 한 번 더"
        value={passwordAgain}
        onChangeText={setPasswordAgain}
        secureTextEntry
        autoComplete="new-password"
      />
      <Text style={[onboardingStyles.muted, problem !== null && styles.bad, matches && styles.good]}>
        {problem ?? (matches ? '일치해요' : '8자 이상 · 영문·숫자·기호를 섞어요 · 아이디와 같으면 안 돼요')}
      </Text>

      <View style={styles.warnBox}>
        <Text style={styles.warnTitle}>바꾸면 다른 기기의 로그인은 모두 끝나요</Text>
        <Text style={onboardingStyles.muted}>휴대폰을 잃어버렸을 때도 이렇게 막을 수 있어요.</Text>
      </View>
      <Text style={onboardingStyles.muted}>휴대폰 번호가 바뀌었어도 같은 분이면 찾을 수 있어요.</Text>
      <Text style={onboardingStyles.muted}>본인확인을 한 적이 없는 계정은 찾지 못해요 · 고객센터 문의는 준비 중이에요.</Text>

      <ErrorBox message={error} />
      {tokenSpent && <SecondaryButton label="본인확인 다시 하기" onPress={onTokenSpent} />}
    </OnboardingScreen>
  );
}

// ---- 완료(이 기기에서 바로 로그인하지 못했을 때) ------------------------------------------------------

function DoneStep({ username, sessionsRevoked }: { username: string; sessionsRevoked: number }) {
  return (
    <OnboardingScreen
      title="비밀번호를 바꿨어요"
      subtitle="새 비밀번호로 로그인해 주세요."
      footer={<PrimaryButton label="로그인하러 가기" onPress={() => router.replace('/staff-login')} />}
    >
      <Stack.Screen options={{ title: '아이디 · 비밀번호 찾기' }} />
      <View style={styles.foundBox} accessibilityLiveRegion="polite">
        <Text style={styles.foundTitle}>{`${username} 비밀번호를 새로 정했어요`}</Text>
        <Text style={onboardingStyles.muted}>
          {sessionsRevoked > 0 ? `로그인돼 있던 기기 ${sessionsRevoked}곳의 로그인을 끝냈어요.` : '로그인돼 있던 다른 기기는 없었어요.'}
        </Text>
      </View>
    </OnboardingScreen>
  );
}

const styles = StyleSheet.create({
  foundBox: {
    marginTop: space.lg,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.brownSoft,
    gap: space.xs,
  },
  foundTitle: { color: colors.brown, fontSize: 15, fontWeight: '800' },
  accountCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.lg,
    gap: space.xs,
  },
  accountHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  username: { flex: 1, color: colors.ink, fontSize: 18, fontWeight: '800' },
  roleBadge: {
    paddingHorizontal: space.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.brownSoft,
    color: colors.brown,
    fontSize: font.small,
    fontWeight: '700',
    overflow: 'hidden',
  },
  sectionTitle: { marginTop: space.xl, color: colors.ink, fontSize: 16, fontWeight: '800' },
  bad: { color: colors.danger },
  good: { color: colors.ok, fontWeight: '700' },
  warnBox: {
    marginTop: space.lg,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.brown,
    backgroundColor: colors.surface,
    gap: space.xs,
  },
  warnTitle: { color: colors.ink, fontSize: font.body, fontWeight: '800' },
});
