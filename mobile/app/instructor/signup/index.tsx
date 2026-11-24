/**
 * 강사 가입 2/2 · 아이디 만들기(보드 I31) — S2-1.7(앱 강사 가입·소속·프로필 화면). 주소 `/instructor/signup`.
 *
 * 가입은 승인 없이 끝나고, 학원 소속만 그 학원 대표가 승인한다(FR-011).
 *  - 「중복 확인」 → `GET /api/instructor/signup/username-available`(11 §1-2)
 *  - 「가입하고 시작」 → `POST /api/instructor/signup`(11 §1-3) → 바로 아이디 로그인 → 학원 탭(I12)
 *    (가입 응답은 세션을 만들지 않는다 — `next: "sign_in"`. 그래서 같은 아이디·비밀번호로 이어서 로그인한다)
 *  - 활동 장르는 하나만 고른다(FR-011b). 가입 뒤에는 바꾸지 않는다
 *  - 사업자등록번호는 비워도 된다(수용 ⑤). 등록증 파일은 로그인 뒤에야 올릴 수 있어(가입 시점엔 세션이 없다) 마이에서 넣는다
 *
 * 앞 화면(본인확인)의 토큰이 메모리에 없으면(앱을 껐다 켬·주소로 바로 들어옴) 본인확인부터 다시 하라고 보낸다.
 * 칸 검사는 입력하는 동안 렌더 중에 계산하고, 서버 호출은 버튼 핸들러 안에서만 한다(효과 훅 없음).
 */
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { checkUsernameAvailable, signInAs, signupInstructor } from '../../../lib/instructor/staff-api';
import { clearInstructorSignupDraft, getInstructorSignupDraft } from '../../../lib/instructor/signup-draft';
import { passwordProblem } from '../../../lib/instructor/password-rule';
import { useAction } from '../../../lib/instructor/staff-ui';
import { Chip, ErrorBox, Field, OnboardingScreen, onboardingStyles, PrimaryButton, SectionLabel } from '../../../lib/onboarding/components';
import { GENRE_LABELS } from '../../../lib/onboarding/labels';
import type { Genre } from '../../../lib/onboarding/types';
import { colors, radius, space } from '../../../lib/theme';

const GENRES: readonly Genre[] = ['dance_sport', 'argentine_tango', 'swing', 'salsa_bachata'];

/** 아이디 규칙(Q41 임시 확정): 영문 소문자·숫자 4~20자 — 서버 isValidStaffUsername 과 같다 */
const USERNAME_RULE = /^[a-z0-9]{4,20}$/;
const DISPLAY_NAME_MAX = 30;

// 비밀번호 규칙(Q41)은 I31B(비밀번호 새로 정하기)와 같이 쓰려고 lib/instructor/password-rule.ts 로 옮겼다

type UsernameCheck = { username: string; available: boolean; reason?: string } | null;

