/**
 * 홈 — 내 기준 장르의 수업 목록(보드 M7, `02-catalog.md` §1).
 *
 * 목록은 「정렬」이 아니라 「거르기」다(Q1(홈 목록: 거르기 vs 정렬) 결정). 거르는 조건은
 * 쿼리가 아니라 서버가 내 프로필에서 읽는다 — 장르는 FR-022a(첫 화면 장르 선택·유지)의
 * 기준 장르 1개, 지역·시간대는 FR-022(사용자 프로필). 그래서 이 화면은 조건을 보내지 않는다.
 *
 * 정렬은 칩 3개(추천순·마감 임박·남은 자리, S3-2.2(시간대 필터·정렬))로 고르고 `?sort=` 로 보낸다.
 * 카드의 정원은 좌석 칸(SeatGrid)으로 보인다 — 남녀 정원은 「남 5/6 · 여 6/6 · 마감」, 단일 정원은 「9/12 · 3자리 남았어요」.
 *
 * 기준 장르가 없으면 서버가 409 `BASE_GENRE_REQUIRED` 를 준다 → 기준 장르 화면으로 안내.
 * 정원이 찬 수업도 목록에 남는다. 마감 표시는 `remaining` 으로 앱이 한다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { apiFetch, type ApiError } from '../../lib/api';
import { formatKstDateTime, formatWon, genreLabel } from '../../lib/catalog/format';
import { colors, font, radius, space } from '../../lib/theme';
import type { Genre, HomeSort, OfferingSummary, Page } from '../../lib/catalog/types';
import { SUB_GENRE_LABELS } from '../../lib/onboarding/labels';
import { fetchMe } from '../../lib/onboarding/members-api';
import type { SubGenre } from '../../lib/onboarding/types';
import { SeatGrid } from '../../lib/catalog/seat-grid';
import { EmptyView, ErrorView, isSoldOut, LoadingView, shared } from '../../lib/catalog/ui';
import { toApiError } from '../../lib/catalog/use-api-resource';
import { LevelUpOverlay } from '../../lib/levels/level-up-overlay';

const PAGE_SIZE = 20;

interface FeedState {
  items: readonly OfferingSummary[];
  nextCursor: string | null;
  status: 'loading' | 'ready' | 'error' | 'refreshing' | 'loadingMore';
  error: ApiError | null;
  /** 내 기준 장르(FR-022a). 홈 목록 응답에 없어 `GET /api/me` 에서 따로 읽는다 */
  baseGenre: Genre | null;
  /** 기준 장르 안의 세부 장르(FR-022a). null 이면 「전체」 — 제목 괄호 「(라틴)」에 쓴다 */
  baseSubGenre: SubGenre | null;
}

const INITIAL: FeedState = { items: [], nextCursor: null, status: 'loading', error: null, baseGenre: null, baseSubGenre: null };

/**
 * 정렬 칩 3개(보드 M7 「정렬 칩」, FR-036a(검색 결과 정렬 5종) 중 지금 서버가 받는 3종).
 * 추천순이 기본값이다. 거리순·인기순은 서버에 아직 없어 칩도 두지 않는다 — 눌러도 422 가 나는 칩을 보이지 않는다.
 */
const SORT_OPTIONS: readonly { value: HomeSort; label: string }[] = [
  { value: 'recommended', label: '추천순' },
  { value: 'deadline', label: '마감 임박' },
  { value: 'seats', label: '남은 자리' },
];

/** 커서는 정렬마다 따로라(계약 02 §1) 다음 장을 부를 때도 지금 정렬을 같이 보낸다. */
function pagePath(sort: HomeSort, cursor: string | null): string {
  const cursorPart = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
  return `/api/home/offerings?limit=${PAGE_SIZE}&sort=${sort}${cursorPart}`;
}

/**
 * 카드의 「기간 · N회」 글자. 서버가 만든 기간 이름(label)이 이미 「11/26~12/21 · 8회」처럼 회차 수로 끝나면
 * 그대로 쓰고, 「12월 기간」처럼 회차 수가 없을 때만 덧붙인다 — 예전에는 늘 덧붙여 「8회 · 8회」가 됐다(2026-11-25 발견).
 */
function periodText(item: OfferingSummary): string {
  // 「· 8회」처럼 구분점까지 맞춰 본다 — 그냥 「8회」로 끝나는지만 보면 「18회」도 맞다고 잘못 판정한다.
  const count = `${item.sessionCount}회`;
  return item.label.endsWith(` ${count}`) ? item.label : `${item.label} · ${count}`;
}

