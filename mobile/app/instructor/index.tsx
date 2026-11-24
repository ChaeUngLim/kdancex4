/**
 * 강사 홈(보드 I1) — S2-4.6(앱 개인 레슨·일정 화면) · S3-5.9(앱 강사 명단 화면). 주소 `/instructor`.
 *
 * 「오늘 수업 인원」 카드 하나가 중심이다. 여러 학원 수업과 개인 레슨이 시간순 한 목록으로 나온다(수용 ③).
 *
 * 부르는 API(둘 다 이미 있는 경로)
 *  1. `GET /api/instructor/me/profile`  머리 줄 「강사 · 라틴하우스 강남 외 1」
 *  2. `GET /api/instructor/schedule?from=오늘&to=오늘&include=sessions,private`  오늘 일정(계약 11 §11, S2-4.5)
 *  3. `GET /api/instructor/headcount?date=오늘`  오늘 인원표(계약 18 §7, S3-5.9) — 참석·결석 칸의 숫자
 *
 * 칸 규칙(S3-5.9 부터)
 *  - 줄 목록은 일정(2)에서 온다 — 휴강·폐강 회차도 그 칸에 「휴강」·「폐강」으로 남기려고. 숫자는 인원표(3)에서 회차 id 로 찾아 붙인다
 *  - 단체 수업의 「참석 남 · 여」는 오늘 인원 = 확정 − 결석 예정 + 현장(서버 computePresent 하나). 결제 대기는 세지 않는다
 *  - 「결석」 칸은 결석 예정 인원 「결석 1 (여)」, 없으면 「없음」. 개인 레슨은 「확정」(수강권 결제 대기면 「결제 대기」)
 *  - 인원표를 못 읽으면 숫자를 지어내지 않고 일정의 결제 확정 인원과 「—」로 그린다
 *  - 개인 레슨 줄은 누르면 개인 레슨 스케줄(I10)로, 수업 줄은 회차 상세(I6B)로 간다
 *  - 「하루 전체 보기 ›」는 수업 인원 한눈에(I7, `/instructor/headcount`)로 간다
 *
 * 읽기는 `useApiResource` 로만 하고 효과 훅을 새로 쓰지 않는다. 오늘 날짜는 렌더 중에 계산한다.
 */
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatKstTime } from '../../lib/catalog/format';
import { LoadingView } from '../../lib/catalog/ui';
import { useApiResource } from '../../lib/catalog/use-api-resource';
import { ACADEMY_COLORS } from '../../lib/instructor/affiliation-api';
import {
  absenceLabel,
  absenceTotal,
  headcountPath,
  presentCounts,
  type HeadcountItem,
  type InstructorHeadcount,
} from '../../lib/instructor/headcount-api';
import {
  byStart,
  kstToday,
  paidLine,
  schedulePath,
  slashDayWithWeekday,
  studentName,
  type ClassSessionItem,
  type InstructorSchedule,
  type PrivateLessonItem,
} from '../../lib/instructor/schedule-api';
import { affiliationSummary, type InstructorProfile } from '../../lib/instructor/staff-api';
import { InstructorShell, MenuGroup, MenuRow, StaffErrorView, staffStyles } from '../../lib/instructor/staff-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';

type TodayItem = ClassSessionItem | PrivateLessonItem;

export default function InstructorHomeScreen() {
  // 오늘(KST)은 렌더 중에 바로 계산한다 — 자정이 지나 다시 그리면 새 날짜로 읽는다
  const today = kstToday();
  const profile = useApiResource<InstructorProfile>('/api/instructor/me/profile');
  const schedule = useApiResource<InstructorSchedule>(schedulePath(today, today, ['sessions', 'private']));
  const headcount = useApiResource<InstructorHeadcount>(headcountPath(today));

  const top = (
    <Text style={styles.who}>
      {profile.state.status === 'ready' ? `강사 · ${affiliationSummary(profile.state.data.affiliations)}` : '강사'}
    </Text>
  );

  let card;
  if (schedule.state.status === 'loading') {
    card = <LoadingView label="오늘 일정을 불러오고 있어요" />;
  } else if (schedule.state.status === 'error') {
    card = <StaffErrorView error={schedule.state.error} onRetry={schedule.reload} />;
  } else {
    // 오늘 할 일만 — 개인 일정은 「수업 인원」 카드에 넣지 않는다(보드 I1)
    const items = byStart(
      schedule.state.data.items.filter((item): item is TodayItem => item.kind === 'class_session' || item.kind === 'private_lesson'),
    );
    // 인원표 줄을 「회차 id · 개인 레슨 예약 id」로 찾을 수 있게 렌더 중에 묶는다. 아직 못 읽었으면 빈 묶음(숫자 없이 그린다)
    const counts = new Map<string, HeadcountItem>(
      headcount.state.status === 'ready'
        ? headcount.state.data.items.map((row) => [row.kind === 'class' ? row.sessionId : row.bookingId, row] as const)
        : [],
    );
    card = <TodayCard items={items} counts={counts} />;
  }

  return (
    <InstructorShell title={`오늘 · ${slashDayWithWeekday(today)}`} active="home" top={top}>
      {card}
      <MenuGroup>
        {/* 개인 레슨 스케줄(I10) 입구. 보드 I1 에는 오늘 개인 레슨 줄로만 들어가서, 레슨이 없는 날에도 갈 수 있게 한 줄 둔다 */}
        <MenuRow title="개인 레슨 스케줄" detail="이번 주 1:1 레슨 · 수강생별 남은 횟수" onPress={() => router.push('/instructor/private-lessons')} />
        {/* 새 반 열기 추천(I15) 입구 — S6-3.6. 수업 탭(I19)이 아직 없어 홈에 둔다(강사 멤버십 기능, 잠김은 그 화면이 알린다) */}
        <MenuRow title="새 반 열기 추천" detail="조건을 넣으면 후보 수와 근거를 보여 줘요" onPress={() => router.push('/instructor/new-class')} divided />
      </MenuGroup>
    </InstructorShell>
  );
}