export default function InstructorSignupScreen() {
  // 렌더할 때 메모리에서 바로 읽는다 — 없으면 아래에서 본인확인으로 돌려보내는 화면을 그린다
  const draft = getInstructorSignupDraft();
  const { busy, error, run } = useAction();
  const check = useAction();
  const [username, setUsername] = useState('');
  const [usernameCheck, setUsernameCheck] = useState<UsernameCheck>(null);
  const [password, setPassword] = useState('');
  const [passwordAgain, setPasswordAgain] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [genre, setGenre] = useState<Genre | null>(null);
  const [businessNumber, setBusinessNumber] = useState('');
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [marketing, setMarketing] = useState(false);

  if (draft === null) {
    return (
      <OnboardingScreen title="강사 회원가입" subtitle="본인확인부터 다시 해 주세요. 본인확인 결과는 10분만 유효해요.">
        <Stack.Screen options={{ title: '강사 회원가입' }} />
        <PrimaryButton label="본인확인으로" onPress={() => router.replace('/instructor/signup/identity')} />
      </OnboardingScreen>
    );
  }

  // ---- 렌더 중 계산: 칸마다 지금 상태 ----
  const name = username.trim();
  const usernameShapeOk = USERNAME_RULE.test(name);
  // 확인한 뒤 아이디를 고치면 확인 결과는 무효다
  const checkedNow = usernameCheck !== null && usernameCheck.username === name ? usernameCheck : null;
  const pwProblem = password.length === 0 ? null : passwordProblem(password, name);
  const pwMatch = passwordAgain.length > 0 && password === passwordAgain;
  const digits = businessNumber.replace(/\D/g, '');
  const businessOk = digits.length === 0 || digits.length === 10;
  const allAgreed = terms && privacy && marketing;
  const canSubmit =
    checkedNow?.available === true &&
    password.length > 0 &&
    pwProblem === null &&
    pwMatch &&
    displayName.trim().length > 0 &&
    displayName.trim().length <= DISPLAY_NAME_MAX &&
    genre !== null &&
    businessOk &&
    terms &&
    privacy &&
    !busy;

  const handleCheckUsername = async () => {
    const result = await check.run(() => checkUsernameAvailable(name));
    if (result !== null) setUsernameCheck({ username: name, available: result.available, reason: result.reason });
  };

  const toggleAll = () => {
    const next = !allAgreed;
    setTerms(next);
    setPrivacy(next);
    setMarketing(next);
  };

  const handleSubmit = async () => {
    if (!canSubmit || genre === null) return;
    const created = await run(() =>
      signupInstructor({
        verificationToken: draft.verificationToken,
        username: name,
        password,
        displayName: displayName.trim(),
        activityGenre: genre,
        businessRegistrationNumber: digits.length === 0 ? null : digits,
        consents: { merchantTerms: terms, merchantPrivacyCollection: privacy, marketing },
      }),
    );
    if (created === null) return;
    // 계정은 생겼다. 같은 토큰으로 두 번 보내지 않게 바로 지운다
    clearInstructorSignupDraft();
    // 이어서 로그인한다. 여기서 실패해도(연결 끊김 등) 계정은 있으므로 로그인 화면으로 보낸다 — 가입을 되풀이하지 않게
    const me = await run(() => signInAs('instructor', name, password));
    router.replace(me !== null ? '/instructor/academy' : '/staff-login');
  };

  let usernameHint = '영문 소문자·숫자 4~20자';
  if (checkedNow?.available === true) usernameHint = '쓸 수 있는 아이디예요';
  else if (checkedNow !== null) usernameHint = checkedNow.reason === 'format' ? '영문 소문자·숫자 4~20자만 돼요' : '이미 쓰는 아이디예요';

  return (
    <OnboardingScreen
      step="2 / 2"
      title="강사 회원가입"
      subtitle="아이디·비밀번호로 바로 가입해요. 학원 소속만 그 학원 대표가 승인해요."
      footer={<PrimaryButton label="가입하고 시작" onPress={handleSubmit} disabled={!canSubmit} loading={busy} />}
    >
      {/* 위 머리 줄(뒤로 가기)에 주소 대신 화면 이름이 보이게 한다 */}
      <Stack.Screen options={{ title: '강사 회원가입' }} />
      <Text style={onboardingStyles.muted}>{`본인확인 완료 · ${draft.nameMasked} · ${draft.phoneMasked}`}</Text>

      <View style={styles.inline}>
        <View style={styles.flex}>
          <Field
            label="아이디"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="junholatin"
          />
        </View>
        <Pressable
          style={[styles.sideButton, (!usernameShapeOk || check.busy) && styles.sideButtonOff]}
          disabled={!usernameShapeOk || check.busy}
          onPress={handleCheckUsername}
          accessibilityRole="button"
          accessibilityLabel="아이디 중복 확인"
        >
          <Text style={styles.sideButtonText}>중복 확인</Text>
        </Pressable>
      </View>
      <Text style={[onboardingStyles.muted, checkedNow?.available === false && styles.bad]}>{usernameHint}</Text>
      <ErrorBox message={check.error} />

      <Field label="비밀번호" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" />
      <Field
        label="비밀번호 한 번 더"
        value={passwordAgain}
        onChangeText={setPasswordAgain}
        secureTextEntry
        autoComplete="new-password"
      />
      <Text style={[onboardingStyles.muted, pwProblem !== null && styles.bad]}>
        {pwProblem ?? (pwMatch ? '일치해요' : '8자 이상 · 영문·숫자·기호를 섞어요 · 아이디와 같으면 안 돼요')}
      </Text>

      <Field
        label="회원에게 보이는 이름"
        hint="강사 프로필과 수업 카드에 이 이름이 나와요"
        value={displayName}
        onChangeText={setDisplayName}
        maxLength={DISPLAY_NAME_MAX}
        placeholder="이준호"
      />

      <SectionLabel
        text="활동 장르 · 하나만 골라요"
        hint="종목은 고르지 않아요. 댄스스포츠면 라틴·스탠다드 수업을 모두 열어요. 가입 뒤에는 바꾸지 않아요."
      />
      <View style={onboardingStyles.row} accessibilityRole="radiogroup">
        {GENRES.map((value) => (
          <Chip key={value} kind="radio" label={GENRE_LABELS[value].name} selected={genre === value} onPress={() => setGenre(value)} />
        ))}
      </View>

      <Field
        label="사업자 등록 · 선택"
        hint="사업자가 있으면 계산서를 발행하고 정산받아요. 없으면 비워 두세요. 등록증은 가입 뒤 마이에서 올려요."
        value={businessNumber}
        onChangeText={setBusinessNumber}
        keyboardType="number-pad"
        maxLength={12}
        placeholder="사업자등록번호 10자리(있으면)"
      />
      {!businessOk && <Text style={[onboardingStyles.muted, styles.bad]}>사업자등록번호는 숫자 10자리예요</Text>}

      <SectionLabel text="약관 동의" />
      <View style={styles.consents}>
        <ConsentRow label="전체 동의" checked={allAgreed} onToggle={toggleAll} strong />
        <ConsentRow label="[필수] 입점 이용약관 (학원·강사)" checked={terms} onToggle={() => setTerms(!terms)} />
        <ConsentRow label="[필수] 개인정보 수집·이용" checked={privacy} onToggle={() => setPrivacy(!privacy)} />
        {/* 만 19세는 체크박스가 아니라 본인확인 생년월일로 이미 판정했다(2026-11-18) — 보이기만 한다 */}
        <ConsentRow label="만 19세 이상 · 본인확인으로 확인했어요" checked onToggle={null} />
        <ConsentRow label="[선택] 광고성 알림 · 밤 9시~아침 8시 제외" checked={marketing} onToggle={() => setMarketing(!marketing)} />
      </View>
      <ErrorBox message={error} />
    </OnboardingScreen>
  );
}

function ConsentRow({ label, checked, onToggle, strong = false }: { label: string; checked: boolean; onToggle: (() => void) | null; strong?: boolean }) {
  return (
    <Pressable
      style={styles.consentRow}
      onPress={onToggle ?? undefined}
      disabled={onToggle === null}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled: onToggle === null }}
    >
      <View style={[styles.box, checked && styles.boxOn]}>{checked && <Text style={styles.boxMark}>✓</Text>}</View>
      <Text style={[styles.consentText, strong && styles.consentStrong]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  inline: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  sideButton: {
    minHeight: 48,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.brown,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  sideButtonOff: { borderColor: colors.line },
  sideButtonText: { color: colors.ink, fontWeight: '700' },
  bad: { color: colors.danger },
  consents: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.md,
    gap: space.xs,
  },
  consentRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 40 },
  box: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.ink3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.brown, borderColor: colors.brown },
  boxMark: { color: colors.surface, fontSize: 12, fontWeight: '800' },
  consentText: { flex: 1, color: colors.ink, fontSize: 13 },
  consentStrong: { fontSize: 15, fontWeight: '700' },
});
