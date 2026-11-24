/**
 * 결제 화면(보드 M9·M9N·M9E) 조각 — 수업 요약 카드, 가격 내역 카드, 결제수단 목록, 멤버십 안내, 환불 마감 띠.
 *
 * 금액은 전부 서버가 준 가격 내역(`priceBreakdownPreview`·`priceBreakdown`)을 그대로 보여 준다.
 * 앱은 더하거나 빼지 않는다 — 결제액을 정하는 곳은 서버 한 곳(계약 03 §3, FR-298b(결제 멱등성·금액 재계산))이다.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, font, MIN_TOUCH, radius, space } from '../theme';
import { METHOD_TEXT } from './checkout';
import { formatKstTime, formatWon, orderPriceLines, parseInstant, seatLabel, toKstParts } from './format';
import type { CheckoutMembership } from './membership';
import type { OfferingDetail, PaymentMethod, PriceLine, SeatKind } from './types';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;

// ---------------------------------------------------------------- 수업 요약

/** 「브래드 댄스 스튜디오 · 화 20:00 · 남 자리」 — 첫 회차 요일·시각과 고른 자리 */
export function offeringSubtitle(detail: OfferingDetail, seatKind: SeatKind): string {
  const first = parseInstant(detail.sessions?.[0]?.startsAt);
  const when = first === null ? '일정 미정' : `${WEEKDAYS[toKstParts(first).weekday]} ${formatKstTime(detail.sessions[0]?.startsAt)}`;
  const seat = seatKind === 'any' ? '자리 1개' : `${seatLabel(seatKind)} 자리`;
  return `${detail.academy?.name ?? ''} · ${when} · ${seat}`;
}

/** 보드 M9 맨 위 카드 — 수업 이름 · 학원 · 시각 · 자리 */
export function OfferingSummary({ detail, seatKind }: { detail: OfferingDetail; seatKind: SeatKind }) {
  return (
    <View style={styles.card} accessible accessibilityLabel={`${detail.title} ${detail.label}, ${offeringSubtitle(detail, seatKind)}`}>
      <View style={styles.summaryRow}>
        <View style={styles.poster} />
        <View style={styles.summaryText}>
          <Text style={styles.summaryTitle} numberOfLines={2}>
            {detail.title} · {detail.label}
          </Text>
          <Text style={styles.muted}>{offeringSubtitle(detail, seatKind)}</Text>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- 가격 내역

/** 계산 순서 안내 한 줄 — 서버가 준 줄 종류에서 만든다(예매 수수료 줄이 있으면 그 칸이 끼어든다) */
function orderHint(lines: readonly PriceLine[], isEvent: boolean): string {
  if (isEvent) {
    const hasFee = lines.some((line) => line.kind === 'booking_fee');
    return `결제액 계산 순서 · 참가비${hasFee ? ' → 예매 수수료' : ''} → 최종`;
  }
  return '결제액 계산 순서 · 정가 → 혜택 → 쿠폰 → 최종';
}

/**
 * 한 줄의 금액 글자. 할인 0원은 「미적용」(보드 M9), 할인은 「−」, 예매 수수료는 「+」를 붙인다.
 * 숫자 자체는 서버 값 그대로다.
 */
function lineAmountText(line: PriceLine): string {
  const isDiscount = line.kind === 'benefit_discount' || line.kind === 'coupon_discount';
  if (isDiscount) {
    return line.amount > 0 ? `−${formatWon(line.amount)}` : '미적용';
  }
  if (line.kind === 'booking_fee') {
    return `+${formatWon(line.amount)}`;
  }
  return formatWon(line.amount);
}

export interface CheckoutPriceCardProps {
  lines: readonly PriceLine[] | undefined;
  isEvent: boolean;
}

/**
 * 가격 내역 카드(FR-117(체크아웃 가격 내역) · FR-283(결제액 계산 순서)).
 * 정가 → 혜택 할인 → 쿠폰 → (예매 수수료) → 최종 결제액. 이벤트형은 0원 할인 줄을 접는다(보드 M9E — 이벤트형엔 할인 칸이 없다).
 */
export function CheckoutPriceCard({ lines, isEvent }: CheckoutPriceCardProps) {
  const ordered = orderPriceLines(lines);
  if (ordered.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.muted}>가격 내역을 받지 못했어요. 결제를 열 수 없어요.</Text>
      </View>
    );
  }
  // 이벤트형은 혜택·쿠폰이 없다 — 0원 할인 줄을 보이면 「받을 수 있는 할인」처럼 읽혀 접는다
  const shown = isEvent
    ? ordered.filter((line) => !((line.kind === 'benefit_discount' || line.kind === 'coupon_discount') && line.amount === 0))
    : ordered;
  return (
    <View style={styles.card}>
      <Text style={styles.hint}>{orderHint(ordered, isEvent)}</Text>
      {shown.map((line) => (
        <PriceRow key={line.kind} line={line} isEvent={isEvent} />
      ))}
    </View>
  );
}

