/**
 * 개인 레슨 개설 2/2 — 열 시간(보드 I10C). S2-4.6(앱 개인 레슨·일정 화면).
 * 주소 `/instructor/private-lessons/{classId}/slots?academyId=&academyName=&subGenre=&minutes=&count=&price=`.
 *
 * 방금 연 수강권 상품에 「레슨 모집」 시간을 연다. 회원은 열린 시간 중 하나를 골라 결제한다.
 *
 * 부르는 API
 *  1. `GET /api/instructor/schedule?from=월&to=일&include=private,open&academyId=`  이 학원의 이번 주 — 이미 잡힌 레슨(예약됨)과 열어 둔 시간(레슨 모집)
 *  2. `POST /api/instructor/private-lesson-products/{classId}/slots`(Idempotency-Key)  새 시간 열기(계약 11 §10-2)
 *     — 서버에 아직 없는 경로다(로드맵에 맡은 Task 없음). 실패하면 서버 문장을 그대로 보인다
 *
 * 규칙(§10-2)
 *  - 시작은 10분 단위, 길이는 상품의 레슨 길이(50·80분)와 같다 — 끝 시각은 화면이 계산한다
 *  - 「매주 반복」이면 8주(계약 기본값 · 추천값), 끄면 그 주 한 번
 *  - 수업·다른 학원 일정과 겹치면 서버가 전체를 거부한다(409 SCHEDULE_CONFLICT, 부분 성공 없음)
 *  - 지난 날에는 시간을 열 수 없다
 *
 * 새로 열 시간은 「회원에게 공개」를 누르기 전까지 화면 상태(useState)에만 있다. 서버 호출은 버튼 핸들러 안에서만 한다.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatKstTime, formatWon } from '../../../../lib/catalog/format';
import { LoadingView, PrimaryButton } from '../../../../lib/catalog/ui';
import { newIdempotencyKey, readRouteId, useApiResource } from '../../../../lib/catalog/use-api-resource';
import { DISCIPLINES_OF, SUB_GENRES_OF } from '../../../../lib/instructor/class-api';
import {
  byStart,
  kstDateOf,
  kstInstant,
  kstToday,
  mondayOf,
  monthSlashDay,
  openLessonSlots,
  readSlotTime,
  REPEAT_WEEKS,
  schedulePath,
  weekDates,
  weekdaySlashDay,
  type InstructorSchedule,
  type NewSlot,
  type OpenedSlots,
} from '../../../../lib/instructor/schedule-api';
import { goBack, InstructorShell, StaffErrorView, staffStyles, useAction } from '../../../../lib/instructor/staff-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../../../../lib/theme';

/** 하루 줄에 보이는 한 칸 — 서버에 있는 것(예약됨·레슨 모집)과 아직 안 보낸 새 시간 */
interface DaySlot {
  key: string;
  startsAt: string;
  label: string;
  tone: 'booked' | 'open' | 'new';
}

/** 주소 인자를 숫자로 — 딥링크 값은 믿지 않으므로 범위를 벗어나면 null */
function readNumber(value: string | string[] | undefined, min: number, max: number): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || !/^\d{1,8}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