/** 첫 장 불러오기·새로 고침·다음 장 이어 붙이기. 결과는 매번 새 객체로 갈아 끼운다. */
function useOfferingFeed() {
  const [feed, setFeed] = useState<FeedState>(INITIAL);
  const [sort, setSort] = useState<HomeSort>('recommended');
  const busy = useRef(false);

  const load = useCallback(async (mode: 'first' | 'refresh' | 'more', cursor: string | null, sortBy: HomeSort) => {
    if (busy.current) {
      return;
    }
    busy.current = true;
    const status = mode === 'more' ? 'loadingMore' : mode === 'refresh' ? 'refreshing' : 'loading';
    setFeed((prev) => ({ ...prev, status, error: null }));
    try {
      // 첫 장·새로 고침 때는 기준 장르도 같이 읽는다(다른 화면에서 장르를 바꾸고 돌아와도 제목이 맞게).
      // 수업이 0개여도 「아르헨티나 탱고」처럼 내 장르가 제목에 보여야 해서 목록과 따로 받는다.
      // 내 정보(제목용)는 실패해도 목록은 보여 준다 — 그때는 이전 제목을 그대로 둔다(null).
      const [page, me] = await Promise.all([
        apiFetch<Page<OfferingSummary>>(pagePath(sortBy, cursor)),
        mode === 'more' ? Promise.resolve(null) : fetchMe().catch(() => null),
      ]);
      const pageItems = page.items ?? [];
      setFeed((prev) => ({
        items: mode === 'more' ? [...prev.items, ...pageItems] : pageItems,
        nextCursor: page.nextCursor ?? null,
        status: 'ready',
        error: null,
        baseGenre: me === null ? prev.baseGenre : me.baseGenre,
        baseSubGenre: me === null ? prev.baseSubGenre : me.baseSubGenre,
      }));
    } catch (error: unknown) {
      setFeed((prev) => ({ ...prev, status: 'error', error: toApiError(error) }));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void load('first', null, 'recommended');
  }, [load]);

  const refresh = useCallback(() => void load('refresh', null, sort), [load, sort]);
  const loadMore = useCallback(() => {
    if (feed.nextCursor !== null && feed.status === 'ready') {
      void load('more', feed.nextCursor, sort);
    }
  }, [feed.nextCursor, feed.status, load, sort]);

  /**
   * 정렬 칩을 눌렀을 때 — 이벤트 처리기 안에서 바로 첫 장을 다시 부른다(효과 훅으로 sort 변화를 지켜보지 않는다).
   * 앞 요청이 아직 도는 중이면 칩도 바꾸지 않는다. 칩만 바뀌고 목록은 옛 정렬로 남는 어긋남을 막는다.
   */
  const changeSort = useCallback(
    (next: HomeSort) => {
      if (next === sort || busy.current) {
        return;
      }
      setSort(next);
      void load('refresh', null, next);
    },
    [load, sort],
  );

  return { feed, sort, changeSort, refresh, loadMore };
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { feed, sort, changeSort, refresh, loadMore } = useOfferingFeed();
  const firstFocus = useRef(true);

  // 결제 대기·취소 뒤 돌아오면 남은 자리 수가 바뀌었을 수 있어 다시 읽는다.
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      refresh();
    }, [refresh]),
  );

  const renderItem = useCallback(({ item }: { item: OfferingSummary }) => <OfferingCard item={item} />, []);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <HomeHeader baseGenre={feed.baseGenre} baseSubGenre={feed.baseSubGenre} />
      <SortChips sort={sort} onChange={changeSort} />
      <FeedBody feed={feed} onRetry={refresh} />
      {feed.items.length > 0 && (
        <FlatList
          data={feed.items}
          keyExtractor={(item) => item.offeringId}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          refreshControl={<RefreshControl refreshing={feed.status === 'refreshing'} onRefresh={refresh} />}
          ListFooterComponent={feed.status === 'loadingMore' ? <LoadingView label="더 불러오는 중" /> : undefined}
        />
      )}
      {/* 받지 않은 레벨 카드·강사 승급 안내가 있으면 홈 위에 등급 연출을 덮는다(S6-3.10, FR-169e) */}
      <LevelUpOverlay />
    </View>
  );
}

/** 목록이 비었을 때만 보이는 상태(첫 로딩·오류·빈 목록). 목록이 있으면 아무것도 그리지 않는다. */
function FeedBody({ feed, onRetry }: { feed: FeedState; onRetry: () => void }) {
  if (feed.items.length > 0) {
    return feed.error !== null ? <Text style={styles.inlineError}>{feed.error.detail}</Text> : null;
  }
  if (feed.status === 'loading' || feed.status === 'refreshing') {
    return <LoadingView />;
  }
  if (feed.error !== null) {
    return <ErrorView error={feed.error} onRetry={onRetry} />;
  }
  return <EmptyView title="조건에 맞는 수업이 아직 없어요" hint="관심 지역·가능 시간대를 넓히면 더 보여요." />;
}

interface HomeHeaderProps {
  baseGenre: Genre | null;
  baseSubGenre: SubGenre | null;
}

