/**
 * 대표 앱 「알림」(보드 O21 · O21B) — S1-4.10(대표 앱 알림함 화면 O21·O21B). 주소 `/owner/notifications`.
 *
 * 하는 일
 *  1. 내가 대표인 학원을 고른다(`GET /api/staff/me`)
 *  2. 고른 종류 칩의 알림을 최신순으로 부른다(`GET /api/staff/notifications`, 계약 10 §2).
 *     칩은 `전체 · 승인 · 신청·마감 · 문의 · 정산 · 운영` — 「운영」은 O21B 에서 더한 칩이다.
 *  3. 「오늘」·「어제」 묶음으로 그린다. 안 읽은 알림은 오른쪽 점과 옅은 바탕으로 보인다.
 *  4. 알림을 누르면 읽음 처리(`POST …/{id}/read`)를 보내고, 앱에 같은 일을 하는 화면이 있으면 그리로 간다.
 *     소속 신청의 「확인하고 승인 ›」은 강사 관리(O37)로 이어진다(spec 대표 알림함, 2026-11-18).
 *  5. 「모두 읽음」은 지금 보고 있는 칩만 읽음으로 바꾼다(`POST …/read-all { category }`).
 *
 * 효과 훅을 새로 쓰지 않는다. 첫 쪽 읽기는 기존 `useApiResource`, 칩 바꾸기·더 보기·읽음은 누를 때(onPress) 한다.
 *
 * 대타 수락 알림(O21B 맨 위 「대타」, S2-3.10)은 「확인하기 ›」를 누르면 그 자리에서 대표 확인(`POST …/substitute-requests/{id}/confirm`,
 * 계약 11 §8-2)을 보내고 「확인했어요 · 수강생 N명에게 알림이 갔어요」로 바꾼다. 다른 강사가 먼저 취소했으면 서버 문장을 그대로 보인다.
 *
 * 범위 밖: 30초 폴링(계약의 추천값 — 「모두 읽음」 뒤처럼 누를 때만 다시 읽는다), 대표 앱 하단 5탭(대표 앱 틀 Task 몫),
 * O21B 의 결제·대타·충돌 알림 종류(그 알림을 쓰는 S3·S2-3·S7 이 만든다 — 지금은 칩과 틀만 받는다).
 */
import { useState } from 'react';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { apiFetch } from '../../lib/api';
import { toApiError, useApiResource } from '../../lib/catalog/use-api-resource';
import { EmptyView, ErrorView, InlineError, LoadingView, SecondaryButton } from '../../lib/catalog/ui';
import {
  confirmSubstitutePath,
  emptyNotificationText,
  groupByDay,
  NOTIFICATION_CHIPS,
  notificationRowView,
  notificationsPath,
  READ_ALL_PATH,
  readNotificationPath,
  type NotificationCategory,
  type NotificationRowView,
  type StaffNotification,
  type StaffNotificationList,
} from '../../lib/owner/notifications-view';
import { OwnerScreen } from '../../lib/owner/owner-screen';
import { pickOwnerAcademy, type StaffMe } from '../../lib/owner/terms-api';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';

/** 「더 보기」로 붙인 뒷 쪽들. 칩을 바꾸면 비운다 */
interface ExtraPages {
  items: StaffNotification[];
  nextCursor: string | null;
}