export default function PrivateLessonSlotsScreen() {
  const params = useLocalSearchParams<{ classId: string; academyId: string; academyName: string; subGenre: string; minutes: string; count: string; price: string }>();
  const classId = readRouteId(params.classId);
  const academyId = readRouteId(params.academyId);
  const minutes = readNumber(params.minutes, 50, 80);
  const count = readNumber(params.count, 1, 50);
  const price = readNumber(params.price, 0, 10_000_000);
  const academyName = typeof params.academyName === 'string' ? params.academyName.slice(0, 60) : '';
  const subGenre = typeof params.subGenre === 'string' ? params.subGenre : '';

  const today = kstToday();
  const monday = mondayOf(today);
  const days = weekDates(monday);
  const schedule = useApiResource<InstructorSchedule>(
    academyId === null ? null : schedulePath(monday, days[6]!, ['private', 'open'], academyId),
  );

  const [newSlots, setNewSlots] = useState<NewSlot[]>([]);
  const [repeatWeekly, setRepeatWeekly] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addDay, setAddDay] = useState<string | null>(null);
  const [addTime, setAddTime] = useState('');
  const [addProblem, setAddProblem] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenedSlots | null>(null);
  // 공개 한 번 = 멱등 키 하나. 성공하면 다음 묶음을 위해 새 키로 바꾼다
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const publish = useAction();

  if (classId === null || academyId === null || minutes === null || count === null || price === null) {
    return (
      <InstructorShell title="개인 레슨 개설 · 2 / 2" active="classes" onBack={() => goBack('/instructor/private-lessons')}>
        <Text style={styles.error}>개인 레슨 정보를 읽지 못했어요. 개인 레슨 스케줄에서 다시 열어 주세요.</Text>
      </InstructorShell>
    );
  }
  const lessonMinutes = minutes;

  // ---- 렌더 중 계산: 하루마다 보일 칸 ----
  const subGenreLabel = Object.values(SUB_GENRES_OF).flat().find((s) => s?.value === subGenre)?.label ?? '';
  const shortGenre = DISCIPLINES_OF[subGenre] !== undefined ? subGenreLabel.replace(/^댄스스포츠\((.+)\)$/, '$1') : subGenreLabel;
  const existing: DaySlot[] =
    schedule.state.status === 'ready'
      ? schedule.state.data.items.flatMap((item): DaySlot[] => {
          if (item.kind === 'private_lesson') return [{ key: item.id, startsAt: item.startsAt, label: '예약됨', tone: 'booked' }];
          if (item.kind === 'private_lesson_open') return [{ key: item.id, startsAt: item.startsAt, label: '레슨 모집', tone: 'open' }];
          return [];
        })
      : [];
  const pending: DaySlot[] = newSlots.map((slot) => ({ key: `new-${slot.startsAt}`, startsAt: slot.startsAt, label: '새로 열 시간', tone: 'new' }));
  const allSlots = byStart([...existing, ...pending].map((s) => ({ ...s, endsAt: s.startsAt })));

  const handleAdd = () => {
    if (addDay === null) {
      setAddProblem('요일을 골라 주세요.');
      return;
    }
    const read = readSlotTime(addTime);
    if ('problem' in read) {
      setAddProblem(read.problem);
      return;
    }
    const startsAt = kstInstant(addDay, read.minutes);
    if (Date.parse(startsAt) <= Date.now()) {
      setAddProblem('지난 시각에는 열 수 없어요.');
      return;
    }
    if (allSlots.some((slot) => slot.startsAt === startsAt)) {
      setAddProblem('이미 있는 시간이에요.');
      return;
    }
    const endsAt = new Date(Date.parse(startsAt) + lessonMinutes * 60_000).toISOString().replace('.000Z', 'Z');
    setNewSlots((prev) => [...prev, { startsAt, endsAt }]);
    setAddProblem(null);
    setAddTime('');
    setAdding(false);
  };

  const handlePublish = async () => {
    const sorted = byStart(newSlots);
    const result = await publish.run(() => openLessonSlots(classId, sorted, repeatWeekly ? REPEAT_WEEKS : 1, idempotencyKey));
    if (result === null) return;
    setOpened(result);
    setNewSlots([]);
    setIdempotencyKey(newIdempotencyKey());
    schedule.reload();
  };

  return (
    <InstructorShell title="개인 레슨 개설 · 2 / 2" active="classes" onBack={() => goBack('/instructor/private-lessons')}>
      <View style={staffStyles.card}>
        <Text style={staffStyles.sectionTitle}>{academyName}</Text>
        <Text style={styles.productLine}>
          {shortGenre !== '' ? `${shortGenre} ` : ''}
          {count}회 수강권 · {lessonMinutes}분 · {formatWon(price)} · 결제는 이 학원으로
        </Text>
      </View>

      <View style={styles.weekHead}>
        <Text style={styles.weekTitle}>
          이번 주 · {monthSlashDay(days[0]!)} – {monthSlashDay(days[6]!)}
        </Text>
        <Pressable
          style={styles.repeat}
          onPress={() => setRepeatWeekly((v) => !v)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: repeatWeekly }}
          aria-checked={repeatWeekly}
          accessibilityLabel="매주 반복"
        >
          <Text style={[styles.repeatText, repeatWeekly && styles.repeatOn]}>매주 반복 {repeatWeekly ? '✓' : '○'}</Text>
        </Pressable>
      </View>

      {schedule.state.status === 'loading' && <LoadingView label="이번 주 시간을 불러오고 있어요" />}
      {schedule.state.status === 'error' && <StaffErrorView error={schedule.state.error} onRetry={schedule.reload} />}

      <View style={staffStyles.card}>
        {days.map((day, index) => {
          const slots = allSlots.filter((slot) => kstDateOf(slot.startsAt) === day);
          return (
            <View key={day} style={[styles.dayRow, index > 0 && styles.divider]}>
              <Text style={[styles.dayLabel, day < today && styles.past]}>{weekdaySlashDay(day)}</Text>
              <View style={styles.daySlots}>
                {slots.length === 0 && <Text style={styles.none}>—</Text>}
                {slots.map((slot) => (
                  <View key={slot.key} style={[styles.slot, styles[`slot_${slot.tone}`]]}>
                    <Text style={[styles.slotText, styles[`slotText_${slot.tone}`]]}>
                      {formatKstTime(slot.startsAt)} {slot.label}
                    </Text>
                    {slot.tone === 'new' && (
                      <Pressable
                        onPress={() => setNewSlots((prev) => prev.filter((s) => s.startsAt !== slot.startsAt))}
                        accessibilityRole="button"
                        accessibilityLabel={`${formatKstTime(slot.startsAt)} 새로 열 시간 빼기`}
                        hitSlop={8}
                      >
                        <Text style={styles.remove}>×</Text>
                      </Pressable>
                    )}
                  </View>
                ))}
              </View>
            </View>
          );
        })}
      </View>

      {adding ? (
        <View style={staffStyles.card}>
          <Text style={staffStyles.sectionTitle}>시간 추가 · 10분 단위</Text>
          <View style={styles.dayChips} accessibilityRole="radiogroup">
            {days.map((day) => (
              <Pressable
                key={day}
                style={[styles.dayChip, addDay === day && styles.dayChipOn, day < today && styles.dayChipOff]}
                disabled={day < today}
                onPress={() => setAddDay(day)}
                accessibilityRole="radio"
                accessibilityState={{ selected: addDay === day, disabled: day < today }}
                aria-checked={addDay === day}
              >
                <Text style={[styles.dayChipText, addDay === day && styles.dayChipTextOn]}>{weekdaySlashDay(day)}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.addRow}>
            <TextInput
              style={styles.timeInput}
              value={addTime}
              onChangeText={setAddTime}
              placeholder="21:10"
              placeholderTextColor={colors.ink3}
              accessibilityLabel="시작 시각"
            />
            <Text style={styles.addHint}>부터 {lessonMinutes}분</Text>
            <Pressable style={styles.addButton} onPress={handleAdd} accessibilityRole="button">
              <Text style={styles.addButtonText}>넣기</Text>
            </Pressable>
          </View>
          {addProblem !== null && (
            <Text style={styles.error} accessibilityLiveRegion="polite">
              {addProblem}
            </Text>
          )}
        </View>
      ) : (
        <Pressable style={styles.addOpen} onPress={() => setAdding(true)} accessibilityRole="button">
          <Text style={styles.addOpenText}>+ 시간 추가 · 10분 단위 (예: 21:10)</Text>
        </Pressable>
      )}

      <Text style={staffStyles.muted}>
        수업·다른 학원 일정과 겹치는 시간은 열 수 없어요. 회원이 결제하면 그 시간은 바로 「예약됨」으로 닫혀요.
        {repeatWeekly ? ` 매주 반복이면 ${REPEAT_WEEKS}주 동안 같은 요일·시각으로 열려요.` : ''}
      </Text>

      {opened !== null && (
        <Text style={styles.done} accessibilityLiveRegion="polite">
          시간 {opened.created.length}개를 회원에게 열었어요.
        </Text>
      )}
      {publish.error !== null && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {publish.error}
        </Text>
      )}
      <PrimaryButton
        label={publish.busy ? '여는 중…' : newSlots.length === 0 ? '새로 열 시간을 넣어 주세요' : `회원에게 공개 · ${newSlots.length}개`}
        onPress={handlePublish}
        disabled={newSlots.length === 0 || publish.busy}
      />
      {opened !== null && (
        <Pressable style={styles.addOpen} onPress={() => router.replace('/instructor/private-lessons')} accessibilityRole="button">
          <Text style={styles.addOpenText}>개인 레슨 스케줄로</Text>
        </Pressable>
      )}
    </InstructorShell>
  );
}

