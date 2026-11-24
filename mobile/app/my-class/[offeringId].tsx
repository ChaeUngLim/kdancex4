/**
 * 신청한 수업 상세 — 보드 M8C(신청한 수업 · 확정 · 달력 한 달 ‹ ›), 로드맵 S3-4.8.
 *
 * 옛 데모 화면 `app/offering/[id].tsx`(수업 상세 M8 — 자리 고르기·결제 시작)와 갈랐다.
 * 그 화면은 「아직 신청 전」 회원이 보는 곳이고, 이 화면은 이미 확정된 수업을 캘린더에서 눌러 들어오는 곳이다.
 * 그래서 하단 탭은 들어온 영역인 「캘린더」가 켜져 있다(spec FR-050 아래 「회원의 신청한 수업 상세 화면」 ⑧).
 *
 * 화면이 읽는 실제 데이터(새 서버 경로는 만들지 않았다)
 *  - `GET /api/offerings/{offeringId}`(계약 02 §2) — 수업명·학원·강사·수강료·**회차 전체**. 달력은 이 회차로 그린다
 *  - `GET /api/me/calendar`(계약 04 §1, 기본 범위 오늘~+31일) — 내 확정 회차. 이 수업 줄이 있으면 「신청함」 태그와
 *    「내 수업 일정」(다음 수업 한 건)을 내 기록에서 보인다. 범위 안에 없으면 회차 목록에서 다음 수업을 고른다
 *
 * 달력 규칙(④ — 2026-11-21 사용자 요청: 「달력은 한 달만, 위 화살표로 넘김」)
 *  - 한 번에 한 달만. 첫 달은 다음 수업이 있는 달, 수업 기간 밖으로는 ‹ › 가 막힌다
 *  - 달 넘기기는 ‹ › 버튼의 onPress 에서 상태를 바꾼다(useEffect 를 쓰지 않는다 — 언제 바뀌는지 눈에 보이게)
 *  - 계산은 `lib/me/class-month-calendar.ts` 의 순수 함수가 한다
 *
 * 이번에 그리지 않은 것(보드에는 있음 — 회원용 서버 경로가 아직 없다): ⑤ 학원 전체 시간표 · ⑥ 수업 전체 목록 ·
 * 「강사 공지」 카드. 지어낸 값으로 채우지 않고 빼 두었다(증거 EVIDENCE.md 「열린 점」).
 */
import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatKstDateTime, formatKstTime, formatWon, parseInstant } from '../../lib/catalog/format';
import { colors, font, radius, space } from '../../lib/theme';
import type { CalendarEntry, OfferingDetail } from '../../lib/catalog/types';
import { Card, DetailScreen, ErrorView, LoadingView, SectionTitle, shared } from '../../lib/catalog/ui';
import { readRouteId, useApiResource } from '../../lib/catalog/use-api-resource';
import {
  calendarFootnote,
  monthCellsMonFirst,
  navState,
  planClassCalendar,
  sessionCountOn,
  shiftWithinPlan,
  WEEK_LABELS_MON_FIRST,
  type ClassCalendarPlan,
  type MonthCursor,
} from '../../lib/me/class-month-calendar';

const TITLE = '신청한 수업';

export default function MyClassDetailScreen() {
  const offeringId = readRouteId(useLocalSearchParams<{ offeringId: string }>().offeringId);
  const detail = useApiResource<OfferingDetail>(
    offeringId === null ? null : `/api/offerings/${encodeURIComponent(offeringId)}`,
  );
  // 내 캘린더(기본 범위). 실패해도 수업 정보는 보여야 하므로 아래에서 오류를 따로 다룬다
  const mine = useApiResource<{ items: readonly CalendarEntry[] }>(offeringId === null ? null : '/api/me/calendar');

  if (offeringId === null) {
    return (
      <DetailScreen title={TITLE} tab="calendar">
        <Text style={shared.muted}>잘못된 수업 주소예요.</Text>
      </DetailScreen>
    );
  }
  const myEntries =
    mine.state.status === 'ready' ? (mine.state.data.items ?? []).filter((entry) => entry.offeringId === offeringId) : [];
  return (
    <DetailScreen title={TITLE} tab="calendar">
      {detail.state.status === 'loading' && <LoadingView />}
      {detail.state.status === 'error' && <ErrorView error={detail.state.error} onRetry={detail.reload} />}
      {detail.state.status === 'ready' && (
        <MyClassBody detail={detail.state.data} myEntries={myEntries} myCalendarFailed={mine.state.status === 'error'} />
      )}
    </DetailScreen>
  );
}

interface MyClassBodyProps {
  detail: OfferingDetail;
  myEntries: readonly CalendarEntry[];
  myCalendarFailed: boolean;
}

function MyClassBody({ detail, myEntries, myCalendarFailed }: MyClassBodyProps) {
  // 렌더할 때 바로 계산한다 — 회차 목록이 같으면 결과도 같다(따로 상태로 들고 있지 않는다)
  const plan = planClassCalendar(detail.sessions ?? [], new Date());
  return (
    <>
      <HeaderBlock detail={detail} />
      <SummaryCard detail={detail} plan={plan} applied={myEntries.length > 0} />
      <NextClassCard plan={plan} myEntries={myEntries} myCalendarFailed={myCalendarFailed} />
      {plan.initialMonth !== null && <ClassMonthCalendar plan={plan} initialMonth={plan.initialMonth} />}
    </>
  );
}

