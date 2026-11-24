/**
 * AI 플래너 답 조각 — 수업 카드(보드 M10F) · 강사 후보 카드(M10G) · 조건 칩 · 결과 없음 버튼(SX-5.7).
 *
 * 화면(app/planner.tsx)은 「언제 무엇을 보낼지」만 맡고, 답 한 건을 어떻게 그릴지는 여기 둔다.
 * 카드의 버튼은 두 가지뿐이다.
 *  - 수업 카드 「신청하기」·「대기 신청」 → 수업 상세(`/offering/{id}`)로만 간다. 결제는 그 화면에서 회원이 직접 한다(FR-214(AI 쓰기 금지))
 *  - 강사 후보 「선택」 → 같은 질문을 그 강사로 정해 다시 묻는다(계약 16 §5-2 select_instructor)
 */
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatWon, genreLabel } from '../catalog/format';
import { colors, font, MIN_TOUCH, radius, space } from '../theme';
import {
  offeringCardHref,
  type PlannerAnswer,
  type PlannerInstructorCandidate,
  type PlannerOfferingCard,
  type PlannerWidenAction,
  type Weekday,
} from './answer';

// ---------------------------------------------------------------- 표시 글자

const WEEKDAY_KO: Readonly<Record<Weekday, string>> = { mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토', sun: '일' };
const LEVEL_KO: Readonly<Record<string, string>> = {
  entry: '입문',
  beginner: '초급',
  novice_intermediate: '초중급',
  intermediate: '중급',
  advanced: '고급',
};
const TIME_BAND_KO: Readonly<Record<string, string>> = { morning: '오전', afternoon: '오후', evening: '저녁' };
const SEAT_KO: Readonly<Record<string, string>> = { male: '남', female: '여' };

/** 「2026-11-12」 → 「11/12」 */
function shortDate(value: string | null): string | null {
  const match = value === null ? null : /^\d{4}-(\d{2})-(\d{2})$/.exec(value);
  return match === null ? null : `${Number(match[1])}/${Number(match[2])}`;
}

/** 「목 21:00–22:00 · 11/12–12/31 · 8회」 — 요일·시간이 여럿이면 쉼표로 잇는다 */
export function scheduleLine(card: PlannerOfferingCard): string {
  const times = card.pattern.map((p) => `${WEEKDAY_KO[p.weekday]} ${p.startTime}–${p.endTime}`).join(', ');
  const from = shortDate(card.firstSessionDate);
  const to = shortDate(card.lastSessionDate);
  const period = from === null ? null : to === null || to === from ? from : `${from}–${to}`;
  const count = card.sessionCount === null ? null : `${card.sessionCount}회`;
  return [times || null, period, count].filter((t): t is string => t !== null).join(' · ');
}

/** 「초급 · 남은 자리 남 2 · 여 3 (대기 가능)」. 남녀 구분 없는 수업은 「남은 자리 3」 */
export function seatLine(card: PlannerOfferingCard): string {
  const level = card.level === null ? null : (LEVEL_KO[card.level] ?? null);
  const pools = card.pools.map((p) => (SEAT_KO[p.seatKind] === undefined ? `${p.remaining}` : `${SEAT_KO[p.seatKind]} ${p.remaining}`)).join(' · ');
  const seats = card.isPrivateLesson ? '1:1 개인 레슨' : `남은 자리 ${pools || '0'}`;
  const waitlist = card.recruitStatus === 'full' && card.waitlistAvailable ? ' (대기 가능)' : '';
  return [level, `${seats}${waitlist}`].filter((t): t is string => t !== null).join(' · ');
}

const STATUS_BADGE: Readonly<Record<PlannerOfferingCard['recruitStatus'], { label: string; full: boolean }>> = {
  open: { label: '모집 중', full: false },
  closing_soon: { label: '마감 임박', full: false },
  full: { label: '마감', full: true },
};

/** 조건 칩 글자 — 강사·학원 이름 + 요일·시간대(있을 때만) */
export function conditionChips(conditions: PlannerAnswer['conditions']): string[] {
  if (conditions === null) return [];
  const weekdays = conditions.weekdays?.length ? conditions.weekdays.map((w) => WEEKDAY_KO[w]).join('·') : null;
  const band = conditions.timeBand === null ? null : (TIME_BAND_KO[conditions.timeBand] ?? conditions.timeBand);
  return [
    conditions.instructor === null ? null : `강사 ${conditions.instructor.name}`,
    conditions.academy?.name ?? null,
    weekdays,
    band,
    // SX-5.8 — 이어 묻기로 좁힌 레벨·모집 중도 칩으로 보인다(무엇으로 좁혔는지 회원이 알게)
    conditions.level === null ? null : (LEVEL_KO[conditions.level] ?? null),
    conditions.recruitOpenOnly ? '모집 중만' : null,
  ].filter((t): t is string => t !== null);
}

/** 「라틴하우스 강남의 이준호 강사 수업 2개를 찾았어요」 */
export function foundHeading(answer: PlannerAnswer): string {
  const instructor = answer.conditions?.instructor?.name;
  const academy = answer.conditions?.academy?.name;
  const who = [academy === undefined ? null : `${academy}의`, instructor === undefined ? null : `${instructor} 강사`]
    .filter((t): t is string => t !== null)
    .join(' ');
  return `${who === '' ? '' : `${who} `}수업 ${answer.offeringCards.length}개를 찾았어요`;
}

// ---------------------------------------------------------------- 조건 칩

export function ChipRow({ labels }: { labels: readonly string[] }) {
  if (labels.length === 0) return null;
  return (
    <View style={styles.chipRow}>
      {labels.map((label) => (
        <View key={label} style={styles.chip}>
          <Text style={styles.chipText}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

export interface ActionChip {
  label: string;
  onPress: () => void;
}

/** 누르는 칩(조건 바꾸기·넓히기). 조회만 다시 하고 예약·결제는 일으키지 않는다 */
export function ActionChipRow({ title, chips, disabled }: { title: string; chips: readonly ActionChip[]; disabled: boolean }) {
  if (chips.length === 0) return null;
  return (
    <View style={styles.block}>
      <Text style={styles.muted}>{title}</Text>
      <View style={styles.chipRow}>
        {chips.map((chip) => (
          <Pressable
            key={chip.label}
            style={styles.actionChip}
            onPress={chip.onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ disabled }}
          >
            <Text style={styles.actionChipText}>{chip.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- 수업 카드(M10F)

export function OfferingCardView({ card }: { card: PlannerOfferingCard }) {
  const badge = STATUS_BADGE[card.recruitStatus];
  const href = offeringCardHref(card);
  // 마감이면 대기 신청이 될 때만 「대기 신청」, 아니면 닫힌 「마감」. 둘 다 수업 상세로만 간다
  const buttonLabel = card.recruitStatus === 'full' ? (card.waitlistAvailable ? '대기 신청' : '마감') : '신청하기';
  const closed = href === null || (card.recruitStatus === 'full' && !card.waitlistAvailable);
  const primary = !closed && card.recruitStatus !== 'full';
  const onPress = () => {
    if (href !== null) router.push(href);
  };
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {card.title}
        </Text>
        <View style={[styles.badge, badge.full && styles.badgeFull]}>
          <Text style={[styles.badgeText, badge.full && styles.badgeFullText]}>{badge.label}</Text>
        </View>
      </View>
      <Text style={styles.cardLine}>{[card.academyName, card.hall].filter((t) => t).join(' · ')}</Text>
      <Text style={styles.cardLine}>{scheduleLine(card)}</Text>
      <Text style={styles.cardSub}>{seatLine(card)}</Text>
      <View style={styles.cardBottom}>
        <Text style={styles.price}>{formatWon(card.priceAmount)}</Text>
        <Pressable
          style={[styles.cardButton, primary ? styles.cardButtonPrimary : styles.cardButtonSecondary, closed && styles.cardButtonClosed]}
          onPress={onPress}
          disabled={closed}
          accessibilityRole="button"
          accessibilityLabel={`${card.title} ${buttonLabel}`}
          accessibilityHint="수업 상세로 가요. 결제는 그 화면에서 직접 해요"
          accessibilityState={{ disabled: closed }}
        >
          <Text style={[styles.cardButtonText, primary && styles.cardButtonTextPrimary, closed && styles.cardButtonTextClosed]}>{buttonLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- 강사 후보 카드(M10G)

export function InstructorCandidateView({
  candidate,
  onSelect,
  disabled,
}: {
  candidate: PlannerInstructorCandidate;
  onSelect: (candidate: PlannerInstructorCandidate) => void;
  disabled: boolean;
}) {
  const genres = candidate.genres.map(genreLabel).join(' · ');
  const academies = candidate.academies.map((a) => a.name).join(' · ');
  return (
    <View style={styles.card}>
      <View style={styles.candidateRow}>
        {/* 사진은 아직 앱에서 내려받지 않는다 — 이름 첫 글자로 둔다(강사 사진은 AI 로 만들지 않는다, FR-061b) */}
        <InitialAvatar name={candidate.displayName} size={48} />
        <View style={styles.candidateText}>
          <Text style={styles.cardTitle}>{candidate.displayName} 강사</Text>
          {genres !== '' && <Text style={styles.cardLine}>{genres}</Text>}
          <Text style={styles.cardSub}>
            {academies}
            {academies === '' ? '' : ' · '}수업 {candidate.publishedOfferingCount}개
          </Text>
        </View>
        <Pressable
          style={[styles.cardButton, styles.cardButtonSecondary]}
          onPress={() => onSelect(candidate)}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`${candidate.displayName} 강사 선택, ${academies}`}
          accessibilityState={{ disabled }}
        >
          <Text style={styles.cardButtonText}>선택</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function InitialAvatar({ name, size }: { name: string; size: number }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]} accessibilityElementsHidden importantForAccessibility="no">
      <Text style={styles.avatarText}>{name.slice(0, 1)}</Text>
    </View>
  );
}

/** 넓히기 버튼 중 이름이 하나라도 남은 것만 쓴다(이름 없는 질문은 서버가 검색하지 않는다) */
export function usableWidenActions(actions: readonly PlannerWidenAction[]): PlannerWidenAction[] {
  return actions.filter((a) => a.instructor !== null || a.academy !== null);
}

export const plannerStyles = StyleSheet.create({
  muted: { fontSize: font.small, color: colors.ink3, lineHeight: 18 },
  heading: { fontSize: 16, fontWeight: '700', color: colors.ink },
  notice: { fontSize: font.small, color: colors.ink3, lineHeight: 19 },
});

const styles = StyleSheet.create({
  block: { gap: space.sm },
  muted: plannerStyles.muted,
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { backgroundColor: '#EBDDF0', borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6 },
  chipText: { fontSize: font.small, color: colors.brown, fontWeight: '600' },
  actionChip: {
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    minHeight: 36,
    justifyContent: 'center',
  },
  actionChipText: { fontSize: font.small, color: colors.ink, fontWeight: '600' },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: 6 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.sm },
  cardTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: colors.ink },
  badge: { backgroundColor: '#EBDDF0', borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  badgeText: { fontSize: font.tiny + 1, color: colors.brown, fontWeight: '600' },
  badgeFull: { backgroundColor: colors.dangerSoft },
  badgeFullText: { color: colors.danger },
  cardLine: { fontSize: font.body - 1, color: colors.ink },
  cardSub: { fontSize: font.small, color: colors.ink3 },
  cardBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: space.xs },
  price: { fontSize: 17, fontWeight: '700', color: colors.ink },
  cardButton: { minHeight: 40, minWidth: 96, paddingHorizontal: space.lg, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  cardButtonPrimary: { backgroundColor: colors.brown },
  cardButtonSecondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  cardButtonClosed: { backgroundColor: colors.disabled, borderColor: colors.disabled },
  cardButtonText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  cardButtonTextPrimary: { color: colors.surface },
  cardButtonTextClosed: { color: colors.disabledInk },
  candidateRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: MIN_TOUCH },
  candidateText: { flex: 1, gap: 2 },
  avatar: { backgroundColor: '#EBDDF0', alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 18, fontWeight: '700', color: colors.brown },
});
