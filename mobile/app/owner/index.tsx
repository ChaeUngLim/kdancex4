/**
 * 대표 앱 「홈」(보드 O6) — S1-4.9(대표 앱 홈 화면 O6). 주소 `/owner`.
 *
 * 관리자 웹 대시보드(W29, S1-4.8)와 같은 API·같은 글자 규칙을 휴대폰 화면으로 옮겼다.
 *  1. 내가 대표인 학원을 고른다(`GET /api/staff/me`)
 *  2. 그 학원 대시보드를 부른다(`GET /api/academies/{id}/dashboard`, 계약 10 §1)
 *  3. 위에서부터 보드 O6 순서로 그린다 — 학원 이름·대표 표시 → 해야 할 일 → 승인 대기 수업 →
 *     오늘 우리 학원 수업 → 작은 숫자 타일(이번 달 매출·환불 요청 등)
 *
 * 숫자 글자는 lib/owner/dashboard-view.ts 가 만들고, 이 화면은 받아 그리기만 한다.
 * 그래서 같은 응답이면 웹과 앱이 같은 숫자를 보인다. 아직 원천 표가 없는 타일(M1 에서는 7개 전부)은
 * 숫자 없이 「준비 중」과 「무엇이 열리면 보이는지」 한 줄만 보인다 — 0 으로 보이면 「진짜 0건」으로 읽히기 때문이다.
 *
 * 효과 훅을 새로 쓰지 않는다. 읽기는 기존 `useApiResource` 를 쓰고, 이동은 줄을 누를 때(onPress) 한다.
 *
 * S3-5.9c(대표 앱 현장 등록·주문 화면)에서 더한 것:
 *  - 「오늘 우리 학원 수업」 표 — 하루 인원표(`GET /api/academies/{id}/headcount`, 계약 18 §7)로 시간 · 수업·강사·홀 · 남 · 여 · 결석.
 *    남·여는 오늘 인원(확정 − 결석 예정 + 현장)이고, 강사 앱 I7 과 같은 함수에서 나온 숫자다
 *  - 바로 가기 두 줄 — 현장 등록(O40) · 주문·결제 찾기(O45)
 *  - 작은 타일 「신규 회원」(S3-5.6 이 대시보드에 더한 newMembers 칸)
 *
 * 범위 밖: 보드의 「임시 권한 · 설명회용」 띠·대표 앱 하단 5탭(대표 앱 틀을 정하는 Task 몫, 강사 관리 O37 과 같은 판단).
 */
import { router, Stack } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useApiResource } from '../../lib/catalog/use-api-resource';
import { EmptyView, ErrorView, LoadingView, SectionTitle } from '../../lib/catalog/ui';
import {
  dashboardDateLabel,
  dashboardPath,
  dashboardTileView,
  dashboardTodoNote,
  dashboardTodoRoute,
  type DashboardTileKey,
  type DashboardTodo,
  type OwnerDashboard,
  newMembersTileView,
  type TileView,
} from '../../lib/owner/dashboard-view';
import { ownerHeadcountPath, todayRows, todaySummaryLine, type OwnerHeadcount } from '../../lib/owner/headcount-view';
import { pickOwnerAcademy, type StaffMe } from '../../lib/owner/terms-api';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';

/** 아래쪽 작은 타일 순서 — 보드 O6 의 「이번 달 결제 · 환불 요청」을 앞에 두고, 웹에만 있던 나머지를 잇는다 */
const SMALL_TILES: readonly DashboardTileKey[] = ['month', 'refundRequests', 'todayOrders', 'nearlyFull', 'nextPayout'];

type TodayState = ReturnType<typeof useApiResource<OwnerHeadcount>>['state'];

export default function OwnerHomeScreen() {
  const insets = useSafeAreaInsets();
  const me = useApiResource<StaffMe>('/api/staff/me');
  const academy = me.state.status === 'ready' ? pickOwnerAcademy(me.state.data) : null;
  // 학원을 고른 뒤에만 대시보드를 부른다(null 이면 부르지 않는다)
  const dashboard = useApiResource<OwnerDashboard>(academy === null ? null : dashboardPath(academy.academyId));
  // 오늘 표는 하루 인원표에서 — 대시보드와 따로 불러, 표만 실패해도 나머지 숫자는 보인다
  const headcount = useApiResource<OwnerHeadcount>(academy === null ? null : ownerHeadcountPath(academy.academyId));

  let body;
  if (me.state.status === 'loading') {
    body = <LoadingView label="내 학원을 확인하고 있어요" />;
  } else if (me.state.status === 'error') {
    body = <ErrorView error={me.state.error} onRetry={me.reload} />;
  } else if (academy === null) {
    // 위임만 받은 강사·운영자 — 재무 대시보드는 위임 대상 밖이라(FR-081a) 숫자를 보이지 않는다
    body = <EmptyView title="홈 숫자는 학원 대표만 볼 수 있어요" hint="입점 승인이 끝난 학원의 대표 계정으로 열어 주세요." />;
  } else if (dashboard.state.status === 'error') {
    body = <ErrorView error={dashboard.state.error} onRetry={dashboard.reload} />;
  } else if (dashboard.state.status === 'loading') {
    body = <LoadingView label="오늘 우리 학원 현황을 불러오고 있어요" />;
  } else {
    body = <DashboardView dashboard={dashboard.state.data} today={headcount.state} onRetryToday={headcount.reload} />;
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* 제목 줄 — 홈이라 뒤로 가기 없이 학원 이름과 「대표」 표시만(보드 O6) */}
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
          {academy?.name ?? '대표 홈'}
        </Text>
        <Text style={styles.roleBadge}>대표</Text>
      </View>
      <ScrollView contentContainerStyle={styles.body}>{body}</ScrollView>
    </View>
  );
}

