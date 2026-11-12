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
 * 아직 다른 점: 카드 사진(FR-022a 사진 카드·3초 교차)은 mobile 에 이미지 자산이 없어 장르 색 면으로
 * 대신했다. 장르 테마 색 적용은 R7(보드와 화면 차이)로 미뤘다.
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ErrorBox, OnboardingScreen, PrimaryButton } from '../lib/onboarding/components';
import { HOME_ROUTE } from '../lib/onboarding/flow';
import { GENRE_LABELS } from '../lib/onboarding/labels';
import { saveBaseGenre } from '../lib/onboarding/members-api';
import { colors, genreColors, radius, space } from '../lib/theme';
import { GENRES, type Genre } from '../lib/onboarding/types';
import { useRequest } from '../lib/onboarding/use-request';

interface GenreCardProps {
  genre: Genre;
  selected: boolean;
  onSelect: (genre: Genre) => void;
}

function GenreCard({ genre, selected, onSelect }: GenreCardProps) {
  const { name, description } = GENRE_LABELS[genre];
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`${name}. ${description}`}
      accessibilityState={{ checked: selected }}
      onPress={() => onSelect(genre)}
      style={[styles.card, { backgroundColor: genreColors[genre] }, selected && styles.cardSelected]}
    >
      <View style={[styles.mark, selected && styles.markSelected]}>
        <Text style={styles.markText}>{selected ? '✓' : ''}</Text>
      </View>
      <Text style={styles.name}>{name}</Text>
      <Text style={styles.description}>{description}</Text>
    </Pressable>
  );
}

export default function BaseGenreScreen() {
  const router = useRouter();
  const { loading, error, run } = useRequest();
  const [genre, setGenre] = useState<Genre | null>(null);

  const handleSubmit = async () => {
    if (!genre) {
      return;
    }
    const member = await run(() => saveBaseGenre(genre));
    if (member) {
      router.replace(HOME_ROUTE);
    }
  };

  const label = genre ? `${GENRE_LABELS[genre].name}로 시작` : '장르를 하나 골라 주세요';

  return (
    <OnboardingScreen
      step="4 / 4"
      title={'메인에서 어떤 춤을\n먼저 볼까요?'}
      subtitle="하나만 골라요. 다음에 들어와도 유지되고, 메인에서 언제든 바꿀 수 있어요."
      footer={<PrimaryButton label={label} onPress={handleSubmit} disabled={!genre} loading={loading} />}
    >
      <View style={styles.grid} accessibilityRole="radiogroup">
        {GENRES.map((value) => (
          <GenreCard key={value} genre={value} selected={genre === value} onSelect={setGenre} />
        ))}
      </View>
      <ErrorBox message={error} />
    </OnboardingScreen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.md, marginTop: space.xl },
  card: {
    width: '48%',
    aspectRatio: 1,
    borderRadius: radius.lg,
    padding: space.md,
    justifyContent: 'flex-end',
    borderWidth: 3,
    borderColor: 'transparent',
  },
  cardSelected: { borderColor: colors.brown },
  mark: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markSelected: { backgroundColor: colors.brown, borderColor: colors.brown },
  markText: { color: colors.surface, fontWeight: '800' },
  name: { color: colors.surface, fontSize: 18, fontWeight: '800' },
  description: { color: colors.surface, fontSize: 12, lineHeight: 16, marginTop: space.xs },
});