/** ① 수업명과 학원·강사 */
function HeaderBlock({ detail }: { detail: OfferingDetail }) {
  return (
    <View style={styles.headerBlock}>
      <Text style={styles.classTitle} accessibilityRole="header">
        {detail.title}
      </Text>
      <Text style={shared.muted}>
        {detail.academy?.name ?? '학원'} · 강사 {detail.instructorName}
      </Text>
    </View>
  );
}

/** 「화 20:00–21:00」 — 첫 회차의 요일·시각 */
function weeklyTimeText(detail: OfferingDetail): string {
  const first = detail.sessions?.[0];
  if (first === undefined) {
    return '일정 미정';
  }
  // 회차 전체의 요일을 모아 월요일부터 순서대로 잇는다(월·수 수업이면 「월·수」).
  // 첫 회차 요일만 쓰면 주 2회 수업이 「월」로만 보인다 — 실제 시연 데이터(월·수 16회)로 찍어 보고 찾았다
  const order = ['월', '화', '수', '목', '금', '토', '일'];
  const days = new Set((detail.sessions ?? []).map((s) => formatKstDateTime(s.startsAt).match(/\((.)\)/)?.[1] ?? ''));
  const dayText = order.filter((d) => days.has(d)).join('·');
  return `${dayText} ${formatKstTime(first.startsAt)}–${formatKstTime(first.endsAt)}`;
}

/** ② 요약 카드 — 구분(판매 단위 이름)·`신청함` 태그, 요일·시간·회차·수강료 */
function SummaryCard({ detail, plan, applied }: { detail: OfferingDetail; plan: ClassCalendarPlan; applied: boolean }) {
  return (
    <Card>
      <View style={styles.tagRow}>
        <Text style={[shared.tag, styles.labelTag]}>{detail.label}</Text>
        {/* 내 캘린더에 이 수업의 확정 회차가 있을 때만 단다 — 서버 기록으로 확인된 것만 「신청함」이라 말한다 */}
        {applied && <Text style={[shared.tag, shared.tagOk]}>신청함</Text>}
      </View>
      <SummaryRow label="요일·시간" value={weeklyTimeText(detail)} />
      <SummaryRow label="회차" value={`총 ${plan.totalCount}회`} />
      <SummaryRow label="수강료" value={formatWon(detail.priceAmount)} />
    </Card>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={shared.muted}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

/**
 * ③ 「내 수업 일정」 — 다음 수업 한 건(아이보리 카드).
 * 내 캘린더 기록(범위 안)에 있으면 그 줄을, 없으면 수업 회차 목록의 다음 회차를 쓴다.
 */
function NextClassCard({ plan, myEntries, myCalendarFailed }: { plan: ClassCalendarPlan; myEntries: readonly CalendarEntry[]; myCalendarFailed: boolean }) {
  const now = Date.now();
  const mineNext = [...myEntries]
    .filter((entry) => (parseInstant(entry.endsAt)?.getTime() ?? 0) > now)
    .sort((a, b) => (parseInstant(a.startsAt)?.getTime() ?? 0) - (parseInstant(b.startsAt)?.getTime() ?? 0))[0];
  const next =
    mineNext !== undefined
      ? { seq: mineNext.sessionSeq, startsAt: mineNext.startsAt, endsAt: mineNext.endsAt }
      : plan.nextSession === null
        ? null
        : { seq: plan.nextSession.seq, startsAt: plan.nextSession.startsAt.toISOString(), endsAt: plan.nextSession.endsAt.toISOString() };
  return (
    <View style={styles.section}>
      <SectionTitle>내 수업 일정</SectionTitle>
      {next === null ? (
        <Text style={shared.muted}>남은 수업이 없어요. 모든 회차가 끝났어요.</Text>
      ) : (
        <View style={styles.nextCard} accessible accessibilityLabel={`다음 수업 ${next.seq}회차 ${formatKstDateTime(next.startsAt)}`}>
          <Text style={styles.nextLabel}>다음 수업 · {next.seq}회차</Text>
          <Text style={styles.nextWhen}>
            {formatKstDateTime(next.startsAt)}–{formatKstTime(next.endsAt)}
          </Text>
        </View>
      )}
      {myCalendarFailed && <Text style={shared.muted}>내 캘린더를 불러오지 못해 수업 회차 기준으로 보여요.</Text>}
    </View>
  );
}

/**
 * ④ 「수업 일정」 달력 — 한 번에 한 달, 카드 오른쪽 위 ‹ › 로 넘긴다.
 * 보고 있는 달은 이 컴포넌트의 상태 하나뿐이고, 바꾸는 곳도 ‹ › 의 onPress 한 곳뿐이다.
 */
function ClassMonthCalendar({ plan, initialMonth }: { plan: ClassCalendarPlan; initialMonth: MonthCursor }) {
  const [cursor, setCursor] = useState<MonthCursor>(initialMonth);
  const { canPrev, canNext } = navState(plan, cursor);
  // 버튼을 누른 그 자리에서 달을 옮긴다. 범위 밖이면 shiftWithinPlan 이 끝 달에 멈춘다
  const move = (delta: number) => setCursor((current) => shiftWithinPlan(plan, current, delta));
  const cells = monthCellsMonFirst(cursor);
  return (
    <Card>
      <View style={styles.calHead}>
        <SectionTitle>수업 일정</SectionTitle>
        <View style={styles.legend}>
          <View style={styles.legendDot} />
          <Text style={styles.legendText}>수업 있는 날</Text>
          <Text style={styles.legendText}>· 전체 {plan.totalCount}회</Text>
        </View>
      </View>
      <View style={styles.monthRow}>
        <Text style={styles.monthTitle} accessibilityRole="header">
          {cursor.year}년 {cursor.month}월
        </Text>
        <MonthNavButton label="‹" a11y="이전 달" enabled={canPrev} onPress={() => move(-1)} />
        <MonthNavButton label="›" a11y="다음 달" enabled={canNext} onPress={() => move(1)} />
      </View>
      <View style={styles.grid}>
        {WEEK_LABELS_MON_FIRST.map((label, index) => (
          <Text key={label} style={[styles.weekLabel, index >= 5 && styles.weekend, plan.classWeekdaysMonFirst.includes(index) && styles.weekStrong]}>
            {label}
          </Text>
        ))}
        {cells.map((day, index) => {
          if (day === null) {
            return <View key={`blank-${index}`} style={styles.cell} />;
          }
          const hasClass = sessionCountOn(plan, cursor, day) > 0;
          return (
            <View
              key={`${cursor.year}-${cursor.month}-${day}`}
              style={styles.cell}
              accessible
              accessibilityLabel={`${cursor.month}월 ${day}일${hasClass ? ', 수업 있는 날' : ''}`}
            >
              <View style={[styles.dayCircle, hasClass && styles.dayCircleOn]}>
                <Text style={[styles.dayText, hasClass && styles.dayTextOn]}>{day}</Text>
              </View>
            </View>
          );
        })}
      </View>
      <Text style={styles.footnote}>ⓘ {calendarFootnote(plan, cursor)}</Text>
    </Card>
  );
}

interface MonthNavButtonProps {
  label: string;
  a11y: string;
  enabled: boolean;
  onPress: () => void;
}

/** ‹ › 버튼. 수업 기간 끝에 닿으면 흐리게 막는다(누를 수 없음을 글자색과 접근성 상태 둘 다로 알린다). */
function MonthNavButton({ label, a11y, enabled, onPress }: MonthNavButtonProps) {
  return (
    <Pressable
      style={[styles.navButton, !enabled && styles.navButtonOff]}
      onPress={onPress}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled: !enabled }}
      hitSlop={6}
    >
      <Text style={[styles.navText, !enabled && styles.navTextOff]}>{label}</Text>
    </Pressable>
  );
}

