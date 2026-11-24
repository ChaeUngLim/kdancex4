/**
 * 회차 상세 — 수업 관리(보드 I6B) — S2-3.8(앱 변경·대타·공지 화면) · 회원 관리 탭(보드 I23) — S3-5.9(앱 강사 명단 화면).
 * 주소 `/instructor/sessions/{sessionId}?classId=…&tab=members`(tab 을 빼면 수업 관리 탭).
 *
 * 회차 하나에서 할 일(공지 · 휴강 · 변경 · 대타)로 들어가는 입구다(instructor-app.md 「회차 상세 — 수업 관리」).
 * 이 Task 가 이어 주는 것은 「수강생 공지 보내기」(I13)와 「대타 요청」(I14 · 이미 요청했으면 I14B)이다.
 * 「오늘 결석자」(I26)는 S3-5.9b(앱 강사 결석 표시 화면)가 이어 붙였다(수업 관리 탭의 줄 + 회원 관리 탭 아래 줄).
 * 「시간·장소 변경」(I34) · 「휴강 알리기」(I25)는 화면을 맡은 Task 가 아직이라
 * 눌리지 않는 「준비 중」으로 둔다(숫자·가짜 화면을 채우지 않는다 — 학원 탭 I12 와 같은 방식).
 *
 * 「회원 관리」 탭(I23, S3-5.9)은 그 회차의 결제 완료 수강생 명단이다 — `GET …/sessions/{sessionId}/roster`(계약 18 §4).
 * 결석 예정이 맨 위, 결제 대기는 이름 없이 숫자만(Q20), 출석률 없이 「N개월째」만(D7).
 * 보드의 체크 상자와 「레벨 정하기」 시트는 S6-3.6(앱 강사 레벨·후보 화면)이 붙였다(아래 MembersTab 설명).
 *
 * 읽기: 수업 관리 탭 = 수업 상세 + 회차 목록(session-ui.tsx `useSessionContext`), 회원 관리 탭 = 명단 하나(머리 줄도 명단 응답으로).
 * 고른 탭은 useState — 주소의 tab 값은 첫 값으로만 쓴다. 효과 훅을 새로 쓰지 않는다.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { EmptyView, LoadingView } from '../../../../lib/catalog/ui';
import { readRouteId, useApiResource } from '../../../../lib/catalog/use-api-resource';
import {
  awaitingLine,
  memberSubLine,
  rosterPath,
  rosterSummaryLine,
  type RosterMember,
  type SessionRoster,
} from '../../../../lib/instructor/headcount-api';
import { absenceScreenHref } from '../../../../lib/instructor/absence-api';
import { capacityLine } from '../../../../lib/instructor/class-api';
import {
  applyLevelEvaluation,
  applyResultLine,
  INSTRUCTOR_MEMBERSHIP_REQUIRED,
  levelChipText,
  MEMBERSHIP_LOCK_TEXT,
  memberLevelsPath,
  type MemberLevelItem,
  type MemberLevels,
} from '../../../../lib/instructor/level-api';
import { LevelSheet } from '../../../../lib/instructor/level-sheet';
import { Button, LockNotice } from '../../../../lib/instructor/level-ui';
import { sessionWhen } from '../../../../lib/instructor/session-api';
import { SessionGate, useSessionContext } from '../../../../lib/instructor/session-ui';
import { goBack, InstructorShell, MenuGroup, MenuRow, StaffErrorView, staffStyles, useAction } from '../../../../lib/instructor/staff-ui';
import { colors, font, radius, space } from '../../../../lib/theme';

export default function SessionDetailScreen() {
  const params = useLocalSearchParams<{ sessionId?: string; classId?: string; tab?: string }>();
  // 고른 탭 — 수업 인원 한눈에(I7)에서 들어오면 주소에 tab=members 가 붙어 회원 관리 탭이 먼저 열린다
  const [tab, setTab] = useState<'manage' | 'members'>(params.tab === 'members' ? 'members' : 'manage');
  // 수업 상세·회차 목록은 「수업 관리」 탭에서만 읽는다. 강사는 남(대표)이 올린 수업의 등록 상세를 읽을 수 없어(Q45 —
  // 수업 상세 경로는 올린 사람만) 대표가 올리고 나를 담당으로 둔 수업이면 403 이 난다. 회원 관리 탭은 명단 경로(담당 강사 허용)만 쓴다.
  const state = useSessionContext(tab === 'manage' ? params.classId : undefined, tab === 'manage' ? params.sessionId : undefined);
  const tabs = (
    <View style={styles.tabs} accessibilityRole="tablist">
      <TabButton label="수업 관리" selected={tab === 'manage'} onPress={() => setTab('manage')} />
      <TabButton label="회원 관리" selected={tab === 'members'} onPress={() => setTab('members')} />
    </View>
  );

  return (
    <InstructorShell title="회차 상세" active="classes" onBack={() => goBack('/instructor/academy')}>
      {tab === 'members' ? (
        <MembersTab classId={readRouteId(params.classId)} sessionId={readRouteId(params.sessionId)} tabs={tabs} />
      ) : (
        <>
        {/* 수업 상세를 못 읽어도(403 등) 회원 관리 탭으로 넘어갈 수 있게 탭은 남긴다 */}
        {state.status === 'error' && tabs}
        <SessionGate state={state}>
          {({ cls, session }) => {
            // 렌더 중 계산: 머리 두 줄과 인원 줄(보드 I6B)
            const place = session.room === null ? cls.academyName : `${cls.academyName} ${session.room.name}`;
            const query = `?classId=${encodeURIComponent(cls.classId)}`;
            const base = `/instructor/sessions/${encodeURIComponent(session.sessionId)}`;
            const scheduled = session.status === 'scheduled';
            // 이미 대타를 요청한 회차면 새 요청(I14)이 아니라 진행 상황(I14B)을 연다 — 회차당 열린 요청은 하나다
            const substituteHref = session.substituteRequest === null ? `${base}/substitute${query}` : `${base}/substitute-status${query}`;
            return (
              <>
                <SessionHead title={cls.title} when={`${sessionWhen(session.startsAt, session.endsAt)} · ${place}`} />
                {tabs}
                <Text style={styles.count}>
                  {`정원 ${capacityLine(cls.capacity)} · 결제 ${session.confirmedMemberCount}명 · 수업 전 인원은 「회원 관리」에서`}
                </Text>

                {!scheduled && (
                  <View style={styles.closedBox}>
                    <Text style={styles.closedText}>휴강·폐강된 회차라 공지와 대타 요청을 할 수 없어요.</Text>
                  </View>
                )}

                <MenuGroup>
                  <MenuRow title="시간 · 장소 변경" detail="바뀌면 결제한 수강생 모두에게 알림" pending />
                  <MenuRow title="휴강 알리기" detail="이 회차만 쉬어요 · 수강생에게 알림" pending divided />
                  <MenuRow
                    title="수강생 공지 보내기"
                    detail="확정 수강생에게 앱 공지"
                    onPress={scheduled ? () => router.push(`${base}/announce${query}`) : undefined}
                    divided
                  />
                  {/* 오늘 결석자(I26, S3-5.9b) — 빠진 수강생 확인 · 결석 표시 · 이의 처리 */}
                  <MenuRow
                    title="오늘 결석자"
                    detail="오늘 수업에 빠진 수강생을 확인해요"
                    onPress={() => router.push(absenceScreenHref(cls.classId, session.sessionId))}
                    divided
                  />
                </MenuGroup>

                <MenuGroup>
                  <MenuRow
                    title="대타 요청"
                    detail={session.substituteRequest === null ? '이 회차를 대신 맡을 강사를 찾아요' : '보낸 요청의 진행 상황을 봐요'}
                    onPress={scheduled ? () => router.push(substituteHref) : undefined}
                  />
                </MenuGroup>
              </>
            );
          }}
        </SessionGate>
        </>
      )}
    </InstructorShell>
  );
}

