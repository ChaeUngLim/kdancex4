/**
 * 개인 레슨 스케줄(보드 I10) — S2-4.6(앱 개인 레슨·일정 화면). 주소 `/instructor/private-lessons`.
 *
 * 한 주(월~일)의 1:1 레슨을 여러 학원 섞어 시간순으로 보이고, 아래에 수강생별 남은 횟수를 보인다.
 *
 * 부르는 API
 *  1. `GET /api/instructor/affiliations`  학원 칩(소속됨만) — 「전체」를 누르면 학원을 거르지 않는다
 *  2. `GET /api/instructor/schedule?from=월&to=일&include=private[&academyId=]`  이번 주 레슨(계약 11 §11, S2-4.5)
 *  3. `GET /api/instructor/private-lesson-passes[?academyId=]`  수강생별 수강권(계약 11 §10-3)
 *     — 서버에 아직 없는 경로다. 못 읽으면 그 카드만 「다시 시도」로 두고 위 표는 그대로 보인다
 *
 * 규칙
 *  - 개인 레슨은 결제 대기여도 수강생 이름이 보인다(수용 ④). 단체 수업의 「결제 대기 N명」 숫자 규칙을 쓰지 않는다
 *  - 멤버십이 끝나 이름이 숨겨지면(`student: null`) 「수강생」으로만 쓴다 — 맨 아래 안내 문장과 같은 뜻
 *  - 수강권 줄(「시간 잡기 ›」)을 누르면 수강생 상세(I20, S2-4.8)로 간다
 *
 * 고른 주·학원은 화면 상태(useState)이고, 주소는 렌더 중에 계산한다. 주소가 바뀌면 `useApiResource` 가 새로 읽는다.
 * 효과 훅을 새로 쓰지 않는다.
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatKstTime } from '../../../lib/catalog/format';
import { LoadingView } from '../../../lib/catalog/ui';
import { useApiResource, type ResourceState } from '../../../lib/catalog/use-api-resource';
import { ACADEMY_COLORS } from '../../../lib/instructor/affiliation-api';
import {
  addDays,
  byStart,
  kstDateOf,
  kstToday,
  lessonStateLabel,
  lessonSummary,
  mondayOf,
  monthSlashDay,
  passesPath,
  schedulePath,
  slashDayTime,
  studentName,
  visiblePasses,
  weekdaySlashDay,
  type InstructorSchedule,
  type PrivateLessonItem,
  type PrivateLessonPass,
} from '../../../lib/instructor/schedule-api';
import type { AffiliationCard } from '../../../lib/instructor/staff-api';
import { goBack, InstructorShell, StaffErrorView, staffStyles } from '../../../lib/instructor/staff-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../../../lib/theme';

export default function PrivateLessonScheduleScreen() {
  const today = kstToday();
  // 몇 주 앞·뒤를 보고 있나(0 = 이번 주). ‹ › 버튼이 바꾼다
  const [weekOffset, setWeekOffset] = useState(0);
  // 고른 학원(null = 전체)
  const [academyId, setAcademyId] = useState<string | null>(null);

  // 주의 월요일·일요일은 렌더 중에 계산한다
  const monday = addDays(mondayOf(today), weekOffset * 7);
  const sunday = addDays(monday, 6);

  const affiliations = useApiResource<{ items: AffiliationCard[] }>('/api/instructor/affiliations');
  const schedule = useApiResource<InstructorSchedule>(schedulePath(monday, sunday, ['private'], academyId));
  const passes = useApiResource<{ items: PrivateLessonPass[] }>(passesPath(academyId));

  const chips = affiliations.state.status === 'ready' ? affiliations.state.data.items.filter((card) => card.status === 'active') : [];
  const passList = passes.state.status === 'ready' ? visiblePasses(passes.state.data.items) : null;

  let table;
  if (schedule.state.status === 'loading') {
    table = <LoadingView label="이번 주 레슨을 불러오고 있어요" />;
  } else if (schedule.state.status === 'error') {
    table = <StaffErrorView error={schedule.state.error} onRetry={schedule.reload} />;
  } else {
    const lessons = byStart(schedule.state.data.items.filter((item): item is PrivateLessonItem => item.kind === 'private_lesson'));
    table = (
      <>
        <Text style={styles.summary}>{lessonSummary(lessons, passList, today)}</Text>
        <LessonTable lessons={lessons} today={today} />
      </>
    );
  }

  const weekTitle = `${monthSlashDay(monday)} – ${monthSlashDay(sunday)}${weekOffset === 0 ? ' · 이번 주' : ''}`;

  return (
    <InstructorShell title="개인 레슨 스케줄" active="classes" onBack={() => goBack('/instructor')}>
      <View style={styles.weekRow}>
        <Pressable style={styles.weekArrow} onPress={() => setWeekOffset((w) => w - 1)} accessibilityRole="button" accessibilityLabel="지난주">
          <Text style={styles.weekArrowText}>‹</Text>
        </Pressable>
        <Text style={styles.weekTitle} accessibilityRole="header">
          {weekTitle}
        </Text>
        <Pressable style={styles.weekArrow} onPress={() => setWeekOffset((w) => w + 1)} accessibilityRole="button" accessibilityLabel="다음 주">
          <Text style={styles.weekArrowText}>›</Text>
        </Pressable>
      </View>

      <View style={styles.chips} accessibilityRole="radiogroup">
        <Chip label="전체" selected={academyId === null} onPress={() => setAcademyId(null)} />
        {chips.map((card) => (
          <Chip
            key={card.academyId}
            label={card.academyName}
            color={card.calendarColorIndex !== null ? ACADEMY_COLORS[card.calendarColorIndex]?.hex ?? null : null}
            selected={academyId === card.academyId}
            onPress={() => setAcademyId(card.academyId)}
          />
        ))}
      </View>

      {table}

      <PassesCard state={passes.state} passList={passList} onRetry={passes.reload} />

      <Text style={staffStyles.muted}>수강생 이름은 멤버십에서 보여요. 끝나면 시간·횟수만 남아요.</Text>

      <Pressable style={styles.openButton} onPress={() => router.push('/instructor/private-lessons/new')} accessibilityRole="button">
        <Text style={styles.openButtonText}>+ 개인 레슨 열기</Text>
      </Pressable>
    </InstructorShell>
  );
}

function Chip({ label, color = null, selected, onPress }: { label: string; color?: string | null; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.chip, selected && styles.chipOn]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      // 웹(react-native-web)은 accessibilityState 를 aria 로 옮기지 않아 직접 준다
      aria-checked={selected}
      accessibilityLabel={label}
    >
      {color !== null && <View style={[styles.chipDot, { backgroundColor: color }]} />}
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

function LessonTable({ lessons, today }: { lessons: readonly PrivateLessonItem[]; today: string }) {
  return (
    <View style={staffStyles.card}>
      <View style={styles.tableHead}>
        <Text style={[styles.th, styles.colWhen]}>날짜·시간</Text>
        <Text style={[styles.th, styles.colWho]}>수강생 · 학원</Text>
        <Text style={[styles.th, styles.colNo]}>회차</Text>
        <Text style={[styles.th, styles.colState]}>상태</Text>
      </View>
      {lessons.length === 0 ? (
        <Text style={styles.empty}>이 주에는 잡힌 1:1 레슨이 없어요.</Text>
      ) : (
        lessons.map((item, index) => {
          const state = lessonStateLabel(item, today);
          const isToday = state === '오늘';
          const isPast = state === '완료' || state === '결석';
          return (
            <View key={item.id} style={[styles.row, index > 0 && styles.divider, isToday && styles.rowToday]}>
              <View style={styles.colWhen}>
                <Text style={styles.day}>{weekdaySlashDay(kstDateOf(item.startsAt))}</Text>
                <Text style={[styles.time, isPast && styles.past]}>{formatKstTime(item.startsAt)}</Text>
              </View>
              <View style={styles.colWho}>
                <Text style={[styles.who, isPast && styles.past]} numberOfLines={1}>
                  {studentName(item.student)}
                </Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {item.academy.name}
                </Text>
              </View>
              <Text style={[styles.no, styles.colNo]}>
                {item.sessionNo}/{item.sessionsTotal}회
              </Text>
              <Text style={[styles.state, styles.colState, isToday && styles.stateToday, isPast && styles.past]}>{state}</Text>
            </View>
          );
        })
      )}
    </View>
  );
}

interface PassesCardProps {
  state: ResourceState<{ items: PrivateLessonPass[] }>;
  passList: PrivateLessonPass[] | null;
  onRetry: () => void;
}

/** 수강생별 남은 횟수 — 결제 대기는 마감 시각을 주황(갈색)으로 보인다 */
function PassesCard({ state, passList, onRetry }: PassesCardProps) {
  let body;
  if (state.status === 'loading') {
    body = <LoadingView label="수강권을 불러오고 있어요" />;
  } else if (state.status === 'error' || passList === null) {
    body = (
      <View style={styles.passError}>
        <Text style={staffStyles.muted}>수강생별 남은 횟수를 불러오지 못했어요.</Text>
        <Pressable style={styles.retry} onPress={onRetry} accessibilityRole="button">
          <Text style={styles.retryText}>다시 시도</Text>
        </Pressable>
      </View>
    );
  } else if (passList.length === 0) {
    body = <Text style={styles.empty}>아직 수강권을 산 회원이 없어요.</Text>;
  } else {
    body = passList.map((pass, index) => {
      const pending = pass.awaitingPayment !== null;
      const detail = pending
        ? `${pass.sessionsTotal}회권 · 결제 대기 · ${slashDayTime(pass.awaitingPayment!.until)}까지`
        : `${pass.sessionsTotal}회권 · 남은 ${pass.remainingSessions}회`;
      return (
        // 줄을 누르면 수강생 상세(I20, S2-4.8)로 간다 — 결제 상태·회차를 보고 다음 회차를 잡는 곳
        <Pressable
          key={pass.passId}
          style={[styles.passRow, index > 0 && styles.divider]}
          onPress={() => router.push(`/instructor/private-lessons/passes/${pass.passId}`)}
          accessibilityRole="button"
          accessibilityLabel={`${studentName(pass.student)} 수강생 상세`}
        >
          <View style={styles.passText}>
            <Text style={styles.who}>{studentName(pass.student)}</Text>
            <Text style={[styles.sub, pending && styles.pending]}>{detail}</Text>
          </View>
          <Text style={styles.bookLater}>{!pending && pass.remainingSessions > 0 ? '시간 잡기 ›' : '›'}</Text>
        </Pressable>
      );
    });
  }
  return (
    <View style={staffStyles.card}>
      <Text style={staffStyles.sectionTitle}>수강생별 남은 횟수</Text>
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  weekRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  weekArrow: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  weekArrowText: { fontSize: font.h2, color: colors.ink },
  weekTitle: { fontSize: 17, fontWeight: '800', color: colors.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  chipOn: { borderColor: colors.brown, backgroundColor: colors.brownSoft },
  chipDot: { width: 8, height: 8, borderRadius: radius.pill },
  chipText: { color: colors.ink, fontSize: font.small },
  chipTextOn: { fontWeight: '700' },
  summary: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  tableHead: { flexDirection: 'row', gap: space.xs },
  th: { color: colors.ink3, fontSize: font.tiny },
  colWhen: { width: 64 },
  colWho: { flex: 1 },
  colNo: { width: 52 },
  colState: { width: 52 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.sm },
  rowToday: { backgroundColor: colors.okSoft, marginHorizontal: -space.sm, paddingHorizontal: space.sm, borderRadius: radius.sm },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  day: { color: colors.ink3, fontSize: font.tiny },
  time: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  who: { color: colors.ink, fontSize: font.body, fontWeight: '700' },
  sub: { color: colors.ink3, fontSize: font.tiny },
  no: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  state: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  stateToday: { color: colors.brown },
  past: { color: colors.ink3 },
  pending: { color: colors.brown, fontWeight: '700' },
  empty: { color: colors.ink3, fontSize: font.body, paddingVertical: space.md, textAlign: 'center' },
  passRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.sm, minHeight: MIN_TOUCH },
  passText: { flex: 1, gap: 2 },
  bookLater: { color: colors.brown, fontSize: font.small, fontWeight: '700' },
  passError: { gap: space.sm, alignItems: 'flex-start' },
  retry: { minHeight: 40, paddingHorizontal: space.lg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.brown, justifyContent: 'center' },
  retryText: { color: colors.brown, fontWeight: '700' },
  openButton: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.brown,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  openButtonText: { color: colors.brown, fontSize: font.body, fontWeight: '700' },
});
