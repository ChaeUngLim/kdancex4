/**
 * 기준 장르 고르기 화면 — T-A5-2(가입·취향 화면 5종) 중 5번째.
 *
 * FR-022a(첫 화면 장르 선택·유지): 가입을 마친 뒤 처음 들어오면 메인 화면의 기준 장르를
 * **딱 하나** 고른다. 고르기 전에는 넘어가지 않고, 「잘 모르겠어요」 같은 건너뛰기도 두지 않는다.
 * 카드는 2×2 4장이고 장르 이름·한 줄 설명을 글자로 넣는다(화면 낭독기도 고를 수 있게).
 *
 * 계약 §6 `PUT /api/me/base-genre`. 서버도 기준 장르가 없으면 홈 목록에 409 `BASE_GENRE_REQUIRED`
 * 를 내므로, 화면을 건너뛰어도 홈 데이터는 열리지 않는다.
 *
 * 세부 장르(2026-11-25): 댄스스포츠·살사/바차타 카드를 고르면 아래에 칩 줄(전체·라틴·스탠다드 /
 * 전체·살사·바차타)이 나온다. 기본값은 「전체」이고 안 골라도 진행된다. 탱고·스윙은 칩이 없다.
 *
 * 들어오는 길은 둘이다 — ① 가입 직후 첫 선택(온보딩, 저장하면 홈으로 갈아 끼움)
 * ② 홈 머리말의 「장르 바꾸기」(`from=home` 과 지금 값 `genre`·`sub` 을 주소로 받아 미리 골라 두고,
 * 저장하면 뒤로 돌아간다 — 홈은 다시 보일 때 목록·제목을 새로 읽는다).
 *
 * 사진 카드(2026-11-25, 보드 M6 「메인 기준 장르 (B · 3초 전환)」): 카드는 장르 사진이고, 댄스스포츠는
 * 라틴(쌈바)↔스탠다드(비엔나왈츠), 살사/바차타는 살사↔바차타 사진이 3초마다 번갈아 나온다
 * (lib/onboarding/genre-photo-card.tsx). **카드를 누른 순간 보이던 사진의 세부 장르가 골라진다** —
 * 화면이 바뀌는 걸 보고 원하는 순간에 누르는 방식이다. 골라진 카드는 그 사진에서 멈추고, 아래 칩도 같이 바뀐다.
 * 칩으로 「전체」를 고르면 카드는 다시 번갈아 돈다. 더블 탭이면 그 세부 장르로 바로 저장하고 홈으로 간다(spec).
 *
 * 아직 다른 점: 장르 테마 색(사진마다 화면 색 바꾸기)은 R7(보드와 화면 차이)로 미뤘다.
 */
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ErrorBox, OnboardingScreen, PrimaryButton } from '../lib/onboarding/components';
import { HOME_ROUTE } from '../lib/onboarding/flow';
import { GenrePhotoCard } from '../lib/onboarding/genre-photo-card';
import { GENRE_LABELS, SUB_GENRE_LABELS } from '../lib/onboarding/labels';
import { saveBaseGenre } from '../lib/onboarding/members-api';
import { colors, font, MIN_TOUCH, radius, space } from '../lib/theme';
import { GENRES, SUB_GENRES_OF, type Genre, type SubGenre } from '../lib/onboarding/types';
import { useRequest } from '../lib/onboarding/use-request';

/** 같은 카드를 이 시간 안에 두 번 누르면 더블 탭으로 본다 */
const DOUBLE_TAP_MS = 400;

interface SubGenreChipsProps {
  genre: Genre;
  sub: SubGenre | null;
  onSelect: (sub: SubGenre | null) => void;
}

