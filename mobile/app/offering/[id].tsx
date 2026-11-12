/**
 * 수업 상세 — 자리 고르기와 결제 시작(보드 M8, `02-catalog.md` §2 · `03-checkout-payment.md` §1).
 *
 * 화면이 지키는 규칙
 *  - 기본 자리: 서버가 정한 `defaultSeatKind`(AC-7(성별 자리 기본값)). 그 자리가 마감이어도
 *    기본 선택을 바꾸지 않고 「마감」 표시 + 결제 버튼을 끈다. 반대 자리가 남았으면 회원이 직접 바꾼다
 *  - 결제 버튼은 환불 공지·중개자 고지·가격 내역이 모두 보이고 공지 확인에 체크해야 열린다
 *    (FR-282(결제 화면 필수 표시)). 학원 공지가 없으면(`refundNotice: null`) 끝까지 닫혀 있다
 *  - 결제 수단 기본값은 가상계좌(FR-111), 카드도 고를 수 있다(FR-111a)
 *  - 주문 생성은 `Idempotency-Key` 를 붙인다(README §5). 같은 선택으로 다시 누르면 같은 키 →
 *    서버가 같은 주문을 돌려준다. 자리나 수단을 바꾸면 다른 시도이므로 새 키를 만든다
 */
import { useCallback, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { apiFetch } from '../../lib/api';
import { formatKstDateTime, formatKstTime, formatWon, seatLabel } from '../../lib/catalog/format';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';
import type { CreateOrderBody, OfferingDetail, Order, PaymentMethod, SeatKind } from '../../lib/catalog/types';
import {
  Card,
  CapacityBar,
  CheckRow,
  DetailScreen,
  ErrorView,
  InlineError,
  LoadingView,
  NoticeBox,
  PoolSummary,
  PriceBreakdown,
  PrimaryButton,
  SectionTitle,
  shared,
} from '../../lib/catalog/ui';
import { newIdempotencyKey, readRouteId, toApiError, useApiResource } from '../../lib/catalog/use-api-resource';

export default function OfferingDetailScreen() {
  const offeringId = readRouteId(useLocalSearchParams<{ id: string }>().id);
  const { state, reload } = useApiResource<OfferingDetail>(
    offeringId === null ? null : `/api/offerings/${encodeURIComponent(offeringId)}`,
  );

  if (offeringId === null) {
    return (
      <DetailScreen title="수업 상세" tab="home">
        <Text style={shared.muted}>잘못된 수업 주소예요.</Text>
      </DetailScreen>
    );
  }
  return (
    <DetailScreen title="수업 상세" tab="home">
      {state.status === 'loading' && <LoadingView />}
      {state.status === 'error' && <ErrorView error={state.error} onRetry={reload} />}
      {state.status === 'ready' && <OfferingBody detail={state.data} onStale={reload} />}
    </DetailScreen>
  );
}

function OfferingBody({ detail, onStale }: { detail: OfferingDetail; onStale: () => void }) {
  return (
    <>
      <OfferingSummaryCard detail={detail} />
      <SessionsCard detail={detail} />
      <CheckoutForm detail={detail} onStale={onStale} />
    </>
  );
}

function OfferingSummaryCard({ detail }: { detail: OfferingDetail }) {
  return (
    <Card>
      <Text style={shared.title}>{detail.title}</Text>
      <Text style={shared.muted}>
        {detail.academy?.name} · 강사 {detail.instructorName} · {detail.label}
      </Text>
      <Text style={styles.price}>{formatWon(detail.priceAmount)}</Text>
      <Text style={shared.muted}>
        정원 {detail.capacity?.total ?? 0} · 신청 {detail.capacity?.enrolled ?? 0}
      </Text>
      <CapacityBar enrolled={detail.capacity?.enrolled ?? 0} total={detail.capacity?.total ?? 0} />
      <PoolSummary pools={detail.capacity?.pools ?? []} />
    </Card>
  );
}

function SessionsCard({ detail }: { detail: OfferingDetail }) {
  const sessions = detail.sessions ?? [];
  return (
    <Card>
      <SectionTitle>회차 {sessions.length}회</SectionTitle>
      {sessions.map((session) => (
        <Text key={session.seq} style={shared.body}>
          {session.seq}회차 · {formatKstDateTime(session.startsAt)}~{formatKstTime(session.endsAt)}
        </Text>
      ))}
    </Card>
  );
}

/** 주문 시작에 필요한 선택값과 전송 상태. 화면에서 떼어 내 결제 버튼 조건을 한곳에 모은다. */
function useCheckoutStart(detail: OfferingDetail, onStale: () => void) {
  const [chosenSeat, setChosenSeat] = useState<SeatKind | null>(null);
  const [method, setMethodState] = useState<PaymentMethod>('virtual_account');
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptKey = useRef<string>(newIdempotencyKey());

  const seatKind = chosenSeat ?? detail.seatSelection?.defaultSeatKind ?? 'any';
  const seatOption = detail.seatSelection?.options?.find((option) => option.seatKind === seatKind);
  const seatAvailable = seatOption?.available === true;

  const chooseSeat = useCallback((next: SeatKind) => {
    attemptKey.current = newIdempotencyKey();
    setChosenSeat(next);
  }, []);
  const setMethod = useCallback((next: PaymentMethod) => {
    attemptKey.current = newIdempotencyKey();
    setMethodState(next);
  }, []);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    const body: CreateOrderBody = { offeringId: detail.offeringId, seatKind, method, noticesAcknowledged: true };
    try {
      const order = await apiFetch<Order>('/api/orders', { method: 'POST', body, idempotencyKey: attemptKey.current });
      router.replace(`/checkout/${encodeURIComponent(order.orderId)}`);
    } catch (caught: unknown) {
      const apiError = toApiError(caught);
      setError(apiError.detail);
      // 자리가 그사이 찼거나 판매가 닫혔으면 화면 숫자가 낡았다 — 다시 읽는다.
      if (apiError.code === 'SEAT_SOLD_OUT' || apiError.code === 'CHECKOUT_CLOSED') {
        attemptKey.current = newIdempotencyKey();
        onStale();
      }
    } finally {
      setSubmitting(false);
    }
  }, [detail.offeringId, method, onStale, seatKind]);

  const hasNotices = detail.refundNotice !== null && (detail.priceBreakdownPreview?.length ?? 0) > 0;
  const alreadyReserved = detail.myReservation !== null && detail.myReservation !== undefined;
  const canPay = hasNotices && seatAvailable && acknowledged && !submitting && !alreadyReserved;

  return {
    seatKind, seatAvailable, chooseSeat, method, setMethod, acknowledged, setAcknowledged,
    submitting, error, submit, canPay, hasNotices, alreadyReserved,
  };
}