const styles = StyleSheet.create({
  productLine: { color: colors.ink3, fontSize: font.small, lineHeight: 18 },
  weekHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  weekTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  repeat: { minHeight: 40, paddingHorizontal: space.md, justifyContent: 'center', borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  repeatText: { color: colors.ink3, fontSize: font.small, fontWeight: '700' },
  repeatOn: { color: colors.brown },
  dayRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingVertical: space.sm },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  dayLabel: { width: 64, color: colors.ink, fontSize: font.small, fontWeight: '700', paddingTop: 6 },
  past: { color: colors.ink3 },
  daySlots: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  none: { color: colors.ink3, paddingTop: 6 },
  slot: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.sm, paddingVertical: 6, borderRadius: radius.sm, borderWidth: 1 },
  slot_booked: { backgroundColor: colors.bg, borderColor: colors.line },
  slot_open: { backgroundColor: colors.okSoft, borderColor: colors.okSoft },
  slot_new: { backgroundColor: colors.brownSoft, borderColor: colors.brown, borderStyle: 'dashed' },
  slotText: { fontSize: font.small },
  slotText_booked: { color: colors.ink3 },
  slotText_open: { color: colors.ok, fontWeight: '700' },
  slotText_new: { color: colors.brown, fontWeight: '700' },
  remove: { color: colors.brown, fontSize: 16, fontWeight: '700' },
  dayChips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  dayChip: { minHeight: 36, paddingHorizontal: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, justifyContent: 'center', backgroundColor: colors.surface },
  dayChipOn: { borderColor: colors.brown, backgroundColor: colors.brownSoft },
  dayChipOff: { backgroundColor: colors.disabled },
  dayChipText: { color: colors.ink, fontSize: font.tiny },
  dayChipTextOn: { fontWeight: '700' },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  timeInput: { width: 90, minHeight: MIN_TOUCH, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: space.md, color: colors.ink, fontSize: 16 },
  addHint: { flex: 1, color: colors.ink3, fontSize: font.small },
  addButton: { minHeight: MIN_TOUCH, paddingHorizontal: space.lg, borderRadius: radius.md, backgroundColor: colors.brown, justifyContent: 'center' },
  addButtonText: { color: colors.surface, fontWeight: '700' },
  addOpen: { minHeight: MIN_TOUCH, borderRadius: radius.md, borderWidth: 1, borderColor: colors.brown, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' },
  addOpenText: { color: colors.brown, fontWeight: '700' },
  done: { color: colors.ok, fontSize: font.body, fontWeight: '700' },
  error: { color: colors.danger, fontSize: font.small, lineHeight: 18 },
});
