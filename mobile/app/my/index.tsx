/**
 * 마이 탭 첫 화면(보드 M12) — S7-1.8(앱 알림 설정·권한 화면). 주소는 `/my`.
 *
 * 맨 위 프로필 카드(닉네임 + 관심 장르·경험·지역), 그 아래 세 묶음 카드다.
 *  ① 멤버십·혜택 — 멤버십 · 쿠폰함 · 대학생 인증 · 구독한 학원
 *  ② 내 활동 — 내 예약·결제 내역 · 자녀 관리 · 레벨 카드 · 관심 장르·지역·시간대 · 알림 설정
 *  ③ 도움 — 고객센터·문의 · 약관·개인정보 처리방침
 * 맨 아래에 앱 버전과 로그아웃.
 *
 * 줄 순서·글자는 보드를 그대로 따르고, 아직 화면이 없는 줄은 「준비 중」으로 눌리지 않게 둔다 —
 * 줄을 빼면 화면이 생길 때마다 위치가 바뀌어 회원이 다시 익혀야 해서다(하단 탭의 「준비 중」과 같은 원칙).
 * 지금 연결된 줄: 내 예약·결제 내역(M16) · 레벨 카드(M26, S6-3.8) · 관심 장르·지역·시간대(취향 입력) · 알림 설정(C1A) · 고객센터·문의(M22, S7-2.8).
 *
 * 프로필 카드 오른쪽 「체험 D-41」 꼬리표는 멤버십 상태 API(`GET /api/me/membership`, 계약 14)가 아직 없어 그리지 않는다.
 * 숫자를 지어 넣지 않는다.
 */
import Constants from 'expo-constants';
import { router, Stack, type Href } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ErrorView, LoadingView } from '../../lib/catalog/ui';
import { MemberTabBar } from '../../lib/catalog/tab-bar';
import { useApiResource } from '../../lib/catalog/use-api-resource';
import { preferenceSummary, profileSubtitle } from '../../lib/me/my-page';
import type { Member } from '../../lib/onboarding/types';
import { clearSessionToken } from '../../lib/session';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';

/** 마이 화면 한 줄. href 가 null 이면 아직 화면이 없어 「준비 중」으로 보인다. */
interface MenuRow {
  key: string;
  title: string;
  body?: string;
  /** 오른쪽 글자 — 「가입하기」처럼 할 일을 적는 줄만 */
  action?: string;
  href: Href | null;
}

export default function MyScreen() {
  const insets = useSafeAreaInsets();
  const { state, reload } = useApiResource<Member>('/api/me');

  /** 로그아웃 — 저장한 토큰을 지우고 로그인 화면으로 간다. 뒤로 가기로 마이에 돌아오지 못하게 replace. */
  const logout = async () => {
    await clearSessionToken();
    router.replace('/login');
  };

  const content = (() => {
    if (state.status === 'loading') return <LoadingView />;
    if (state.status === 'error') return <ErrorView error={state.error} onRetry={reload} />;
    const member = state.data;
    // 렌더 중에 바로 만든다 — 회원 정보가 바뀌면 다음 렌더에서 글자도 따라 바뀐다
    const benefits: readonly MenuRow[] = [
      { key: 'membership', title: '멤버십', body: 'AI 검색·대기 신청·학원 구독', action: '가입하기', href: null },
      { key: 'coupons', title: '쿠폰함', body: '1+1 쿠폰 · 동반자 쿠폰', href: null },
      { key: 'student', title: '대학생 인증', body: '학교 이메일(.ac.kr) · 첫 결제 1회 50%', action: '인증하기', href: null },
      { key: 'academies', title: '구독한 학원', body: '소리·무음·알림 끔 설정', href: null },
    ];
    const activity: readonly MenuRow[] = [
      { key: 'orders', title: '내 예약 · 결제 내역', href: '/my/orders' },
      { key: 'children', title: '자녀 관리', body: '만 19세 미만 자녀를 등록하고 대신 신청해요', href: null },
      { key: 'level', title: '레벨 카드', body: '받은 레벨 카드를 모아 봐요', href: '/my/level-cards' },
      { key: 'prefs', title: '관심 장르 · 지역 · 시간대', body: preferenceSummary(member), href: '/preferences' },
      { key: 'notify', title: '알림 설정', href: '/my/notification-settings' },
    ];
    const help: readonly MenuRow[] = [
      { key: 'support', title: '고객센터 · 문의', body: '학원 대표 · 운영자에게 묻고 답을 받아요', href: '/my/inquiries' },
      { key: 'terms', title: '약관 · 개인정보 처리방침', href: null },
    ];
    return (
      <>
        <View style={styles.profile} accessible accessibilityLabel={`${member.nickname}. ${profileSubtitle(member)}`}>
          <View style={styles.avatar} />
          <View style={styles.profileText}>
            <Text style={styles.name}>{member.nickname}</Text>
            <Text style={styles.muted} numberOfLines={2}>
              {profileSubtitle(member)}
            </Text>
          </View>
        </View>
        <MenuCard rows={benefits} />
        <MenuCard rows={activity} />
        <MenuCard rows={help} />
        <View style={styles.footer}>
          <View style={styles.footerLeft}>
            <Text style={styles.muted}>버전 {Constants.expoConfig?.version ?? '-'}</Text>
            <Text style={styles.muted}> · </Text>
            <Pressable onPress={logout} accessibilityRole="button" accessibilityLabel="로그아웃" hitSlop={12}>
              <Text style={styles.muted}>로그아웃</Text>
            </Pressable>
          </View>
        </View>
      </>
    );
  })();

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <Text style={[styles.title, { paddingTop: insets.top + space.lg }]} accessibilityRole="header">
        마이
      </Text>
      <ScrollView contentContainerStyle={styles.body}>{content}</ScrollView>
      <MemberTabBar active="my" />
    </View>
  );
}

