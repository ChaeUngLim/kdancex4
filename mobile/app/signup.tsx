/**
 * 가입 정보 확인·가입 완료 화면 — 보드 M3(가입 정보) · T-A5-2(가입·취향 화면 5종) 중 3번째.
 * S3-1.8(앱 가입·동의·취향 화면 보정)에서 보드 M3 에 맞춰 고쳤다.
 *
 * FR-002(가입 정보 수집·고지): 앞(M2)에서 인증한 휴대폰 값으로 성별·연락처를 미리 채워 보여 주고
 * 항목마다 수집 목적을 한 줄로 붙인다. 생년은 칸으로 두지 않는다(2026-11-18 사용자 결정) — 고칠 수 없는
 * 인증 값이라 설명 한 줄로만 알린다. 세 값은 본인확인 결과에서 오므로 앱이 서버에 따로 보내지 않는다.
 *
 * FR-019a(회원 닉네임 표시): 성별 위에 닉네임 칸을 둔다(계약 01 열린 점 ①). 비워 두면 가입하지 않는다 —
 * 본명으로 대신 채우면 본명이 강사·다른 회원에게 그대로 드러나기 때문이다.
 *
 * 서버에 보내는 것(계약 01 §3): `verificationToken` · `noticeAcknowledged` · `nickname` · `consents` 여섯 칸.
 * 동의 값은 앞의 약관 동의 화면(보드 C14A)이 메모리에 둔 것을 그대로 싣는다.
 *
 * 오류 처리
 *  - 409 `IDENTITY_ALREADY_USED`(FR-003) → 문구만 보여 준다
 *  - 422 `VALIDATION_FAILED`(토큰 만료·닉네임 규칙) → 문구 + 본인확인 다시 하기 버튼
 *  - 422 `NICKNAME_NOT_ALLOWED` → 문구(다른 닉네임을 적게 한다)
 *  - 422 `CONSENT_REQUIRED` · 401 → 약관 동의 · 로그인 화면(`useRequest` 가 처리)
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ErrorBox, Field, OnboardingScreen, onboardingStyles, PrimaryButton, SecondaryButton } from '../lib/onboarding/components';
import {
  clearSignupConsents,
  clearVerifiedIdentity,
  getSignupConsents,
  getVerifiedIdentity,
  hasRequiredConsents,
  isVerificationExpired,
  nextOnboardingRoute,
  SIGNUP_START_ROUTE,
} from '../lib/onboarding/flow';
import { CONSENT_ITEMS, GENDER_LABELS, NICKNAME_HINTS, SIGNUP_PURPOSES, SIGNUP_SUBTITLE } from '../lib/onboarding/labels';
import { completeSignup } from '../lib/onboarding/members-api';
import type { Gender } from '../lib/onboarding/types';
import { useRequest } from '../lib/onboarding/use-request';
import { NICKNAME_MAX, normalizeNickname, validateNickname } from '../lib/onboarding/validation';
import { colors, radius, space } from '../lib/theme';

const GENDERS: readonly Gender[] = ['male', 'female'];

/** 01012345678 → 010-4821-3390. 보드 M3 처럼 인증한 번호를 그대로 보여 준다(본인이 보는 화면). */
function formatPhone(phone: string): string {
  if (phone.length === 11) {
    return `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`;
  }
  return phone;
}

/** 본인확인 결과나 동의가 없을 때 — 처음 단계로 돌려보낸다. */
function Restart({ title, subtitle, label, onPress }: { title: string; subtitle: string; label: string; onPress: () => void }) {
  return (
    <OnboardingScreen step="2 / 4" title={title} subtitle={subtitle} footer={<PrimaryButton label={label} onPress={onPress} />}>
      {null}
    </OnboardingScreen>
  );
}

/** 칸 제목 + 수집 목적 한 줄(보드 M3 의 「성별 · 남·여 정원 배정에 씁니다」 모양). */
function FieldTitle({ label, purpose }: { label: string; purpose: string }) {
  return (
    <View style={styles.titleRow}>
      <Text style={styles.titleText}>{label}</Text>
      <Text style={styles.purpose}>· {purpose}</Text>
    </View>
  );
}