// 보드 M8C 의 아이보리 동그라미·테두리 값(spec: 아이보리 바탕 #EDE3D3 + 옅은 웜토프 테두리 #E3CF9F)
const IVORY_FILL = '#EDE3D3';
const IVORY_BORDER = '#E3CF9F';

const styles = StyleSheet.create({
  headerBlock: { gap: space.xs },
  classTitle: { fontSize: font.h2 + 2, fontWeight: '800', color: colors.ink },
  section: { gap: space.sm },
  tagRow: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  labelTag: { backgroundColor: colors.brownSoft, color: colors.brown },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  summaryValue: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  nextCard: {
    backgroundColor: IVORY_FILL,
    borderColor: IVORY_BORDER,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
    gap: 2,
  },
  nextLabel: { fontSize: font.small, color: colors.brown, fontWeight: '700' },
  nextWhen: { fontSize: 16, fontWeight: '700', color: colors.ink },
  calHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  legend: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  legendDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: IVORY_FILL, borderWidth: 1.5, borderColor: IVORY_BORDER },
  legendText: { fontSize: font.tiny, color: colors.ink3 },
  monthRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  monthTitle: { flex: 1, fontSize: 18, fontWeight: '800', color: colors.ink },
  navButton: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navButtonOff: { opacity: 0.45 },
  navText: { fontSize: 20, fontWeight: '700', color: colors.ink },
  navTextOff: { color: colors.disabledInk },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  weekLabel: { width: `${100 / 7}%`, textAlign: 'center', fontSize: font.small, color: colors.ink, paddingVertical: space.sm },
  weekend: { color: colors.ink3 },
  weekStrong: { fontWeight: '700' },
  cell: { width: `${100 / 7}%`, alignItems: 'center', paddingVertical: 3 },
  dayCircle: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  dayCircleOn: { backgroundColor: IVORY_FILL, borderWidth: 1.5, borderColor: IVORY_BORDER },
  dayText: { fontSize: font.body, color: colors.ink3 },
  dayTextOn: { color: colors.ink, fontWeight: '800' },
  footnote: { fontSize: font.small, color: colors.ink3 },
});
