/**
 * 결제 대기 — 가상계좌 안내·기한·가격 내역·공지(보드 M9, `03-checkout-payment.md` §1~§3).
 *
 * 이 화면이 지키는 것
 *  - 가격 내역은 정가 → 혜택 할인 → 쿠폰 → (예매 수수료) → 최종 결제액 순서(FR-117·FR-283)
 *  - 기한은 서버가 준 `payment.dueAt` 하나만 믿는다. `dueAt <= 지금` 이면 화면은 만료로 본다.
 *    만료(`expired`)·취소(`cancelled`)는 끝 상태라 다시 결제로 돌아가지 않는다 — 새로 신청해야 한다
 *  - 「입금했어요」를 눌러도 서버 상태는 바뀌지 않는다. 확정은 PG 웹훅이 한다(AC-3(웹훅 신뢰성)).
 *    앱은 `GET /api/orders/{id}` 로 상태를 다시 읽을 뿐이다
 *  - 입금 전에는 스스로 주문을 취소할 수 있다(FR-286(입금 전 셀프 취소)). 돈이 오가지 않아 환불이 아니다
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { apiFetch } from '../../lib/api';
import { bankLabel, formatKstDateTime, formatRemaining, formatWon, parseInstant, seatLabel } from '../../lib/catalog/format';
import { colors, font, space } from '../../lib/theme';
import type { Order } from '../../lib/catalog/types';
import {
  Card,
  DetailScreen,
  ErrorView,
  InlineError,
  LoadingView,
  NoticeBox,
  PriceBreakdown,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  shared,
} from '../../lib/catalog/ui';
import { readRouteId, toApiError, useApiResource } from '../../lib/catalog/use-api-resource';

const CLOCK_TICK_MS = 30_000;

/** 남은 시간 표시용 시계. 30초마다 다시 그린다. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** 화면이 보여 줄 단계. 서버 상태 + 기한 판정(`dueAt <= now`)을 합친 값. */
type CheckoutPhase = 'waiting' | 'overdue' | 'paid' | 'expired' | 'cancelled' | 'other';

function phaseOf(order: Order, now: number): CheckoutPhase {
  switch (order.status) {
    case 'paid':
      return 'paid';
    case 'expired':
      return 'expired';
    case 'cancelled':
      return 'cancelled';
    case 'pending': {
      const due = parseInstant(order.payment?.dueAt);
      return due !== null && due.getTime() <= now ? 'overdue' : 'waiting';
    }
    default:
      return 'other';
  }
}

export default function CheckoutScreen() {
  const orderId = readRouteId(useLocalSearchParams<{ orderId: string }>().orderId);
  const { state, reload } = useApiResource<Order>(
    orderId === null ? null : `/api/orders/${encodeURIComponent(orderId)}`,
  );
  const firstFocus = useRef(true);

  // 다른 화면(은행 앱 등)에 다녀오면 상태를 다시 읽는다.
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      reload();
    }, [reload]),
  );

  return (
    <DetailScreen title="결제하기" tab="home">
      {orderId === null && <Text style={shared.muted}>잘못된 주문 주소예요.</Text>}
      {orderId !== null && state.status === 'loading' && <LoadingView />}
      {state.status === 'error' && <ErrorView error={state.error} onRetry={reload} />}
      {state.status === 'ready' && <CheckoutBody order={state.data} onChanged={reload} />}
    </DetailScreen>
  );
}

function CheckoutBody({ order, onChanged }: { order: Order; onChanged: () => void }) {
  const now = useNow();
  const phase = phaseOf(order, now);
  return (
    <>
      <StatusCard order={order} phase={phase} now={now} />
      <Card>
        <SectionTitle>가격 내역</SectionTitle>
        <PriceBreakdown lines={order.priceBreakdown} />
      </Card>
      {(phase === 'waiting' || phase === 'overdue') && <PaymentGuide order={order} />}
      <NoticeBox title="환불·취소 공지 · 통신판매중개자 고지">
        {`결제를 시작할 때 확인한 공지가 이 주문에 고정돼 있어요.\n환불 공지 판본 ${order.refundNoticeVersionId} · 중개자 고지 ${order.intermediaryNoticeVersion}`}
      </NoticeBox>
      <CheckoutActions order={order} phase={phase} onChanged={onChanged} />
    </>
  );
}

