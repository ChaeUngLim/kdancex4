/**
 * 개인 레슨 수강생 상세(보드 I20) — S2-4.8(앱 개인 레슨 수강생·회차·규칙 화면). 주소 `/instructor/private-lessons/passes/{passId}`.
 *
 * 개인 레슨 스케줄(I10)에서 수강생을 누르면 열린다. 결제 상태 · 결제일 · 수단 · 금액 · 사용 기한 · 진행 회차를 보이고,
 * 강사가 열어 둔 「레슨 모집」 시간 가운데 하나를 골라 다음 회차를 잡는다. 잡으면 서버가 회원에게 알림을 보낸다.
 *
 * 부르는 API(계약 11 §10-3, 서버는 S2-4.7)
 *  1. `GET  /api/instructor/private-lesson-passes/{passId}`             상세 + 잡을 수 있는 시간(openSlots)
 *  2. `POST /api/instructor/private-lesson-passes/{passId}/bookings`    다음 회차 잡기(Idempotency-Key)
 *
 * 규칙
 *  - 결제 대기 수강권도 이름은 보인다(수용 ④). 다만 회차는 결제가 끝난 뒤(active)에만 잡는다 — 서버가 409 PASS_NOT_ACTIVE 로 막는 것과 같다
 *  - 이미 잡힌 앞으로의 회차는 「잡힌 회차」 줄로 보이고, 누르면 회차 바꾸기·취소(I20B)로 간다
 *  - 「규칙 바꾸기」는 이 학원의 개인 레슨 규칙(I20C)으로 간다. 바꿔도 이 수강권은 결제 때 판본 그대로다
 *
 * 고른 시간은 화면 상태(useState)이고, 서버 호출은 「잡기」 버튼 핸들러 안에서만 한다. 효과 훅을 쓰지 않는다.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatWon } from '../../../../../lib/catalog/format';
import { LoadingView } from '../../../../../lib/catalog/ui';
import { newIdempotencyKey, readRouteId, useApiResource } from '../../../../../lib/catalog/use-api-resource';
import {
  bookSlot,
  canBook,
  fullDateWithWeekday,
  lessonStart,
  lessonWhen,
  passDetailPath,
  passProgress,
  passStatusLabel,
  paymentMethodLabel,
  subGenreShortOf,
  type PrivateLessonPassDetail,
} from '../../../../../lib/instructor/private-lesson-api';
import { kstDateOf, slashDayTime, slashDayWithWeekday, studentName } from '../../../../../lib/instructor/schedule-api';
import { goBack, InstructorShell, StaffErrorView, staffStyles, useAction } from '../../../../../lib/instructor/staff-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../../../../../lib/theme';

export default function PrivateLessonPassScreen() {
  const params = useLocalSearchParams<{ passId: string }>();
  const passId = readRouteId(params.passId);
  const detail = useApiResource<PrivateLessonPassDetail>(passId === null ? null : passDetailPath(passId));

  // 고른 「레슨 모집」 시간(null = 아직 안 고름)
  const [slotId, setSlotId] = useState<string | null>(null);
  // 잡기 한 번 = 멱등 키 하나. 응답을 못 받고 다시 눌러도 회차는 하나만 생긴다. 성공하면 새 키로 바꾼다
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [booked, setBooked] = useState<string | null>(null);
  const book = useAction();

  const shell = (children: ReactNode) => (
    <InstructorShell title="개인 레슨" active="classes" onBack={() => goBack('/instructor/private-lessons')}>
      {children}
    </InstructorShell>
  );

  if (passId === null) return shell(<Text style={styles.error}>수강권 정보를 읽지 못했어요. 개인 레슨 스케줄에서 다시 열어 주세요.</Text>);
  if (detail.state.status === 'loading') return shell(<LoadingView label="수강생 정보를 불러오고 있어요" />);
  if (detail.state.status === 'error') return shell(<StaffErrorView error={detail.state.error} onRetry={detail.reload} />);

  // ---- 렌더 중 계산 ----
  const pass = detail.state.data;
  const progress = passProgress(pass, new Date());
  const name = studentName(pass.student);
  const genre = subGenreShortOf(pass.discipline);
  const bookable = canBook(pass) && progress.remainingToBook > 0;
  // 고른 시간이 목록에서 사라졌으면(다시 읽은 뒤 남이 잡음) 고르지 않은 것으로 본다
  const picked = pass.openSlots.find((slot) => slot.slotId === slotId) ?? null;
  const usedRatio = pass.sessionsTotal > 0 ? Math.min(1, pass.sessionsUsed / pass.sessionsTotal) : 0;

  const paymentLine =
    pass.payment !== null
      ? [`${slashDayWithWeekday(kstDateOf(pass.payment.paidAt))} 결제`, paymentMethodLabel(pass.payment.method), formatWon(pass.payment.amount)]
          .filter((part) => part !== '')
          .join(' · ')
      : pass.awaitingPayment?.until
        ? `결제 대기 · ${slashDayTime(pass.awaitingPayment.until)}까지`
        : '결제 대기';

  const handleBook = async () => {
    if (picked === null) return;
    const result = await book.run(() => bookSlot(pass.passId, picked.slotId, idempotencyKey));
    if (result === null) return;
    setBooked(`${lessonStart(picked.startsAt)} 으로 잡았어요. ${name} 님에게 알림이 갔어요.`);
    setSlotId(null);
    setIdempotencyKey(newIdempotencyKey());
    detail.reload();
  };

  return shell(
    <>
      <View style={staffStyles.card}>
        <View style={styles.headRow}>
          <View style={styles.avatar} />
          <View style={styles.headText}>
            <Text style={styles.name}>{name}</Text>
            <Text style={styles.sub}>
              {genre !== '' ? `${genre} ` : ''}
              {pass.sessionsTotal}회 수강권 · {pass.lessonMinutes}분 · {pass.academyName}
            </Text>
          </View>
          <Text style={[styles.badge, pass.awaitingPayment !== null && styles.badgePending]}>{passStatusLabel(pass)}</Text>
        </View>
        <View style={styles.divider} />
        <Text style={styles.line}>{paymentLine}</Text>
        {pass.validUntil !== null && (
          <Text style={styles.sub}>
            사용 기한 {fullDateWithWeekday(pass.validUntil)}까지 · 결제일부터 {pass.rule.validityMonths}개월
          </Text>
        )}
      </View>

      <View style={styles.progressHead}>
        <Text style={styles.label}>회차</Text>
        <Text style={styles.progressText}>
          {pass.sessionsUsed}회 진행 · 남은 {pass.remainingSessions}회
        </Text>
      </View>
      <View style={styles.track} accessibilityLabel={`${pass.sessionsTotal}회 중 ${pass.sessionsUsed}회 진행`}>
        <View style={[styles.fill, { width: `${usedRatio * 100}%` }]} />
      </View>
      {progress.last !== null && (
        <Text style={styles.sub}>
          마지막 레슨 {lessonStart(progress.last.startsAt)} · {progress.last.sessionNo}/{pass.sessionsTotal}회
        </Text>
      )}

      {progress.upcoming.length > 0 && (
        <View style={staffStyles.card}>
          <Text style={staffStyles.sectionTitle}>잡힌 회차</Text>
          {progress.upcoming.map((booking, index) => (
            <Pressable
              key={booking.bookingId}
              style={[styles.bookedRow, index > 0 && styles.rowDivider]}
              onPress={() => router.push(`/instructor/private-lessons/passes/${pass.passId}/bookings/${booking.bookingId}`)}
              accessibilityRole="button"
              accessibilityLabel={`${booking.sessionNo}회차 ${lessonStart(booking.startsAt)} 바꾸기·취소`}
            >
              <View style={styles.headText}>
                <Text style={styles.slotTime}>{lessonWhen(booking.startsAt, booking.endsAt)}</Text>
                <Text style={styles.sub}>
                  {booking.sessionNo}/{pass.sessionsTotal}회 · 예약됨
                </Text>
              </View>
              <Text style={styles.link}>바꾸기·취소 ›</Text>
            </Pressable>
          ))}
        </View>
      )}

      {booked !== null && (
        <Text style={styles.done} accessibilityLiveRegion="polite">
          {booked}
        </Text>
      )}

      {bookable ? (
        <>
          <View style={styles.gapSm}>
            <Text style={styles.sectionTitle}>
              다음 회차 잡기 · {progress.nextNo}/{pass.sessionsTotal}회
            </Text>
            <Text style={staffStyles.muted}>
              내가 열어 둔 「레슨 모집」 시간이에요. 고르면 {name} 님에게 알림이 가고 그 시간은 예약됨으로 닫혀요.
            </Text>
          </View>
          <View style={staffStyles.card} accessibilityRole="radiogroup">
            {pass.openSlots.length === 0 ? (
              <Text style={styles.empty}>열어 둔 「레슨 모집」 시간이 없어요. 아래에서 시간을 먼저 열어 주세요.</Text>
            ) : (
              pass.openSlots.map((slot, index) => {
                const selected = slot.slotId === picked?.slotId;
                return (
                  <Pressable
                    key={slot.slotId}
                    style={[styles.slotRow, index > 0 && styles.rowDivider]}
                    onPress={() => setSlotId(slot.slotId)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    aria-checked={selected}
                    accessibilityLabel={lessonWhen(slot.startsAt, slot.endsAt)}
                  >
                    <View style={[styles.radio, selected && styles.radioOn]}>{selected && <View style={styles.radioDot} />}</View>
                    <View style={styles.headText}>
                      <Text style={styles.slotTime}>{lessonWhen(slot.startsAt, slot.endsAt)}</Text>
                      <Text style={styles.sub}>
                        {pass.academyName}
                        {slot.roomName !== null ? ` ${slot.roomName}` : ''}
                      </Text>
                    </View>
                  </Pressable>
                );
              })
            )}
          </View>
          <Pressable
            style={styles.textButton}
            onPress={() =>
              router.push({
                pathname: '/instructor/private-lessons/[classId]/slots',
                params: {
                  classId: pass.productClassId,
                  academyId: pass.academyId,
                  academyName: pass.academyName,
                  subGenre: '',
                  minutes: String(pass.lessonMinutes),
                  count: String(pass.sessionsTotal),
                  price: String(pass.payment?.amount ?? 0),
                },
              })
            }
            accessibilityRole="button"
          >
            <Text style={styles.link}>+ 레슨 모집 시간 더 열기 · 10분 단위</Text>
          </Pressable>
        </>
      ) : (
        <View style={staffStyles.card}>
          <Text style={staffStyles.muted}>
            {pass.awaitingPayment !== null
              ? '결제가 끝나면 다음 회차를 잡을 수 있어요.'
              : pass.status === 'active'
                ? '모든 회차를 잡았어요. 잡힌 회차는 위에서 바꾸거나 취소할 수 있어요.'
                : '이 수강권으로는 더 잡을 회차가 없어요.'}
          </Text>
        </View>
      )}

      <View style={styles.ruleBox}>
        <Text style={styles.ruleTitle}>바꾸기·취소 규칙 · 이 수강권</Text>
        <Text style={styles.ruleText}>
          시작 {pass.rule.changeDeadlineHours}시간 전까지는 바꾸거나 취소해도 회차가 그대로예요. 그 뒤 회원 사정으로 취소하면 1회가 차감돼요.
        </Text>
      </View>
      <Pressable
        style={styles.textButton}
        onPress={() =>
          router.push({ pathname: '/instructor/private-lessons/rules', params: { academyId: pass.academyId, academyName: pass.academyName } })
        }
        accessibilityRole="button"
      >
        <Text style={styles.ruleLink}>규칙 바꾸기 ›</Text>
      </Pressable>

      {book.error !== null && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {book.error}
        </Text>
      )}
      {bookable && (
        <Pressable
          style={[styles.primary, (picked === null || book.busy) && styles.primaryOff]}
          onPress={handleBook}
          disabled={picked === null || book.busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: picked === null || book.busy }}
        >
          <Text style={[styles.primaryText, (picked === null || book.busy) && styles.primaryTextOff]}>
            {book.busy ? '잡는 중…' : picked === null ? '시간을 골라 주세요' : `${lessonStart(picked.startsAt)} 으로 잡기`}
          </Text>
        </Pressable>
      )}
    </>,
  );
}

const styles = StyleSheet.create({
  headRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  avatar: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.line },
  headText: { flex: 1, gap: 2 },
  name: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  sub: { color: colors.ink3, fontSize: font.tiny },
  line: { color: colors.ink, fontSize: font.small, fontWeight: '600' },
  badge: {
    paddingHorizontal: space.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.brownSoft,
    color: colors.brown,
    fontSize: font.small,
    fontWeight: '700',
    overflow: 'hidden',
  },
  badgePending: { backgroundColor: colors.dangerSoft, color: colors.danger },
  divider: { height: 1, backgroundColor: colors.line },
  progressHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: colors.ink3, fontSize: font.small },
  progressText: { color: colors.brown, fontSize: font.small, fontWeight: '800' },
  track: { height: 10, borderRadius: radius.pill, backgroundColor: colors.line, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: colors.brown },
  gapSm: { gap: space.xs },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  bookedRow: { flexDirection: 'row', alignItems: 'center', minHeight: MIN_TOUCH, paddingVertical: space.xs },
  slotRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: MIN_TOUCH, paddingVertical: space.xs },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  slotTime: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  radio: { width: 24, height: 24, borderRadius: radius.pill, borderWidth: 2, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: colors.brown, backgroundColor: colors.brown },
  radioDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.surface },
  empty: { color: colors.ink3, fontSize: font.small, paddingVertical: space.sm },
  textButton: { minHeight: 40, justifyContent: 'center' },
  link: { color: colors.brown, fontSize: font.small, fontWeight: '700' },
  ruleBox: { backgroundColor: colors.brownSoft, borderRadius: radius.md, padding: space.lg, gap: space.xs },
  ruleTitle: { color: colors.ink, fontSize: font.small, fontWeight: '800' },
  ruleText: { color: colors.ink, fontSize: font.small, lineHeight: 19 },
  ruleLink: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  done: { color: colors.ok, fontSize: font.small, fontWeight: '700', backgroundColor: colors.okSoft, padding: space.md, borderRadius: radius.md },
  error: { color: colors.danger, fontSize: font.small },
  primary: { minHeight: 56, borderRadius: radius.lg, backgroundColor: colors.brown, alignItems: 'center', justifyContent: 'center' },
  primaryOff: { backgroundColor: colors.disabled },
  primaryText: { color: colors.surface, fontSize: 16, fontWeight: '800' },
  primaryTextOff: { color: colors.disabledInk },
});
