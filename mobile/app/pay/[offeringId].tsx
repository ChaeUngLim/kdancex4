/**
 * 결제하기 — 결제수단을 고르고 주문을 시작하는 화면(보드 M9 · M9N · M9E, 계약 03 §1 · 02 §2).
 *
 * 흐름: 수업 상세(M8)에서 자리를 고르고 「결제하기」 → 이 화면 → 「N원 결제」 → `POST /api/orders` → 결제 대기·완료 화면.
 *
 * 이 화면이 지키는 것
 *  - 금액은 서버 응답만 보여 준다. 수업 상세의 `priceBreakdownPreview` 는 주문 생성과 같은 계산 함수의 결과다(S3-3.15b).
 *    버튼의 금액도 그 표의 「최종」 줄이다. 앱이 정가에서 직접 빼거나 더하지 않는다
 *  - 고를 수 있는 수단은 수업 구분(`classKind`)으로 정한다(FR-280(결제수단 결정)).
 *    정규·단기·개인 레슨은 4종(카드 기본), 이벤트형은 간편 계좌이체(기본)·가상계좌 2종(보드 M9E)
 *  - 멤버십이 없는 회원에게 「3개월 멤버십으로 결제하면 1+1」 안내를 띄운다(보드 M9N). 지금은 모두 「가입한 적 없음」(membership.ts)
 *  - 환불 규칙·개인정보 제3자 제공 동의에 체크해야 결제 버튼이 열린다(FR-282(결제 화면 필수 표시))
 *  - `Idempotency-Key` — 같은 수단으로 다시 누르면 같은 키라 서버가 같은 주문을 돌려준다. 수단을 바꾸면 새 키(README §5)
 */
import { useCallback, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { apiFetch } from '../../lib/api';
import { isEventClassKind, paymentMethodsFor } from '../../lib/catalog/checkout';
import {
  CheckoutPriceCard,
  MembershipBanner,
  MethodList,
  OfferingSummary,
  RefundDeadlineBand,
} from '../../lib/catalog/checkout-ui';
import { formatWon } from '../../lib/catalog/format';
import { readMembershipForCheckout } from '../../lib/catalog/membership';
import { SellerCard } from '../../lib/catalog/seller-card';
import type { CreateOrderBody, OfferingDetail, Order, PaymentMethod, SeatKind } from '../../lib/catalog/types';
import { CheckRow, DetailScreen, ErrorView, InlineError, LoadingView, NoticeBox, PrimaryButton, shared } from '../../lib/catalog/ui';
import { newIdempotencyKey, readRouteId, toApiError, useApiResource } from '../../lib/catalog/use-api-resource';
import { colors, font, space } from '../../lib/theme';

const SEAT_KINDS: readonly SeatKind[] = ['male', 'female', 'any'];

/** 주소의 `seat` 값 검사 — 딥링크 값은 믿지 않는다. 모르는 값이면 null(서버 기본 자리를 쓴다) */
function readSeat(value: string | string[] | undefined): SeatKind | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return SEAT_KINDS.find((kind) => kind === raw) ?? null;
}

export default function PayScreen() {
  const params = useLocalSearchParams<{ offeringId: string; seat?: string }>();
  const offeringId = readRouteId(params.offeringId);
  const { state, reload } = useApiResource<OfferingDetail>(
    offeringId === null ? null : `/api/offerings/${encodeURIComponent(offeringId)}`,
  );
  return (
    <DetailScreen title="결제하기" tab="home">
      {offeringId === null && <Text style={shared.muted}>잘못된 수업 주소예요.</Text>}
      {offeringId !== null && state.status === 'loading' && <LoadingView />}
      {state.status === 'error' && <ErrorView error={state.error} onRetry={reload} />}
      {state.status === 'ready' && (
        <PayBody detail={state.data} seatKind={readSeat(params.seat) ?? state.data.seatSelection?.defaultSeatKind ?? 'any'} onStale={reload} />
      )}
    </DetailScreen>
  );
}

interface PayBodyProps {
  detail: OfferingDetail;
  seatKind: SeatKind;
  onStale: () => void;
}

