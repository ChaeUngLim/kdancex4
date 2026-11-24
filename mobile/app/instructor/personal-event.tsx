/**
 * 강사 캘린더 → 개인 일정 넣기(보드 I36) — S2-1.11. 주소 `/instructor/personal-event?date=YYYY-MM-DD`.
 *
 * 강사가 수업 말고 자기 일정(개인 연습 등)을 적어 둔다(FR-053, 강사 멤버십 기능).
 *  - 제목 · 날짜 · 시작–끝(10분 단위) · 반복(안 함 · 매주 ○ · 매일)을 받아
 *    `POST /api/instructor/personal-events`(11 §2-3)로 넣는다
 *  - **나만 보인다**: 학원 시간표·대표 캘린더에는 제목 없이 「불가 시간」, 대타 요청에서는 「일정이 있어요」로만 보인다.
 *    화면은 이 규칙을 「나만 봐요」 상자로 알리고, 서버로는 제목을 강사 본인 일정으로만 보낸다
 *  - 수업·개인 레슨과 겹쳐도 막지 않는다. 서버가 돌려준 `overlaps` 를 넣은 뒤 그대로 알린다
 *  - 넣은 일정은 그 자리에서 「지우기」(DELETE, 반복이면 시리즈 전체)를 할 수 있다
 *
 * 보드에서는 캘린더(I5) 위에 시트로 올라오지만, 강사 캘린더는 S2-4 몫이라 아직 없다.
 * 그래서 같은 시트 모양을 홀로 띄우고, 캘린더가 생기면 고른 날을 `?date=` 로 넘겨 연다.
 * 그 전까지는 마이(I9)의 「개인 일정 넣기」 줄에서 들어온다.
 * 넣기 「전」 겹침 확인(`POST /api/classes/schedule-check`)도 수업 등록(S2-2) 전이라 아직 부르지 않는다.
 *
 * 효과 훅 없음: 칸 값은 useState, 검사는 렌더 중 계산, 넣기·지우기는 버튼 핸들러 안에서 한다.
 */
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  addPersonalEvent,
  deletePersonalEvent,
  kstDateTime,
  kstHm,
  kstToUtcIso,
  monthDayWeekday,
  nextDays,
  PERSONAL_TITLE_MAX,
  readYmd,
  repeatLabel,
  timeRangeProblem,
  todayKst,
  type PersonalEvent,
  type PersonalEventRepeat,
} from '../../lib/instructor/profile-api';
import { goBack, InstructorShell, staffStyles, useAction } from '../../lib/instructor/staff-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';

/** 날짜 고르기 칩 개수 — 캘린더가 붙기 전 임시로 고른 날부터 2주 */
const DAY_CHOICES = 14;
const REPEATS: readonly PersonalEventRepeat[] = ['none', 'weekly', 'daily'];

