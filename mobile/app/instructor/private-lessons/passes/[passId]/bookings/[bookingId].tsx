/**
 * 레슨 회차 바꾸기(보드 I20B) — S2-4.8(앱 개인 레슨 수강생·회차·규칙 화면).
 * 주소 `/instructor/private-lessons/passes/{passId}/bookings/{bookingId}`. 수강생 상세(I20)의 「잡힌 회차」를 누르면 열린다.
 *
 * 잡힌 회차 하나에 세 가지 중 하나를 한다.
 *  ① 시간 바꾸기       — 다른 「레슨 모집」 시간으로 옮긴다. 회차 번호는 그대로, 차감 없음
 *  ② 강사 사정으로 취소 — 회차를 수강권에 돌려준다(남은 횟수 그대로). 사유는 회원에게 보인다
 *  ③ 회원 요청으로 취소 — 기한(수강권에 고정된 판본, 보통 24시간) 전이면 차감 없음, 뒤면 1회 차감
 *
 * 부르는 API(계약 11 §10-3, 서버는 S2-4.7)
 *  1. `GET  /api/instructor/private-lesson-passes/{passId}`                    회차 · 열린 시간 · 규칙 판본
 *  2. `GET  /api/instructor/me/profile`                                        알림 미리 보기의 강사 이름(못 읽으면 「강사」)
 *  3. `POST /api/instructor/private-lesson-bookings/{bookingId}/reschedule`    ①
 *  4. `POST /api/instructor/private-lesson-bookings/{bookingId}/cancel`        ②·③ — 차감 판정은 서버(S2-4.3 함수)가 한다
 *
 * 「회원에게 가는 알림」 상자는 미리 보기다. 실제 알림 글은 서버가 만든다(알림 발송은 S7-1).
 * 환불은 이 화면에서 하지 않는다 — 결제·환불 문의는 그 학원 대표가 받는다(FR-098b).
 * 서버 호출은 아래 버튼 핸들러 안에서만 한다. 효과 훅을 쓰지 않는다.
 */
import { useLocalSearchParams } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { LoadingView } from '../../../../../../lib/catalog/ui';
import { readRouteId, useApiResource } from '../../../../../../lib/catalog/use-api-resource';
import {
  cancelBooking,
  CANCEL_REASON_MAX,
  lessonStart,
  lessonWhen,
  memberCancelIsFree,
  numberedBookings,
  passDetailPath,
  rescheduleBooking,
  type BookingStatus,
  type CancelledBooking,
  type PrivateLessonPassDetail,
  type RescheduledBooking,
} from '../../../../../../lib/instructor/private-lesson-api';
import { studentName } from '../../../../../../lib/instructor/schedule-api';
import { goBack, InstructorShell, StaffErrorView, staffStyles, useAction } from '../../../../../../lib/instructor/staff-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../../../../../../lib/theme';

type Choice = 'reschedule' | 'instructor' | 'member';

/** 끝난 뒤 보일 결과 한 줄 — 서버 응답으로 만든다 */
function doneMessage(result: CancelledBooking | RescheduledBooking): string {
  if (result.status === 'booked') return `${lessonStart(result.startsAt)} 으로 바꿨어요. 회원에게 알림이 갔어요.`;
  if (result.status === 'cancelled_instructor') return `강사 사정으로 취소했어요. 회차를 돌려줬어요 · 남은 ${result.remainingSessions}회.`;
  if (result.status === 'cancelled_member_free') return `회원 요청으로 취소했어요. 차감 없음 · 남은 ${result.remainingSessions}회.`;
  return `회원 요청으로 취소했어요. 기한이 지나 1회 차감 · 남은 ${result.remainingSessions}회.`;
}

/** 머리 배지 — 회차 상태를 한 단어로 */
function bookingBadge(status: BookingStatus, editable: boolean): string {
  if (status === 'booked') return editable ? '예약됨' : '지난 회차';
  if (status === 'done') return '마침';
  if (status === 'no_show') return '오지 않음';
  return '취소됨';
}

