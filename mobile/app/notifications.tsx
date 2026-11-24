/**
 * 회원 알림함(보드 M21 · M21E, 계약 04 §2 `GET /api/me/notifications`).
 *
 * 위에 종류 칩(전체 · 수업 · 결제·쿠폰 · 학원 소식 · 대기), 아래에 `오늘 · 어제 · 이번 주` 묶음 카드.
 * 읽지 않은 알림은 굵은 제목 + 연한 아이보리 바탕 + 오른쪽 플럼 점으로 구별한다(색만이 아니라 글자 굵기·점·읽기 이름표로).
 * 할 일이 있는 알림은 플럼 글씨 행동 문구를 붙이고, 누르면 그 화면으로 간다.
 *
 * 칩은 서버에 다시 묻지 않고 받은 목록 안에서 `kind` 로 거른다 — 회원 알림함 경로에는 칩 쿼리가 없다
 * (계약 04 §2 · 열린 점 ⑨). 「모두 읽음」도 같은 이유로 아직 없다 — 읽음 경로는 계약이 범위 밖으로 둔 채다.
 * 줄 글자·묶음 계산은 `lib/me/notifications-view.ts` 에 있다.
 */
import { useState } from 'react';
import { router, type Href } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { apiFetch } from '../lib/api';
import type { MemberNotification } from '../lib/catalog/types';
import { Card, DetailScreen, ErrorView, InlineError, LoadingView, SecondaryButton, shared } from '../lib/catalog/ui';
import { toApiError, useApiResource } from '../lib/catalog/use-api-resource';
import {
  filterByChip,
  groupNotifications,
  NOTIFICATION_CHIPS,
  type NotificationChip,
  type NotificationIcon,
  type NotificationRowView,
} from '../lib/me/notifications-view';
import { colors, font, MIN_TOUCH, radius, space } from '../lib/theme';

const PAGE_SIZE = 20;

interface NotificationsPage {
  items: readonly MemberNotification[];
  nextCursor: string | null;
}

/** 종류별 아이콘 원의 바탕색·글자(보드 M21 — 일정·변경·대기·결제·학원 소식). */
const ICONS: Readonly<Record<NotificationIcon, { bg: string; fg: string; glyph: string }>> = {
  schedule: { bg: '#E6ECF8', fg: colors.info, glyph: '일' },
  change: { bg: colors.dangerSoft, fg: colors.danger, glyph: '!' },
  waitlist: { bg: '#F3ECE0', fg: '#8A6A3A', glyph: '대' },
  payment: { bg: '#EEE9E4', fg: colors.ink, glyph: '₩' },
  academy: { bg: '#EFE6F1', fg: colors.brown, glyph: '학' },
  other: { bg: colors.line, fg: colors.ink3, glyph: '·' },
};

export default function NotificationsScreen() {
  const [chip, setChip] = useState<NotificationChip>('all');
  const { state, reload } = useApiResource<NotificationsPage>(`/api/me/notifications?limit=${PAGE_SIZE}`);
  const [more, setMore] = useState<{ items: readonly MemberNotification[]; cursor: string | null } | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  if (state.status === 'loading') {
    return (
      <DetailScreen title="알림" tab="home">
        <LoadingView />
      </DetailScreen>
    );
  }
  if (state.status === 'error') {
    return (
      <DetailScreen title="알림" tab="home">
        <ErrorView error={state.error} onRetry={reload} />
      </DetailScreen>
    );
  }

  const all = [...state.data.items, ...(more?.items ?? [])];
  const cursor = more === null ? state.data.nextCursor : more.cursor;
  // 렌더 중에 바로 계산한다 — 칩·시각이 바뀌면 다음 렌더에서 다시 나눈다
  const groups = groupNotifications(filterByChip(all, chip), new Date());

  /** 「더 보기」 — 서버 커서로 다음 쪽을 이어 받는다. */
  const loadMore = async () => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await apiFetch<NotificationsPage>(
        `/api/me/notifications?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`,
      );
      setMore({ items: [...(more?.items ?? []), ...page.items], cursor: page.nextCursor });
    } catch (error: unknown) {
      setMoreError(toApiError(error).detail);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <DetailScreen title="알림" tab="home">
      <Chips chip={chip} onChange={setChip} />
      {groups.length === 0 && <EmptyNotifications filtered={chip !== 'all' && all.length > 0} />}
      {groups.map((group) => (
        <View key={group.key} style={styles.group}>
          <Text style={styles.groupTitle} accessibilityRole="header">
            {group.label}
          </Text>
          <Card>
            {group.rows.map((row, index) => (
              <NotificationRow key={row.id} row={row} first={index === 0} />
            ))}
          </Card>
        </View>
      ))}
      <InlineError message={moreError} />
      {cursor !== null && (
        <SecondaryButton label={loadingMore ? '불러오는 중이에요' : '더 보기'} onPress={loadMore} disabled={loadingMore} />
      )}
      <Text style={styles.footer}>광고성 알림은 동의한 경우에만 와요</Text>
    </DetailScreen>
  );
}