interface DashboardViewProps {
  dashboard: OwnerDashboard;
  today: TodayState;
  onRetryToday: () => void;
}

function DashboardView({ dashboard, today, onRetryToday }: DashboardViewProps) {
  const approvals = dashboardTileView(dashboard, 'pendingClassApprovals');
  const sessions = dashboardTileView(dashboard, 'sessions');
  return (
    <View style={styles.stack}>
      <Text style={styles.date}>{dashboardDateLabel(dashboard.date)}</Text>

      <SectionTitle>{`해야 할 일 ${dashboard.todos.length}건`}</SectionTitle>
      {dashboard.todos.length === 0 ? (
        <Text style={styles.muted}>지금 처리할 일이 없어요</Text>
      ) : (
        <View style={styles.card}>
          {dashboard.todos.map((todo, index) => (
            <TodoRow key={`${todo.kind}-${index}`} todo={todo} divided={index > 0} />
          ))}
        </View>
      )}

      {/* 보드 O6 의 큰 카드 두 장: 승인 대기 수업 · 오늘 우리 학원 수업 */}
      <TileCard tile={approvals} wide />
      <TodayCard today={today} onRetry={onRetryToday} tomorrow={sessions.ready ? dashboard.sessions.tomorrow.length : null} />

      {/* 휴대폰에서 바로 하는 일 세 가지(spec 「휴대폰에서 할 수 있는 일은 대표 앱에서도」) */}
      <View style={styles.card}>
        <LinkRow title="현장 등록" note="현장·전화로 받은 인원을 남·여로 넣어요" href="/owner/onsite" divided={false} />
        <LinkRow title="주문 · 결제" note="이름·수업으로 찾고 결제·환불 이력을 봐요" href="/owner/orders" divided />
        <LinkRow title="문의함" note="회원·강사 문의를 보고 바로 답해요" href="/owner/inquiries" divided />
      </View>

      <View style={styles.grid}>
        <TileCard tile={dashboardTileView(dashboard, 'month')} />
        <TileCard tile={dashboardTileView(dashboard, 'refundRequests')} />
        <TileCard tile={newMembersTileView(dashboard)} />
        {SMALL_TILES.filter((key) => key !== 'month' && key !== 'refundRequests').map((key) => (
          <TileCard key={key} tile={dashboardTileView(dashboard, key)} />
        ))}
      </View>

      <Text style={styles.muted}>등록·설정·환불 처리는 관리자 웹에서 해요. 숫자는 관리자 웹 대시보드와 같아요.</Text>
    </View>
  );
}

/**
 * 「오늘 우리 학원 수업」 표(보드 O6) — 시간 · 수업·강사·홀 · 남 · 여 · 결석.
 * 결석이 1명 이상이면 숫자를 강조색으로(보드). 표 아래에 합계와 내일 수업 수.
 */
function TodayCard({ today, onRetry, tomorrow }: { today: TodayState; onRetry: () => void; tomorrow: number | null }) {
  let content;
  if (today.status === 'loading') {
    content = <Text style={styles.muted}>오늘 수업을 불러오고 있어요</Text>;
  } else if (today.status === 'error') {
    content = <ErrorView error={today.error} onRetry={onRetry} />;
  } else if (today.data.items.length === 0) {
    content = <Text style={styles.muted}>오늘 우리 학원 수업이 없어요</Text>;
  } else {
    const rows = todayRows(today.data);
    content = (
      <>
        <View style={styles.tableHead}>
          <Text style={[styles.th, styles.colTime]}>시간</Text>
          <Text style={[styles.th, styles.colTitle]}>수업 · 강사 · 홀</Text>
          <Text style={[styles.th, styles.colNum]}>남</Text>
          <Text style={[styles.th, styles.colNum]}>여</Text>
          <Text style={[styles.th, styles.colNum]}>결석</Text>
        </View>
        {rows.map((row) => (
          <View key={row.key} style={styles.tableRow} accessible accessibilityLabel={`${row.time} ${row.title} ${row.sub} 남 ${row.male} 여 ${row.female} 결석 ${row.absence}`}>
            <Text style={[styles.td, styles.colTime]}>{row.time}</Text>
            <View style={styles.colTitle}>
              <Text style={styles.tdTitle}>{row.title}</Text>
              <Text style={styles.tdSub}>{row.sub}</Text>
            </View>
            <Text style={[styles.td, styles.colNum]}>{row.male}</Text>
            <Text style={[styles.td, styles.colNum]}>{row.female}</Text>
            <Text style={[styles.td, styles.colNum, row.absence > 0 && styles.absence]}>{row.absence}</Text>
          </View>
        ))}
        <Text style={styles.muted}>{todaySummaryLine(today.data)}</Text>
      </>
    );
  }
  return (
    <View style={[styles.tile, styles.tileWide]} testID="o6-today">
      <Text style={styles.cardTitle}>오늘 우리 학원 수업</Text>
      {content}
      {tomorrow !== null && <Text style={styles.muted}>{`내일 수업 ${tomorrow}개`}</Text>}
    </View>
  );
}