export default function PrivateLessonBookingScreen() {
  const params = useLocalSearchParams<{ passId: string; bookingId: string }>();
  const passId = readRouteId(params.passId);
  const bookingId = readRouteId(params.bookingId);
  const detail = useApiResource<PrivateLessonPassDetail>(passId === null ? null : passDetailPath(passId));
  const profile = useApiResource<{ displayName: string }>('/api/instructor/me/profile');

  const [choice, setChoice] = useState<Choice | null>(null);
  const [newSlotId, setNewSlotId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const action = useAction();

  const backTo = passId === null ? '/instructor/private-lessons' : `/instructor/private-lessons/passes/${passId}`;
  const shell = (children: ReactNode) => (
    <InstructorShell title="레슨 회차 바꾸기" active="classes" onBack={() => goBack(backTo as `/instructor/${string}`)}>
      {children}
    </InstructorShell>
  );

  if (passId === null || bookingId === null) return shell(<Text style={styles.error}>회차 정보를 읽지 못했어요. 수강생 화면에서 다시 열어 주세요.</Text>);
  if (detail.state.status === 'loading') return shell(<LoadingView label="회차를 불러오고 있어요" />);
  if (detail.state.status === 'error') return shell(<StaffErrorView error={detail.state.error} onRetry={detail.reload} />);

  // ---- 렌더 중 계산 ----
  const pass = detail.state.data;
  // 취소돼 회차를 돌려받은 예약은 번호가 없다 — 그래서 원래 목록에서 찾고 번호는 따로 붙인다
  const booking = pass.bookings.find((b) => b.bookingId === bookingId) ?? null;
  if (booking === null) return shell(<Text style={styles.error}>이 수강권에서 그 회차를 찾지 못했어요.</Text>);
  const sessionNo = numberedBookings(pass.bookings).find((b) => b.bookingId === bookingId)?.sessionNo ?? null;
  const sessionLabel = sessionNo !== null ? `${sessionNo}/${pass.sessionsTotal}회` : '회차 돌려줌';

  const name = studentName(pass.student);
  const instructorName = profile.state.status === 'ready' ? profile.state.data.displayName : '';
  const now = new Date();
  const hours = pass.rule.changeDeadlineHours;
  const isFree = memberCancelIsFree(booking.startsAt, hours, now);
  const editable = booking.status === 'booked' && Date.parse(booking.startsAt) > now.getTime();
  const picked = pass.openSlots.find((slot) => slot.slotId === newSlotId) ?? null;
  const when = lessonStart(booking.startsAt);
  const trimmed = reason.trim();

  // 고른 동작에 따라 바뀌는 글자 — 알림 미리 보기 · 버튼
  const preview =
    choice === 'reschedule'
      ? picked === null
        ? '옮길 시간을 고르면 여기에 보여요.'
        : `${when} 레슨이 ${lessonStart(picked.startsAt)} 으로 바뀌었어요. 회차는 그대로예요 (${sessionLabel}).`
      : choice === 'instructor'
        ? `${when} 레슨이 강사 사정으로 취소됐어요. 회차는 그대로 남아 있어요 (남은 ${pass.remainingSessions}회).`
        : choice === 'member'
          ? isFree
            ? `${when} 레슨이 회원 요청으로 취소됐어요. 차감 없이 회차가 남아 있어요 (남은 ${pass.remainingSessions}회).`
            : `${when} 레슨이 회원 요청으로 취소됐어요. 기한이 지나 1회가 차감됐어요 (남은 ${Math.max(0, pass.remainingSessions - 1)}회).`
          : null;
  // 강사 사정 취소는 서버가 사유를 꼭 받는다(1~200자) — 빈 칸이면 버튼을 끈다
  const ready =
    editable &&
    done === null &&
    !action.busy &&
    (choice === 'reschedule' ? picked !== null : choice === 'instructor' ? trimmed.length > 0 : choice === 'member');
  const buttonLabel =
    choice === 'reschedule'
      ? picked === null
        ? '옮길 시간을 골라 주세요'
        : `${lessonStart(picked.startsAt)} 으로 바꾸기`
      : choice === 'instructor'
        ? trimmed.length === 0
          ? '취소 사유를 적어 주세요'
          : '강사 사정으로 취소하기'
        : choice === 'member'
          ? '회원 요청으로 취소하기'
          : '할 일을 골라 주세요';

  const handleSubmit = async () => {
    if (!ready || choice === null) return;
    const result = await action.run<CancelledBooking | RescheduledBooking>(() =>
      choice === 'reschedule' && picked !== null
        ? rescheduleBooking(booking.bookingId, picked.slotId)
        : cancelBooking(booking.bookingId, choice === 'instructor' ? 'instructor' : 'member', reason),
    );
    if (result === null) return;
    setDone(doneMessage(result));
    detail.reload();
  };

  const options: { key: Choice; title: string; detail: string }[] = [
    { key: 'reschedule', title: '시간 바꾸기', detail: '다른 「레슨 모집」 시간으로 옮겨요 · 회차는 그대로' },
    { key: 'instructor', title: '강사 사정으로 취소', detail: `회차를 수강권에 돌려줘요 · 남은 ${pass.remainingSessions}회 그대로` },
    {
      key: 'member',
      title: '회원 요청으로 취소',
      detail: isFree ? `지금은 시작 ${hours}시간 전이라 차감 없이 취소돼요` : `시작 ${hours}시간 전이 지나 1회가 차감돼요`,
    },
  ];

  return shell(
    <>
      <View style={staffStyles.card}>
        <View style={styles.headRow}>
          <Text style={styles.headTitle}>
            {name} · {sessionLabel}
          </Text>
          <Text style={styles.badge}>{bookingBadge(booking.status, editable)}</Text>
        </View>
        <Text style={styles.sub}>
          {lessonWhen(booking.startsAt, booking.endsAt)} · {pass.academyName}
        </Text>
      </View>

      {!editable ? (
        done === null && <Text style={styles.error}>이미 지나갔거나 끝난 회차는 바꾸거나 취소할 수 없어요.</Text>
      ) : (
        <>
          <Text style={styles.label}>무엇을 할까요</Text>
          <View style={styles.options} accessibilityRole="radiogroup">
            {options.map((option) => {
              const selected = choice === option.key;
              return (
                <Pressable
                  key={option.key}
                  style={[styles.option, selected && styles.optionOn]}
                  onPress={() => {
                    setChoice(option.key);
                    action.setError(null);
                  }}
                  disabled={done !== null}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, disabled: done !== null }}
                  aria-checked={selected}
                  accessibilityLabel={option.title}
                >
                  <View style={[styles.radio, selected && styles.radioOn]}>{selected && <View style={styles.radioDot} />}</View>
                  <View style={styles.optionText}>
                    <Text style={styles.optionTitle}>{option.title}</Text>
                    <Text style={styles.sub}>{option.detail}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          {choice === 'reschedule' && (
            <View style={staffStyles.card} accessibilityRole="radiogroup">
              <Text style={staffStyles.sectionTitle}>옮길 시간</Text>
              {pass.openSlots.length === 0 ? (
                <Text style={styles.sub}>열어 둔 「레슨 모집」 시간이 없어요. 시간을 먼저 열어 주세요.</Text>
              ) : (
                pass.openSlots.map((slot, index) => {
                  const selected = slot.slotId === picked?.slotId;
                  return (
                    <Pressable
                      key={slot.slotId}
                      style={[styles.slotRow, index > 0 && styles.rowDivider]}
                      onPress={() => setNewSlotId(slot.slotId)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      aria-checked={selected}
                      accessibilityLabel={lessonWhen(slot.startsAt, slot.endsAt)}
                    >
                      <View style={[styles.radio, selected && styles.radioOn]}>{selected && <View style={styles.radioDot} />}</View>
                      <Text style={styles.slotTime}>{lessonWhen(slot.startsAt, slot.endsAt)}</Text>
                    </Pressable>
                  );
                })
              )}
            </View>
          )}

          {preview !== null && (
            <>
              <Text style={styles.label}>회원에게 가는 알림</Text>
              <View style={styles.notice}>
                <Text style={styles.noticeTitle}>[개인 레슨] {instructorName !== '' ? `${instructorName} 강사` : '강사'}</Text>
                <Text style={styles.noticeText}>{preview}</Text>
                {choice !== 'reschedule' && trimmed.length > 0 && <Text style={styles.noticeText}>사유: {trimmed}</Text>}
              </View>
            </>
          )}

          {(choice === 'instructor' || choice === 'member') && (
            <>
              <Text style={styles.label}>
                취소 사유 · {choice === 'instructor' ? '꼭 적어요' : '선택'} · 회원에게 보여요
              </Text>
              <TextInput
                style={styles.input}
                value={reason}
                onChangeText={setReason}
                maxLength={CANCEL_REASON_MAX}
                placeholder={choice === 'instructor' ? '예: 대회 심사 일정이 생겼어요' : '예: 회원이 아파서 못 와요'}
                placeholderTextColor={colors.ink3}
                accessibilityLabel="취소 사유"
                editable={done === null}
              />
            </>
          )}
        </>
      )}

      <View style={styles.refundBox}>
        <Text style={styles.refundText}>결제·환불 문의는 {pass.academyName} 대표가 받아요. 강사는 회차만 정리해요.</Text>
      </View>

      {done !== null && (
        <Text style={styles.done} accessibilityLiveRegion="polite">
          {done}
        </Text>
      )}
      {action.error !== null && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {action.error}
        </Text>
      )}

      {done !== null ? (
        <Pressable style={styles.primary} onPress={() => goBack(backTo as `/instructor/${string}`)} accessibilityRole="button">
          <Text style={styles.primaryText}>{name} 님 화면으로</Text>
        </Pressable>
      ) : (
        editable && (
          <Pressable
            style={[styles.primary, choice !== 'reschedule' && choice !== null && styles.primaryDanger, !ready && styles.primaryOff]}
            onPress={handleSubmit}
            disabled={!ready}
            accessibilityRole="button"
            accessibilityState={{ disabled: !ready }}
          >
            <Text style={[styles.primaryText, !ready && styles.primaryTextOff]}>{action.busy ? '처리 중…' : buttonLabel}</Text>
          </Pressable>
        )
      )}
    </>,
  );
}

const styles = StyleSheet.create({
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  headTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', flex: 1 },
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
  sub: { color: colors.ink3, fontSize: font.tiny },
  label: { color: colors.ink3, fontSize: font.small },
  options: { gap: space.sm },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: MIN_TOUCH + 12,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  optionOn: { borderColor: colors.brown, backgroundColor: colors.brownSoft },
  optionText: { flex: 1, gap: 2 },
  optionTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  radio: { width: 24, height: 24, borderRadius: radius.pill, borderWidth: 2, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: colors.brown, backgroundColor: colors.brown },
  radioDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.surface },
  slotRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: MIN_TOUCH },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  slotTime: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  notice: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: space.md, gap: space.xs },
  noticeTitle: { color: colors.ink, fontSize: font.small, fontWeight: '800' },
  noticeText: { color: colors.ink, fontSize: font.small, lineHeight: 19 },
  input: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    paddingHorizontal: space.md,
    color: colors.ink,
    fontSize: font.body,
    minWidth: 0,
  },
  refundBox: { backgroundColor: colors.brownSoft, borderRadius: radius.md, padding: space.lg },
  refundText: { color: colors.ink, fontSize: font.small, lineHeight: 19, fontWeight: '600' },
  done: { color: colors.ok, fontSize: font.small, fontWeight: '700', backgroundColor: colors.okSoft, padding: space.md, borderRadius: radius.md },
  error: { color: colors.danger, fontSize: font.small },
  primary: { minHeight: 56, borderRadius: radius.lg, backgroundColor: colors.brown, alignItems: 'center', justifyContent: 'center' },
  primaryDanger: { backgroundColor: colors.danger },
  primaryOff: { backgroundColor: colors.disabled },
  primaryText: { color: colors.surface, fontSize: 16, fontWeight: '800' },
  primaryTextOff: { color: colors.disabledInk },
});
