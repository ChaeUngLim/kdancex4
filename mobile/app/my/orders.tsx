/**
 * 내 예약 · 결제 내역(보드 M16 · M16E, FR-298(주문 상태 6종) · FR-098b(환불 요청 경로) · 계약 04 §9).
 *
 * 한 화면에 두 탭을 둔다 — 「예약」은 지금 이어진 주문(입금 대기·결제완료·부분 환불)을 카드로,
 * 만료·입금 전 취소·전액 환불은 「지난 주문」 한 줄로 접는다. 「결제·환불 내역」은 모든 주문의 금액을 줄로 보인다.
 * 왜 한 화면인가(spec FR-138 화면 절): 입금 대기·환불은 한 주문의 상태들이라, 나누면 자기 주문을 두 곳에서 찾게 된다.
 *
 * 서버(`GET /api/me/orders`)는 상태를 6종 값 그대로 주고, 글자·색은 `lib/me/orders-view.ts` 가 정한다.
 * 버튼은 지금 갈 화면이 있는 것만 단다 — 입금 대기 → `계좌 보기`(결제 뒤 화면 M9C).
 * 영수증(실 PG S8-1 뒤)·환불 요청(M4)·대기 줄(대기 경로)은 아직 서버가 없어 그리지 않는다.
 */
import { useState } from 'react';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { apiFetch } from '../../lib/api';
import { formatKstDateTime, formatWon, seatLabel } from '../../lib/catalog/format';
import type { MyOrder } from '../../lib/catalog/types';
import {
  Card,
  DetailScreen,
  ErrorView,
  InlineError,
  LoadingView,
  NoticeBox,
  PrimaryButton,
  SecondaryButton,
  shared,
} from '../../lib/catalog/ui';
import { toApiError, useApiResource } from '../../lib/catalog/use-api-resource';
import { hasRefund, orderStatusLabel, paymentMethodLabel, splitReservationTab, type StatusTone } from '../../lib/me/orders-view';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';

const PAGE_SIZE = 20;

interface OrdersPage {
  items: readonly MyOrder[];
  nextCursor: string | null;
}

type OrdersTab = 'reservations' | 'payments';

const TONE_STYLES: Readonly<Record<StatusTone, object>> = {
  ok: shared.tagOk,
  warn: shared.tagWarn,
  danger: shared.tagDanger,
  closed: shared.tagClosed,
};

export default function MyOrdersScreen() {
  const [tab, setTab] = useState<OrdersTab>('reservations');
  const { state, reload } = useApiResource<OrdersPage>(`/api/me/orders?limit=${PAGE_SIZE}`);
  // 「더 보기」로 이어 받은 뒤쪽 쪽들. 첫 쪽은 훅이 들고 있다
  const [more, setMore] = useState<{ items: readonly MyOrder[]; cursor: string | null } | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  if (state.status === 'loading') {
    return (
      <DetailScreen title="내 예약 · 결제 내역" tab="my">
        <LoadingView />
      </DetailScreen>
    );
  }
  if (state.status === 'error') {
    return (
      <DetailScreen title="내 예약 · 결제 내역" tab="my">
        <ErrorView error={state.error} onRetry={reload} />
      </DetailScreen>
    );
  }

  const orders = [...state.data.items, ...(more?.items ?? [])];
  const cursor = more === null ? state.data.nextCursor : more.cursor;

  /** 「더 보기」를 눌렀을 때만 다음 쪽을 부른다(서버 커서 그대로). */
  const loadMore = async () => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await apiFetch<OrdersPage>(`/api/me/orders?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`);
      setMore({ items: [...(more?.items ?? []), ...page.items], cursor: page.nextCursor });
    } catch (error: unknown) {
      setMoreError(toApiError(error).detail);
    } finally {
      setLoadingMore(false);
    }
  };

  const { active, past } = splitReservationTab(orders);
  return (
    <DetailScreen title="내 예약 · 결제 내역" tab="my">
      <Segment tab={tab} reservationCount={active.length} onChange={setTab} />
      {orders.length === 0 ? (
        <EmptyOrders />
      ) : tab === 'reservations' ? (
        <ReservationList active={active} past={past} />
      ) : (
        <PaymentList orders={orders} />
      )}
      <InlineError message={moreError} />
      {cursor !== null && <SecondaryButton label={loadingMore ? '불러오는 중이에요' : '더 보기'} onPress={loadMore} disabled={loadingMore} />}
      <NoticeBox title="환불 요청은 이렇게 처리돼요">
        <Text style={shared.body}>환불 요청은 문의로 접수돼 강사가 확인하고, 돌려받을 금액은 대표가 정해요.</Text>
      </NoticeBox>
    </DetailScreen>
  );
}