function HomeHeader({ baseGenre, baseSubGenre }: HomeHeaderProps) {
  // 제목은 내 기준 장르(GET /api/me). 예전에는 첫 수업의 장르를 써서, 그 장르 수업이 0개면 「오늘의 수업」이 떴다.
  // 세부 장르가 있으면 「댄스스포츠(라틴)」 — 괄호 부분은 조금 작게(spec FR-022a)
  const subLabel = baseSubGenre === null ? null : SUB_GENRE_LABELS[baseSubGenre];

  // 「장르 바꾸기」 — 기준 장르 화면으로 가면서 지금 값을 주소로 넘겨 미리 골라 두게 한다.
  // 저장하고 돌아오면 아래 useFocusEffect 가 목록과 제목을 새로 읽는다
  const openGenrePicker = () =>
    router.push({
      pathname: '/base-genre',
      params: { from: 'home', genre: baseGenre ?? '', sub: baseSubGenre ?? '' },
    });

  return (
    <View style={styles.headerRow}>
      <View style={styles.header}>
        <Text style={shared.muted}>기준 장르</Text>
        <View style={styles.titleRow}>
          <Text style={styles.headerTitle} accessibilityRole="header">
            {baseGenre === null ? '오늘의 수업' : genreLabel(baseGenre)}
            {subLabel !== null && <Text style={styles.headerSub}>({subLabel})</Text>}
          </Text>
          <Pressable
            style={styles.changeGenre}
            onPress={openGenrePicker}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="장르 바꾸기"
          >
            <Text style={styles.changeGenreText}>장르 바꾸기</Text>
          </Pressable>
        </View>
      </View>
      {/* 알림함(보드 M21) 들어가는 곳 — 홈 머리 오른쪽 */}
      <Pressable
        style={styles.bell}
        onPress={() => router.push('/notifications')}
        accessibilityRole="button"
        accessibilityLabel="알림함 열기"
      >
        <Text style={styles.bellText}>알림</Text>
      </Pressable>
    </View>
  );
}

/** 정렬 칩 줄. 고른 칩은 플럼 테두리·옅은 바탕, 나머지는 흰 바탕(보드 M7 칩 규칙) */
function SortChips({ sort, onChange }: { sort: HomeSort; onChange: (next: HomeSort) => void }) {
  return (
    <View style={styles.sortRow} accessibilityRole="radiogroup" accessibilityLabel="정렬">
      {SORT_OPTIONS.map((option) => {
        const selected = option.value === sort;
        return (
          <Pressable
            key={option.value}
            style={[styles.sortChip, selected && styles.sortChipOn]}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
          >
            <Text style={[styles.sortText, selected && styles.sortTextOn]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function OfferingCard({ item }: { item: OfferingSummary }) {
  const soldOut = isSoldOut(item.capacity?.pools ?? []);
  const open = () => router.push(`/offering/${encodeURIComponent(item.offeringId)}`);
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${item.academy?.name ?? ''}${soldOut ? ', 마감' : ''}`}
    >
      <View style={styles.cardTop}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {item.title}
        </Text>
        {soldOut && <Text style={[shared.tag, shared.tagClosed]}>마감</Text>}
      </View>
      <Text style={shared.muted}>
        {item.academy?.name} · {item.academy?.regionGu} · {periodText(item)}
      </Text>
      <Text style={shared.muted}>첫 수업 {formatKstDateTime(item.firstSessionStartsAt)}</Text>
      {/* 정원 좌석 칸 — 남녀 정원은 남·여 두 덩어리, 단일 정원은 한 줄(보드 M7 카드 · spec 2026-10-05) */}
      <SeatGrid pools={item.capacity?.pools ?? []} size="small" />
      <View style={styles.cardBottom}>
        <Text style={styles.price}>{formatWon(item.priceAmount)}</Text>
        {item.capacity?.pools?.length === 1 && item.capacity.pools[0]?.seatKind === 'any' && (
          <Text style={[shared.tag, shared.tagWarn]}>남녀 구분 없음</Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingRight: space.md },
  header: { flex: 1, paddingHorizontal: space.lg, paddingVertical: space.md, gap: 2 },
  bell: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  bellText: { fontSize: font.small, fontWeight: '700', color: colors.brown },
  headerTitle: { fontSize: font.h1 - 4, fontWeight: '800', color: colors.ink, flexShrink: 1 },
  // 제목 괄호 「(라틴)」 — 제목보다 작게(spec FR-022a)
  headerSub: { fontSize: font.h2 - 2, fontWeight: '700', color: colors.ink },
  titleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: space.sm },
  changeGenre: {
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
  },
  changeGenreText: { fontSize: font.small, fontWeight: '700', color: colors.brown },
  list: { paddingHorizontal: space.lg, paddingBottom: space.xl, gap: space.md },
  sortRow: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  sortChip: {
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  sortChipOn: { borderColor: colors.brown, borderWidth: 1.5, backgroundColor: colors.brownSoft },
  sortText: { fontSize: font.small, color: colors.ink },
  sortTextOn: { color: colors.brown, fontWeight: '700' },
  inlineError: { color: colors.danger, fontSize: font.small, paddingHorizontal: space.lg },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  cardPressed: { opacity: 0.85 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  cardTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: colors.ink },
  cardBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' },
  price: { fontSize: 18, fontWeight: '800', color: colors.ink },
});
