/**
 * 수업 상세 — 자리 고르기와 결제 시작(보드 M8, `02-catalog.md` §2 · `03-checkout-payment.md` §1).
 *
 * 화면이 지키는 규칙
 *  - 기본 자리: 서버가 정한 `defaultSeatKind`(AC-7(성별 자리 기본값)). 그 자리가 마감이어도
 *    기본 선택을 바꾸지 않고 「마감」 표시 + 결제 버튼을 끈다. 반대 자리가 남았으면 회원이 직접 바꾼다
 *  - 「결제하기」는 결제 화면(보드 M9·M9E, `app/pay/[offeringId].tsx`)으로 고른 자리를 넘긴다.
 *    결제수단 고르기·동의·주문 시작은 그 화면이 한다(S3-3.16(앱 결제 화면)).
 *    학원 공지가 없거나(`refundNotice: null`) 가격 내역이 없거나 자리가 마감이면 버튼이 닫혀 있다
 *  - 정원은 좌석 칸으로 보인다(보드 M8 남·여 두 덩어리 / C13A 단일 정원 한 줄 + 「남녀 구분 없음」 칩)
 *  - 판매자 정보(상호·대표자·사업자번호 등 6항목)와 중개자 고지를 결제 버튼 위에 늘 펼쳐 둔다
 *    (S3-2.4(판매자 정보·결제 전 정책), FR-248(사업자 정보 표시)·FR-241(결제 전 정책 표시)) — 접어 두면 결제 전에 못 보고 지나친다
 *  - 가격 내역 미리 보기(`priceBreakdownPreview`)는 서버 값 그대로 보인다(S3-3.15b). 없으면(옛 서버) 정가 한 줄만 보이고 버튼은 닫혀 있다
 */
import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatKstDateTime, formatKstTime, formatWon, seatLabel } from '../../lib/catalog/format';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';
import type { OfferingDetail, PriceLine, SeatKind } from '../../lib/catalog/types';
import { SellerCard } from '../../lib/catalog/seller-card';
import { NoGenderChip, SeatGrid } from '../../lib/catalog/seat-grid';
import {
  Card,
  DetailScreen,
  ErrorView,
  LoadingView,
  NoticeBox,
  PriceBreakdown,
  PrimaryButton,
  SectionTitle,
  shared,
} from '../../lib/catalog/ui';
import { readRouteId, useApiResource } from '../../lib/catalog/use-api-resource';

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
      {state.status === 'ready' && <OfferingBody detail={state.data} />}
    </DetailScreen>
  );
}

function OfferingBody({ detail }: { detail: OfferingDetail }) {
  return (
    <>
      <OfferingSummaryCard detail={detail} />
      <CapacityCard detail={detail} />
      <SessionsCard detail={detail} />
      <CheckoutForm detail={detail} />
    </>
  );
}

function OfferingSummaryCard({ detail }: { detail: OfferingDetail }) {
  return (
    <Card>
      <Text style={shared.title}>{detail.title}</Text>
      <Text style={shared.muted}>
        {detail.academy?.name} · 강사 {detail.instructorName} · {weeklyTimeText(detail)}
      </Text>
      {/* 강사 프로필(M15) 입구 — 거기서 「이 강사 수업 물어보기」로 AI 플래너를 연다(SX-5.7) */}
      {detail.instructorId ? (
        <Pressable
          onPress={() => router.push(`/instructors/${detail.instructorId}`)}
          accessibilityRole="link"
          style={styles.instructorLink}
        >
          <Text style={styles.instructorLinkText}>{detail.instructorName} 강사 프로필 보기 ›</Text>
        </Pressable>
      ) : null}
      <View style={styles.priceRow}>
        <Text style={shared.muted}>수강료 · {detail.label}</Text>
        <Text style={styles.price}>{formatWon(detail.priceAmount)}</Text>
      </View>
    </Card>
  );
}

/** 월요일부터 세는 요일 순서 — 요약에 요일을 「월·목」처럼 주 순서대로 늘어놓을 때 쓴다 */
const WEEK_ORDER = ['월', '화', '수', '목', '금', '토', '일'] as const;

/**
 * 「월·목 19:00–20:00」 — 모든 회차의 요일을 모아 주 순서로, 시각은 첫 회차 것.
 * 예전에는 첫 회차 요일 하나만 써서 월·목 수업이 「목」으로만 보였다(2026-11-25 시연 중 발견).
 * 회차 목록은 아래 카드에 따로 있다.
 */
function weeklyTimeText(detail: OfferingDetail): string {
  const sessions = detail.sessions ?? [];
  const first = sessions[0];
  if (first === undefined) {
    return '일정 미정';
  }
  const dayOf = (iso: string) => formatKstDateTime(iso).match(/\((.)\)/)?.[1] ?? '';
  const days = new Set(sessions.map((session) => dayOf(session.startsAt)));
  const dayText = WEEK_ORDER.filter((day) => days.has(day)).join('·');
  return `${dayText} ${formatKstTime(first.startsAt)}–${formatKstTime(first.endsAt)}`;
}

/**
 * 정원 카드(FR-090(정원·신청 인원 표시)). 신청 인원은 확정 수만 센 값이다(결제 대기는 안 셈, S3-2.3).
 * 단일 정원이면 「남녀 구분 없음」 칩과 「성별과 상관없이 먼저 신청한 순서로 자리가 차요」를 단다(보드 C13A).
 */
