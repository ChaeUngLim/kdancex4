/**
 * 결제 뒤 화면 — 입금 안내(보드 M9C) · 예약 확정(M9B) · 결제 실패(X2) · 결제창 승인 대기 · 만료·취소
 * (`03-checkout-payment.md` §1~§2 · §8 M-03).
 *
 * 이 화면이 지키는 것
 *  - 상태는 서버 `GET /api/orders/{id}` 하나만 믿는다. 「입금했어요」·「결제창에서 돌아왔어요」는 서버 상태를 바꾸지 않는다 —
 *    확정은 PG 웹훅이 한다(AC-3(웹훅 신뢰성)). 앱은 새로고침으로 다시 읽을 뿐이다
 *  - 금액은 주문의 가격 내역·결제 금액(서버 값)만 보여 준다
 *  - 기한은 서버가 준 `payment.dueAt` 하나만 믿는다. `dueAt <= 지금` 이면 「기한 지남」으로 본다
 *  - 결제 실패(X2): 결제창 수단(카드·간편결제·간편 계좌이체) 주문이 `cancelled` 면 승인 실패로 본다.
 *    회원이 스스로 취소할 수 있는 것은 가상계좌 입금 전뿐이라(FR-286(입금 전 셀프 취소)) 결제창 주문의 취소는
 *    PG 승인 실패(계약 03 §8 M-03)에서만 생긴다. 실패하면 자리를 잡아 두지 않는다(2026-11-03 사용자 결정)
 *  - 수업 이름·학원·첫 수업은 주문 응답에 없어, 결제 화면이 넘겨 준 `offeringId` 로 수업 상세를 함께 읽는다
 */
import { useCallback, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { apiFetch } from '../../lib/api';
import { isWindowMethod, methodName } from '../../lib/catalog/checkout';
import { OfferingSummary } from '../../lib/catalog/checkout-ui';
import { bankLabel, formatKstDateTime, formatRemaining, formatWon, parseInstant, seatLabel } from '../../lib/catalog/format';
import type { OfferingDetail, Order } from '../../lib/catalog/types';
import {
  Card,
  DetailScreen,
  ErrorView,
  InlineError,
  LoadingView,
  PriceBreakdown,
  PrimaryButton,
  SecondaryButton,
  shared,
} from '../../lib/catalog/ui';
import { readRouteId, toApiError, useApiResource } from '../../lib/catalog/use-api-resource';
import { colors, font, radius, space } from '../../lib/theme';

/** 화면이 보여 줄 단계. 서버 상태 + 결제수단 + 기한 판정(`dueAt <= now`)을 합친 값 */
type CheckoutPhase = 'deposit' | 'window' | 'overdue' | 'paid' | 'failed' | 'expired' | 'cancelled' | 'other';

/**
 * 주문 → 화면 단계. 핵심 갈림길은 둘이다.
 *  ① pending: 가상계좌면 입금 안내(M9C), 결제창 수단이면 승인 대기. 기한이 지났으면 「기한 지남」
 *  ② cancelled: 결제창 수단이면 승인 실패(X2), 가상계좌면 회원이 입금 전에 취소한 것
 */
function phaseOf(order: Order, now: number): CheckoutPhase {
  const windowMethod = isWindowMethod(order.payment?.method);
  switch (order.status) {
    case 'paid':
      return 'paid';
    case 'expired':
      return 'expired';
    case 'cancelled':
      return windowMethod ? 'failed' : 'cancelled';
    case 'pending': {
      const due = parseInstant(order.payment?.dueAt);
      if (due !== null && due.getTime() <= now) {
        return 'overdue';
      }
      return windowMethod ? 'window' : 'deposit';
    }
    default:
      return 'other';
  }
}

const TITLES: Readonly<Record<CheckoutPhase, string>> = {
  deposit: '입금 안내',
  window: '결제하기',
  overdue: '입금 안내',
  paid: '예약 확정',
  failed: '결제하기',
  expired: '주문 상태',
  cancelled: '주문 상태',
  other: '주문 상태',
};

export default function CheckoutScreen() {
  const params = useLocalSearchParams<{ orderId: string; offeringId?: string }>();
  const orderId = readRouteId(params.orderId);
  const offeringId = readRouteId(params.offeringId);
  const { state, reload } = useApiResource<Order>(
    orderId === null ? null : `/api/orders/${encodeURIComponent(orderId)}`,
  );
  const offering = useApiResource<OfferingDetail>(
    offeringId === null ? null : `/api/offerings/${encodeURIComponent(offeringId)}`,
  );
  const firstFocus = useRef(true);

  // 다른 화면(은행 앱·결제창)에 다녀오면 상태를 다시 읽는다.
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      reload();
    }, [reload]),
  );

  // 렌더할 때의 시각으로 기한을 판정한다. 새로고침하면 다시 그려지며 남은 시간도 갱신된다
  const now = Date.now();
  const detail = offering.state.status === 'ready' ? offering.state.data : null;
  const phase = state.status === 'ready' ? phaseOf(state.data, now) : null;
  return (
    <DetailScreen title={phase === null ? '결제' : TITLES[phase]} tab="home">
      {orderId === null && <Text style={shared.muted}>잘못된 주문 주소예요.</Text>}
      {orderId !== null && state.status === 'loading' && <LoadingView />}
      {state.status === 'error' && <ErrorView error={state.error} onRetry={reload} />}
      {state.status === 'ready' && phase !== null && (
        <CheckoutBody order={state.data} phase={phase} now={now} detail={detail} offeringId={offeringId} onChanged={reload} />
      )}
    </DetailScreen>
  );
}