const PHASE_TEXT: Readonly<Record<CheckoutPhase, { tag: string; title: string; tone: keyof typeof TONE }>> = {
  waiting: { tag: '입금 대기', title: '입금하면 신청이 확정돼요', tone: 'warn' },
  overdue: { tag: '기한 지남', title: '입금 기한이 지났어요. 상태를 확인하고 있어요', tone: 'danger' },
  paid: { tag: '예약 확정', title: '결제가 확인됐어요', tone: 'ok' },
  expired: { tag: '만료', title: '입금 기한이 지나 주문이 끝났어요. 다시 신청해 주세요', tone: 'closed' },
  cancelled: { tag: '취소됨', title: '주문을 취소했어요', tone: 'closed' },
  other: { tag: '확인 중', title: '주문 상태를 확인해 주세요', tone: 'warn' },
};

const TONE = { ok: shared.tagOk, warn: shared.tagWarn, danger: shared.tagDanger, closed: shared.tagClosed };

function StatusCard({ order, phase, now }: { order: Order; phase: CheckoutPhase; now: number }) {
  const text = PHASE_TEXT[phase];
  const due = parseInstant(order.payment?.dueAt);
  const remaining = due === null ? null : formatRemaining(due.getTime() - now);
  return (
    <Card>
      <Text style={[shared.tag, TONE[text.tone]]}>{text.tag}</Text>
      <Text style={shared.title} accessibilityLiveRegion="polite">
        {text.title}
      </Text>
      <Text style={shared.muted}>
        {seatLabel(order.seatKind)} 자리 · 결제 금액 {formatWon(order.payment?.amount ?? 0)}
      </Text>
      {phase === 'waiting' && (
        <Text style={styles.due}>
          {formatKstDateTime(order.payment?.dueAt)}까지{remaining === null ? '' : ` · ${remaining} 남음`}
        </Text>
      )}
    </Card>
  );
}

/** 가상계좌면 입금 계좌, 카드면 결제창 안내. */
function PaymentGuide({ order }: { order: Order }) {
  const account = order.payment?.virtualAccount;
  if (order.payment?.method === 'virtual_account' && account) {
    return (
      <NoticeBox title="가상계좌 입금 안내">
        <View style={styles.accountRows}>
          <Row label="은행" value={bankLabel(account.bankCode)} />
          <Row label="계좌번호" value={account.accountNumber} selectable />
          <Row label="예금주" value={account.holder} />
          <Row label="입금액" value={formatWon(order.payment.amount)} />
        </View>
        <Text style={shared.muted}>입금액이 다르면 확정되지 않아요. 이 계좌는 이 주문에만 쓰여요.</Text>
      </NoticeBox>
    );
  }
  return (
    <NoticeBox title="카드 결제 안내">
      카드 결제창은 아직 연결 전이에요. 결제가 확인되면 이 화면에서 상태가 바뀌어요.
    </NoticeBox>
  );
}

function Row({ label, value, selectable = false }: { label: string; value: string; selectable?: boolean }) {
  return (
    <View style={styles.row} accessible>
      <Text style={shared.muted}>{label}</Text>
      <Text style={styles.rowValue} selectable={selectable}>
        {value}
      </Text>
    </View>
  );
}

interface CheckoutActionsProps {
  order: Order;
  phase: CheckoutPhase;
  onChanged: () => void;
}

function CheckoutActions({ order, phase, onChanged }: CheckoutActionsProps) {
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancelOrder = useCallback(async () => {
    setCancelling(true);
    setError(null);
    try {
      await apiFetch(`/api/orders/${encodeURIComponent(order.orderId)}/cancel`, { method: 'POST' });
    } catch (caught: unknown) {
      // ORDER_NOT_CANCELLABLE: 그사이 입금이 확인됐거나 만료됐다 — 문장을 보여 주고 상태를 다시 읽는다.
      setError(toApiError(caught).detail);
    } finally {
      setCancelling(false);
      onChanged();
    }
  }, [onChanged, order.orderId]);

  if (phase === 'paid') {
    return <PrimaryButton label="캘린더에서 보기" onPress={() => router.navigate('/calendar')} />;
  }
  if (phase === 'expired' || phase === 'cancelled') {
    return <SecondaryButton label="홈으로" onPress={() => router.navigate('/home')} />;
  }
  return (
    <>
      <InlineError message={error} />
      <PrimaryButton label="입금 상태 새로고침" onPress={onChanged} hint="입금이 확인됐는지 다시 확인해요" />
      {phase === 'waiting' && (
        <SecondaryButton
          label={cancelling ? '취소하는 중…' : '입금 전 주문 취소'}
          onPress={() => void cancelOrder()}
          disabled={cancelling}
          hint="아직 입금 전이라 환불 없이 자리를 바로 풀어요"
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  due: { fontSize: font.body, fontWeight: '700', color: colors.brown },
  accountRows: { gap: space.xs, marginVertical: space.xs },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  rowValue: { fontSize: font.body, fontWeight: '700', color: colors.ink, flexShrink: 1, textAlign: 'right' },
});
