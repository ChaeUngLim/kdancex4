/**
 * 강사 「학원」 탭(보드 I12) — S2-1.7(앱 강사 가입·소속·프로필 화면). 주소 `/instructor/academy`.
 *
 * 강사가 소속된 학원을 칩으로 고르고, 고른 학원의 카드·시간표·내 수업·공지를 본다.
 * 대표의 학원 관리와 다르다 — 회원·권한·정산은 여기 없다(instructor-app.md).
 *
 * 부르는 API(모두 이미 있는 경로)
 *  1. `GET /api/staff/me`                    내 이름과 학원별 위임 권한 → 「수업 등록 권한 있음/없음」
 *  2. `GET /api/instructor/affiliations`     학원별 소속 상태 → 칩(소속됨·승인 대기만)
 *  3. `GET /api/instructor/staff-notices?academyId=…&limit=2`  고른 학원의 공지 최신 2건(소속됨일 때만)
 *
 * 흐름은 렌더 중 계산으로 정한다(효과 훅 없음): 고른 학원 = 내가 누른 칩, 아직 안 눌렀으면 첫 소속 학원.
 * 고른 학원이 바뀌면 3번 주소가 바뀌고, `useApiResource` 가 새 주소를 읽는다.
 *
 * 아직 원천이 없는 칸은 숫자·가짜 값을 채우지 않고 「준비 중」과 「무엇이 열리면 보이는지」만 보인다.
 *  - 전체 시간표·이 학원에서 내 수업: 수업·회차(class_sessions)와 담당 강사 칸은 S2-2 가 만든다
 *  - 학원 주소·홀: 강사가 학원 정보를 읽는 경로(학원 검색 API)는 S2-1.9
 *  - 「+ 소속 신청」(I27)·「내 소속 신청」(I27B)·「학원 색 바꾸기」(I9E)는 S2-1.10 이 붙였다. 「소속 해제」(I28)는 S2-3.8 이 붙였다. 「전체 보기」(I39)는 공지 화면 Task
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useApiResource } from '../../lib/catalog/use-api-resource';
import { LoadingView } from '../../lib/catalog/ui';
import {
  academyChips,
  canSubmitClass,
  initialOf,
  noticeCategoryLabel,
  shortKstDate,
  type AffiliationCard,
  type InstructorNotice,
  type StaffMe,
} from '../../lib/instructor/staff-api';
import { InstructorShell, StaffErrorView, staffStyles } from '../../lib/instructor/staff-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';

/** 공지는 최신 2건만 보이고 나머지는 「전체 보기」(I39)로 넘긴다(보드 I12) */
const NOTICE_PREVIEW = 2;

function noticesPath(academyId: string): string {
  return `/api/instructor/staff-notices?academyId=${encodeURIComponent(academyId)}&limit=${NOTICE_PREVIEW}`;
}

export default function InstructorAcademyScreen() {
  const me = useApiResource<StaffMe>('/api/staff/me');
  const cards = useApiResource<{ items: AffiliationCard[] }>('/api/instructor/affiliations');
  const [pickedId, setPickedId] = useState<string | null>(null);

  // 렌더 중에 바로 계산: 칩 목록 → 고른 학원(누른 칩이 목록에 없으면 첫 칩)
  const chips = cards.state.status === 'ready' ? academyChips(cards.state.data.items) : [];
  const selected = chips.find((c) => c.academyId === pickedId) ?? chips[0] ?? null;
  // 소속됨인 학원만 공지를 읽는다(승인 대기 학원의 공지는 서버도 주지 않는다 — 09 §3)
  const notices = useApiResource<{ items: InstructorNotice[] }>(
    selected !== null && selected.status === 'active' ? noticesPath(selected.academyId) : null,
  );

  let body;
  if (me.state.status === 'error') {
    body = <StaffErrorView error={me.state.error} onRetry={me.reload} />;
  } else if (cards.state.status === 'error') {
    body = <StaffErrorView error={cards.state.error} onRetry={cards.reload} />;
  } else if (me.state.status === 'loading' || cards.state.status === 'loading') {
    body = <LoadingView label="소속 학원을 불러오고 있어요" />;
  } else if (selected === null) {
    body = <NoAcademy />;
  } else {
    body = (
      <AcademyBody
        me={me.state.data}
        chips={chips}
        selected={selected}
        onPick={setPickedId}
        notices={notices.state}
        onRetryNotices={notices.reload}
      />
    );
  }

  const staffName = me.state.status === 'ready' ? me.state.data.displayName : null;
  return (
    <InstructorShell
      title="학원"
      subtitle="소속 학원의 시간표·내 수업·공지를 봐요."
      active="academy"
      top={<TopBar academyName={selected?.academyName ?? null} staffName={staffName} />}
    >
      {body}
    </InstructorShell>
  );
}