/** 줄 묶음 카드. 줄 사이에 가는 선을 긋는다. */
function MenuCard({ rows }: { rows: readonly MenuRow[] }) {
  return (
    <View style={styles.card}>
      {rows.map((row, index) => (
        <MenuItem key={row.key} row={row} first={index === 0} />
      ))}
    </View>
  );
}

function MenuItem({ row, first }: { row: MenuRow; first: boolean }) {
  const ready = row.href !== null;
  const open = () => {
    if (row.href !== null) router.push(row.href);
  };
  // 오른쪽 글자: 화면이 없으면 「준비 중」, 할 일이 있으면 그 글자 + ›, 아니면 › 만
  const side = !ready ? '준비 중' : row.action !== undefined ? `${row.action} ›` : '›';
  return (
    <Pressable
      style={[styles.row, !first && styles.rowLine]}
      onPress={open}
      disabled={!ready}
      accessibilityRole="button"
      accessibilityLabel={ready ? row.title : `${row.title}, 준비 중`}
      accessibilityState={{ disabled: !ready }}
    >
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, !ready && styles.rowTitleOff]}>{row.title}</Text>
        {row.body !== undefined && row.body.length > 0 && <Text style={styles.muted}>{row.body}</Text>}
      </View>
      <Text style={[styles.side, !ready && styles.sideOff]}>{side}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  title: { fontSize: 22, fontWeight: '800', color: colors.ink, paddingHorizontal: space.lg, paddingBottom: space.sm },
  body: { padding: space.lg, gap: space.md },
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  // 회원 사진은 받지 않는다(가입 단계에 사진 칸이 없다) — 자리만 둔다
  avatar: { width: 48, height: 48, borderRadius: radius.md, backgroundColor: '#DCD4CA' },
  profileText: { flex: 1, gap: 4 },
  name: { fontSize: 17, fontWeight: '800', color: colors.ink },
  muted: { fontSize: font.small, color: colors.ink3 },
  card: {
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.lg,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: MIN_TOUCH + 8, paddingVertical: space.md },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, fontWeight: '700', color: colors.ink },
  rowTitleOff: { color: colors.disabledInk },
  side: { fontSize: font.small, fontWeight: '700', color: colors.ink },
  sideOff: { fontWeight: '400', color: colors.disabledInk },
  footer: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: space.xs, paddingBottom: space.lg },
  footerLeft: { flexDirection: 'row', alignItems: 'center' },
});