function PayBody({ detail, seatKind, onStale }: PayBodyProps) {
  const isEvent = isEventClassKind(detail.classKind);
  const methods = paymentMethodsFor(detail.classKind);
  const membership = readMembershipForCheckout();
  const form = usePayForm(detail, seatKind, methods[0] ?? 'virtual_account', onStale);
  const [openPanel, setOpenPanel] = useState<'refund' | 'seller' | null>(null);
  const togglePanel = (panel: 'refund' | 'seller') => setOpenPanel((now) => (now === panel ? null : panel));

  return (
    <>
      <OfferingSummary detail={detail} seatKind={seatKind} />
      <CheckoutPriceCard lines={detail.priceBreakdownPreview} isEvent={isEvent} />
      {isEvent && <RefundDeadlineBand />}
      {!isEvent && <MembershipBanner membership={membership} />}
      <MethodList methods={methods} selected={form.method} isEvent={isEvent} onSelect={form.chooseMethod} />
      <CheckRow
        checked={form.agreed}
        disabled={detail.refundNotice === null}
        label="환불 규칙과 개인정보 제3자 제공(학원)에 동의해요"
        onToggle={() => form.setAgreed((prev) => !prev)}
      />
      <Text style={styles.notice}>
        K-DanceX4는 통신판매중개자이며 판매 당사자가 아니에요. 이 수업의 판매자 · {detail.academy?.name ?? '학원'}
      </Text>
      <View style={styles.links}>
        <LinkText label="환불 규칙" open={openPanel === 'refund'} onPress={() => togglePanel('refund')} />
        <LinkText label="판매자 정보" open={openPanel === 'seller'} onPress={() => togglePanel('seller')} />
      </View>
      {openPanel === 'refund' && (
        <NoticeBox title="환불·취소 공지">{detail.refundNotice?.body ?? '학원이 환불 공지를 아직 등록하지 않아 결제할 수 없어요.'}</NoticeBox>
      )}
      {openPanel === 'seller' && <SellerCard seller={detail.seller} />}
      <InlineError message={form.error} />
      <PrimaryButton label={form.payLabel} onPress={() => void form.submit()} disabled={!form.canPay} />
    </>
  );
}

/** 「환불 규칙 ›」 같은 펼침 글자 버튼 */
function LinkText({ label, open, onPress }: { label: string; open: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={12}>
      <Text style={styles.link}>
        {label} {open ? '⌃' : '›'}
      </Text>
    </Pressable>
  );
}

/**
 * 수단 선택·동의·전송 상태. 결제 버튼이 열리는 조건을 한곳에 모은다.
 * 버튼 금액은 서버 가격 내역의 「최종」 줄 — 없으면 버튼을 닫는다(앱이 금액을 만들지 않는다).
 */
function usePayForm(detail: OfferingDetail, seatKind: SeatKind, defaultMethod: PaymentMethod, onStale: () => void) {
  const [method, setMethod] = useState<PaymentMethod>(defaultMethod);
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptKey = useRef<string>(newIdempotencyKey());

  const chooseMethod = useCallback((next: PaymentMethod) => {
    // 수단이 바뀌면 다른 시도다 — 새 멱등키
    attemptKey.current = newIdempotencyKey();
    setMethod(next);
  }, []);

  const finalAmount = detail.priceBreakdownPreview?.find((line) => line.kind === 'final')?.amount;
  const seatAvailable = detail.seatSelection?.options?.find((option) => option.seatKind === seatKind)?.available === true;
  const canPay = finalAmount !== undefined && detail.refundNotice !== null && seatAvailable && agreed && !submitting;

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    const body: CreateOrderBody = { offeringId: detail.offeringId, seatKind, method, noticesAcknowledged: true };
    try {
      const order = await apiFetch<Order>('/api/orders', { method: 'POST', body, idempotencyKey: attemptKey.current });
      // 결제 대기·완료·실패 화면은 수업 이름을 그리려고 판매 단위 번호를 같이 받는다(주문 응답에는 수업 정보가 없다)
      router.replace(`/checkout/${encodeURIComponent(order.orderId)}?offeringId=${encodeURIComponent(detail.offeringId)}`);
    } catch (caught: unknown) {
      const apiError = toApiError(caught);
      setError(apiError.detail);
      // 자리가 그사이 찼거나 판매가 닫혔으면 화면 숫자가 낡았다 — 새 키로 다시 읽는다
      if (apiError.code === 'SEAT_SOLD_OUT' || apiError.code === 'CHECKOUT_CLOSED') {
        attemptKey.current = newIdempotencyKey();
        onStale();
      }
    } finally {
      setSubmitting(false);
    }
  }, [detail.offeringId, method, onStale, seatKind]);

  const payLabel = submitting
    ? '결제 준비 중…'
    : !seatAvailable
      ? '이 자리는 마감됐어요'
      : finalAmount === undefined
        ? '가격 내역을 받지 못했어요'
        : `${formatWon(finalAmount)} 결제`;

  return { method, chooseMethod, agreed, setAgreed, error, submit, canPay, payLabel };
}

const styles = StyleSheet.create({
  notice: { fontSize: font.small, color: colors.ink3, lineHeight: 19 },
  links: { flexDirection: 'row', gap: space.lg },
  link: { fontSize: font.small, color: colors.brown, fontWeight: '700' },
});