/** 맨 위 머리 — 학원 첫 글자 동그라미 · 학원 이름 · 「이준호 강사」 · 알림(보드 I12) */
function TopBar({ academyName, staffName }: { academyName: string | null; staffName: string | null }) {
  return (
    <View style={styles.topBar}>
      <View style={styles.logo}>
        <Text style={styles.logoText}>{initialOf(academyName ?? '학원')}</Text>
      </View>
      <View style={styles.flex}>
        <Text style={styles.topAcademy} numberOfLines={1}>
          {academyName ?? '소속 학원 없음'}
        </Text>
        {staffName !== null && <Text style={styles.topStaff}>{`${staffName} 강사`}</Text>}
      </View>
      {/* 강사 알림함(I21)은 다른 Task — 자리만 */}
      <Text style={styles.bell} accessibilityLabel="알림, 준비 중">
        알림
      </Text>
    </View>
  );
}

interface AcademyBodyProps {
  me: StaffMe;
  chips: AffiliationCard[];
  selected: AffiliationCard;
  onPick: (academyId: string) => void;
  notices: ReturnType<typeof useApiResource<{ items: InstructorNotice[] }>>['state'];
  onRetryNotices: () => void;
}

function AcademyBody({ me, chips, selected, onPick, notices, onRetryNotices }: AcademyBodyProps) {
  const active = selected.status === 'active';
  return (
    <View style={styles.stack}>
      {/* 소속 학원 칩 + 「+ 소속 신청」 */}
      <View style={styles.chipRow} accessibilityRole="radiogroup">
        {chips.map((chip) => {
          const on = chip.academyId === selected.academyId;
          return (
            <Pressable
              key={chip.affiliationId}
              style={[styles.chip, on && styles.chipOn]}
              onPress={() => onPick(chip.academyId)}
              accessibilityRole="radio"
              accessibilityLabel={chip.status === 'pending' ? `${chip.academyName}, 승인 대기` : chip.academyName}
              accessibilityState={{ checked: on }}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>
                {chip.status === 'pending' ? `${chip.academyName} · 승인 대기` : chip.academyName}
              </Text>
            </Pressable>
          );
        })}
        {/* 소속 신청(I27)·내 소속 신청(I27B) 입구 — S2-1.10 */}
        <Pressable
          style={[styles.chip, styles.chipDashed]}
          onPress={() => router.push('/instructor/affiliations/apply')}
          accessibilityRole="button"
          accessibilityLabel="소속 신청"
        >
          <Text style={styles.chipText}>+ 소속 신청</Text>
        </Pressable>
        <Pressable
          style={[styles.chip, styles.chipDashed]}
          onPress={() => router.push('/instructor/affiliations')}
          accessibilityRole="button"
          accessibilityLabel="내 소속 신청"
        >
          <Text style={styles.chipText}>내 소속 신청</Text>
        </Pressable>
      </View>

      {/* 학원 카드 */}
      <View style={staffStyles.card}>
        <Text style={styles.cardTitle}>{selected.academyName}</Text>
        <View style={styles.badgeRow}>
          <Text style={active ? styles.okBadge : staffStyles.badge}>{active ? '소속 승인됨' : '승인 대기'}</Text>
          {active && (
            <Text style={staffStyles.badge}>
              {canSubmitClass(selected) ? '수업 등록 권한 있음' : '수업 등록 권한 없음'}
            </Text>
          )}
        </View>
        {!active && <Text style={staffStyles.muted}>대표가 승인하면 이 학원의 시간표와 공지가 열려요.</Text>}
        {/* 학원 색(I9E, S2-1.10) — 소속됨 학원만 고를 수 있다(승인 대기는 서버도 409) */}
        {active && (
          <Pressable
            style={styles.colorRow}
            onPress={() => router.push('/instructor/academy-colors')}
            accessibilityRole="button"
            accessibilityLabel="학원 색 바꾸기"
          >
            <Text style={styles.colorLabel}>학원 색</Text>
            <Text style={styles.colorMore}>바꾸기 ›</Text>
          </Pressable>
        )}
      </View>

      {active && (
        <>
          <PendingSection
            title={`${selected.academyName} · 전체 시간표`}
            note="이 학원에 수업이 등록되면 요일·시간별 시간표가 여기에 보여요."
          />
          <PendingSection title="이 학원에서 내 수업" note="내가 연 수업이 승인되면 여기에 모여요. 수업 등록은 수업 탭에서 해요." />
          <NoticeSection state={notices} onRetry={onRetryNotices} />
          {/* 소속 해제(I28) — S2-3.8 이 화면을 붙였다 */}
          <Pressable
            style={styles.releaseRow}
            onPress={() => router.push(`/instructor/affiliations/${encodeURIComponent(selected.affiliationId)}/release`)}
            accessibilityRole="button"
            accessibilityLabel="소속 해제"
          >
            <View style={styles.flex}>
              <Text style={styles.releaseTitle}>소속 해제</Text>
              <Text style={staffStyles.muted}>이 학원의 이후 수업이 있으면 대체 강사·휴강·폐강을 먼저 정해요.</Text>
            </View>
            <Text style={styles.releaseChevron}>›</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

/** 원천 데이터가 아직 없는 구역 — 빈 표·0 대신 「준비 중」 */
function PendingSection({ title, note }: { title: string; note: string }) {
  return (
    <View style={staffStyles.card} accessible accessibilityLabel={`${title}, 준비 중. ${note}`}>
      <View style={styles.sectionHead}>
        <Text style={[staffStyles.sectionTitle, styles.flex]}>{title}</Text>
        <Text style={staffStyles.pendingBadge}>준비 중</Text>
      </View>
      <Text style={staffStyles.muted}>{note}</Text>
    </View>
  );
}

function NoticeSection({ state, onRetry }: { state: AcademyBodyProps['notices']; onRetry: () => void }) {
  let content;
  if (state.status === 'loading') {
    content = <Text style={staffStyles.muted}>공지를 불러오고 있어요</Text>;
  } else if (state.status === 'error') {
    content = <StaffErrorView error={state.error} onRetry={onRetry} />;
  } else if (state.data.items.length === 0) {
    content = <Text style={staffStyles.muted}>아직 이 학원에서 받은 공지가 없어요.</Text>;
  } else {
    content = state.data.items.map((notice, index) => (
      <View key={notice.noticeId} style={[styles.noticeRow, index > 0 && styles.divider]}>
        <Text style={staffStyles.badge}>{noticeCategoryLabel(notice.category)}</Text>
        <View style={styles.flex}>
          <Text style={[styles.noticeTitle, notice.readAt === null && styles.noticeUnread]} numberOfLines={2}>
            {notice.title}
          </Text>
          <Text style={staffStyles.muted}>{`${shortKstDate(notice.publishedAt)} · 대표`}</Text>
        </View>
      </View>
    ));
  }
  return (
    <View style={staffStyles.card}>
      <View style={styles.sectionHead}>
        <Text style={[staffStyles.sectionTitle, styles.flex]}>학원 공지</Text>
        <Text style={styles.moreDisabled} accessibilityLabel="공지 전체 보기, 준비 중">
          전체 보기 · 준비 중
        </Text>
      </View>
      {content}
    </View>
  );
}

function NoAcademy() {
  return (
    <View style={staffStyles.card}>
      <Text style={staffStyles.sectionTitle}>아직 소속 학원이 없어요</Text>
      <Text style={staffStyles.muted}>
        학원 대표가 보낸 초대 링크를 열거나, 학원을 찾아 소속을 신청하면 여기에 학원이 생겨요. 대표가 승인하면 시간표와 공지가 열려요.
      </Text>
      <Pressable style={styles.noAcademyButton} onPress={() => router.push('/instructor/affiliations/apply')} accessibilityRole="button">
        <Text style={styles.noAcademyButtonText}>학원 찾아 소속 신청</Text>
      </Pressable>
      <Pressable style={styles.link} onPress={() => router.push('/instructor/affiliations')} accessibilityRole="link">
        <Text style={styles.colorMore}>내 소속 신청 보기 ›</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  stack: { gap: space.md },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  logo: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { color: colors.surface, fontWeight: '800', fontSize: font.body },
  topAcademy: { color: colors.ink, fontSize: font.body, fontWeight: '700' },
  topStaff: { color: colors.ink3, fontSize: font.small },
  bell: { fontSize: font.small, color: colors.disabledInk },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: colors.brown, borderColor: colors.brown },
  chipText: { color: colors.ink, fontSize: font.body },
  chipTextOn: { color: colors.surface, fontWeight: '700' },
  chipDashed: { borderStyle: 'dashed', backgroundColor: colors.bg },
  cardTitle: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  okBadge: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.okSoft,
    color: colors.ok,
    fontSize: font.tiny,
    fontWeight: '700',
    overflow: 'hidden',
  },
  colorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: MIN_TOUCH,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    marginTop: space.xs,
  },
  colorLabel: { flex: 1, color: colors.ink, fontSize: font.body },
  colorMore: { color: colors.brown, fontSize: font.small, fontWeight: '800' },
  noAcademyButton: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    backgroundColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.sm,
  },
  noAcademyButtonText: { color: colors.surface, fontWeight: '700' },
  link: { minHeight: MIN_TOUCH - 12, justifyContent: 'center', alignSelf: 'flex-start' },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  moreDisabled: { color: colors.disabledInk, fontSize: font.small },
  noticeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingVertical: space.sm },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  noticeTitle: { color: colors.ink, fontSize: font.body },
  noticeUnread: { fontWeight: '700' },
  releaseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: MIN_TOUCH,
  },
  releaseTitle: { color: colors.ink, fontSize: font.body, fontWeight: '700' },
  releaseChevron: { color: colors.ink3, fontSize: font.h2 },
});