function TodayCard({ items, counts }: { items: readonly TodayItem[]; counts: ReadonlyMap<string, HeadcountItem> }) {
  return (
    <View style={staffStyles.card}>
      <View style={styles.cardHead}>
        <Text style={staffStyles.sectionTitle}>오늘 수업 인원</Text>
        <Pressable onPress={() => router.push('/instructor/headcount')} accessibilityRole="button" accessibilityLabel="하루 전체 보기" hitSlop={8}>
          <Text style={styles.headLink}>하루 전체 보기 ›</Text>
        </Pressable>
      </View>
      <View style={styles.tableHead}>
        <Text style={[styles.th, styles.colTime]}>시간</Text>
        <Text style={[styles.th, styles.colWhat]}>수업 · 학원</Text>
        <Text style={[styles.th, styles.colPaid]}>참석 남 · 여</Text>
        <Text style={[styles.th, styles.colAbsent]}>결석</Text>
      </View>
      {items.length === 0 ? (
        <Text style={styles.empty}>오늘은 잡힌 수업이 없어요.</Text>
      ) : (
        items.map((item, index) => <TodayRow key={`${item.kind}-${item.id}`} item={item} count={counts.get(item.id)} divided={index > 0} />)
      )}
    </View>
  );
}

/** 참석 칸 글자 — 남녀면 「남 1 · 여 2」, 단일 정원이면 「3명」 */
function presentText(count: HeadcountItem): string {
  const present = presentCounts(count);
  return 'any' in present ? `${present.any}명` : `남 ${present.male} · 여 ${present.female}`;
}

function TodayRow({ item, count, divided }: { item: TodayItem; count: HeadcountItem | undefined; divided: boolean }) {
  const color = item.academy.colorIndex !== null ? ACADEMY_COLORS[item.academy.colorIndex]?.hex ?? colors.line : colors.line;
  // 줄마다 무엇을 보일지 렌더 중에 정한다 — 개인 레슨과 단체 수업은 칸 뜻이 다르다
  const isLesson = item.kind === 'private_lesson';
  const title = isLesson ? '개인 레슨 · 1:1' : item.title;
  const where = isLesson
    ? `${studentName(item.student)} · ${item.academy.name}`
    : `${item.academy.name}${item.room !== null ? ` ${item.room}` : ''}${item.isSubstitute ? ' · 대타' : ''}`;
  // 휴강·폐강 회차는 인원표에 없다(계약 18 §7) — 그 칸에 상태 글자를 쓴다
  const closedLabel = !isLesson && item.status === 'cancelled' ? '휴강' : !isLesson && item.status === 'closed' ? '폐강' : null;
  const paid = isLesson ? `${item.sessionNo}/${item.sessionsTotal}회` : count !== undefined ? presentText(count) : paidLine(item.paid);
  const absent = closedLabel ?? (count !== undefined ? absenceLabel(count) : isLesson ? '확정' : '—');
  const warn = count !== undefined && absenceTotal(count) > 0;

  const onPress = () => {
    if (item.kind === 'private_lesson') router.push('/instructor/private-lessons');
    else router.push({ pathname: '/instructor/sessions/[sessionId]', params: { sessionId: item.id, classId: item.classId } });
  };

  return (
    <Pressable
      style={[styles.row, divided && styles.divider]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${formatKstTime(item.startsAt)} ${title}, ${where}, ${paid}, ${absent}`}
    >
      <Text style={[styles.time, styles.colTime]}>{formatKstTime(item.startsAt)}</Text>
      <View style={[styles.colWhat, styles.whatBox]}>
        <View style={styles.titleLine}>
          <View style={[styles.academyDot, { backgroundColor: color }]} />
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <Text style={styles.rowSub} numberOfLines={1}>
          {where}
        </Text>
      </View>
      <Text style={[styles.paid, styles.colPaid]}>{paid}</Text>
      <Text style={[styles.absent, styles.colAbsent, isLesson && styles.confirmed, warn && styles.absentWarn]}>{absent}</Text>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  who: { color: colors.ink3, fontSize: font.small },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headLink: { color: colors.brown, fontSize: font.small, fontWeight: '700' },
  tableHead: { flexDirection: 'row', gap: space.xs, paddingTop: space.xs },
  th: { color: colors.ink3, fontSize: font.tiny },
  colTime: { width: 48 },
  colWhat: { flex: 1 },
  colPaid: { width: 78 },
  colAbsent: { width: 70 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: MIN_TOUCH + 8, paddingVertical: space.sm },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  time: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  whatBox: { gap: 2 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  academyDot: { width: 8, height: 8, borderRadius: radius.pill },
  rowTitle: { color: colors.ink, fontSize: font.body, fontWeight: '700', flexShrink: 1 },
  rowSub: { color: colors.ink3, fontSize: font.tiny },
  paid: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  absent: { color: colors.ink3, fontSize: font.small },
  confirmed: { color: colors.brown, fontWeight: '700' },
  absentWarn: { color: colors.danger, fontWeight: '700' },
  chevron: { color: colors.ink3, fontSize: font.h2 },
  empty: { color: colors.ink3, fontSize: font.body, paddingVertical: space.md, textAlign: 'center' },
});