function PriceRow({ line, isEvent }: { line: PriceLine; isEvent: boolean }) {
  if (line.kind === 'final') {
    return (
      <View style={[styles.priceRow, styles.finalRow]} accessible accessibilityLabel={`최종 결제액 ${formatWon(line.amount)}`}>
        <Text style={styles.finalLabel}>최종 결제액</Text>
        <Text style={styles.finalAmount}>{formatWon(line.amount)}</Text>
      </View>
    );
  }
  const label = isEvent && line.kind === 'list_price' ? '참가비' : line.label;
  const isFee = line.kind === 'booking_fee';
  const isCoupon = line.kind === 'coupon_discount';
  const amountText = lineAmountText(line);
  return (
    <View accessible accessibilityLabel={`${label} ${amountText}`}>
      <View style={styles.priceRow}>
        <View style={styles.priceLabelWrap}>
          <Text style={isFee ? styles.accentLabel : styles.priceLabel}>{label}</Text>
          {isCoupon && <Text style={styles.chip}>할인 큰 쪽 하나만</Text>}
        </View>
        <Text style={amountText === '미적용' ? styles.muted : isFee ? styles.accentAmount : styles.priceAmount}>{amountText}</Text>
      </View>
      {isFee && <Text style={styles.muted}>취소해도 돌려드리지 않아요</Text>}
    </View>
  );
}

// ---------------------------------------------------------------- 멤버십 안내(M9N)

/**
 * 「3개월 멤버십으로 결제하면 1+1 바로 적용」(보드 M9N, FR-120(멤버십 1+1 쿠폰)). 멤버십이 없는 회원에게만 보인다.
 * 금액은 설정값(membership.ts). 멤버십 가입 화면(M18)은 S6-1.9 몫이라 아직 「보기 ›」로 넘어갈 곳이 없다.
 */
export function MembershipBanner({ membership }: { membership: CheckoutMembership }) {
  if (membership.state !== 'never_joined') {
    return null;
  }
  return (
    <View style={styles.membership} accessible accessibilityLabel="멤버십 안내">
      <View style={styles.membershipText}>
        <Text style={styles.membershipTitle}>3개월 멤버십으로 결제하면 1+1 바로 적용</Text>
        <Text style={styles.muted}>3개월 {formatWon(membership.threeMonthPrice)} · 결제할 때마다 쿠폰 1장</Text>
      </View>
      <Text style={styles.soon}>곧 열려요</Text>
    </View>
  );
}

// ---------------------------------------------------------------- 환불 마감 띠(M9E)

/**
 * 이벤트형 환불 마감 안내(FR-099d(환불 마감일 필수 입력·결제 적용)). 보드 M9E 는 날짜를 띠에 적지만
 * 수업 상세 응답(계약 02 §2)에 환불 마감일 칸이 아직 없어 날짜는 환불 공지로 안내한다 — 날짜를 지어내지 않는다.
 */
