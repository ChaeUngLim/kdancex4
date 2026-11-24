/**
 * 수업 인원 한눈에(보드 I7) — S3-5.9(앱 강사 명단 화면). 주소 `/instructor/headcount`. 강사 홈(I1)의 「하루 전체 보기 ›」로 들어온다.
 *
 * 하루(KST) 동안 내가 맡은 수업·개인 레슨을 시간순 한 표로 보고, 날짜(‹ ›)와 학원(칩)을 바꿔 본다.
 *  - 맨 위 요약줄: 「수업 2 · 개인 레슨 1 · 참석 21 (남 9 · 여 12) · 결석 예정 1」(서버 summary 그대로)
 *  - 표 한 줄: 시간 · 수업·학원 · 참석 남·여(오늘 인원 + 좌석 점 막대) · 결석
 *  - 수업 줄을 누르면 회차 상세의 「회원 관리」 탭(I23)으로 바로 간다 — 이 화면은 인원을 보러 오는 곳이라 명단이 다음 할 일이다.
 *    개인 레슨 줄은 개인 레슨 스케줄(I10)로 간다
 *
 * 부르는 API: `GET /api/instructor/headcount?date=&academyId=`(계약 18 §7) · `GET /api/instructor/affiliations`(학원 칩과 색, 계약 08 §2)
 * 고른 날짜·학원은 useState 이고 주소는 렌더 중에 계산한다 — 효과 훅을 쓰지 않는다(바뀌면 useApiResource 가 새 주소로 다시 읽는다).
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatKstTime } from '../../lib/catalog/format';
import { EmptyView, LoadingView } from '../../lib/catalog/ui';
import { useApiResource } from '../../lib/catalog/use-api-resource';
import { ACADEMY_COLORS } from '../../lib/instructor/affiliation-api';
import type { AffiliationCard } from '../../lib/instructor/staff-api';
import {
  absenceLabel,
  absenceTotal,
  gaugeDots,
  headcountPath,
  headcountSummaryLine,
  itemPlace,
  presentCounts,
  type HeadcountItem,
  type InstructorHeadcount,
} from '../../lib/instructor/headcount-api';
import { addDays, kstToday, slashDayWithWeekday } from '../../lib/instructor/schedule-api';
import { goBack, InstructorShell, StaffErrorView, staffStyles } from '../../lib/instructor/staff-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';

export default function HeadcountScreen() {
  const today = kstToday();
  // 오늘에서 며칠 떨어진 날을 보나(0 = 오늘). 화살표 핸들러가 바꾼다
  const [dayOffset, setDayOffset] = useState(0);
  // 고른 학원(null = 전체)
  const [academyId, setAcademyId] = useState<string | null>(null);

  const date = addDays(today, dayOffset);
  const affiliations = useApiResource<{ items: AffiliationCard[] }>('/api/instructor/affiliations');
  const headcount = useApiResource<InstructorHeadcount>(headcountPath(date, academyId));

  // 학원 칩과 색은 소속(active) 카드에서 — 인원표 응답에는 색이 없어서 학원 id 로 찾아 붙인다
  const active = affiliations.state.status === 'ready' ? affiliations.state.data.items.filter((card) => card.status === 'active') : [];
  const colorOf = (id: string): string => {
    const index = active.find((card) => card.academyId === id)?.calendarColorIndex ?? null;
    return index !== null ? ACADEMY_COLORS[index]?.hex ?? colors.line : colors.line;
  };

  let body;
  if (headcount.state.status === 'loading') {
    body = <LoadingView label="그날 인원을 불러오고 있어요" />;
  } else if (headcount.state.status === 'error') {
    body = <StaffErrorView error={headcount.state.error} onRetry={headcount.reload} />;
  } else if (headcount.state.data.items.length === 0) {
    body = <EmptyView title="이날은 잡힌 수업이 없어요" hint="휴강·폐강된 회차는 이 표에 나오지 않아요." />;
  } else {
    body = <HeadcountTable items={headcount.state.data.items} colorOf={colorOf} />;
  }

  // 요약줄은 제목 위 작은 글자(보드 I7). 읽기 전·오류면 비운다
  const top =
    headcount.state.status === 'ready' ? <Text style={styles.summary}>{headcountSummaryLine(headcount.state.data.summary)}</Text> : undefined;

  return (
    <InstructorShell title="수업 인원 한눈에" active="home" top={top} onBack={() => goBack('/instructor')}>
      <View style={styles.dayRow}>
        <Pressable style={styles.dayArrow} onPress={() => setDayOffset((d) => d - 1)} accessibilityRole="button" accessibilityLabel="전날">
          <Text style={styles.dayArrowText}>‹</Text>
        </Pressable>
        <Text style={styles.dayTitle} accessibilityRole="header">
          {`${slashDayWithWeekday(date)}${dayOffset === 0 ? ' 오늘' : ''}`}
        </Text>
        <Pressable style={styles.dayArrow} onPress={() => setDayOffset((d) => d + 1)} accessibilityRole="button" accessibilityLabel="다음 날">
          <Text style={styles.dayArrowText}>›</Text>
        </Pressable>
      </View>

      <View style={styles.chips} accessibilityRole="radiogroup">
        <Chip label="전체" selected={academyId === null} onPress={() => setAcademyId(null)} />
        {active.map((card) => (
          <Chip
            key={card.academyId}
            label={card.academyName}
            color={colorOf(card.academyId)}
            selected={academyId === card.academyId}
            onPress={() => setAcademyId(card.academyId)}
          />
        ))}
      </View>

      {body}
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
      // 웹(react-native-web)은 accessibilityState 를 aria 로 옮기지 않아 직접 준다(I10 칩과 같은 방법)
      aria-checked={selected}
      accessibilityLabel={label}
    >
      {color !== null && <View style={[styles.chipDot, { backgroundColor: color }]} />}
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

function HeadcountTable({ items, colorOf }: { items: readonly HeadcountItem[]; colorOf: (academyId: string) => string }) {
  return (
    <View style={staffStyles.card}>
      <View style={styles.tableHead}>
        <Text style={[styles.th, styles.colTime]}>시간</Text>
        <Text style={[styles.th, styles.colWhat]}>수업 · 학원</Text>
        <Text style={[styles.th, styles.colPresent]}>참석 남 · 여</Text>
        <Text style={[styles.th, styles.colAbsent]}>결석</Text>
      </View>
      {items.map((item, index) => (
        <HeadcountRow key={item.kind === 'class' ? item.sessionId : item.bookingId} item={item} color={colorOf(item.academy.id)} divided={index > 0} />
      ))}
    </View>
  );
}

function HeadcountRow({ item, color, divided }: { item: HeadcountItem; color: string; divided: boolean }) {
  const present = presentCounts(item);
  const absent = absenceLabel(item);
  const warn = absenceTotal(item) > 0;
  const lesson = item.kind === 'private_lesson';
  // 자리 종류별 정원 — 점 막대의 전체 칸. 개인 레슨은 1:1 이라 그 성별 칸만 1칸
  const capacity = (kind: 'male' | 'female' | 'any') =>
    item.kind === 'class' ? item.seats.find((seat) => seat.seatKind === kind)?.capacity ?? 0 : kind === item.student.gender ? 1 : 0;

  const onPress = () => {
    if (item.kind === 'private_lesson') router.push('/instructor/private-lessons');
    else
      router.push({
        pathname: '/instructor/sessions/[sessionId]',
        params: { sessionId: item.sessionId, classId: item.classId, tab: 'members' },
      });
  };

  const presentText = 'any' in present ? `${present.any}명` : `남 ${present.male} · 여 ${present.female}`;
  return (
    <Pressable
      style={[styles.row, divided && styles.divider]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${formatKstTime(item.startsAt)} ${item.title}, ${itemPlace(item)}, 참석 ${presentText}, ${absent}`}
    >
      <Text style={[styles.time, styles.colTime]}>{formatKstTime(item.startsAt)}</Text>
      <View style={[styles.colWhat, styles.whatBox]}>
        <View style={styles.titleLine}>
          <View style={[styles.academyDot, { backgroundColor: color }]} />
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.title}
          </Text>
        </View>
        <Text style={styles.rowSub} numberOfLines={1}>
          {itemPlace(item)}
        </Text>
      </View>
      <View style={[styles.colPresent, styles.presentBox]}>
        {'any' in present ? (
          <SeatCount label={`${present.any}명`} tone={colors.brown} gauge={gaugeDots(present.any, capacity('any'))} />
        ) : (
          <View style={styles.genderPair}>
            <SeatCount label={`남 ${present.male}`} tone={colors.seatMale} gauge={gaugeDots(present.male, capacity('male'))} />
            <SeatCount label={`여 ${present.female}`} tone={colors.seatFemale} gauge={gaugeDots(present.female, capacity('female'))} />
          </View>
        )}
      </View>
      <Text style={[styles.absent, styles.colAbsent, lesson && styles.confirmed, warn && styles.absentWarn, absent === '없음' && styles.none]}>
        {absent}
      </Text>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

/** 「● 남 5」 + 아래 좌석 점 막대(찬 칸만 칠함). 정원이 없으면 막대 없이 숫자만 */
function SeatCount({ label, tone, gauge }: { label: string; tone: string; gauge: { filled: number; total: number } | null }) {
  return (
    <View style={styles.seatBox}>
      <View style={styles.seatLabel}>
        <View style={[styles.seatDot, { backgroundColor: tone }]} />
        <Text style={styles.seatText}>{label}</Text>
      </View>
      {gauge !== null && (
        <View style={styles.gauge} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {Array.from({ length: gauge.total }, (_, i) => (
            <View key={i} style={[styles.gaugeDot, { backgroundColor: i < gauge.filled ? tone : colors.line }]} />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { color: colors.ink3, fontSize: font.small, fontWeight: '700' },
  dayRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dayArrow: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  dayArrowText: { fontSize: font.h2, color: colors.ink },
  dayTitle: { fontSize: 17, fontWeight: '800', color: colors.ink },
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
  tableHead: { flexDirection: 'row', gap: space.xs },
  th: { color: colors.ink3, fontSize: font.tiny },
  colTime: { width: 48 },
  colWhat: { flex: 1 },
  colPresent: { width: 90 },
  colAbsent: { width: 68 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: MIN_TOUCH + 8, paddingVertical: space.sm },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  time: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  whatBox: { gap: 2 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  academyDot: { width: 8, height: 8, borderRadius: radius.pill },
  rowTitle: { color: colors.ink, fontSize: font.body, fontWeight: '700', flexShrink: 1 },
  rowSub: { color: colors.ink3, fontSize: font.tiny },
  presentBox: { justifyContent: 'center' },
  genderPair: { flexDirection: 'row', gap: space.xs },
  seatBox: { gap: 3 },
  seatLabel: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  seatDot: { width: 7, height: 7, borderRadius: radius.pill },
  seatText: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  gauge: { flexDirection: 'row', gap: 2 },
  gaugeDot: { width: 4, height: 4, borderRadius: radius.pill },
  absent: { color: colors.ink3, fontSize: font.small },
  confirmed: { color: colors.brown, fontWeight: '700' },
  absentWarn: { color: colors.danger, fontWeight: '700' },
  none: { color: colors.disabledInk },
  chevron: { color: colors.ink3, fontSize: font.h2 },
});
