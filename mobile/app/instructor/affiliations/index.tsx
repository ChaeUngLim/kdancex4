/**
 * 강사 「내 소속 신청」(보드 I27B) — S2-1.10. 주소 `/instructor/affiliations`.
 * 학원 탭(I12) 칩 줄의 「내 소속 신청」과 대표의 승인·거절 알림(링크 `/instructor/affiliations`)에서 들어온다.
 *
 * 학원마다 가장 최근 소속 신청 하나를 카드로 보인다(`GET /api/instructor/affiliations`, 08 §2).
 *  - 승인 대기 → 신청 날짜 + 「신청 취소」(`POST …/{id}/withdraw`). 취소하면 목록을 다시 읽는다
 *  - 거절됨   → 신청·거절 날짜 + 대표가 고른 사유(4종 목록, 「기타」면 대표가 쓴 한 줄) + 「다시 신청하기」(→ I27, 그 학원이 골라진 채로)
 *  - 승인됨   → 승인 날짜 + 수업 등록 권한 있음/없음(`GET /api/staff/me` 의 class_submit) + 「학원 탭에서 보기 ›」
 * 철회·해제된 신청은 지난 일이라 카드로 보이지 않는다(다시 신청은 I27 검색에서 할 수 있다).
 *
 * 카드 순서는 보드대로 승인 대기 → 거절됨 → 승인됨이다. 손이 가야 하는 카드(취소·다시 신청)를 위에 둔다.
 * 효과 훅 없음: 읽기는 `useApiResource`, 취소는 버튼 핸들러 안에서 하고 끝나면 `reload()` 를 부른다.
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useApiResource } from '../../../lib/catalog/use-api-resource';
import { LoadingView } from '../../../lib/catalog/ui';
import { kstMonthDayWeekday, rejectReasonLabel, withdrawAffiliation } from '../../../lib/instructor/affiliation-api';
import { canSubmitClass, type AffiliationCard, type StaffMe } from '../../../lib/instructor/staff-api';
import { goBack, InstructorShell, StaffErrorView, staffStyles, useAction } from '../../../lib/instructor/staff-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../../../lib/theme';

/** 보이는 상태와 그 순서. 이 셋 밖(철회·해제)은 카드로 그리지 않는다 */
const CARD_ORDER = ['pending', 'rejected', 'active'] as const;

/** 렌더 중 계산 — 상태별로 묶어 보드 순서대로 이어 붙인다. 같은 상태 안에서는 서버 순서(최근 신청이 위)를 지킨다 */
function orderedCards(items: readonly AffiliationCard[]): AffiliationCard[] {
  return CARD_ORDER.flatMap((status) => items.filter((item) => item.status === status));
}

export default function InstructorMyAffiliationsScreen() {
  const cards = useApiResource<{ items: AffiliationCard[] }>('/api/instructor/affiliations');
  const me = useApiResource<StaffMe>('/api/staff/me');
  const withdraw = useAction();
  // 지금 취소 중인 카드 — 그 카드의 버튼만 「취소하고 있어요…」로 바꾼다
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);

  const handleWithdraw = async (affiliationId: string) => {
    setWithdrawingId(affiliationId);
    const done = await withdraw.run(() => withdrawAffiliation(affiliationId));
    setWithdrawingId(null);
    if (done !== null) cards.reload();
  };

  let body;
  if (cards.state.status === 'loading') {
    body = <LoadingView label="소속 신청을 불러오고 있어요" />;
  } else if (cards.state.status === 'error') {
    body = <StaffErrorView error={cards.state.error} onRetry={cards.reload} />;
  } else {
    const list = orderedCards(cards.state.data.items);
    const staffMe = me.state.status === 'ready' ? me.state.data : null;
    body =
      list.length === 0 ? (
        <View style={staffStyles.card}>
          <Text style={staffStyles.sectionTitle}>아직 소속 신청이 없어요</Text>
          <Text style={staffStyles.muted}>학원을 찾아 신청하면 대표가 확인한 뒤 결과를 알려 드려요.</Text>
          <Pressable style={styles.secondary} onPress={() => router.push('/instructor/affiliations/apply')} accessibilityRole="button">
            <Text style={styles.secondaryText}>학원 찾아 소속 신청</Text>
          </Pressable>
        </View>
      ) : (
        list.map((card) => (
          <AffiliationCardView
            key={card.affiliationId}
            card={card}
            me={staffMe}
            withdrawing={withdrawingId === card.affiliationId}
            onWithdraw={() => handleWithdraw(card.affiliationId)}
          />
        ))
      );
  }

  return (
    <InstructorShell title="내 소속 신청" active="academy" onBack={() => goBack('/instructor/academy')}>
      {withdraw.error !== null && (
        <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">
          {withdraw.error}
        </Text>
      )}
      {body}
      <View style={styles.reasonBlock}>
        <Text style={styles.reasonHead}>거절 사유는 대표가 목록에서 골라요</Text>
        <Text style={staffStyles.muted}>
          지금은 강사를 모집하지 않아요 · 학원 장르와 맞지 않아요 · 정보가 더 필요해요 · 기타(대표가 한 줄로 적어요)
        </Text>
      </View>
      <Text style={staffStyles.muted}>거절돼도 다시 신청할 수 있어요. 소속은 학원마다 따로 승인돼요.</Text>
    </InstructorShell>
  );
}