function CheckoutForm({ detail, onStale }: { detail: OfferingDetail; onStale: () => void }) {
  const form = useCheckoutStart(detail, onStale);
  const payLabel = form.submitting
    ? '결제 준비 중…'
    : !form.seatAvailable
      ? `${seatLabel(form.seatKind)} 자리 마감`
      : `${seatLabel(form.seatKind)} 자리로 결제하기`;
  return (
    <>
      <SeatPicker detail={detail} selected={form.seatKind} onSelect={form.chooseSeat} />
      <Card>
        <SectionTitle>가격 내역</SectionTitle>
        <PriceBreakdown lines={detail.priceBreakdownPreview} />
      </Card>
      <MethodPicker method={form.method} onSelect={form.setMethod} />
      <NoticeBox title="환불·취소 공지">
        {detail.refundNotice?.body ?? '학원이 환불 공지를 아직 등록하지 않아 지금은 결제할 수 없어요.'}
      </NoticeBox>
      <NoticeBox title="통신판매중개자 고지">{detail.intermediaryNotice?.body ?? '-'}</NoticeBox>
      {form.alreadyReserved && <Text style={shared.muted}>이미 신청한 수업이에요. 캘린더에서 확인해 주세요.</Text>}
      <CheckRow
        checked={form.acknowledged}
        disabled={!form.hasNotices}
        label="환불 공지와 가격 내역을 확인했어요"
        onToggle={() => form.setAcknowledged((prev) => !prev)}
      />
      <InlineError message={form.error} />
      <PrimaryButton label={payLabel} onPress={() => void form.submit()} disabled={!form.canPay} />
    </>
  );
}

interface SeatPickerProps {
  detail: OfferingDetail;
  selected: SeatKind;
  onSelect: (seat: SeatKind) => void;
}

/** 자리 고르기. 단일 정원(`single`)이면 고를 것이 없어 안내만 한다. */
function SeatPicker({ detail, selected, onSelect }: SeatPickerProps) {
  const options = detail.seatSelection?.options ?? [];
  if (detail.seatMode === 'single' || options.length <= 1) {
    const soldOut = options[0]?.available === false;
    return <Text style={shared.muted}>{soldOut ? '정원이 마감됐어요.' : '자리 구분 없이 신청해요.'}</Text>;
  }
  return (
    <Card>
      <SectionTitle>신청 자리</SectionTitle>
      <View style={styles.chips}>
        {options.map((option) => (
          <Chip
            key={option.seatKind}
            label={option.available ? seatLabel(option.seatKind) : `${seatLabel(option.seatKind)} · 마감`}
            selected={option.seatKind === selected}
            onPress={() => onSelect(option.seatKind)}
          />
        ))}
      </View>
      <Text style={shared.muted}>기본 자리는 본인확인 성별로 정해져요.</Text>
    </Card>
  );
}

function MethodPicker({ method, onSelect }: { method: PaymentMethod; onSelect: (m: PaymentMethod) => void }) {
  return (
    <Card>
      <SectionTitle>결제 수단</SectionTitle>
      <View style={styles.chips}>
        <Chip label="계좌이체 · 가상계좌" selected={method === 'virtual_account'} onPress={() => onSelect('virtual_account')} />
        <Chip label="카드" selected={method === 'card'} onPress={() => onSelect('card')} />
      </View>
      <Text style={shared.muted}>
        {method === 'virtual_account' ? '입금이 확인되면 신청이 확정돼요.' : '카드 승인이 확인되면 신청이 확정돼요.'}
      </Text>
    </Card>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.chip, selected && styles.chipSelected]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  price: { fontSize: font.num - 4, fontWeight: '800', color: colors.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: MIN_TOUCH - 8,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  chipSelected: { backgroundColor: colors.night, borderColor: colors.night },
  chipText: { fontSize: font.body, color: colors.ink },
  chipTextSelected: { color: colors.surface, fontWeight: '700' },
});