function CapacityCard({ detail }: { detail: OfferingDetail }) {
  const single = detail.seatMode === 'single';
  return (
    <Card>
      <View style={styles.capacityHead}>
        <SectionTitle>정원 {detail.capacity?.total ?? 0}명</SectionTitle>
        {single && <NoGenderChip />}
      </View>
      <SeatGrid pools={detail.capacity?.pools ?? []} size="large" />
      <Text style={shared.muted}>
        {single ? '성별과 상관없이 먼저 신청한 순서로 자리가 차요' : '신청 인원은 결제가 끝난 자리만 세요'}
      </Text>
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

/**
 * 결제 화면으로 넘어가기 전 상태 — 고른 자리와 버튼이 열리는 조건.
 * 결제수단·동의·주문 시작은 결제 화면(M9)이 맡는다. 여기서는 「어느 자리로 결제하러 가나」만 정한다.
 */
function CheckoutForm({ detail }: { detail: OfferingDetail }) {
  const [chosenSeat, setChosenSeat] = useState<SeatKind | null>(null);
  const seatKind = chosenSeat ?? detail.seatSelection?.defaultSeatKind ?? 'any';
  const seatAvailable = detail.seatSelection?.options?.find((option) => option.seatKind === seatKind)?.available === true;
  // 가격 내역 미리 보기·환불 공지가 없으면 결제 화면도 금액을 못 그린다 — 넘어가지 않는다
  const hasPreview = (detail.priceBreakdownPreview?.length ?? 0) > 0;
  const alreadyReserved = detail.myReservation !== null && detail.myReservation !== undefined;
  const canGo = hasPreview && detail.refundNotice !== null && seatAvailable && !alreadyReserved;
  const finalAmount = detail.priceBreakdownPreview?.find((line) => line.kind === 'final')?.amount ?? detail.priceAmount;
  const seatName = seatKind === 'any' ? '자리 1개' : `${seatLabel(seatKind)} 자리`;
  const payLabel = !seatAvailable ? `${seatName} 마감` : `${seatName} 결제하기 · ${formatWon(finalAmount)}`;
  // 미리 보기가 없을 때 보이는 정가 한 줄(가격 내역 첫 줄과 같은 모양)
  const listPriceOnly: readonly PriceLine[] = [{ kind: 'list_price', label: '수강료', amount: detail.priceAmount }];
  const goPay = () =>
    router.push(`/pay/${encodeURIComponent(detail.offeringId)}?seat=${encodeURIComponent(seatKind)}`);
  return (
    <>
      <SeatPicker detail={detail} selected={seatKind} onSelect={setChosenSeat} />
      <Card>
        <SectionTitle>가격 내역</SectionTitle>
        <PriceBreakdown lines={hasPreview ? detail.priceBreakdownPreview : listPriceOnly} />
        {!hasPreview && <Text style={shared.muted}>쿠폰·혜택 할인은 결제 단계에서 계산돼요.</Text>}
      </Card>
      <NoticeBox title="환불·취소 공지">
        {detail.refundNotice?.body ?? '학원이 환불 공지를 아직 등록하지 않아 지금은 결제할 수 없어요.'}
      </NoticeBox>
      <NoticeBox title="통신판매중개자 고지">{detail.intermediaryNotice?.body ?? '-'}</NoticeBox>
      <SellerCard seller={detail.seller} />
      {alreadyReserved && <Text style={shared.muted}>이미 신청한 수업이에요. 캘린더에서 확인해 주세요.</Text>}
      {!hasPreview && <Text style={shared.muted}>결제는 곧 열려요. 지금은 수업 정보만 볼 수 있어요.</Text>}
      <PrimaryButton label={payLabel} onPress={goPay} disabled={!canGo} />
    </>
  );
}

interface SeatPickerProps {
  detail: OfferingDetail;
  selected: SeatKind;
  onSelect: (seat: SeatKind) => void;
}

/**
 * 자리 고르기. 단일 정원(`single`)이면 고를 것이 없어 「자리 1개 · 남녀 구분 없음」 한 줄만 보인다(보드 C13A,
 * FR-092c(성별 구분 없는 단일 정원)). 남녀 정원이면 남·여 칩 — 기본은 본인확인 성별 자리다.
 */
function SeatPicker({ detail, selected, onSelect }: SeatPickerProps) {
  const options = detail.seatSelection?.options ?? [];
  if (detail.seatMode === 'single' || options.length <= 1) {
    const soldOut = options[0]?.available === false;
    return (
      <Card>
        <SectionTitle>신청 자리</SectionTitle>
        <View style={styles.singleSeat} accessible accessibilityLabel="자리 1개, 남녀 구분 없음">
          <View style={styles.radioOuter}>
            <View style={styles.radioInner} />
          </View>
          <View style={styles.singleSeatText}>
            <Text style={styles.singleSeatTitle}>{soldOut ? '자리 1개 · 마감' : '자리 1개 · 남녀 구분 없음'}</Text>
            <Text style={shared.muted}>이 수업은 남·여 자리를 고르지 않아요</Text>
          </View>
        </View>
      </Card>
    );
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
  instructorLink: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  instructorLinkText: { fontSize: font.small, color: colors.brown, fontWeight: '700' },
  price: { fontSize: font.num - 4, fontWeight: '800', color: colors.ink },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  capacityHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  singleSeat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.brown,
    backgroundColor: colors.brownSoft,
  },
  singleSeatText: { flex: 1, gap: 2 },
  singleSeatTitle: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  radioOuter: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.brown, alignItems: 'center', justifyContent: 'center' },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.brown },
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