/** 머리 두 줄 — 「쌈바(입문)」 / 「11/11 (수) 20:30–21:30 · 라틴하우스 강남 A홀」 */
function SessionHead({ title, when }: { title: string; when: string }) {
  return (
    <View style={styles.head}>
      <Text style={styles.classTitle}>{title}</Text>
      <Text style={styles.when}>{when}</Text>
    </View>
  );
}

function TabButton({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.tab, selected && styles.tabOn]}
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      // 웹(react-native-web)은 accessibilityState 를 aria 로 옮기지 않아 직접 준다
      aria-selected={selected}
    >
      <Text style={selected ? styles.tabTextOn : styles.tabTextOff}>{label}</Text>
    </Pressable>
  );
}

/**
 * 회원 관리 탭(보드 I23) — 그 회차의 결제 완료 수강생. 탭을 열었을 때만 명단을 읽는다(이 컴포넌트가 그려질 때 useApiResource 가 부른다).
 * 위: 「수업 전 인원 · 참석 17 (남 8 · 여 9) · 결석 예정 2」 + 결제 대기 숫자. 아래: 수강생 줄(닉네임 · 성별 · 연령대 · N개월째 · 결석 예정, 오른쪽 가린 연락처).
 *
 * S6-3.6(앱 강사 레벨·후보 화면)이 레벨 정하기를 붙였다(spec FR-169d(강사 레벨 등급 조절)):
 *  - 명단을 받은 뒤 그 판매 단위의 레벨 경로(`…/offerings/{offeringId}/member-levels`)를 읽어 줄마다 「Lv.5 초중급」 칩을 단다.
 *  - 줄 왼쪽 체크 상자로 수강생을 고르고 「선택한 n명 레벨 올리기」를 누르면 레벨 정하기 시트(level-sheet.tsx)가 열린다.
 *  - 강사 멤버십이 아니면 레벨 경로가 403 INSTRUCTOR_MEMBERSHIP_REQUIRED 다 → 버튼을 잠그고 「멤버십 강사만 쓸 수 있어요」.
 *    회원 체크 상자는 회원의 멤버십으로 잠그지 않는다(2026-11-24 개정 — 받는 회원은 멤버십 무관).
 *  - 고른 수강생 · 시트 열림 · 적용 결과 줄은 모두 useState. 서버 쓰기는 시트의 「최종 적용」 버튼에서만 한다.
 */