interface CardProps {
  card: AffiliationCard;
  /** 수업 등록 권한을 보려고 읽는 내 정보. 아직 못 읽었으면 null — 권한 줄을 빼고 그린다 */
  me: StaffMe | null;
  withdrawing: boolean;
  onWithdraw: () => void;
}

function AffiliationCardView({ card, me, withdrawing, onWithdraw }: CardProps) {
  const requested = `${kstMonthDayWeekday(card.requestedAt)} 신청`;
  const decided = card.decidedAt !== null ? kstMonthDayWeekday(card.decidedAt) : '';

  if (card.status === 'pending') {
    return (
      <View style={staffStyles.card}>
        <CardHead name={card.academyName} badge="승인 대기" tone="pending" />
        <Text style={staffStyles.muted}>{`${requested} · 대표가 확인하면 알려 드려요`}</Text>
        <Pressable
          style={[styles.outline, withdrawing && styles.outlineBusy]}
          onPress={onWithdraw}
          disabled={withdrawing}
          accessibilityRole="button"
          accessibilityLabel={`${card.academyName} 신청 취소`}
          accessibilityState={{ disabled: withdrawing, busy: withdrawing }}
        >
          <Text style={styles.outlineText}>{withdrawing ? '취소하고 있어요…' : '신청 취소'}</Text>
        </Pressable>
      </View>
    );
  }

  if (card.status === 'rejected') {
    return (
      <View style={staffStyles.card}>
        <CardHead name={card.academyName} badge="거절됨" tone="rejected" />
        <Text style={staffStyles.muted}>{`${requested} · ${decided} 거절`}</Text>
        <View style={styles.reasonBox}>
          <Text style={staffStyles.muted}>대표가 고른 사유</Text>
          <Text style={styles.reasonText}>{rejectReasonLabel(card.rejectReasonCode, card.rejectReasonText)}</Text>
        </View>
        <Pressable
          style={styles.primary}
          // 그 학원이 검색·선택된 채로 I27 을 연다
          onPress={() =>
            router.push({ pathname: '/instructor/affiliations/apply', params: { q: card.academyName, academyId: card.academyId } })
          }
          accessibilityRole="button"
          accessibilityLabel={`${card.academyName} 다시 신청하기`}
        >
          <Text style={styles.primaryText}>다시 신청하기</Text>
        </Pressable>
      </View>
    );
  }

  // 승인됨(active)
  const permission = canSubmitClass(card) ? '수업 등록 권한 있음' : '수업 등록 권한 없음';
  return (
    <View style={staffStyles.card}>
      <CardHead name={card.academyName} badge="승인됨" tone="active" />
      <Text style={staffStyles.muted}>{permission !== null ? `${decided} 승인 · ${permission}` : `${decided} 승인`}</Text>
      <Pressable
        style={styles.link}
        onPress={() => router.replace('/instructor/academy')}
        accessibilityRole="link"
        accessibilityLabel={`${card.academyName} 학원 탭에서 보기`}
      >
        <Text style={styles.linkText}>학원 탭에서 보기 ›</Text>
      </Pressable>
    </View>
  );
}

/** 카드 머리 — 학원 이름 + 오른쪽 상태 배지(글자로도 상태를 말한다, 색만으로 구분하지 않는다) */
function CardHead({ name, badge, tone }: { name: string; badge: string; tone: 'pending' | 'rejected' | 'active' }) {
  return (
    <View style={styles.head}>
      <Text style={styles.name}>{name}</Text>
      <Text style={[styles.badge, tone === 'pending' && styles.badgePending, tone === 'rejected' && styles.badgeRejected, tone === 'active' && styles.badgeActive]}>
        {badge}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { flex: 1, color: colors.ink, fontSize: 16, fontWeight: '800' },
  badge: {
    paddingHorizontal: space.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    fontSize: font.small,
    fontWeight: '700',
    overflow: 'hidden',
  },
  badgePending: { backgroundColor: colors.brownSoft, color: colors.brown },
  badgeRejected: { backgroundColor: colors.dangerSoft, color: colors.danger },
  badgeActive: { backgroundColor: colors.okSoft, color: colors.ok },
  outline: {
    alignSelf: 'flex-start',
    minHeight: MIN_TOUCH - 8,
    paddingHorizontal: space.xl,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    justifyContent: 'center',
    marginTop: space.xs,
  },
  outlineBusy: { backgroundColor: colors.disabled },
  outlineText: { color: colors.ink, fontWeight: '700' },
  reasonBox: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg,
    padding: space.md,
    gap: 2,
  },
  reasonText: { color: colors.ink, fontSize: font.body, fontWeight: '800' },
  primary: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    backgroundColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.xs,
  },
  primaryText: { color: colors.surface, fontSize: 15, fontWeight: '700' },
  secondary: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { color: colors.brown, fontWeight: '700' },
  link: { minHeight: MIN_TOUCH - 12, justifyContent: 'center', alignSelf: 'flex-start' },
  linkText: { color: colors.brown, fontSize: font.small, fontWeight: '800' },
  reasonBlock: { gap: space.xs, marginTop: space.sm },
  reasonHead: { color: colors.ink3, fontSize: font.small, fontWeight: '800' },
  error: { color: colors.danger, fontSize: font.body, lineHeight: 20 },
});
