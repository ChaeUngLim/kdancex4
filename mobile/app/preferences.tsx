/**
 * 취향 입력 화면 — T-A5-2(가입·취향 화면 5종) 중 4번째.
 *
 * FR-022(사용자 프로필): 관심 장르(여러 개, 필수) · 활동 지역 · 활동 가능 시간 · 경험 수준(FR-029(경험 수준 구간)).
 * 계약 §5 `PUT /api/me/profile` 는 전체 교체라, 화면을 열 때 `GET /api/me` 로 지금 값을 채워 두고
 * 고친 결과를 통째로 보낸다. 관심 장르는 추천용일 뿐이고 홈 장르는 다음 화면의 기준 장르가 정한다
 * (plan D16(홈 장르 조건)).
 *
 * 함께 듣고 싶은 연령대·세부 장르는 1회차 범위 밖이라 보내지 않는다(계약: 모르는 칸은 422).
 */
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import {
  Chip,
  ErrorBox,
  Field,
  OnboardingScreen,
  onboardingStyles,
  PrimaryButton,
  SecondaryButton,
  SectionLabel,
} from '../lib/onboarding/components';
import { nextOnboardingRoute } from '../lib/onboarding/flow';
import { EXPERIENCE_LABELS, GENRE_LABELS } from '../lib/onboarding/labels';
import { fetchMe, saveProfile } from '../lib/onboarding/members-api';
import { colors } from '../lib/theme';
import { EXPERIENCE_LEVELS, GENRES, type ExperienceLevel, type Genre, type Region } from '../lib/onboarding/types';
import { useRequest } from '../lib/onboarding/use-request';
import { hasRegion, MAX_REGIONS, validateTimeWindow } from '../lib/onboarding/validation';

/** 있으면 빼고 없으면 넣은 새 배열. 원래 배열은 고치지 않는다. */
function toggle<T>(items: readonly T[], value: T): readonly T[] {
  return items.includes(value) ? items.filter((item) => item !== value) : [...items, value];
}

interface RegionEditorProps {
  regions: readonly Region[];
  onChange: (next: readonly Region[]) => void;
}

/** 시·구를 적어 하나씩 더하고, 칩을 누르면 뺀다. 최대 20개(계약 §5). */
function RegionEditor({ regions, onChange }: RegionEditorProps) {
  const [sido, setSido] = useState('서울');
  const [gu, setGu] = useState('');
  const candidate: Region = { sido: sido.trim(), gu: gu.trim() };
  const canAdd =
    candidate.sido.length > 0 && candidate.gu.length > 0 && regions.length < MAX_REGIONS && !hasRegion(regions, candidate);

  const handleAdd = () => {
    onChange([...regions, candidate]);
    setGu('');
  };

  return (
    <View>
      <View style={onboardingStyles.row}>
        {regions.map((region) => (
          <Chip
            key={`${region.sido}-${region.gu}`}
            label={`${region.gu} ✕`}
            selected
            onPress={() => onChange(regions.filter((item) => item !== region))}
          />
        ))}
      </View>
      <Field label="시·도" value={sido} onChangeText={setSido} placeholder="서울" />
      <Field label="구" value={gu} onChangeText={setGu} placeholder="강남구" onSubmitEditing={canAdd ? handleAdd : undefined} />
      {canAdd ? <SecondaryButton label="+ 지역 추가" onPress={handleAdd} /> : null}
    </View>
  );
}

export default function PreferencesScreen() {
  const router = useRouter();
  const load = useRequest();
  const save = useRequest();
  const [genres, setGenres] = useState<readonly Genre[]>([]);
  const [regions, setRegions] = useState<readonly Region[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [level, setLevel] = useState<ExperienceLevel | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);

  // 지금 저장된 취향으로 칸을 채운다. 화면이 닫히면 요청을 끊는다.
  const runLoad = load.run;
  useEffect(() => {
    const controller = new AbortController();
    void runLoad(() => fetchMe(controller.signal)).then((member) => {
      if (!member || controller.signal.aborted) {
        return;
      }
      setGenres(member.profile.interestGenres);
      setRegions(member.profile.regions);
      setFrom(member.profile.availableFrom ?? '');
      setTo(member.profile.availableTo ?? '');
      setLevel(member.profile.experienceLevel);
    });
    return () => controller.abort();
  }, [runLoad]);

  const handleSubmit = async () => {
    const problem = genres.length === 0 ? '관심 장르를 하나 이상 골라 주세요.' : validateTimeWindow(from.trim(), to.trim());
    setInputError(problem);
    if (problem) {
      return;
    }
    const member = await save.run(() =>
      saveProfile({
        interestGenres: genres,
        regions,
        availableFrom: from.trim() || null,
        availableTo: to.trim() || null,
        experienceLevel: level,
      }),
    );
    if (member) {
      router.replace(nextOnboardingRoute(member));
    }
  };

  const footer = (
    <PrimaryButton label="다음 · 기준 장르" onPress={handleSubmit} disabled={genres.length === 0} loading={save.loading} />
  );

  return (
    <OnboardingScreen
      step="3 / 4"
      title="어떤 춤에 끌리세요?"
      subtitle="여러 개 골라도 돼요. 추천에만 쓰이고 언제든 바꿀 수 있어요."
      footer={footer}
    >
      {load.loading ? <ActivityIndicator color={colors.brown} accessibilityLabel="저장된 취향을 불러오는 중" /> : null}
      <SectionLabel text="관심 장르" hint="필수 · 여러 개 선택" />
      <View style={onboardingStyles.row}>
        {GENRES.map((genre) => (
          <Chip
            key={genre}
            label={GENRE_LABELS[genre].name}
            selected={genres.includes(genre)}
            onPress={() => setGenres((previous) => toggle(previous, genre))}
          />
        ))}
      </View>
      <SectionLabel text="활동 지역" hint={`선택 · 최대 ${MAX_REGIONS}개`} />
      <RegionEditor regions={regions} onChange={setRegions} />
      <SectionLabel text="활동 가능 시간" hint="선택 · 시작과 끝을 함께 넣어요" />
      <Field label="부터" value={from} onChangeText={setFrom} placeholder="19:00" keyboardType="numbers-and-punctuation" maxLength={5} />
      <Field label="까지" value={to} onChangeText={setTo} placeholder="22:30" keyboardType="numbers-and-punctuation" maxLength={5} />
      <SectionLabel text="경험 수준" hint="선택 · 다시 누르면 해제" />
      <View style={onboardingStyles.row} accessibilityRole="radiogroup">
        {EXPERIENCE_LEVELS.map((value) => (
          <Chip
            key={value}
            kind="radio"
            label={EXPERIENCE_LABELS[value]}
            selected={level === value}
            onPress={() => setLevel((previous) => (previous === value ? null : value))}
          />
        ))}
      </View>
      <Text style={onboardingStyles.muted}>{load.error ? '저장된 취향을 불러오지 못했어요. 새로 입력해도 돼요.' : ''}</Text>
      <ErrorBox message={inputError ?? save.error} />
    </OnboardingScreen>
  );
}
