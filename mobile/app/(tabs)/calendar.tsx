/**
 * 캘린더 — 확정된 내 수업 회차(보드 M11, `04-me-calendar-notifications.md` §1).
 *
 * 「캘린더」는 기기 캘린더 연동이 아니라 앱 안 기록이다(Q9(캘린더의 뜻) 결정).
 * 결제가 확정되면 서버가 회차마다 한 줄씩 넣고(FR-289(확정 후 일괄 처리)), 취소하면 지운다.
 * 결제 대기 중인 주문은 여기 나오지 않는다.
 *
 * 한 달씩 본다. 요청 범위는 KST 달력 날짜 `from`~`to`(최대 62일)라 한 달이면 넉넉하다.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatDateKey, formatKstTime, toKstDateKey, toKstParts } from '../../lib/catalog/format';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';
import type { CalendarEntry } from '../../lib/catalog/types';
import { Card, EmptyView, ErrorView, LoadingView, SecondaryButton, shared } from '../../lib/catalog/ui';
import { useApiResource } from '../../lib/catalog/use-api-resource';

const WEEK_LABELS = ['일', '월', '화', '수', '목', '금', '토'] as const;

interface MonthCursor {
  year: number;
  month: number; // 1~12
}

function daysInMonth({ year, month }: MonthCursor): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function shiftMonth({ year, month }: MonthCursor, delta: number): MonthCursor {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** 달력 칸 — 앞쪽 빈칸(null) + 1일~말일. 요일은 달력 날짜 자체로 계산하므로 시간대가 끼지 않는다. */
function monthCells(cursor: MonthCursor): readonly (number | null)[] {
  const firstWeekday = new Date(Date.UTC(cursor.year, cursor.month - 1, 1)).getUTCDay();
  const days = Array.from({ length: daysInMonth(cursor) }, (_, i) => i + 1);
  return [...Array.from({ length: firstWeekday }, () => null), ...days];
}

/** 회차를 KST 날짜별로 묶은 새 객체. */
function groupByDate(items: readonly CalendarEntry[]): Readonly<Record<string, readonly CalendarEntry[]>> {
  return items.reduce<Record<string, readonly CalendarEntry[]>>((acc, entry) => {
    const start = new Date(entry.startsAt);
    if (Number.isNaN(start.getTime())) {
      return acc;
    }
    const key = toKstDateKey(start);
    return { ...acc, [key]: [...(acc[key] ?? []), entry] };
  }, {});
}

export default function CalendarScreen() {
  const insets = useSafeAreaInsets();
  const today = toKstParts(new Date());
  const todayKey = formatDateKey(today.year, today.month, today.day);
  const [cursor, setCursor] = useState<MonthCursor>({ year: today.year, month: today.month });
  const [selectedKey, setSelectedKey] = useState<string>(todayKey);

  const from = formatDateKey(cursor.year, cursor.month, 1);
  const to = formatDateKey(cursor.year, cursor.month, daysInMonth(cursor));
  const { state, reload } = useApiResource<{ items: readonly CalendarEntry[] }>(
    `/api/me/calendar?from=${from}&to=${to}`,
  );
  useReloadOnRefocus(reload);

  const byDate = useMemo(() => (state.status === 'ready' ? groupByDate(state.data.items ?? []) : {}), [state]);

  const moveMonth = (delta: number) => {
    const next = shiftMonth(cursor, delta);
    setCursor(next);
    setSelectedKey(formatDateKey(next.year, next.month, 1));
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <MonthHeader cursor={cursor} onMove={moveMonth} />
      <ScrollView contentContainerStyle={styles.body}>
        <MonthGrid cursor={cursor} byDate={byDate} selectedKey={selectedKey} todayKey={todayKey} onSelect={setSelectedKey} />
        {state.status === 'loading' && <LoadingView />}
        {state.status === 'error' && <ErrorView error={state.error} onRetry={reload} />}
        {state.status === 'ready' && <DayEntries dateKey={selectedKey} entries={byDate[selectedKey] ?? []} />}
      </ScrollView>
    </View>
  );
}

/** 탭을 다시 눌러 돌아오면(결제 확정·취소 뒤) 새로 읽는다. 처음 한 번은 훅이 이미 읽었다. */
function useReloadOnRefocus(reload: () => void) {
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      reload();
    }, [reload]),
  );
}

function MonthHeader({ cursor, onMove }: { cursor: MonthCursor; onMove: (delta: number) => void }) {
  return (
    <View style={styles.monthHeader}>
      <Text style={styles.monthTitle} accessibilityRole="header">
        {cursor.year}년 {cursor.month}월
      </Text>
      <View style={styles.monthNav}>
        <NavButton label="‹" a11y="이전 달" onPress={() => onMove(-1)} />
        <NavButton label="›" a11y="다음 달" onPress={() => onMove(1)} />
      </View>
    </View>
  );
}