function MembersTab({ classId, sessionId, tabs }: { classId: string | null; sessionId: string | null; tabs: ReactNode }) {
  const ok = classId !== null && sessionId !== null;
  const roster = useApiResource<SessionRoster>(ok ? rosterPath(classId, sessionId) : null);
  // 레벨은 명단을 받은 뒤에만 읽는다(판매 단위 id 가 명단 응답에 있다)
  const offeringId = roster.state.status === 'ready' ? roster.state.data.offeringId : null;
  const levels = useApiResource<MemberLevels>(offeringId === null ? null : memberLevelsPath(offeringId));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  const apply = useAction();

  if (!ok) return <EmptyView title="회차 주소가 올바르지 않아요" />;
  if (roster.state.status === 'loading') return <LoadingView label="명단을 불러오고 있어요" />;
  if (roster.state.status === 'error') return <StaffErrorView error={roster.state.error} onRetry={roster.reload} />;
  const data = roster.state.data;
  const awaiting = awaitingLine(data.awaitingPayment);
  // 머리 줄은 명단 응답으로 그린다(명단에는 학원 이름이 없어 홀 이름만)
  const when = data.roomName === null ? sessionWhen(data.startsAt, data.endsAt) : `${sessionWhen(data.startsAt, data.endsAt)} · ${data.roomName}`;

  // 렌더 중 계산: 레벨 응답 상태 → 칩 표 · 잠김 여부 · 고른 사람의 레벨 줄
  const levelData = levels.state.status === 'ready' ? levels.state.data : null;
  const locked = levels.state.status === 'error' && levels.state.error.code === INSTRUCTOR_MEMBERSHIP_REQUIRED;
  const levelOf = new Map((levelData?.items ?? []).map((item) => [item.memberId, item]));
  const selected = selectedIds.flatMap((id) => {
    const item = levelOf.get(id);
    return item === undefined ? [] : [item];
  });
  const canRaise = levelData !== null && selected.length > 0;

  const toggle = (memberId: string) => {
    setApplied(null);
    setSelectedIds(selectedIds.includes(memberId) ? selectedIds.filter((id) => id !== memberId) : [...selectedIds, memberId]);
  };

  // 시트의 「최종 적용」 — 평가 레벨 저장 + (회원 레벨보다 높으면) 승급 안내. 끝나면 고른 것을 비우고 레벨을 다시 읽는다
  const onApply = async (level: number) => {
    if (levelData === null) return;
    const res = await apply.run(() =>
      applyLevelEvaluation({ offeringId: levelData.offeringId, detailGenre: levelData.detailGenre, memberIds: selected.map((m) => m.memberId), level }),
    );
    if (res === null) return;
    setSheetOpen(false);
    setSelectedIds([]);
    setApplied(applyResultLine(res));
    levels.reload();
  };

  return (
    <>
      <SessionHead title={data.title} when={when} />
      {tabs}
      <Text style={styles.count}>{rosterSummaryLine(data.seats)}</Text>
      {awaiting !== null && <Text style={staffStyles.muted}>{awaiting}</Text>}
      {data.members.length === 0 ? (
        <EmptyView title="아직 결제를 마친 수강생이 없어요" hint="결제가 끝나면 이 명단에 이름이 보여요." />
      ) : (
        <View style={staffStyles.card}>
          {data.members.map((member, index) => (
            <MemberRow
              key={member.memberId}
              member={member}
              level={levelOf.get(member.memberId) ?? null}
              checked={selectedIds.includes(member.memberId)}
              onToggle={() => toggle(member.memberId)}
              divided={index > 0}
            />
          ))}
        </View>
      )}

      {data.members.length > 0 && (
        <View style={styles.levelBar}>
          <Button
            // 글자의 n 은 체크한 사람 수 — 잠겨서 레벨을 못 읽었어도 몇 명을 골랐는지는 보인다
            label={selectedIds.length > 0 ? `선택한 ${selectedIds.length}명 레벨 올리기` : '수강생을 골라 레벨 올리기'}
            onPress={() => {
              apply.setError(null);
              setSheetOpen(true);
            }}
            disabled={locked || !canRaise}
          />
          {locked && (
            <LockNotice title={MEMBERSHIP_LOCK_TEXT}>
              <Text style={staffStyles.muted}>레벨 올리기는 강사 멤버십 기능이에요. 수강생 명단과 결석 확인은 그대로 쓸 수 있어요.</Text>
            </LockNotice>
          )}
          {levels.state.status === 'error' && !locked && <StaffErrorView error={levels.state.error} onRetry={levels.reload} />}
          {applied !== null && (
            <Text style={styles.applied} accessibilityLiveRegion="polite">
              {applied}
            </Text>
          )}
        </View>
      )}

      <Text style={staffStyles.muted}>연락처는 가운데를 가려 보여요. 결석은 레벨에만 쓰이고 출석률은 따로 두지 않아요.</Text>
      {/* 오늘 결석자(I26) 입구 — 대표가 올린 수업은 수업 관리 탭이 403 이라(Q45) 이 탭에도 둔다(S3-5.9b 추천안) */}
      <MenuGroup>
        <MenuRow
          title="오늘 결석자"
          detail="빠진 수강생 확인 · 결석 표시 · 이의 처리"
          onPress={() => router.push(absenceScreenHref(data.classId, data.sessionId))}
        />
      </MenuGroup>

      {sheetOpen && levelData !== null && (
        <LevelSheet
          selected={selected}
          detailGenre={levelData.detailGenre}
          busy={apply.busy}
          error={apply.error}
          onCancel={() => setSheetOpen(false)}
          onApply={(level) => void onApply(level)}
        />
      )}
    </>
  );
}