function Chips({ chip, onChange }: { chip: NotificationChip; onChange: (next: NotificationChip) => void }) {
  return (
    <View style={styles.chips} accessibilityRole="tablist">
      {NOTIFICATION_CHIPS.map((item) => {
        const selected = item.key === chip;
        return (
          <Pressable
            key={item.key}
            style={[styles.chip, selected && styles.chipOn]}
            onPress={() => onChange(item.key)}
            accessibilityRole="tab"
            accessibilityLabel={`${item.label} 알림`}
            accessibilityState={{ selected }}
          >
            <Text style={[styles.chipText, selected && styles.chipTextOn]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** M21E — 알림이 하나도 없을 때(칩으로 걸러 빈 경우는 한 줄만 바꾼다). */
function EmptyNotifications({ filtered }: { filtered: boolean }) {
  return (
    <Card>
      <View style={styles.emptyCircle} />
      <Text style={styles.emptyTitle}>{filtered ? '이 종류의 알림이 없어요' : '새 알림이 없어요'}</Text>
      <Text style={styles.emptyBody}>결제 확인·입금 기한·수업 변경·결석 표시 알림이 여기에 쌓여요.</Text>
    </Card>
  );
}

/** 알림 한 줄 — 아이콘 · 제목/설명/행동 문구 · 시각 + 안 읽음 점. 행동 문구가 있으면 줄 전체가 눌린다. */
function NotificationRow({ row, first }: { row: NotificationRowView; first: boolean }) {
  const icon = ICONS[row.icon];
  const action = row.action;
  const open = () => {
    if (action !== null) router.push(action.href as Href);
  };
  return (
    <Pressable
      style={[styles.row, !first && styles.rowLine, row.unread && styles.rowUnread]}
      onPress={open}
      disabled={action === null}
      accessibilityRole={action === null ? 'text' : 'button'}
      accessibilityLabel={`${row.unread ? '안 읽음. ' : ''}${row.title}${row.description ? `. ${row.description}` : ''}`}
    >
      <View style={[styles.icon, { backgroundColor: icon.bg }]}>
        <Text style={[styles.iconText, { color: icon.fg }]}>{icon.glyph}</Text>
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, row.unread && styles.rowTitleUnread]}>{row.title}</Text>
        {row.description !== null && <Text style={shared.muted}>{row.description}</Text>}
        {action !== null && <Text style={styles.action}>{action.label} ›</Text>}
      </View>
      <View style={styles.rowSide}>
        <Text style={shared.muted}>{row.timeLabel}</Text>
        {row.unread && <View style={styles.dot} />}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: colors.brownSoft, borderColor: colors.brown },
  chipText: { fontSize: font.small, color: colors.ink },
  chipTextOn: { fontWeight: '700', color: colors.brown },
  group: { gap: space.sm },
  groupTitle: { fontSize: font.small, fontWeight: '700', color: colors.ink3 },
  row: { flexDirection: 'row', gap: space.md, paddingVertical: space.md, paddingHorizontal: space.sm, minHeight: MIN_TOUCH, borderRadius: radius.sm },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowUnread: { backgroundColor: '#FBF8F2' },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: font.body, fontWeight: '800' },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: font.body, color: colors.ink },
  rowTitleUnread: { fontWeight: '800' },
  action: { fontSize: font.small, fontWeight: '700', color: colors.brown, marginTop: 2 },
  rowSide: { alignItems: 'flex-end', gap: space.sm },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.brown },
  footer: { fontSize: font.tiny, color: colors.ink3, textAlign: 'center' },
  emptyCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#EDE3D3', alignSelf: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.ink, textAlign: 'center' },
  emptyBody: { fontSize: font.small, color: colors.ink3, textAlign: 'center' },
});
