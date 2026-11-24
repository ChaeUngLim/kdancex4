/**
 * 카드 모음(보드 M26 · 비어 있으면 C24A) — S6-3.8(앱 회원 레벨 카드 화면). 주소는 `/my/level-cards`, 입구는 마이 › 레벨 카드.
 *   요구: spec FR-169f(카드 모음 화면) · FR-169c(레벨 성장 캐릭터) · FR-169e(카드 안 세부 장르는 영어) · FR-161(단계 이름)
 *
 * 화면 구성(위에서부터):
 *   ① 받은 장수(「13장」)
 *   ② 세부 장르 거르기 칩 — 「전체」 + 카드가 있는 세부 장르(영어 이름)
 *   ③ 세부 장르마다 섹션: 「Samba · 댄스스포츠 라틴」 + 오른쪽 「지금 Lv.10 (댄서) · 10장」, 그 아래 3열 카드
 *      카드 = 위 캐릭터 그림 + 아래 「Lv.N」과 단계 태그. 지금 레벨 카드는 웜토프 테두리와 그림 위 「지금」 태그
 * 카드가 한 장도 없으면 C24A 빈 안내(첫 카드를 받는 조건 문구 + 수업 찾기)를 보인다.
 *
 * 데이터는 `GET /api/me/level-cards`(계약 14 §5) 하나다. 「지금」 표시도 서버가 정한 isCurrent 를 그대로 쓴다.
 * 카드에는 세부 장르 · 레벨 · 단계 이름만 적는다 — 그 밖의 레벨 설명 글은 쓰지 않는다(FR-169c).
 *
 * 이 Task 에서 하지 않은 것: 카드 크게 보기·대표 캐릭터 고르기(M26B, `PUT /api/me/featured-level-card`),
 * C24A 의 「지금 듣는 수업」 막대(읽을 API 가 아직 없다). 그래서 카드는 눌리지 않는다.
 */
import { useState } from 'react';
import { router } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { DetailScreen, ErrorView, LoadingView, PrimaryButton } from '../../lib/catalog/ui';
import { useApiResource } from '../../lib/catalog/use-api-resource';
import { levelCardArt } from '../../lib/levels/level-card-art';
import {
  genreNameEn,
  groupLevelCards,
  levelText,
  type LevelCard,
  type LevelCardsPage,
  type LevelDetailGenre,
} from '../../lib/levels/level-cards-view';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';

// 보드 M26 · FR-169e 의 카드 색 — 웜토프 테두리(지금 레벨 카드)와 단계 태그 바탕
const CARD_EDGE = '#C9B9A4';
const STAGE_TAG_BG = '#EDE6DA';

export default function LevelCardsScreen() {
  const { state, reload } = useApiResource<LevelCardsPage>('/api/me/level-cards');
  // 거르기 칩 — null 이면 「전체」. 칩을 누를 때 바로 바꾼다(불러오기는 다시 하지 않는다 — 카드는 이미 다 받았다)
  const [filter, setFilter] = useState<LevelDetailGenre | null>(null);

  if (state.status === 'loading') {
    return (
      <DetailScreen title="카드 모음" tab="my">
        <LoadingView />
      </DetailScreen>
    );
  }
  if (state.status === 'error') {
    return (
      <DetailScreen title="카드 모음" tab="my">
        <ErrorView error={state.error} onRetry={reload} />
      </DetailScreen>
    );
  }

  const cards = state.data.items;
  // 렌더 중에 바로 묶는다 — 칩을 바꾸면 다음 렌더에서 섹션도 따라 바뀐다
  const sections = groupLevelCards(cards);
  const shown = filter === null ? sections : sections.filter((s) => s.genre === filter);

  return (
    <DetailScreen title="카드 모음" tab="my">
      <Text style={styles.count} accessibilityLabel={`받은 카드 ${cards.length}장`}>
        {cards.length}장
      </Text>
      {cards.length === 0 ? (
        <EmptyCollection />
      ) : (
        <>
          <View style={styles.chips} accessibilityRole="tablist">
            <FilterChip label="전체" selected={filter === null} onPress={() => setFilter(null)} />
            {sections.map((s) => (
              <FilterChip key={s.genre} label={genreNameEn(s.genre)} selected={filter === s.genre} onPress={() => setFilter(s.genre)} />
            ))}
          </View>
          {shown.map((section) => (
            <View key={section.genre} style={styles.section}>
              <View style={styles.sectionHead}>
                <Text style={styles.sectionTitle} accessibilityRole="header" numberOfLines={1}>
                  {section.title}
                </Text>
                <Text style={styles.sectionMeta}>
                  {section.current === null ? '' : `지금 ${levelText(section.current.level, section.current.stageLabel)} · `}
                  {section.cards.length}장
                </Text>
              </View>
              <View style={styles.grid}>
                {section.cards.map((card) => (
                  <CardTile key={card.cardId} card={card} />
                ))}
              </View>
            </View>
          ))}
        </>
      )}
    </DetailScreen>
  );
}

function FilterChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.chip, selected && styles.chipOn]}
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      hitSlop={6}
    >
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

/** 카드 한 장(보드 M26 의 106×150 칸 — 위 그림, 아래 레벨과 단계 태그) */
function CardTile({ card }: { card: LevelCard }) {
  const art = levelCardArt(card.characterKey);
  const label = `${genreNameEn(card.detailGenre)} ${levelText(card.level, card.stageLabel)}${card.isCurrent ? ', 지금 레벨 카드' : ''}`;
  return (
    <View style={[styles.tile, card.isCurrent && styles.tileCurrent]} accessible accessibilityLabel={label}>
      <View style={styles.artBox}>
        {art !== null && <Image source={art} style={styles.art} resizeMode="cover" />}
        {card.isCurrent && (
          <View style={styles.nowTag}>
            <Text style={styles.nowText}>지금</Text>
          </View>
        )}
      </View>
      <View style={styles.tileFoot}>
        <Text style={styles.tileLevel}>Lv.{card.level}</Text>
        <View style={styles.stageTag}>
          <Text style={styles.stageText}>{card.stageLabel}</Text>
        </View>
      </View>
    </View>
  );
}

/**
 * 카드가 없을 때(보드 C24A). 문구는 spec FR-169a 화면 절의 2026-11-19 결정 그대로 —
 * 첫 카드를 받는 조건 한 줄과 결석이 출석에 반영된다는 한 줄. 출석 숫자는 쓰지 않는다(D7).
 */
function EmptyCollection() {
  return (
    <>
      <View style={styles.empty}>
        <View style={styles.emptyIcon}>
          <Text style={styles.emptyStar}>★</Text>
        </View>
        <Text style={styles.emptyTitle}>아직 받은 카드가 없어요</Text>
        <Text style={styles.emptyBody}>정기 수업 하나를 끝까지 마치고 출석 70% 이상이면 첫 등급 카드를 받아요</Text>
        <Text style={styles.emptyHint}>결석으로 표시되면 출석에 반영돼요</Text>
      </View>
      <Text style={styles.footNote}>카드는 세부 장르마다 따로 자라요 — Samba 카드는 쌈바 수업으로만 받아요.</Text>
      <PrimaryButton label="수업 찾기" onPress={() => router.navigate('/home')} />
    </>
  );
}

const styles = StyleSheet.create({
  count: { alignSelf: 'flex-end', fontSize: font.small, fontWeight: '700', color: colors.ink3 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.brownSoft, borderColor: CARD_EDGE },
  chipText: { fontSize: font.small, color: colors.ink },
  chipTextOn: { fontWeight: '800' },
  section: { gap: space.sm },
  sectionHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.sm },
  sectionTitle: { flexShrink: 1, fontSize: 15, fontWeight: '800', color: colors.ink },
  sectionMeta: { fontSize: font.small, color: colors.ink3 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  // 3열 — 간격 두 칸을 뺀 폭의 1/3 쯤
  tile: {
    width: '31.5%',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  tileCurrent: { borderWidth: 1.5, borderColor: CARD_EDGE },
  artBox: { height: 112, backgroundColor: '#E9E3DA' },
  art: { width: '100%', height: '100%' },
  nowTag: {
    position: 'absolute',
    top: space.xs,
    right: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.night,
  },
  nowText: { fontSize: font.tiny, fontWeight: '800', color: '#FFFFFF' },
  tileFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.sm, minHeight: 38 },
  tileLevel: { fontSize: font.body, fontWeight: '800', color: colors.ink },
  stageTag: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm, backgroundColor: STAGE_TAG_BG },
  stageText: { fontSize: font.tiny, fontWeight: '700', color: colors.ink },
  empty: {
    alignItems: 'center',
    gap: space.sm,
    padding: space.xl,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  emptyIcon: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: MIN_TOUCH / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.brownSoft,
  },
  emptyStar: { fontSize: 20, color: colors.brown },
  emptyTitle: { fontSize: 17, fontWeight: '800', color: colors.ink },
  emptyBody: { fontSize: font.body, color: colors.ink, textAlign: 'center', lineHeight: 20 },
  emptyHint: { fontSize: font.small, color: colors.ink3, textAlign: 'center' },
  footNote: { fontSize: font.small, color: colors.ink3 },
});