function NavButton({ label, a11y, onPress }: { label: string; a11y: string; onPress: () => void }) {
  return (
    <Pressable style={styles.navButton} onPress={onPress} accessibilityRole="button" accessibilityLabel={a11y}>
      <Text style={styles.navText}>{label}</Text>
    </Pressable>
  );
}

interface MonthGridProps {
  cursor: MonthCursor;
  byDate: Readonly<Record<string, readonly CalendarEntry[]>>;
  selectedKey: string;
  todayKey: string;
  onSelect: (key: string) => void;
}

function MonthGrid({ cursor, byDate, selectedKey, todayKey, onSelect }: MonthGridProps) {
  const cells = monthCells(cursor);
  return (
    <Card>
      <View style={styles.grid}>
        {WEEK_LABELS.map((label) => (
          <Text key={label} style={styles.weekLabel}>
            {label}
          </Text>
        ))}
        {cells.map((day, index) => {
          if (day === null) {
            return <View key={`blank-${index}`} style={styles.cell} />;
          }
          const key = formatDateKey(cursor.year, cursor.month, day);
          const count = byDate[key]?.length ?? 0;
          const selected = key === selectedKey;
          return (
            <Pressable
              key={key}
              style={styles.cell}
              onPress={() => onSelect(key)}
              accessibilityRole="button"
              accessibilityLabel={`${cursor.month}월 ${day}일${count > 0 ? `, 수업 ${count}개` : ''}`}
              accessibilityState={{ selected }}
            >
              <View style={[styles.dayCircle, selected && styles.daySelected]}>
                <Text style={[styles.dayText, key === todayKey && styles.today, selected && styles.dayTextSelected]}>
                  {day}
                </Text>
              </View>
              <View style={[styles.dot, count > 0 && styles.dotOn]} />
            </Pressable>
          );
        })}
      </View>
    </Card>
  );
}

function DayEntries({ dateKey, entries }: { dateKey: string; entries: readonly CalendarEntry[] }) {
  const [, month, day] = dateKey.split('-').map(Number);
  return (
    <View style={styles.dayList}>
      <Text style={styles.dayHeading}>
        {month}/{day} 수업
      </Text>
      {entries.length === 0 && <EmptyView title="이날은 확정된 수업이 없어요" />}
      {entries.map((entry) => (
        <EntryCard key={entry.entryId} entry={entry} />
      ))}
    </View>
  );
}

function EntryCard({ entry }: { entry: CalendarEntry }) {
  const openCancel = () => router.push(`/reservation/${encodeURIComponent(entry.reservationId)}/cancel`);
  return (
    <Card>
      <Text style={[shared.tag, shared.tagOk]}>예약 확정</Text>
      <Text style={styles.entryTitle}>{entry.title}</Text>
      <Text style={shared.muted}>
        {entry.academyName} · {entry.sessionSeq}회차 · {formatKstTime(entry.startsAt)}~{formatKstTime(entry.endsAt)}
      </Text>
      <SecondaryButton label="취소·환불 안내" onPress={openCancel} />
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { padding: space.lg, gap: space.md, paddingBottom: space.xl },
  monthHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  monthTitle: { flex: 1, fontSize: font.h1 - 4, fontWeight: '800', color: colors.ink },
  monthNav: { flexDirection: 'row', gap: space.xs },
  navButton: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  navText: { fontSize: 26, color: colors.ink },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  weekLabel: { width: `${100 / 7}%`, textAlign: 'center', fontSize: font.tiny, color: colors.ink3, paddingBottom: space.sm },
  cell: { width: `${100 / 7}%`, alignItems: 'center', paddingVertical: 2, minHeight: MIN_TOUCH },
  dayCircle: { width: 34, height: 34, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  daySelected: { backgroundColor: colors.night },
  dayText: { fontSize: font.body, color: colors.ink },
  dayTextSelected: { color: colors.surface, fontWeight: '700' },
  today: { color: colors.brown, fontWeight: '800' },
  dot: { width: 5, height: 5, borderRadius: 3, marginTop: 2, backgroundColor: 'transparent' },
  dotOn: { backgroundColor: colors.flame },
  dayList: { gap: space.md },
  dayHeading: { fontSize: 16, fontWeight: '700', color: colors.ink },
  entryTitle: { fontSize: 16, fontWeight: '700', color: colors.ink },
});
