/**
 * 약관 동의 화면 — S3-1.8(앱 가입·동의·취향 화면 보정) · 보드 C14A(가입 · 약관 동의).
 *
 * M-01(동의 항목): 필수 넷(이용약관·개인정보 수집·학원에 개인정보 제공·만 19세 이상)과
 * 선택 둘(광고성 알림·위치 정보)을 나눠 보여 주고, 필수에 모두 동의해야 「동의하고 본인확인으로」가 눌린다.
 *
 * 왜 여기서 서버에 저장하지 않나:
 *   동의 기록(`member_consents`)은 회원이 생겨야 쓸 수 있다. 그래서 고른 값은 메모리(`flow.ts`)에 두고
 *   가입 화면이 `POST /api/members` 의 `consents` 여섯 칸으로 한 번에 보낸다(계약 01 §3).
 *   서버도 필수 넷 중 하나라도 false 면 422 `CONSENT_REQUIRED` 로 막는다 — 화면만 막으면 우회되기 때문이다.
 *
 * 「보기 ›」로 여는 약관 전문은 회원 약관 판본이 생기는 S7-3.1 몫이라 이 화면에는 두지 않았다.
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { OnboardingScreen, PrimaryButton } from '../lib/onboarding/components';
import { getSignupConsents, hasRequiredConsents, setSignupConsents } from '../lib/onboarding/flow';
import { CONSENT_ITEMS } from '../lib/onboarding/labels';
import type { ConsentKey, SignupConsents } from '../lib/onboarding/types';
import { colors, MIN_TOUCH, radius, space } from '../lib/theme';

/** 처음엔 모두 꺼 둔다. 앞에서 고른 값이 메모리에 있으면(뒤로 가기로 돌아온 경우) 그 값을 살린다. */
const NONE_AGREED: SignupConsents = {
  memberTerms: false,
  memberPrivacyCollection: false,
  academySharing: false,
  age19Plus: false,
  marketing: false,
  location: false,
};

/** 모든 칸을 같은 값으로 바꾼 새 객체 — 「전체 동의」가 쓴다. */
function allConsents(value: boolean): SignupConsents {
  return {
    memberTerms: value,
    memberPrivacyCollection: value,
    academySharing: value,
    age19Plus: value,
    marketing: value,
    location: value,
  };
}

function CheckRow({
  label,
  description,
  checked,
  onPress,
  emphasis = false,
}: {
  label: string;
  description: string;
  checked: boolean;
  onPress: () => void;
  emphasis?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      onPress={onPress}
      style={styles.row}
    >
      <View style={[styles.box, checked && styles.boxOn]}>
        <Text style={styles.boxMark}>{checked ? '✓' : ''}</Text>
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, emphasis && styles.rowTitleStrong]}>{label}</Text>
        <Text style={styles.rowDescription}>{description}</Text>
      </View>
    </Pressable>
  );
}

export default function ConsentScreen() {
  const router = useRouter();
  const [consents, setConsents] = useState<SignupConsents>(() => getSignupConsents() ?? NONE_AGREED);

  // 렌더 중에 바로 계산한다 — 전체 동의 여부와 버튼을 켤지 여부.
  const everyChecked = CONSENT_ITEMS.every(({ key }) => consents[key]);
  const canContinue = hasRequiredConsents(consents);

  // 한 칸만 바꾼 새 객체로 갈아 끼운다(원래 객체는 고치지 않는다).
  const toggle = (key: ConsentKey) => setConsents((previous) => ({ ...previous, [key]: !previous[key] }));

  const handleContinue = () => {
    setSignupConsents(consents);
    router.push('/identity');
  };

  const renderGroup = (required: boolean) =>
    CONSENT_ITEMS.filter((item) => item.required === required).map((item) => (
      <CheckRow
        key={item.key}
        label={`[${required ? '필수' : '선택'}] ${item.title}`}
        description={item.description}
        checked={consents[item.key]}
        onPress={() => toggle(item.key)}
      />
    ));

  return (
    <OnboardingScreen
      title="시작하기 전에 동의해 주세요"
      subtitle="필수 4가지에 모두 동의해야 가입을 마쳐요. 선택은 나중에 바꿀 수 있어요."
      footer={<PrimaryButton label="동의하고 본인확인으로" onPress={handleContinue} disabled={!canContinue} />}
    >
      <View style={[styles.card, styles.allCard]}>
        <CheckRow
          label="전체 동의"
          description="선택 항목까지 모두 동의해요"
          checked={everyChecked}
          onPress={() => setConsents(allConsents(!everyChecked))}
          emphasis
        />
      </View>
      <Text style={styles.groupLabel}>필수</Text>
      <View style={styles.card}>{renderGroup(true)}</View>
      <Text style={styles.groupLabel}>선택</Text>
      <View style={styles.card}>{renderGroup(false)}</View>
      <Text style={styles.note}>
        선택 동의는 마이 › 알림 설정에서 언제든 끌 수 있어요. 동의한 시각과 끈 시각은 기록으로 남아요.
      </Text>
      <Text style={styles.next}>다음은 휴대폰 본인확인이에요 · 한 사람 한 계정</Text>
    </OnboardingScreen>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
  },
  allCard: { marginTop: space.lg, backgroundColor: colors.brownSoft },
  groupLabel: { marginTop: space.lg, marginBottom: space.sm, fontSize: 13, color: colors.ink3, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: MIN_TOUCH, paddingVertical: space.sm },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.brown, borderColor: colors.brown },
  boxMark: { color: colors.surface, fontSize: 13, fontWeight: '800' },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 14, color: colors.ink, fontWeight: '600' },
  rowTitleStrong: { fontSize: 15, fontWeight: '800' },
  rowDescription: { marginTop: 2, fontSize: 12, color: colors.ink3, lineHeight: 17 },
  note: { marginTop: space.lg, fontSize: 12, color: colors.ink3, lineHeight: 18 },
  next: { marginTop: space.md, fontSize: 13, color: colors.ink, fontWeight: '600' },
});