export function RefundDeadlineBand() {
  return (
    <View style={styles.band} accessible>
      <Text style={styles.bandText}>환불 마감일까지 취소할 수 있어요 · 그 뒤에는 환불되지 않아요</Text>
      <Text style={styles.muted}>마감일은 아래 「환불 규칙」에서 확인해요</Text>
    </View>
  );
}

// ---------------------------------------------------------------- 결제수단

export interface MethodListProps {
  methods: readonly PaymentMethod[];
  selected: PaymentMethod;
  isEvent: boolean;
  onSelect: (method: PaymentMethod) => void;
}

/**
 * 결제수단 목록 — 라디오 한 줄씩(보드 M9 「즉시 확정」·「입금 확인 뒤 확정」). 목록과 순서는 checkout.ts 의 표.
 * 이벤트형은 두 줄만 보이고 「카드와 간편결제는 받지 않아요」를 적는다(보드 M9E, FR-111a(카드 허용 범위)).
 */
export function MethodList({ methods, selected, isEvent, onSelect }: MethodListProps) {
  return (
    <View style={styles.methods} accessibilityRole="radiogroup">
      <Text style={styles.hint}>{isEvent ? '결제수단 · 행사는 계좌이체로만 결제해요' : '결제수단 · 모두 PG 를 거쳐요'}</Text>
      {methods.map((method) => {
        const on = method === selected;
        return (
          <Pressable
            key={method}
            style={[styles.methodRow, on && styles.methodRowOn]}
            onPress={() => onSelect(method)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${METHOD_TEXT[method].name}, ${METHOD_TEXT[method].when}`}
          >
            <View style={[styles.radioOuter, on && styles.radioOuterOn]}>{on && <View style={styles.radioInner} />}</View>
            <Text style={[styles.methodName, on && styles.methodNameOn]}>{METHOD_TEXT[method].name}</Text>
            <Text style={styles.muted}>{METHOD_TEXT[method].when}</Text>
          </Pressable>
        );
      })}
      {isEvent && <Text style={styles.muted}>카드와 간편결제는 받지 않아요. 환불은 입력하신 환불 계좌로 보내 드려요.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  poster: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: colors.brown },
  summaryText: { flex: 1, gap: 2 },
  summaryTitle: { fontSize: 16, fontWeight: '700', color: colors.ink },
  muted: { fontSize: font.small, color: colors.ink3 },
  hint: { fontSize: font.small - 1, color: colors.ink3 },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm },
  priceLabelWrap: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexShrink: 1 },
  priceLabel: { fontSize: font.body, color: colors.ink },
  priceAmount: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  accentLabel: { fontSize: font.body, color: colors.brown, fontWeight: '600' },
  accentAmount: { fontSize: font.body, fontWeight: '700', color: colors.brown },
  chip: {
    fontSize: font.tiny,
    color: colors.brown,
    backgroundColor: colors.brownSoft,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  finalRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingTop: space.md, marginTop: space.xs },
  finalLabel: { fontSize: 16, fontWeight: '800', color: colors.ink },
  finalAmount: { fontSize: font.num, fontWeight: '800', color: colors.ink },
  membership: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.info,
    padding: space.lg,
  },
  membershipText: { flex: 1, gap: 2 },
  membershipTitle: { fontSize: font.body, fontWeight: '700', color: colors.info },
  soon: { fontSize: font.tiny, color: colors.ink3 },
  band: { backgroundColor: colors.brownSoft, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: space.md, gap: 2 },
  bandText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  methods: { gap: space.sm },
  methodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: MIN_TOUCH + 4,
    paddingHorizontal: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  methodRowOn: { borderColor: colors.brown, borderWidth: 1.5 },
  radioOuter: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  radioOuterOn: { borderColor: colors.brown },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.brown },
  methodName: { flex: 1, fontSize: font.body, color: colors.ink },
  methodNameOn: { fontWeight: '700' },
});