interface BodyProps {
  order: Order;
  phase: CheckoutPhase;
  now: number;
  detail: OfferingDetail | null;
  offeringId: string | null;
  onChanged: () => void;
}

function CheckoutBody(props: BodyProps) {
  switch (props.phase) {
    case 'paid':
      return <ConfirmedView {...props} />;
    case 'deposit':
    case 'overdue':
      return <DepositView {...props} />;
    case 'window':
      return <WindowWaitingView {...props} />;
    case 'failed':
      return <FailedView {...props} />;
    default:
      return <ClosedView {...props} />;
  }
}

// ---------------------------------------------------------------- M9C 입금 안내

/** 가상계좌 입금 안내(보드 M9C) — 계좌·입금액·기한, 주문 요약, 새로고침·입금 전 취소 */
function DepositView({ order, phase, now, detail, onChanged }: BodyProps) {
  const account = order.payment?.virtualAccount;
  const amount = order.payment?.amount ?? 0;
  const due = parseInstant(order.payment?.dueAt);
  const remaining = due === null ? null : formatRemaining(due.getTime() - now);
  const overdue = phase === 'overdue';
  const seat = order.seatKind === 'any' ? '자리 1개' : `${seatLabel(order.seatKind)} 자리 1개`;
  return (
    <>
      <View style={styles.hero} accessibilityLiveRegion="polite">
        <Text style={[shared.tag, overdue ? shared.tagDanger : shared.tagWarn, styles.centerSelf]}>{overdue ? '기한 지남' : '입금 대기'}</Text>
        <Text style={styles.heroTitle}>
          {overdue ? '입금 기한이 지났어요. 상태를 확인하고 있어요' : `${formatWon(amount)}을 입금하면 예약이 확정돼요`}
        </Text>
        {!overdue && <Text style={styles.heroSub}>입금 기한까지 {seat}를 잡아 뒀어요</Text>}
      </View>
      <Card>
        {account ? (
          <>
            <Text style={shared.muted}>{bankLabel(account.bankCode)}</Text>
            <Text style={styles.accountNumber} selectable accessibilityLabel={`계좌번호 ${account.accountNumber}`}>
              {account.accountNumber}
            </Text>
            <Row label="예금주" value={account.holder} />
            <Row label="입금액" value={formatWon(amount)} strong />
            <Row label="입금 기한" value={`${formatKstDateTime(order.payment?.dueAt)}까지`} />
            {!overdue && remaining !== null && <Text style={styles.remaining}>{remaining} 남음</Text>}
          </>
        ) : (
          <Text style={shared.muted}>입금 계좌를 받지 못했어요. 새로고침해 주세요.</Text>
        )}
      </Card>
      <Text style={styles.footnote}>
        기한은 발급 뒤 24시간과 수업 시작 1시간 전 중 이른 쪽이에요 · 지나면 주문이 만료되고 자리는 대기 1번에게 넘어가요
      </Text>
      <Card>
        {detail !== null && <Row label="수업" value={`${detail.title} · ${detail.label}`} />}
        <Row label="주문 상태" value={overdue ? '미결제 · 기한 지남' : '미결제 · 입금 대기'} />
        <Row label="금액이 다르게 입금되면" value="확정 안 됨 · 전액 돌려드려요" />
      </Card>
      <DepositActions order={order} canCancel={!overdue} onChanged={onChanged} />
    </>
  );
}

