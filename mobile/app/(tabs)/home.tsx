/**
 * 홈 — 내 기준 장르의 수업 목록(보드 M7, `02-catalog.md` §1).
 *
 * 목록은 「정렬」이 아니라 「거르기」다(Q1(홈 목록: 거르기 vs 정렬) 결정). 거르는 조건은
 * 쿼리가 아니라 서버가 내 프로필에서 읽는다 — 장르는 FR-022a(첫 화면 장르 선택·유지)의
 * 기준 장르 1개, 지역·시간대는 FR-022(사용자 프로필). 그래서 이 화면은 조건을 보내지 않는다.
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
import type { OfferingSummary, Page } from '../../lib/catalog/types';
import { CapacityBar, EmptyView, ErrorView, isSoldOut, LoadingView, PoolSummary, shared } from '../../lib/catalog/ui';
import { toApiError } from '../../lib/catalog/use-api-resource';

const PAGE_SIZE = 20;

interface FeedState {
  items: readonly OfferingSummary[];
  nextCursor: string | null;
  status: 'loading' | 'ready' | 'error' | 'refreshing' | 'loadingMore';
  error: ApiError | null;
}

const INITIAL: FeedState = { items: [], nextCursor: null, status: 'loading', error: null };

function pagePath(cursor: string | null): string {
  const cursorPart = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
  return `/api/home/offerings?limit=${PAGE_SIZE}${cursorPart}`;
}

/** 첫 장 불러오기·새로 고침·다음 장 이어 붙이기. 결과는 매번 새 객체로 갈아 끼운다. */
function useOfferingFeed() {
  const [feed, setFeed] = useState<FeedState>(INITIAL);
  const busy = useRef(false);

  const load = useCallback(async (mode: 'first' | 'refresh' | 'more', cursor: string | null) => {
    if (busy.current) {
      return;
    }
    busy.current = true;
    const status = mode === 'more' ? 'loadingMore' : mode === 'refresh' ? 'refreshing' : 'loading';
    setFeed((prev) => ({ ...prev, status, error: null }));
    try {
      const page = await apiFetch<Page<OfferingSummary>>(pagePath(cursor));
      const pageItems = page.items ?? [];
      setFeed((prev) => ({
        items: mode === 'more' ? [...prev.items, ...pageItems] : pageItems,
        nextCursor: page.nextCursor ?? null,
        status: 'ready',
        error: null,
      }));
    } catch (error: unknown) {
      setFeed((prev) => ({ ...prev, status: 'error', error: toApiError(error) }));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void load('first', null);
  }, [load]);

  const refresh = useCallback(() => void load('refresh', null), [load]);
  const loadMore = useCallback(() => {
    if (feed.nextCursor !== null && feed.status === 'ready') {
      void load('more', feed.nextCursor);
    }
  }, [feed.nextCursor, feed.status, load]);

  return { feed, refresh, loadMore };
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { feed, refresh, loadMore } = useOfferingFeed();
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
      <HomeHeader items={feed.items} />
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

function HomeHeader({ items }: { items: readonly OfferingSummary[] }) {
  // 응답에 기준 장르가 따로 오지 않아 첫 수업의 장르로 표시한다(summary 「계약 모호점」).
  const genre = items[0]?.genre;
  return (
    <View style={styles.header}>
      <Text style={shared.muted}>기준 장르</Text>
      <Text style={styles.headerTitle} accessibilityRole="header">
        {genre === undefined ? '오늘의 수업' : genreLabel(genre)}
      </Text>
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
        {item.academy?.name} · {item.academy?.regionGu} · {item.label} · {item.sessionCount}회
      </Text>
      <Text style={shared.muted}>첫 수업 {formatKstDateTime(item.firstSessionStartsAt)}</Text>
      <CapacityBar enrolled={item.capacity?.enrolled ?? 0} total={item.capacity?.total ?? 0} />
      <View style={styles.cardBottom}>
        <Text style={styles.price}>{formatWon(item.priceAmount)}</Text>
        <PoolSummary pools={item.capacity?.pools ?? []} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: 2 },
  headerTitle: { fontSize: font.h1 - 4, fontWeight: '800', color: colors.ink },
  list: { paddingHorizontal: space.lg, paddingBottom: space.xl, gap: space.md },
  inlineError: { color: colors.danger, fontSize: font.small, paddingHorizontal: space.lg },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  cardPressed: { opacity: 0.85 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  cardTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: colors.ink },
  cardBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' },
  price: { fontSize: 18, fontWeight: '800', color: colors.ink },
});