export default function OwnerNotificationsScreen() {
  const [category, setCategory] = useState<NotificationCategory | null>(null);
  const [extra, setExtra] = useState<ExtraPages | null>(null);
  // 이 화면에서 읽음으로 바꾼 id — 서버 응답을 다시 받기 전에도 점을 바로 지운다
  const [readLocally, setReadLocally] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 이 화면에서 대타를 확인한 알림 id → 알린 수강생 수. 확인한 줄은 버튼 대신 결과 글자를 보인다
  const [confirmed, setConfirmed] = useState<Readonly<Record<string, number>>>({});

  const me = useApiResource<StaffMe>('/api/staff/me');
  const academy = me.state.status === 'ready' ? pickOwnerAcademy(me.state.data) : null;
  // 학원을 고른 뒤에만 부른다. 칩이 바뀌면 경로가 바뀌어 첫 쪽부터 새로 읽는다
  const firstPage = useApiResource<StaffNotificationList>(academy === null ? null : notificationsPath(academy.academyId, category));

  /** 칩 누르기 — 칩을 바꾸고, 앞 칩에서 붙여 둔 뒷 쪽·안내를 비운다 */
  const selectChip = (key: NotificationCategory | null) => {
    setCategory(key);
    setExtra(null);
    setMessage(null);
    setError(null);
  };

  /** 「더 보기」 — 마지막 커서로 다음 쪽을 받아 뒤에 붙인다 */
  const loadMore = async (cursor: string) => {
    if (academy === null) return;
    setBusy(true);
    setError(null);
    try {
      const page = await apiFetch<StaffNotificationList>(notificationsPath(academy.academyId, category, cursor));
      setExtra((prev) => ({ items: [...(prev?.items ?? []), ...page.items], nextCursor: page.nextCursor }));
    } catch (caught: unknown) {
      setError(toApiError(caught).detail);
    } finally {
      setBusy(false);
    }
  };

  /** 「모두 읽음」 — 지금 칩만 읽음으로 바꾸고(전체 칩이면 null) 첫 쪽부터 다시 읽는다 */
  const readAll = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ updated: number }>(READ_ALL_PATH, { method: 'POST', body: { category } });
      setMessage(result.updated === 0 ? '새로 읽을 알림이 없어요' : `알림 ${result.updated}건을 읽음으로 바꿨어요`);
      setExtra(null);
      setReadLocally(new Set());
      firstPage.reload();
    } catch (caught: unknown) {
      setError(toApiError(caught).detail);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 알림 한 줄 누르기. 읽음 처리를 먼저 보내고, 앱에 갈 화면이 있으면 이동한다.
   * 읽음이 실패해도 이동은 막지 않는다(대표가 할 일을 먼저 하게) — 실패는 돌아왔을 때 안내 줄로 보인다.
   */
  const openRow = async (row: NotificationRowView) => {
    if (row.unread) {
      try {
        await apiFetch<StaffNotification>(readNotificationPath(row.id), { method: 'POST' });
        setReadLocally((prev) => new Set([...prev, row.id]));
      } catch (caught: unknown) {
        setError(toApiError(caught).detail);
      }
    }
    if (row.confirmRequestId !== null && academy !== null && confirmed[row.id] === undefined) {
      await confirmSubstitute(row.id, academy.academyId, row.confirmRequestId);
      return;
    }
    if (row.route !== null) router.push(row.route);
  };

  /** 대타 「확인하기 ›」 — 대표 확인을 보내고 그 줄을 결과 글자로 바꾼다(효과 훅 없이 누를 때 한 번) */
  const confirmSubstitute = async (rowId: string, academyId: string, requestId: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ notifiedMemberCount: number }>(confirmSubstitutePath(academyId, requestId), { method: 'POST', body: {} });
      setConfirmed((prev) => ({ ...prev, [rowId]: result.notifiedMemberCount }));
      setMessage(`대타를 확인했어요 · 수강생 ${result.notifiedMemberCount}명에게 알림이 갔어요`);
    } catch (caught: unknown) {
      setError(toApiError(caught).detail);
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (me.state.status === 'loading') {
    body = <LoadingView label="내 학원을 확인하고 있어요" />;
  } else if (me.state.status === 'error') {
    body = <ErrorView error={me.state.error} onRetry={me.reload} />;
  } else if (academy === null) {
    body = <EmptyView title="대표 알림은 학원 대표만 볼 수 있어요" hint="입점 승인이 끝난 학원의 대표 계정으로 열어 주세요." />;
  } else if (firstPage.state.status === 'error') {
    body = <ErrorView error={firstPage.state.error} onRetry={firstPage.reload} />;
  } else if (firstPage.state.status === 'loading') {
    body = <LoadingView label="알림을 불러오고 있어요" />;
  } else {
    const items = [...firstPage.state.data.items, ...(extra?.items ?? [])];
    const nextCursor = extra === null ? firstPage.state.data.nextCursor : extra.nextCursor;
    const now = new Date();
    body =
      items.length === 0 ? (
        <EmptyView title={emptyNotificationText(category)} />
      ) : (
        <View style={styles.stack}>
          {groupByDay(items, now).map((group) => (
            <View key={group.label} style={styles.group}>
              <Text style={styles.dayLabel}>{group.label}</Text>
              <View style={styles.card}>
                {group.items.map((item, index) => (
                  <NotificationRow
                    key={item.id}
                    row={withConfirmed(notificationRowView(item, now, readLocally), confirmed)}
                    divided={index > 0}
                    onPress={openRow}
                  />
                ))}
              </View>
            </View>
          ))}
          {nextCursor !== null && <SecondaryButton label="더 보기" disabled={busy} onPress={() => void loadMore(nextCursor)} />}
        </View>
      );
  }

  return (
    <OwnerScreen title="알림" headerRight={<ReadAllButton disabled={busy || academy === null} onPress={() => void readAll()} />}>
      {/* 종류 칩 — 보드 O21·O21B 순서 그대로. 고른 칩은 바탕색과 글자 굵기로 함께 보인다(색만으로 구별하지 않게) */}
      <View style={styles.chips} accessibilityRole="tablist">
        {NOTIFICATION_CHIPS.map((chip) => {
          const selected = chip.key === category;
          return (
            <Pressable
              key={chip.label}
              style={[styles.chip, selected && styles.chipSelected]}
              onPress={() => selectChip(chip.key)}
              accessibilityRole="tab"
              // accessibilityState 는 웹(react-native-web)에서 aria-selected 로 옮겨지지 않아 aria-selected 를 직접 준다(기기에서도 같은 뜻)
              aria-selected={selected}
              accessibilityLabel={`${chip.label} 알림`}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{chip.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {message !== null && <Text style={styles.message}>{message}</Text>}
      <InlineError message={error} />
      {body}
    </OwnerScreen>
  );
}

/** 이 화면에서 대타를 확인한 줄은 「확인하기 ›」 대신 결과를 보이고 다시 누를 수 없게 한다 */
function withConfirmed(row: NotificationRowView, confirmed: Readonly<Record<string, number>>): NotificationRowView {
  const count = confirmed[row.id];
  if (count === undefined) return row;
  return { ...row, actionLabel: `확인했어요 · 수강생 ${count}명에게 알림이 갔어요`, confirmRequestId: null };
}

function ReadAllButton({ disabled, onPress }: { disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={styles.readAll}
      accessibilityRole="button"
      accessibilityLabel="모두 읽음"
      accessibilityState={{ disabled }}
    >
      <Text style={[styles.readAllText, disabled && styles.readAllDisabled]}>모두 읽음</Text>
    </Pressable>
  );
}

/** 알림 한 줄 — 왼쪽 두 글자 배지 · 제목 · 내용 · 행동 글자 · 오른쪽 시각과 안 읽음 점(보드 O21B 모양) */
function NotificationRow({
  row,
  divided,
  onPress,
}: {
  row: NotificationRowView;
  divided: boolean;
  onPress: (row: NotificationRowView) => Promise<void>;
}) {
  return (
    <Pressable
      style={[styles.row, divided && styles.divider, row.unread && styles.rowUnread]}
      onPress={() => void onPress(row)}
      accessibilityRole="button"
      accessibilityLabel={`${row.unread ? '안 읽음. ' : ''}${row.title}${row.actionLabel !== null ? `. ${row.actionLabel}` : ''}`}
    >
      <Text style={[styles.badge, row.category === 'operations' && styles.badgeOperations]}>{row.badge}</Text>
      <View style={styles.flex}>
        <Text style={styles.title}>{row.title}</Text>
        {row.body !== null && <Text style={styles.body}>{row.body}</Text>}
        {row.actionLabel !== null && <Text style={styles.action}>{row.actionLabel}</Text>}
        {row.webOnlyNote !== null && <Text style={styles.muted}>{row.webOnlyNote}</Text>}
      </View>
      <View style={styles.side}>
        <Text style={styles.muted}>{row.time}</Text>
        {row.unread && <View style={styles.dot} accessibilityElementsHidden />}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs + 2 },
  chip: {
    minHeight: 36,
    paddingHorizontal: space.md,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  chipSelected: { backgroundColor: colors.brownSoft, borderColor: colors.brown },
  chipText: { color: colors.ink, fontSize: font.small },
  chipTextSelected: { fontWeight: '700' },
  message: { color: colors.ok, fontSize: font.small },
  stack: { gap: space.md },
  group: { gap: space.xs },
  dayLabel: { color: colors.ink3, fontSize: font.small },
  card: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  row: { flexDirection: 'row', gap: space.md, minHeight: MIN_TOUCH, padding: space.md },
  rowUnread: { backgroundColor: colors.bg },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  badge: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    textAlign: 'center',
    lineHeight: 40,
    overflow: 'hidden',
    backgroundColor: colors.brownSoft,
    color: colors.brown,
    fontSize: font.tiny,
    fontWeight: '700',
  },
  // 운영 배지는 파란 글자 + 테두리 — 안 읽음 줄 바탕(colors.bg)과 같은 색이어도 네모가 보이게 한다
  badgeOperations: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, color: colors.info },
  flex: { flex: 1, gap: 2 },
  title: { color: colors.ink, fontSize: font.body, fontWeight: '700' },
  body: { color: colors.ink3, fontSize: font.small },
  action: { color: colors.brown, fontSize: font.small, fontWeight: '700', marginTop: space.xs },
  muted: { color: colors.ink3, fontSize: font.small },
  side: { alignItems: 'flex-end', gap: space.sm },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.brown },
  readAll: { minHeight: MIN_TOUCH, justifyContent: 'center', paddingHorizontal: space.xs },
  readAllText: { color: colors.ink3, fontSize: font.small, fontWeight: '700' },
  readAllDisabled: { color: colors.disabledInk },
});