function DepositActions({ order, canCancel, onChanged }: { order: Order; canCancel: boolean; onChanged: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 입금 전 셀프 취소(FR-286) — 돈이 오가지 않아 환불이 아니라 주문 취소다. 결과는 서버에서 다시 읽는다
  const cancelOrder = async () => {
    setCancelling(true);
    setError(null);
    try {
      await apiFetch(`/api/orders/${encodeURIComponent(order.orderId)}/cancel`, { method: 'POST' });
    } catch (caught: unknown) {
      // ORDER_NOT_CANCELLABLE: 그사이 입금이 확인됐거나 만료됐다 — 문장을 보여 주고 상태를 다시 읽는다
      setError(toApiError(caught).detail);
    } finally {
      setCancelling(false);
      onChanged();
    }
  };

  return (
    <>
      <InlineError message={error} />
      <PrimaryButton label="입금 상태 새로고침" onPress={onChanged} hint="입금이 확인됐는지 다시 확인해요" />
      {canCancel && (
        <SecondaryButton
          label={cancelling ? '취소하는 중…' : '입금 전 취소하기'}
          onPress={() => void cancelOrder()}
          disabled={cancelling}
          hint="아직 입금 전이라 환불 없이 자리를 바로 풀어요"
        />
      )}
      <Text style={styles.footnote}>입금 전이라 환불이 아니라 바로 취소돼요 · 입금이 확인되면 이 버튼은 사라지고 환불 요청으로만 돌릴 수 있어요</Text>
    </>
  );
}

// ---------------------------------------------------------------- 결제창 승인 대기

/** 카드·간편결제·간편 계좌이체 — PG 결제창의 승인을 기다리는 동안. 승인·실패는 웹훅이 정하고 앱은 다시 읽는다 */
function WindowWaitingView({ order, now, detail, onChanged }: BodyProps) {
  const due = parseInstant(order.payment?.dueAt);
  const remaining = due === null ? null : formatRemaining(due.getTime() - now);
  return (
    <>
      {detail !== null && <OfferingSummary detail={detail} seatKind={order.seatKind} />}
      <Card>
        <Text style={[shared.tag, shared.tagWarn]}>승인 대기</Text>
        <Text style={shared.title} accessibilityLiveRegion="polite">
          {methodName(order.payment?.method)} 결제창에서 결제를 마쳐 주세요
        </Text>
        <Text style={shared.muted}>
          결제 금액 {formatWon(order.payment?.amount ?? 0)}
          {remaining === null ? '' : ` · ${remaining} 안에 마치지 않으면 자리가 풀려요`}
        </Text>
      </Card>
      <Card>
        <PriceBreakdown lines={order.priceBreakdown} />
      </Card>
      <PrimaryButton label="결제 상태 새로고침" onPress={onChanged} hint="결제가 승인됐는지 다시 확인해요" />
    </>
  );
}

// ---------------------------------------------------------------- M9B 예약 확정

/** 예약 확정(보드 M9B) — 수업·학원·첫 수업·자리, 결제수단·가격 내역, 캘린더로 */
function ConfirmedView({ order, detail }: BodyProps) {
  const seat = order.seatKind === 'any' ? '자리 1개' : `${seatLabel(order.seatKind)} 자리`;
  return (
    <>
      <View style={styles.hero} accessibilityLiveRegion="polite">
        <View style={styles.checkCircle}>
          <Text style={styles.checkMark}>✓</Text>
        </View>
        <Text style={styles.heroTitle}>예약이 확정됐어요</Text>
        <Text style={styles.heroSub}>결제 확인 알림을 보냈고 내 캘린더에 담았어요</Text>
      </View>
      <Card>
        {detail !== null && <Row label="수업" value={`${detail.title} · ${detail.label}`} />}
        {detail !== null && <Row label="학원" value={detail.academy?.name ?? '-'} />}
        {detail !== null && <Row label="첫 수업" value={formatKstDateTime(detail.sessions?.[0]?.startsAt)} />}
        <Row label="신청 자리" value={seat} />
      </Card>
      <Card>
        <Row label="결제수단" value={methodName(order.payment?.method)} />
        <PriceBreakdown lines={order.priceBreakdown} />
      </Card>
      <Text style={styles.footnote}>환불은 학원의 환불 규정을 따라요 · 요청은 마이 › 내 예약에서</Text>
      <PrimaryButton label="캘린더에서 보기" onPress={() => router.navigate('/calendar')} />
      <SecondaryButton label="홈으로" onPress={() => router.navigate('/home')} />
    </>
  );
}

// ---------------------------------------------------------------- X2 결제 실패

/**
 * 결제 실패(보드 X2) — 주문 카드는 그대로 두고 아래에 오류 카드. 「돈은 빠져나가지 않았고 자리도 잡히지 않았다」를 먼저 적는다.
 * 카드사 실패 사유는 주문 조회 응답에 없어(계약 03 §2) 지어내지 않는다. 다시 결제하면 새 주문(새 멱등키)이다(§8 M-03).
 */
function FailedView({ order, detail, offeringId }: BodyProps) {
  const retry = () => {
    if (offeringId === null) {
      router.navigate('/home');
      return;
    }
    router.replace(`/pay/${encodeURIComponent(offeringId)}?seat=${encodeURIComponent(order.seatKind)}`);
  };
  return (
    <>
      {detail !== null && <OfferingSummary detail={detail} seatKind={order.seatKind} />}
      <View style={styles.errorCard} accessibilityLiveRegion="polite">
        <View style={styles.errorCircle}>
          <Text style={styles.errorMark}>!</Text>
        </View>
        <Text style={styles.heroTitle}>결제가 완료되지 않았어요</Text>
        <Text style={styles.heroSub}>{methodName(order.payment?.method)} 승인이 되지 않았어요</Text>
        <Text style={styles.errorBody}>돈은 빠져나가지 않았고, 수업 자리도 아직 잡히지 않았어요.</Text>
        <View style={styles.errorButtons}>
          <View style={styles.flex}>
            <SecondaryButton label="문의하기" onPress={() => undefined} disabled hint="문의 창구는 곧 열려요" />
          </View>
          <View style={styles.flex}>
            <PrimaryButton label="다시 결제하기" onPress={retry} />
          </View>
        </View>
        <Text style={shared.muted}>다른 카드·계좌이체는 「다시 결제하기」에서 골라요 · 문의하기는 곧 열려요</Text>
      </View>
    </>
  );
}

// ---------------------------------------------------------------- 만료·취소

const CLOSED_TEXT: Readonly<Record<string, { tag: string; title: string }>> = {
  expired: { tag: '만료', title: '입금 기한이 지나 주문이 끝났어요. 다시 신청해 주세요' },
  cancelled: { tag: '취소됨', title: '주문을 취소했어요' },
  other: { tag: '확인 중', title: '주문 상태를 확인해 주세요' },
};

function ClosedView({ order, phase, detail }: BodyProps) {
  const text = CLOSED_TEXT[phase] ?? CLOSED_TEXT.other!;
  return (
    <>
      {detail !== null && <OfferingSummary detail={detail} seatKind={order.seatKind} />}
      <Card>
        <Text style={[shared.tag, shared.tagClosed]}>{text.tag}</Text>
        <Text style={shared.title} accessibilityLiveRegion="polite">
          {text.title}
        </Text>
      </Card>
      <SecondaryButton label="홈으로" onPress={() => router.navigate('/home')} />
    </>
  );
}

// ---------------------------------------------------------------- 공용

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label} ${value}`}>
      <Text style={shared.muted}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.rowStrong]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: space.sm, paddingVertical: space.md },
  centerSelf: { alignSelf: 'center' },
  heroTitle: { fontSize: font.h2, fontWeight: '800', color: colors.ink, textAlign: 'center' },
  heroSub: { fontSize: font.small, color: colors.ink3, textAlign: 'center' },
  accountNumber: { fontSize: 22, fontWeight: '800', color: colors.ink, letterSpacing: 0.5 },
  remaining: { fontSize: font.small, fontWeight: '700', color: colors.brown, textAlign: 'right' },
  footnote: { fontSize: font.small - 1, color: colors.ink3, lineHeight: 18 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.md,
    paddingVertical: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowValue: { fontSize: font.body, fontWeight: '700', color: colors.ink, flexShrink: 1, textAlign: 'right' },
  rowStrong: { fontSize: 16, fontWeight: '800' },
  checkCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.brownSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkMark: { fontSize: 26, color: colors.brown, fontWeight: '800' },
  errorCard: { backgroundColor: colors.surface, borderRadius: 18, padding: space.lg, gap: space.sm, alignItems: 'center' },
  errorCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.dangerSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorMark: { fontSize: 26, color: colors.danger, fontWeight: '800' },
  errorBody: { fontSize: font.body, color: colors.ink, textAlign: 'center', lineHeight: 20 },
  errorButtons: { flexDirection: 'row', gap: space.sm, alignSelf: 'stretch', marginTop: space.sm },
  flex: { flex: 1, borderRadius: radius.md },
});