/** 위쪽 두 칸 세그먼트 — 「예약 N」·「결제·환불 내역」(보드 M16). */
function Segment({ tab, reservationCount, onChange }: { tab: OrdersTab; reservationCount: number; onChange: (next: OrdersTab) => void }) {
  const items: readonly { key: OrdersTab; label: string }[] = [
    { key: 'reservations', label: `예약 ${reservationCount}` },
    { key: 'payments', label: '결제·환불 내역' },
  ];
  return (
    <View style={styles.segment} accessibilityRole="tablist">
      {items.map((item) => {
        const selected = item.key === tab;
        return (
          <Pressable
            key={item.key}
            style={[styles.segmentCell, selected && styles.segmentOn]}
            onPress={() => onChange(item.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextOn]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** M16E — 아직 주문이 하나도 없을 때. 공통 빈 카드 규칙(원 · 제목 · 설명 · 다음 행동). */
function EmptyOrders() {
  return (
    <Card>
      <View style={styles.emptyCircle} />
      <Text style={styles.emptyTitle}>아직 신청한 수업이 없어요</Text>
      <Text style={shared.muted}>결제한 수업과 입금 대기 주문이 여기에 쌓여요. 마음에 드는 수업을 찾아 신청해 보세요.</Text>
      <PrimaryButton label="수업 찾기" onPress={() => router.navigate('/home')} />
    </Card>
  );
}

function ReservationList({ active, past }: { active: readonly MyOrder[]; past: readonly MyOrder[] }) {
  const [showPast, setShowPast] = useState(false);
  return (
    <View style={styles.list}>
      {active.length === 0 && <Text style={shared.muted}>지금 이어진 예약은 없어요.</Text>}
      {active.map((order) => (
        <ReservationCard key={order.orderId} order={order} />
      ))}
      {past.length > 0 && (
        <Pressable
          style={styles.pastRow}
          onPress={() => setShowPast(!showPast)}
          accessibilityRole="button"
          accessibilityState={{ expanded: showPast }}
        >
          <Text style={styles.pastText}>지난 주문 {past.length}건</Text>
          <Text style={styles.pastText}>{showPast ? '접기' : '펼치기'}</Text>
        </Pressable>
      )}
      {showPast && past.map((order) => <ReservationCard key={order.orderId} order={order} />)}
    </View>
  );
}

/** 예약 카드 한 장 — 상태 태그 · 수업명 · 학원 · 자리 · 금액 · 결제수단 + 상태에 맞는 버튼. */
function ReservationCard({ order }: { order: MyOrder }) {
  const status = orderStatusLabel(order.status);
  const openCheckout = () =>
    router.push(`/checkout/${encodeURIComponent(order.orderId)}?offeringId=${encodeURIComponent(order.offeringId)}`);
  return (
    <Card>
      <Text style={[shared.tag, TONE_STYLES[status.tone]]}>{status.label}</Text>
      <Text style={styles.cardTitle}>{order.title}</Text>
      <Text style={shared.muted}>
        {order.academyName} · {seatLabel(order.seatKind)} 자리
      </Text>
      <Text style={shared.body}>
        {formatWon(order.totalAmount)} · {paymentMethodLabel(order.method)}
        {hasRefund(order) ? ` · 환불 ${formatWon(order.refundedAmount)}` : ''}
      </Text>
      {order.status === 'pending' && order.dueAt !== null && (
        <Text style={styles.due}>{formatKstDateTime(order.dueAt)}까지 입금해 주세요</Text>
      )}
      {order.status === 'pending' && <SecondaryButton label="계좌 보기" onPress={openCheckout} />}
    </Card>
  );
}

/** 「결제·환불 내역」 — 주문마다 한 줄. 결제 시각(없으면 주문 시각) · 금액 · 환불액. */
function PaymentList({ orders }: { orders: readonly MyOrder[] }) {
  return (
    <Card>
      {orders.map((order, index) => {
        const status = orderStatusLabel(order.status);
        return (
          <View key={order.orderId} style={[styles.payRow, index > 0 && styles.payRowLine]}>
            <View style={styles.payText}>
              <Text style={styles.payTitle} numberOfLines={1}>
                {order.title}
              </Text>
              <Text style={shared.muted}>
                {formatKstDateTime(order.paidAt ?? order.createdAt)} · {paymentMethodLabel(order.method)}
              </Text>
            </View>
            <View style={styles.payAmounts}>
              <Text style={styles.payAmount}>{formatWon(order.totalAmount)}</Text>
              {hasRefund(order) && <Text style={styles.refund}>환불 −{formatWon(order.refundedAmount)}</Text>}
              <Text style={[shared.tag, TONE_STYLES[status.tone]]}>{status.label}</Text>
            </View>
          </View>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  segment: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.pill, padding: 4, borderWidth: 1, borderColor: colors.line },
  segmentCell: { flex: 1, minHeight: MIN_TOUCH - 8, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  segmentOn: { backgroundColor: colors.brown },
  segmentText: { fontSize: font.body, color: colors.ink3, fontWeight: '600' },
  segmentTextOn: { color: colors.surface, fontWeight: '700' },
  list: { gap: space.md },
  cardTitle: { fontSize: 16, fontWeight: '700', color: colors.ink },
  due: { fontSize: font.small, color: colors.brown, fontWeight: '700' },
  pastRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: MIN_TOUCH,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  pastText: { fontSize: font.body, color: colors.ink3 },
  payRow: { flexDirection: 'row', gap: space.sm, paddingVertical: space.sm },
  payRowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  payText: { flex: 1, gap: 2 },
  payTitle: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  payAmounts: { alignItems: 'flex-end', gap: 2 },
  payAmount: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  refund: { fontSize: font.small, color: colors.danger },
  emptyCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#EDE3D3', alignSelf: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.ink, textAlign: 'center' },
});