export default function PersonalEventScreen() {
  const params = useLocalSearchParams<{ date?: string }>();
  // 주소로 받은 날은 검사해서 쓰고, 없거나 틀리면 오늘(한국 날짜)
  const [baseDate] = useState(() => readYmd(params.date) ?? todayKst());
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(baseDate);
  const [pickingDate, setPickingDate] = useState(false);
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');
  const [repeat, setRepeat] = useState<PersonalEventRepeat>('none');
  // 이 화면에서 넣은 일정(넣은 순서). 개인 일정 목록을 읽는 경로는 강사 일정(S2-4 §11)이 맡는다
  const [added, setAdded] = useState<readonly PersonalEvent[]>([]);
  const save = useAction();
  const remove = useAction();

  // 렌더 중 계산: 칸 검사 · 버튼 켜짐
  const trimmedTitle = title.trim();
  const timesFilled = startText.trim() !== '' && endText.trim() !== '';
  const timeProblem = timesFilled ? timeRangeProblem(startText, endText) : null;
  const canSubmit = trimmedTitle !== '' && timesFilled && timeProblem === null && !save.busy;

  const handleSubmit = async () => {
    const event = await save.run(() =>
      addPersonalEvent({
        title: trimmedTitle,
        startsAt: kstToUtcIso(date, startText),
        endsAt: kstToUtcIso(date, endText),
        repeat,
      }),
    );
    if (event !== null) {
      // 새 배열로 바꿔 끼우고, 다음 일정을 바로 적을 수 있게 제목·시간만 비운다(날짜·반복은 남긴다)
      setAdded((prev) => [...prev, event]);
      setTitle('');
      setStartText('');
      setEndText('');
    }
  };

  const handleDelete = async (eventId: string) => {
    const done = await remove.run(async () => {
      await deletePersonalEvent(eventId);
      return true;
    });
    if (done !== null) setAdded((prev) => prev.filter((event) => event.eventId !== eventId));
  };

  return (
    <InstructorShell title="캘린더" active="calendar" onBack={() => goBack('/instructor/my')}>
      <Text style={styles.dayHeading}>{monthDayWeekday(date)}</Text>

      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <Text style={styles.sheetTitle} accessibilityRole="header">
          개인 일정 넣기
        </Text>

        <Text style={styles.label}>제목</Text>
        <TextInput
          accessibilityLabel="제목"
          value={title}
          onChangeText={setTitle}
          maxLength={PERSONAL_TITLE_MAX}
          placeholder="개인 연습"
          placeholderTextColor={colors.ink3}
          style={styles.input}
        />

        <Text style={styles.label}>날짜</Text>
        <Pressable
          style={styles.dateRow}
          onPress={() => setPickingDate((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel={`날짜 ${monthDayWeekday(date)}, 바꾸기`}
          accessibilityState={{ expanded: pickingDate }}
        >
          <Text style={styles.dateText}>{monthDayWeekday(date)}</Text>
          <Text style={styles.chevron}>{pickingDate ? '⌃' : '›'}</Text>
        </Pressable>
        {pickingDate && (
          <View style={styles.chipWrap}>
            {nextDays(baseDate, DAY_CHOICES).map((day) => (
              <Pressable
                key={day}
                style={[styles.chip, day === date && styles.chipOn]}
                onPress={() => {
                  setDate(day);
                  setPickingDate(false);
                }}
                accessibilityRole="radio"
                accessibilityLabel={monthDayWeekday(day)}
                accessibilityState={{ checked: day === date }}
              >
                <Text style={[styles.chipText, day === date && styles.chipTextOn]}>{monthDayWeekday(day)}</Text>
              </Pressable>
            ))}
          </View>
        )}

        <Text style={styles.label}>시간 · 10분 단위</Text>
        <View style={styles.timeRow}>
          <TextInput
            accessibilityLabel="시작 시간"
            value={startText}
            onChangeText={setStartText}
            placeholder="14:00"
            placeholderTextColor={colors.ink3}
            maxLength={5}
            style={[styles.input, styles.timeInput]}
          />
          <Text style={styles.dash}>–</Text>
          <TextInput
            accessibilityLabel="끝 시간"
            value={endText}
            onChangeText={setEndText}
            placeholder="16:00"
            placeholderTextColor={colors.ink3}
            maxLength={5}
            style={[styles.input, styles.timeInput]}
          />
        </View>
        {timeProblem !== null && <Text style={styles.error}>{timeProblem}</Text>}

        <Text style={styles.label}>반복</Text>
        <View style={styles.chipWrap} accessibilityRole="radiogroup">
          {REPEATS.map((value) => (
            <Pressable
              key={value}
              style={[styles.chip, value === repeat && styles.chipOn]}
              onPress={() => setRepeat(value)}
              accessibilityRole="radio"
              accessibilityLabel={repeatLabel(value, date)}
              accessibilityState={{ checked: value === repeat }}
            >
              <Text style={[styles.chipText, value === repeat && styles.chipTextOn]}>{repeatLabel(value, date)}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.privacyBox}>
          <Text style={styles.privacyTitle}>나만 봐요</Text>
          <Text style={staffStyles.muted}>학원 시간표와 대표 캘린더에는 제목 없이 「불가 시간」으로만 보여요.</Text>
          <Text style={staffStyles.muted}>대타 요청을 받을 때도 이 시간은 「일정이 있어요」로 빠져요.</Text>
        </View>
        <Text style={staffStyles.muted}>수업 시간과 겹치면 넣을 때 무엇과 몇 분 겹치는지 알려 줘요. 막지는 않아요.</Text>

        {save.error !== null && <Text style={styles.error}>{save.error}</Text>}
        <Pressable
          style={[styles.submit, !canSubmit && styles.submitOff]}
          onPress={handleSubmit}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityLabel="개인 일정 넣기"
          accessibilityState={{ disabled: !canSubmit, busy: save.busy }}
        >
          <Text style={[styles.submitText, !canSubmit && styles.submitTextOff]}>
            {save.busy ? '넣고 있어요…' : '개인 일정 넣기'}
          </Text>
        </Pressable>
      </View>

      {added.length > 0 && <AddedList events={added} onDelete={handleDelete} deleting={remove.busy} error={remove.error} />}
    </InstructorShell>
  );
}

interface AddedListProps {
  events: readonly PersonalEvent[];
  onDelete: (eventId: string) => void;
  deleting: boolean;
  error: string | null;
}

/** 넣은 일정 카드 — 시각 · 반복 · 겹침 안내 · 「지우기」 */
function AddedList({ events, onDelete, deleting, error }: AddedListProps) {
  return (
    <View style={staffStyles.card} accessibilityLiveRegion="polite">
      <Text style={staffStyles.sectionTitle}>{`넣은 개인 일정 ${events.length}개`}</Text>
      {events.map((event, index) => {
        const ymd = new Date(Date.parse(event.startsAt) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
        return (
          <View key={event.eventId} style={[styles.addedRow, index > 0 && styles.addedDivider]}>
            <View style={styles.addedText}>
              <Text style={styles.addedTitle}>{event.title}</Text>
              <Text style={staffStyles.muted}>
                {`${kstDateTime(event.startsAt)}–${kstHm(event.endsAt)} · 반복 ${repeatLabel(event.repeat, ymd)}`}
              </Text>
              {event.overlaps.length === 0 ? (
                <Text style={styles.okText}>✓ 겹치는 수업·개인 레슨이 없어요</Text>
              ) : (
                event.overlaps.map((overlap) => (
                  <Text key={`${overlap.kind}-${overlap.label}`} style={styles.warnText}>
                    {`${overlap.label}과 ${overlap.overlapMinutes}분 겹쳐요`}
                  </Text>
                ))
              )}
            </View>
            <Pressable
              style={styles.deleteButton}
              onPress={() => onDelete(event.eventId)}
              disabled={deleting}
              accessibilityRole="button"
              accessibilityLabel={`${event.title} 지우기`}
            >
              <Text style={styles.deleteText}>지우기</Text>
            </Pressable>
          </View>
        );
      })}
      {error !== null && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  dayHeading: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg + 8,
    borderTopRightRadius: radius.lg + 8,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
    borderWidth: 1,
    borderColor: colors.line,
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.line },
  sheetTitle: { color: colors.ink, fontSize: font.h2, fontWeight: '800', marginBottom: space.xs },
  label: { color: colors.ink3, fontSize: font.small, fontWeight: '700', marginTop: space.xs },
  input: {
    minHeight: MIN_TOUCH - 4,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg,
    color: colors.ink,
    fontSize: 15,
  },
  dateRow: {
    minHeight: MIN_TOUCH - 4,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dateText: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  chevron: { color: colors.ink3, fontSize: font.h2 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  // 웹의 입력칸은 기본 너비가 있어 flex 만 주면 카드 밖으로 밀린다 — 최소 너비를 0 으로 풀어 두 칸이 나눠 갖게 한다
  timeInput: { flex: 1, minWidth: 0 },
  dash: { color: colors.ink3, fontSize: 16 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 34,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  chipOn: { backgroundColor: colors.brown },
  chipText: { color: colors.ink, fontSize: font.small, fontWeight: '600' },
  chipTextOn: { color: colors.surface, fontWeight: '800' },
  privacyBox: { backgroundColor: colors.bg, borderRadius: radius.md, padding: space.md, gap: space.xs, marginTop: space.sm },
  privacyTitle: { color: colors.ink, fontWeight: '800', fontSize: font.body },
  error: { color: colors.danger, fontSize: font.small },
  submit: {
    minHeight: MIN_TOUCH + 8,
    borderRadius: radius.lg,
    backgroundColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.sm,
  },
  submitOff: { backgroundColor: colors.disabled },
  submitText: { color: colors.surface, fontSize: 16, fontWeight: '800' },
  submitTextOff: { color: colors.disabledInk },
  addedRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  addedDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  addedText: { flex: 1, gap: 2 },
  addedTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  okText: { color: colors.ok, fontSize: font.small, fontWeight: '700' },
  warnText: { color: colors.brown, fontSize: font.small, fontWeight: '700' },
  deleteButton: {
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    justifyContent: 'center',
  },
  deleteText: { color: colors.danger, fontWeight: '700', fontSize: font.small },
});