/** 바로 가기 한 줄 — 누르면 그 대표 앱 화면으로 */
function LinkRow({ title, note, href, divided }: { title: string; note: string; href: '/owner/onsite' | '/owner/orders' | '/owner/inquiries'; divided: boolean }) {
  return (
    <Pressable
      style={[styles.todoRow, divided && styles.divider]}
      onPress={() => router.push(href)}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <View style={styles.flex}>
        <Text style={styles.todoTitle}>{title}</Text>
        <Text style={styles.muted}>{note}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

/** 해야 할 일 한 줄 — 누르면 같은 일을 하는 대표 앱 화면(강사 관리·약관)으로 간다 */
function TodoRow({ todo, divided }: { todo: DashboardTodo; divided: boolean }) {
  return (
    <Pressable
      style={[styles.todoRow, divided && styles.divider]}
      onPress={() => router.push(dashboardTodoRoute(todo))}
      accessibilityRole="button"
      accessibilityLabel={todo.title}
    >
      <View style={styles.flex}>
        <Text style={styles.todoTitle}>{todo.title}</Text>
        <Text style={styles.muted}>{dashboardTodoNote(todo)}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

/**
 * 타일 하나. 준비된 타일은 큰 숫자 + 작은 설명, 준비 안 된 타일은 「준비 중」 배지 + 안내 한 줄.
 * 준비 안 된 타일에는 숫자 자리를 아예 그리지 않는다(빈 칸·0 대신).
 */
function TileCard({ tile, wide = false }: { tile: TileView; wide?: boolean }) {
  return (
    <View
      style={[styles.tile, wide ? styles.tileWide : styles.tileHalf]}
      accessible
      accessibilityLabel={tile.ready ? `${tile.title} ${tile.headline}` : `${tile.title} 준비 중. ${tile.pendingNote}`}
    >
      <Text style={styles.tileTitle}>{tile.title}</Text>
      {tile.ready ? (
        <>
          <Text style={styles.tileNumber}>{tile.headline}</Text>
          {tile.detail !== null && <Text style={styles.muted}>{tile.detail}</Text>}
        </>
      ) : (
        <>
          <Text style={styles.pendingBadge}>준비 중</Text>
          <Text style={styles.muted}>{tile.pendingNote}</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  headerTitle: { flexShrink: 1, fontSize: font.h2, fontWeight: '700', color: colors.ink },
  roleBadge: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.brownSoft,
    color: colors.brown,
    fontSize: font.small,
    fontWeight: '700',
  },
  body: { padding: space.lg, paddingTop: space.xs, paddingBottom: space.xl * 2 },
  stack: { gap: space.md },
  date: { color: colors.ink3, fontSize: font.small },
  muted: { color: colors.ink3, fontSize: font.small },
  flex: { flex: 1, gap: 2 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.lg,
  },
  todoRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: MIN_TOUCH, paddingVertical: space.md },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  todoTitle: { color: colors.ink, fontSize: font.body, fontWeight: '700' },
  chevron: { color: colors.ink3, fontSize: font.h2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  tile: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.md,
    gap: space.xs,
  },
  tileWide: { width: '100%' },
  // 두 칸씩 — 사이 간격(space.md)의 절반만큼 줄여 한 줄에 둘이 들어가게 한다
  tileHalf: { flexBasis: '47%', flexGrow: 1 },
  tileTitle: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  tileNumber: { color: colors.ink, fontSize: font.h2, fontWeight: '700' },
  cardTitle: { color: colors.ink, fontSize: font.body, fontWeight: '700' },
  tableHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingTop: space.xs },
  tableRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.xs },
  th: { color: colors.ink3, fontSize: font.tiny },
  td: { color: colors.ink, fontSize: font.body, fontWeight: '600' },
  tdTitle: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  tdSub: { color: colors.ink, fontSize: font.small },
  colTime: { width: 48 },
  colTitle: { flex: 1 },
  colNum: { width: 34, textAlign: 'center' },
  absence: { color: colors.brown, fontWeight: '800' },
  pendingBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.brownSoft,
    color: colors.brown,
    fontSize: font.tiny,
    fontWeight: '700',
  },
});