/** 세부 장르 칩 줄 — 「전체」(null) + 그 장르의 세부 장르. 세부 장르가 없는 장르면 아무것도 그리지 않는다. */
function SubGenreChips({ genre, sub, onSelect }: SubGenreChipsProps) {
  const options = SUB_GENRES_OF[genre];
  if (options.length === 0) {
    return null;
  }
  const chips: readonly { value: SubGenre | null; label: string }[] = [
    { value: null, label: '전체' },
    ...options.map((value) => ({ value, label: SUB_GENRE_LABELS[value] })),
  ];
  return (
    <View style={styles.subBlock}>
      <Text style={styles.subTitle}>{GENRE_LABELS[genre].name} 안에서 먼저 볼 것</Text>
      <View style={styles.subRow} accessibilityRole="radiogroup" accessibilityLabel="세부 장르">
        {chips.map((chip) => {
          const selected = chip.value === sub;
          return (
            <Pressable
              key={chip.label}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              onPress={() => onSelect(chip.value)}
              style={[styles.subChip, selected && styles.subChipOn]}
            >
              <Text style={[styles.subText, selected && styles.subTextOn]}>{chip.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** 주소로 받은 글자가 진짜 장르 값일 때만 쓴다(주소는 아무나 바꿀 수 있어 그대로 믿지 않는다) */
function parseGenre(raw: unknown): Genre | null {
  return GENRES.find((g) => g === raw) ?? null;
}

/** 주소로 받은 세부 장르가 그 장르에 속할 때만 쓴다. 아니면 「전체」 */
function parseSubGenre(genre: Genre | null, raw: unknown): SubGenre | null {
  if (genre === null) {
    return null;
  }
  return SUB_GENRES_OF[genre].find((s) => s === raw) ?? null;
}

export default function BaseGenreScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ from?: string; genre?: string; sub?: string }>();
  // 홈의 「장르 바꾸기」로 왔나. 그렇다면 지금 값을 미리 골라 두고, 저장 뒤 뒤로 돌아간다
  const fromHome = params.from === 'home';
  const { loading, error, run } = useRequest();
  // 처음 그릴 때 한 번만 주소 값으로 채운다(useState 의 초기값 함수 — 효과 훅 없이 미리 선택)
  const [genre, setGenre] = useState<Genre | null>(() => parseGenre(params.genre));
  const [sub, setSub] = useState<SubGenre | null>(() => parseSubGenre(parseGenre(params.genre), params.sub));

  // 바로 전에 누른 카드와 시각 — 더블 탭을 알아보려고 둔다(다시 그릴 필요가 없어 상태가 아니라 ref)
  const lastTap = useRef<{ genre: Genre; at: number } | null>(null);

  // 저장하고 화면을 나간다. 아래 버튼과 더블 탭이 같이 쓴다
  const submit = async (chosen: Genre, chosenSub: SubGenre | null) => {
    const member = await run(() => saveBaseGenre(chosen, chosenSub));
    if (!member) {
      return;
    }
    // 홈에서 왔으면 뒤로(홈이 다시 보이며 새로 읽는다), 첫 선택이면 홈으로 갈아 끼운다(뒤로 가기로 가입 화면에 못 돌아가게)
    if (fromHome && router.canGoBack()) {
      router.back();
    } else {
      router.replace(HOME_ROUTE);
    }
  };

  /**
   * 카드를 눌렀을 때 — 그 순간 보이던 사진의 세부 장르(visibleSub)를 함께 받는다.
   * 한 번 누르면 그 장르·세부 장르를 고르고(카드는 그 사진에서 멈춘다), 같은 카드를 곧바로 한 번 더 누르면
   * 그대로 저장하고 홈으로 간다(spec FR-022a 「두 번 탭하면 메인으로 바로 간다」).
   */
  const handleCardPress = (next: Genre, visibleSub: SubGenre | null) => {
    const now = Date.now();
    const previous = lastTap.current;
    const isDoubleTap = previous !== null && previous.genre === next && now - previous.at < DOUBLE_TAP_MS;
    lastTap.current = isDoubleTap ? null : { genre: next, at: now };
    setGenre(next);
    setSub(visibleSub);
    if (isDoubleTap && !loading) {
      void submit(next, visibleSub);
    }
  };

  const handleSubmit = () => {
    if (genre) {
      void submit(genre, sub);
    }
  };

  const chosenName = genre ? `${GENRE_LABELS[genre].name}${sub ? `(${SUB_GENRE_LABELS[sub]})` : ''}` : null;
  const label = chosenName === null ? '장르를 하나 골라 주세요' : fromHome ? `${chosenName}로 바꾸기` : `${chosenName}로 시작`;

  return (
    <OnboardingScreen
      step={fromHome ? undefined : '4 / 4'}
      title={fromHome ? '메인 장르 바꾸기' : '메인에서 어떤 춤을\n먼저 볼까요?'}
      subtitle="하나만 골라요. 다음에 들어와도 유지되고, 메인에서 언제든 바꿀 수 있어요."
      footer={<PrimaryButton label={label} onPress={handleSubmit} disabled={!genre} loading={loading} />}
    >
      {/* 홈에서 왔을 때만 머리말(← 뒤로)을 켠다 — 바꾸지 않고 그냥 나갈 길. 첫 선택(가입 직후)은 고르기 전에 못 나가게 그대로 숨긴다 */}
      <Stack.Screen options={{ headerShown: fromHome, title: '' }} />
      <View style={styles.grid} accessibilityRole="radiogroup">
        {GENRES.map((value) => (
          <GenrePhotoCard
            key={value}
            genre={value}
            role="radio"
            selected={genre === value}
            // 고른 카드만 고른 세부 장르 사진에서 멈춘다. 「전체」(null)면 계속 번갈아 돈다
            lockedSub={genre === value ? sub : null}
            onPress={handleCardPress}
          />
        ))}
      </View>
      {genre ? <SubGenreChips genre={genre} sub={sub} onSelect={setSub} /> : null}
      <ErrorBox message={error} />
    </OnboardingScreen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.md, marginTop: space.xl },
  subBlock: { marginTop: space.lg, gap: space.sm },
  subTitle: { color: colors.ink, fontSize: font.body, fontWeight: '700' },
  subRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  subChip: {
    minHeight: MIN_TOUCH,
    minWidth: 72,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subChipOn: { borderColor: colors.brown, backgroundColor: colors.brownSoft },
  subText: { color: colors.ink, fontSize: font.body, fontWeight: '600' },
  subTextOn: { color: colors.brown, fontWeight: '800' },
});