interface MemberRowProps {
  member: RosterMember;
  /** 레벨 경로에서 받은 그 수강생의 레벨(아직 못 받았거나 잠겼으면 null — 칩을 그리지 않는다) */
  level: MemberLevelItem | null;
  checked: boolean;
  onToggle: () => void;
  divided: boolean;
}

function MemberRow({ member, level, checked, onToggle, divided }: MemberRowProps) {
  const absent = member.absence !== null;
  return (
    <View style={[styles.memberRow, divided && styles.memberDivider]}>
      <Pressable
        style={[styles.check, checked && styles.checkOn]}
        onPress={onToggle}
        accessibilityRole="checkbox"
        accessibilityLabel={`${member.nickname} 고르기`}
        accessibilityState={{ checked }}
        aria-checked={checked}
        hitSlop={8}
      >
        {checked && <Text style={styles.checkMark}>✓</Text>}
      </Pressable>
      <View style={styles.memberText} accessible accessibilityLabel={`${member.nickname}, ${memberSubLine(member)}, ${member.phoneMasked}`}>
        <Text style={styles.memberName}>{member.nickname}</Text>
        <Text style={[styles.memberSub, absent && styles.memberSubAbsent]}>{memberSubLine(member)}</Text>
      </View>
      <View style={styles.memberRight}>
        {level !== null && <Text style={styles.levelChip}>{levelChipText(level)}</Text>}
        <Text style={styles.memberPhone}>{member.phoneMasked}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { gap: 4, marginTop: -space.xs },
  classTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  when: { color: colors.ink3, fontSize: font.small },
  tabs: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 4,
  },
  tab: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  tabOn: { backgroundColor: colors.brownSoft, borderWidth: 1, borderColor: colors.brown },
  tabTextOff: { color: colors.ink3, fontSize: font.body, fontWeight: '700' },
  tabTextOn: { color: colors.ink, fontSize: font.body, fontWeight: '800' },
  count: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  closedBox: { backgroundColor: colors.dangerSoft, borderRadius: radius.md, padding: space.md },
  closedText: { color: colors.danger, fontSize: font.small, fontWeight: '700' },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 52, paddingVertical: space.xs },
  memberDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  memberText: { flex: 1, gap: 2 },
  memberName: { color: colors.ink, fontSize: font.body, fontWeight: '800' },
  memberSub: { color: colors.ink3, fontSize: font.small },
  memberSubAbsent: { color: colors.danger, fontWeight: '700' },
  memberPhone: { color: colors.ink3, fontSize: font.small },
  memberRight: { alignItems: 'flex-end', gap: 2 },
  levelChip: { color: colors.ink, fontSize: font.small, fontWeight: '800' },
  check: {
    width: 26,
    height: 26,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.brown, borderColor: colors.brown },
  checkMark: { color: colors.surface, fontSize: 15, fontWeight: '800' },
  levelBar: { gap: space.sm },
  applied: { color: colors.brown, fontSize: font.small, fontWeight: '800' },
});