export default function SignupScreen() {
  const router = useRouter();
  const { loading, error, run } = useRequest();
  const [nickname, setNickname] = useState('');
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  // 화면을 여는 순간의 값을 고정한다. 메모리 값은 가입이 끝나면 지운다.
  const [identity] = useState(getVerifiedIdentity);
  const [consents] = useState(getSignupConsents);

  // 동의가 없으면 본인확인보다 먼저 약관 동의로 보낸다(가입 순서: 동의 → 본인확인 → 가입 정보).
  if (!hasRequiredConsents(consents)) {
    return (
      <Restart
        title="약관 동의가 필요해요"
        subtitle="필수 약관 동의가 없어요. 동의부터 다시 해 주세요."
        label="약관 동의 하러 가기"
        onPress={() => router.replace(SIGNUP_START_ROUTE)}
      />
    );
  }
  if (!identity || isVerificationExpired(identity)) {
    return (
      <Restart
        title="본인확인이 필요해요"
        subtitle="본인확인 결과가 없거나 10분이 지나 만료됐어요. 다시 확인해 주세요."
        label="본인확인 하러 가기"
        onPress={() => router.replace('/identity')}
      />
    );
  }

  const { input, result } = identity;
  const agreedOptional = CONSENT_ITEMS.filter((item) => !item.required && consents[item.key]).map((item) => item.title);

  const handleSubmit = async () => {
    // 서버와 같은 규칙으로 먼저 거른다. 최종 판정(금칙어 포함)은 서버가 한다.
    const normalized = normalizeNickname(nickname);
    const problem = validateNickname(normalized);
    setNicknameError(problem);
    if (problem) {
      return;
    }
    const member = await run(() =>
      completeSignup({ verificationToken: result.verificationToken, noticeAcknowledged: true, nickname: normalized, consents }),
    );
    if (member) {
      clearVerifiedIdentity();
      clearSignupConsents();
      router.replace(nextOnboardingRoute(member));
    }
  };

  return (
    <OnboardingScreen
      step="2 / 4"
      title="가입 정보를 확인해요"
      subtitle={SIGNUP_SUBTITLE}
      footer={<PrimaryButton label="다음 · 관심 장르" onPress={handleSubmit} loading={loading} />}
    >
      <View style={onboardingStyles.card}>
        <Field
          label="닉네임"
          hint={NICKNAME_HINTS.fixed}
          value={nickname}
          onChangeText={(text) => {
            // 고치기 시작하면 앞의 안내는 지운다(지난 입력에 대한 문구라서)
            setNickname(text);
            setNicknameError(null);
          }}
          placeholder="서연"
          maxLength={NICKNAME_MAX + 4}
          autoComplete="nickname"
        />
        <Text style={onboardingStyles.muted}>{NICKNAME_HINTS.visibility}</Text>
        <ErrorBox message={nicknameError} />

        <FieldTitle label="성별" purpose={SIGNUP_PURPOSES.gender} />
        {/* 인증 값으로 골라져 있다. 본인확인 결과라 여기서 바꾸지 않는다(신청 때마다 자리는 바꿀 수 있다 — 보드 M2) */}
        <View style={styles.segment} accessibilityRole="radiogroup">
          {GENDERS.map((value) => {
            const selected = input.gender === value;
            return (
              <View
                key={value}
                style={[styles.segmentOption, selected && styles.segmentOn]}
                accessible
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: true }}
              >
                <Text style={[styles.segmentText, selected && styles.segmentTextOn]}>{GENDER_LABELS[value]}</Text>
              </View>
            );
          })}
        </View>

        <FieldTitle label="연락처" purpose={SIGNUP_PURPOSES.phone} />
        <View style={styles.readonlyInput} accessible accessibilityLabel={`연락처 ${formatPhone(input.phone)}`}>
          <Text style={styles.readonlyText}>{formatPhone(input.phone)}</Text>
        </View>
      </View>

      {/* 앞(보드 C14A)에서 고른 동의 — 가입 요청에 이대로 실린다 */}
      <View style={onboardingStyles.card}>
        <Text style={styles.titleText}>동의한 항목</Text>
        <Text style={onboardingStyles.body}>필수 4가지 모두 동의</Text>
        <Text style={onboardingStyles.muted}>
          선택: {agreedOptional.length > 0 ? agreedOptional.join(' · ') : '동의 안 함'} · 마이 › 알림 설정에서 바꿀 수 있어요
        </Text>
      </View>

      <ErrorBox message={error} />
      {error ? <SecondaryButton label="본인확인 다시 하기" onPress={() => router.replace('/identity')} /> : null}
    </OnboardingScreen>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.sm },
  titleText: { fontSize: 12, fontWeight: '700', color: colors.ink },
  purpose: { fontSize: 11, color: colors.ink3 },
  segment: {
    flexDirection: 'row',
    gap: space.xs,
    padding: space.xs,
    borderRadius: radius.md,
    backgroundColor: colors.disabled,
  },
  segmentOption: { flex: 1, minHeight: 40, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  segmentOn: { backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.brown },
  segmentText: { fontSize: 15, color: colors.ink3 },
  segmentTextOn: { color: colors.brown, fontWeight: '700' },
  readonlyInput: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    paddingHorizontal: space.md,
    justifyContent: 'center',
  },
  readonlyText: { fontSize: 15, color: colors.ink },
});
