/**
 * 대표 앱 「주문 · 결제」(보드 O45) — S3-5.9c(대표 앱 현장 등록·주문 화면). 주소 `/owner/orders`.
 *
 * 대표가 휴대폰에서 우리 학원 주문을 찾는다(FR-079a(대표 주문·결제 목록), 관리자 웹 W10 과 같은 경로·규칙).
 *  1. 내가 대표인 학원을 고른다(`GET /api/staff/me`)
 *  2. 검색어(닉네임·수업명, 숫자 4자리면 연락처 뒷 4자리)와 칩(전체·결제 완료·입금 대기·환불)으로 목록을 부른다
 *     (`GET /api/academies/{id}/orders`, 계약 18 §2-1). 검색은 「찾기」 단추·키보드 완료를 누를 때 보낸다
 *  3. 줄을 누르면 그 주문의 결제·환불 이력을 불러 펼친다(`GET …/orders/{orderId}`, §2-2) — 누를 때 부른다
 *  4. 더 있으면 맨 아래 「더 보기」로 다음 쪽을 이어 붙인다
 *
 * 회원은 닉네임만 보인다(FR-019a). 카드·계좌 번호는 서버가 아예 내리지 않는다(FR-299).
 * 환불 처리는 환불 슬라이스(M4)의 화면 몫이라 여기서는 「환불 요청」 표시와 안내까지만 한다.
 *
 * 효과 훅을 새로 쓰지 않는다. 첫 목록은 공용 `useApiResource`(주소가 바뀌면 다시 읽음), 펼침·더 보기는 버튼 핸들러에서 부른다.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { apiFetch } from '../../lib/api';
import { toApiError, useApiResource } from '../../lib/catalog/use-api-resource';
import { EmptyView, ErrorView, InlineError, LoadingView, SecondaryButton } from '../../lib/catalog/ui';
import {
  ORDER_CHIPS,
  orderClassLine,
  orderStatusLine,
  ownerOrderDetailPath,
  ownerOrdersPath,
  timelineRow,
  won,
  type OrderChip,
  type OrderTone,
  type OwnerOrder,
  type OwnerOrderDetail,
  type OwnerOrderList,
} from '../../lib/owner/orders-view';
import { OwnerScreen } from '../../lib/owner/owner-screen';
import { pickOwnerAcademy, type StaffMe } from '../../lib/owner/terms-api';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';

export default function OwnerOrdersScreen() {
  const me = useApiResource<StaffMe>('/api/staff/me');
  const academy = me.state.status === 'ready' ? pickOwnerAcademy(me.state.data) : null;
  const [chip, setChip] = useState<OrderChip>('all');
  // 입력 중 글자와 실제로 찾은 글자를 나눈다 — 한 글자마다 서버를 부르지 않게
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  // 화면을 연 시각 하나로 기간(오늘 ~ 1년 전)을 고정한다 — 렌더마다 주소가 바뀌어 다시 읽는 일을 막는다
  const [openedAt] = useState(() => new Date());
  const path = academy === null ? null : ownerOrdersPath(academy.academyId, chip, query, openedAt);
  const list = useApiResource<OwnerOrderList>(path);

  let body;
  if (me.state.status === 'loading') {
    body = <LoadingView label="내 학원을 확인하고 있어요" />;
  } else if (me.state.status === 'error') {
    body = <ErrorView error={me.state.error} onRetry={me.reload} />;
  } else if (academy === null) {
    // 위임 강사는 주문 목록을 볼 수 없다(계약 §1-1 — 돈 이야기는 대표만)
    body = <EmptyView title="주문·결제는 학원 대표만 볼 수 있어요" hint="입점 승인이 끝난 학원의 대표 계정으로 열어 주세요." />;
  } else if (list.state.status === 'error') {
    body = <ErrorView error={list.state.error} onRetry={list.reload} />;
  } else if (list.state.status === 'loading') {
    body = <LoadingView label="주문을 찾고 있어요" />;
  } else {
    // 첫 쪽이 바뀌면(칩·검색어) 펼침·이어 붙인 쪽을 처음부터 — key 로 새로 시작한다
    body = <OrderList key={path ?? ''} academyId={academy.academyId} first={list.state.data} chip={chip} query={query} openedAt={openedAt} />;
  }

  return (
    <OwnerScreen title="주문 · 결제">
      <View style={styles.searchRow}>
        <TextInput
          style={styles.search}
          value={typed}
          onChangeText={setTyped}
          onSubmitEditing={() => setQuery(typed)}
          placeholder="이름·수업으로 검색"
          placeholderTextColor={colors.ink3}
          returnKeyType="search"
          accessibilityLabel="이름·수업으로 검색"
        />
        <Pressable style={styles.searchButton} onPress={() => setQuery(typed)} accessibilityRole="button" accessibilityLabel="찾기">
          <Text style={styles.searchButtonText}>찾기</Text>
        </Pressable>
      </View>
      <View style={styles.chips}>
        {ORDER_CHIPS.map((c) => {
          const on = c.key === chip;
          return (
            <Pressable
              key={c.key}
              style={[styles.chip, on && styles.chipOn]}
              onPress={() => setChip(c.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{c.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {body}
    </OwnerScreen>
  );
}

interface OrderListProps {
  academyId: string;
  first: OwnerOrderList;
  chip: OrderChip;
  query: string;
  openedAt: Date;
}

/** 목록 + 펼친 이력 + 더 보기. 펼친 주문의 이력은 처음 누를 때 한 번만 부르고 기억해 둔다 */
function OrderList({ academyId, first, chip, query, openedAt }: OrderListProps) {
  const [more, setMore] = useState<OwnerOrder[]>([]);
  const [cursor, setCursor] = useState<string | null>(first.nextCursor);
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Readonly<Record<string, OwnerOrderDetail>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const orders = [...first.items, ...more];

  // 줄 누름 — 열려 있으면 접고, 처음 여는 주문이면 이력을 부른다
  async function toggle(orderId: string) {
    setError(null);
    if (openId === orderId) {
      setOpenId(null);
      return;
    }
    setOpenId(orderId);
    if (details[orderId] !== undefined) return;
    try {
      const detail = await apiFetch<OwnerOrderDetail>(ownerOrderDetailPath(academyId, orderId));
      setDetails((prev) => ({ ...prev, [orderId]: detail }));
    } catch (e: unknown) {
      setError(toApiError(e).detail);
    }
  }

  // 더 보기 — 다음 쪽을 이어 붙인다
  async function loadMore() {
    if (cursor === null) return;
    setBusy(true);
    setError(null);
    try {
      const page = await apiFetch<OwnerOrderList>(ownerOrdersPath(academyId, chip, query, openedAt, cursor));
      setMore((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e: unknown) {
      setError(toApiError(e).detail);
    }
    setBusy(false);
  }

  if (orders.length === 0) {
    return <EmptyView title="찾는 주문이 없어요" hint="검색어나 칩을 바꿔 보세요. 최근 1년 주문에서 찾아요." />;
  }

  return (
    <View>
      {orders.map((order) => (
        <OrderRow
          key={order.orderId}
          order={order}
          open={openId === order.orderId}
          detail={details[order.orderId] ?? null}
          onPress={() => void toggle(order.orderId)}
        />
      ))}
      <InlineError message={error} />
      {cursor !== null && <SecondaryButton label={busy ? '불러오고 있어요' : '더 보기'} onPress={() => void loadMore()} disabled={busy} />}
      <Text style={styles.footnote}>줄을 누르면 결제·환불 이력이 펼쳐져요. 환불은 「환불 요청」에서 처리해요.</Text>
    </View>
  );
}

const TONE_STYLE: Readonly<Record<OrderTone, object>> = {
  accent: { color: colors.brown },
  danger: { color: colors.danger },
  muted: { color: colors.ink3 },
};

interface OrderRowProps {
  order: OwnerOrder;
  open: boolean;
  detail: OwnerOrderDetail | null;
  onPress: () => void;
}

/** 주문 한 줄 — 왼쪽 닉네임·수업, 오른쪽 금액·수단·상태. 열려 있으면 아래에 이력 상자 */
function OrderRow({ order, open, detail, onPress }: OrderRowProps) {
  const status = orderStatusLine(order);
  return (
    <View style={styles.rowWrap}>
      <Pressable
        style={styles.row}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${order.member.nickname} ${orderClassLine(order)} ${won(order.amount)} ${status.text}`}
        testID={`order-row-${order.member.nickname}`}
      >
        <View style={styles.flex}>
          <Text style={styles.name}>{order.member.nickname}</Text>
          <Text style={styles.muted} numberOfLines={1}>
            {orderClassLine(order)}
          </Text>
        </View>
        <View style={styles.right}>
          <Text style={styles.amount}>{won(order.amount)}</Text>
          <Text style={[styles.status, TONE_STYLE[status.tone]]}>{status.text}</Text>
        </View>
      </Pressable>
      {open && (
        <View style={styles.history} testID="order-history">
          <Text style={styles.historyTitle}>결제 · 환불 이력</Text>
          {detail === null ? (
            <Text style={styles.muted}>불러오고 있어요</Text>
          ) : (
            detail.timeline.map((item, index) => {
              const line = timelineRow(item);
              return (
                <View key={`${item.kind}-${index}`} style={styles.historyRow}>
                  <Text style={styles.historyDate}>{line.date}</Text>
                  <Text style={styles.historyLabel}>{line.label}</Text>
                  <Text style={styles.historyRight}>{line.right}</Text>
                </View>
              );
            })
          )}
          {detail !== null && detail.refundedAmount > 0 && (
            <Text style={styles.muted}>{`환불된 금액 ${won(detail.refundedAmount)}`}</Text>
          )}
          {order.refundRequest !== null && <Text style={styles.refundNote}>환불 요청 처리 화면은 준비 중이에요 · 관리자 웹에서 처리해요</Text>}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  searchRow: { flexDirection: 'row', gap: space.sm },
  search: {
    flex: 1,
    minHeight: MIN_TOUCH - 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    paddingHorizontal: space.md,
    fontSize: font.body,
    color: colors.ink,
  },
  searchButton: {
    minWidth: MIN_TOUCH + 8,
    borderRadius: radius.md,
    backgroundColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchButtonText: { color: colors.surface, fontWeight: '700', fontSize: font.body },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.surface },
  chipOn: { backgroundColor: colors.brown },
  chipText: { color: colors.ink, fontSize: font.small, fontWeight: '600' },
  chipTextOn: { color: colors.surface },
  rowWrap: { borderBottomWidth: 1, borderBottomColor: colors.line, paddingVertical: space.md, gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, minHeight: MIN_TOUCH },
  flex: { flex: 1, gap: 2 },
  right: { alignItems: 'flex-end', gap: 2 },
  name: { fontSize: 16, fontWeight: '700', color: colors.ink },
  muted: { color: colors.ink3, fontSize: font.small },
  amount: { fontSize: 16, fontWeight: '700', color: colors.ink },
  status: { fontSize: font.small, fontWeight: '600' },
  history: {
    backgroundColor: colors.brownSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.md,
    gap: space.sm,
  },
  historyTitle: { fontSize: font.small, fontWeight: '700', color: colors.ink },
  historyRow: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  historyDate: { width: 72, color: colors.ink3, fontSize: font.small },
  historyLabel: { flex: 1, color: colors.ink, fontSize: font.small },
  historyRight: { color: colors.ink, fontSize: font.small },
  refundNote: { color: colors.brown, fontSize: font.small, fontWeight: '600', textAlign: 'right' },
  footnote: { color: colors.ink3, fontSize: font.small, marginTop: space.md },
});
