/**
 * 오늘 결석자(보드 I26) — S3-5.9b(앱 강사 결석 표시 화면).
 * 주소 `/instructor/sessions/{sessionId}/absences?classId=…` — 회차 상세의 「오늘 결석자」 줄에서 들어온다.
 *
 * 이 화면에서 하는 일(spec FR-092e 「결석 표시」 · 2026-11-19 사용자 결정):
 *  ① 그 회차에 빠진 수강생만 줄로 본다 — 회원이 알린 결석 예정 + 강사·대표가 표시한 결석. 참석한 사람은 나오지 않는다
 *  ② 줄의 스위치를 끄면 결석 표시를 취소한다(출석으로 돌아간다 · 기록은 남는다)
 *  ③ 「+ 다른 수강생 결석 표시」로 알리지 않고 빠진 수강생을 결석으로 표시한다 → 회원에게 알림
 *  ④ 회원이 이의를 걸면 그 줄에서 「결석 취소」(받아들이기) · 「결석 유지」를 고르고, 결과를 이 화면에서 본다
 *
 * 무엇을 언제 할 수 있는지는 서버가 정해 준다(window: 시작 전 · 열림 · 잠김) — 이 화면은 그 값대로 스위치를 막는다.
 * 데이터 읽기는 useApiResource(공용 읽기 훅) 셋: 결석 목록 · (시트를 열었을 때만) 명단 · 같은 날 하루 인원표(이전·다음).
 * 쓰기(표시·취소·이의 처리)는 버튼 핸들러에서 바로 부르고, 끝나면 목록을 다시 읽는다. 효과 훅을 새로 쓰지 않는다.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { EmptyView, InlineError, LoadingView } from '../../../../lib/catalog/ui';
import { readRouteId, useApiResource } from '../../../../lib/catalog/use-api-resource';
import {
  absencesPath,
  absenceScreenHref,
  absenceSubLine,
  absenceSummaryLine,
  acceptedLine,
  canEditMarks,
  disputeLine,
  markableMembers,
  neighborSessions,
  sessionDateKey,
  windowNotice,
  type AbsenceItem,
  type SessionAbsenceList,
} from '../../../../lib/instructor/absence-api';
import { cancelAbsence, markAbsence, resolveDispute } from '../../../../lib/instructor/absence-actions';
import { headcountPath, rosterPath, type InstructorHeadcount, type SessionRoster } from '../../../../lib/instructor/headcount-api';
import { sessionWhen } from '../../../../lib/instructor/session-api';
import { goBack, InstructorShell, StaffErrorView, staffStyles, useAction } from '../../../../lib/instructor/staff-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../../../../lib/theme';

export default function SessionAbsencesScreen() {
  const params = useLocalSearchParams<{ sessionId?: string; classId?: string }>();
  const classId = readRouteId(params.classId);
  const sessionId = readRouteId(params.sessionId);
  const ok = classId !== null && sessionId !== null;
  const list = useApiResource<SessionAbsenceList>(ok ? absencesPath(classId, sessionId) : null);
  const back = () => goBack(sessionId === null ? '/instructor/academy' : `/instructor/sessions/${encodeURIComponent(sessionId)}?classId=${encodeURIComponent(classId ?? '')}&tab=members`);

  return (
    <InstructorShell title="오늘 결석" active="classes" onBack={back}>
      {!ok ? (
        <EmptyView title="회차 주소가 올바르지 않아요" />
      ) : list.state.status === 'loading' ? (
        <LoadingView label="결석 명단을 불러오고 있어요" />
      ) : list.state.status === 'error' ? (
        <StaffErrorView error={list.state.error} onRetry={list.reload} />
      ) : (
        <AbsenceBody data={list.state.data} onChanged={list.reload} />
      )}
    </InstructorShell>
  );
}

/** 목록을 받은 뒤의 화면 전체 — 머리글 · 요약 · 줄 · 이의 결과 · 다른 수강생 표시 · 안내 */
function AbsenceBody({ data, onChanged }: { data: SessionAbsenceList; onChanged: () => void }) {
  const action = useAction();
  // 「다른 수강생 결석 표시」 시트가 열렸나 — 열렸을 때만 명단을 읽는다
  const [picking, setPicking] = useState(false);
  // 렌더 중 계산: 지금 시각(줄의 「오늘 17:40」) · 스위치를 쓸 수 있나 · 막혔으면 그 이유
  const now = new Date();
  const editable = canEditMarks(data);
  const notice = windowNotice(data, now);
  const place = data.roomName === null ? data.academyName : `${data.academyName} ${data.roomName}`;

  // 쓰기는 모두 이 한 함수를 거친다 — 진행 중 표시·오류 문구를 같이 다루고, 성공하면 목록을 다시 읽는다
  const write = async (task: () => Promise<unknown>) => {
    const done = await action.run(task);
    if (done !== null) onChanged();
    return done !== null;
  };

  return (
    <>
      <View style={styles.head}>
        <View style={styles.headTitleRow}>
          <Text style={styles.classTitle} testID="absence-title">{data.title}</Text>
          <NeighborNav startsAt={data.startsAt} sessionId={data.sessionId} />
        </View>
        <Text style={styles.when}>{`${place} · ${sessionWhen(data.startsAt, data.endsAt)}`}</Text>
      </View>

      <View style={styles.summaryBox}>
        <Text style={styles.summaryText} testID="absence-summary">{absenceSummaryLine(data)}</Text>
      </View>

      {notice !== null && <Text style={styles.notice}>{notice}</Text>}
      <InlineError message={action.error} />

      {data.items.length === 0 ? (
        <EmptyView title="이 회차에 빠진 수강생이 없어요" hint="표시가 없으면 모두 참석으로 봐요." />
      ) : (
        <View style={staffStyles.card}>
          {data.items.map((item, index) => (
            <AbsenceRow
              key={item.markId}
              item={item}
              now={now}
              divided={index > 0}
              editable={editable && !action.busy}
              onCancel={() => write(() => cancelAbsence(data.classId, data.sessionId, item.markId))}
              onResolve={(decision) => write(() => resolveDispute(item.markId, decision))}
              busy={action.busy}
            />
          ))}
        </View>
      )}

      {data.acceptedDisputes.length > 0 && (
        <View style={staffStyles.card}>
          <Text style={staffStyles.sectionTitle}>이의로 취소된 결석</Text>
          {data.acceptedDisputes.map((item) => (
            <View key={item.markId} style={styles.acceptedRow} accessible>
              <Text style={styles.memberName}>{item.nickname}</Text>
              <Text style={styles.acceptedText}>{acceptedLine(item, now)}</Text>
              {item.disputeReason !== null && <Text style={styles.memberSub}>{`회원이 쓴 사유 「${item.disputeReason}」`}</Text>}
            </View>
          ))}
        </View>
      )}

      <View style={styles.guideBox}>
        <Text style={styles.guideTitle}>결석 표시 안내</Text>
        <Text style={styles.guideText}>
          표시하면 회원에게 「결석으로 표시됐어요」 알림이 가요. 회원은 이의 신청할 수 있고 누가 언제 표시했는지 남아요. 결석은 레벨에만 써요.
        </Text>
      </View>
      <Text style={staffStyles.muted}>출석 체크는 따로 없고, 표시가 없으면 참석으로 봐요. 정산·대기 순번에는 쓰지 않아요. 홈 표의 결석 숫자와 늘 같아요.</Text>

      {editable && (
        <Pressable
          style={styles.addButton}
          onPress={() => setPicking((open) => !open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: picking }}
          testID="absence-add"
        >
          <Text style={styles.addText}>{picking ? '닫기' : '+ 다른 수강생 결석 표시'}</Text>
        </Pressable>
      )}
      {editable && picking && (
        <MemberPicker
          data={data}
          busy={action.busy}
          onPick={async (memberId) => {
            if (await write(() => markAbsence(data.classId, data.sessionId, memberId))) setPicking(false);
          }}
        />
      )}
      <Text style={staffStyles.muted}>표시하면 회원에게 알림이 가요 · 끄면 표시가 지워지고 그 기록도 남아요</Text>
    </>
  );
}

interface AbsenceRowProps {
  item: AbsenceItem;
  now: Date;
  divided: boolean;
  editable: boolean;
  busy: boolean;
  onCancel: () => void;
  onResolve: (decision: 'accept' | 'reject') => void;
}

/** 줄 하나 — 이름 · 성별 · 개월 수 · 누가 언제(둘째 줄), 오른쪽 「결석 표시」 스위치, 이의가 있으면 그 아래 상태와 처리 단추 */
function AbsenceRow({ item, now, divided, editable, busy, onCancel, onResolve }: AbsenceRowProps) {
  const dispute = disputeLine(item);
  return (
    <View style={[styles.row, divided && styles.divider]} testID={`absence-row-${item.nickname}`}>
      <View style={styles.rowMain}>
        <View style={styles.avatar} />
        <View style={styles.rowText}>
          <Text style={styles.memberName}>{item.nickname}</Text>
          <Text style={styles.memberSub}>{absenceSubLine(item, now)}</Text>
        </View>
        <View style={styles.switchBox}>
          {/* 이 화면의 줄은 모두 결석이라 늘 켜져 있다. 끄는 것 = 표시 취소 */}
          <Switch
            value
            disabled={!editable}
            onValueChange={(next) => (next ? undefined : onCancel())}
            trackColor={{ true: colors.brown, false: colors.line }}
            thumbColor={colors.surface}
            accessibilityLabel={`${item.nickname} 결석 표시 끄기`}
          />
          <Text style={styles.switchLabel}>결석 표시</Text>
        </View>
      </View>
      {dispute !== null && (
        <View style={[styles.disputeBox, dispute.tone === 'result' && styles.disputeResult]}>
          <Text style={dispute.tone === 'pending' ? styles.disputePending : styles.disputeResultText}>{dispute.text}</Text>
          {item.canResolveDispute && (
            <View style={styles.disputeButtons}>
              <Pressable style={styles.disputeAccept} disabled={busy} onPress={() => onResolve('accept')} accessibilityRole="button">
                <Text style={styles.disputeAcceptText}>결석 취소(받아들이기)</Text>
              </Pressable>
              <Pressable style={styles.disputeReject} disabled={busy} onPress={() => onResolve('reject')} accessibilityRole="button">
                <Text style={styles.disputeRejectText}>결석 유지</Text>
              </Pressable>
            </View>
          )}
          {item.disputeStatus === 'requested' && !item.canResolveDispute && (
            <Text style={styles.memberSub}>표시한 사람(또는 대표)이 처리해요.</Text>
          )}
        </View>
      )}
    </View>
  );
}

/** 「다른 수강생 결석 표시」 시트 — 결제 완료 명단에서 아직 결석이 아닌 사람만. 한 명을 누르면 바로 표시한다 */
function MemberPicker({ data, busy, onPick }: { data: SessionAbsenceList; busy: boolean; onPick: (memberId: string) => void }) {
  const roster = useApiResource<SessionRoster>(rosterPath(data.classId, data.sessionId));
  if (roster.state.status === 'loading') return <LoadingView label="수강생 명단을 불러오고 있어요" />;
  if (roster.state.status === 'error') return <StaffErrorView error={roster.state.error} onRetry={roster.reload} />;
  const candidates = markableMembers(roster.state.data, data);
  if (candidates.length === 0) return <EmptyView title="더 표시할 수강생이 없어요" />;
  return (
    <View style={staffStyles.card} testID="absence-picker">
      <Text style={staffStyles.sectionTitle}>빠진 수강생을 골라요</Text>
      {candidates.map((member, index) => (
        <Pressable
          key={member.memberId}
          style={[styles.pickRow, index > 0 && styles.divider]}
          disabled={busy}
          onPress={() => onPick(member.memberId)}
          accessibilityRole="button"
          accessibilityLabel={`${member.nickname} 결석 표시`}
        >
          <Text style={styles.memberName}>{member.nickname}</Text>
          <Text style={styles.memberSub}>{`${member.gender === 'male' ? '남' : '여'} · ${member.monthsEnrolled}개월째`}</Text>
          <Text style={styles.pickAction}>결석 표시</Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * 오른쪽 위 「‹ 이전 · 다음 ›」 — 같은 날 내 앞뒤 수업으로 넘긴다(연달아 수업하는 강사가 홈으로 돌아가지 않게).
 * 하루 인원표(강사 경로)를 읽어 이 회차의 앞뒤를 찾는다. 없거나 못 읽으면 그 쪽 글자를 흐리게 둔다.
 */
function NeighborNav({ startsAt, sessionId }: { startsAt: string; sessionId: string }) {
  const date = sessionDateKey(startsAt);
  const day = useApiResource<InstructorHeadcount>(date === null ? null : headcountPath(date));
  const around = day.state.status === 'ready' ? neighborSessions(day.state.data.items, sessionId) : { prev: null, next: null };
  const go = (target: { classId: string; sessionId: string } | null) =>
    target === null ? undefined : () => router.replace(absenceScreenHref(target.classId, target.sessionId));
  return (
    <View style={styles.nav}>
      <Pressable onPress={go(around.prev)} disabled={around.prev === null} accessibilityRole="button" accessibilityLabel="같은 날 이전 수업" hitSlop={8}>
        <Text style={around.prev === null ? styles.navOff : styles.navOn}>‹ 이전</Text>
      </Pressable>
      <Text style={styles.navDot}>·</Text>
      <Pressable onPress={go(around.next)} disabled={around.next === null} accessibilityRole="button" accessibilityLabel="같은 날 다음 수업" hitSlop={8}>
        <Text style={around.next === null ? styles.navOff : styles.navOn}>다음 ›</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { gap: 4, marginTop: -space.xs },
  headTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  classTitle: { flex: 1, color: colors.ink, fontSize: 16, fontWeight: '800' },
  when: { color: colors.ink3, fontSize: font.small },
  nav: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  navOn: { color: colors.brown, fontSize: font.small, fontWeight: '800' },
  navOff: { color: colors.ink3, fontSize: font.small },
  navDot: { color: colors.ink3, fontSize: font.small },
  summaryBox: { backgroundColor: '#EFE6F1', borderRadius: radius.md, paddingVertical: space.md, paddingHorizontal: space.lg },
  summaryText: { color: colors.brown, fontSize: font.body, fontWeight: '800' },
  notice: { color: colors.ink3, fontSize: font.small, lineHeight: 18 },
  row: { gap: space.sm, paddingVertical: space.xs },
  rowMain: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 52 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space.sm },
  avatar: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.disabled },
  rowText: { flex: 1, gap: 2 },
  memberName: { color: colors.ink, fontSize: font.body, fontWeight: '800' },
  memberSub: { color: colors.ink3, fontSize: font.small },
  switchBox: { alignItems: 'center', gap: 2, minWidth: MIN_TOUCH },
  switchLabel: { color: colors.ink3, fontSize: font.tiny },
  disputeBox: { backgroundColor: colors.dangerSoft, borderRadius: radius.md, padding: space.md, gap: space.sm },
  disputeResult: { backgroundColor: colors.brownSoft },
  disputePending: { color: colors.danger, fontSize: font.small, fontWeight: '700' },
  disputeResultText: { color: colors.brown, fontSize: font.small, fontWeight: '700' },
  disputeButtons: { flexDirection: 'row', gap: space.sm },
  disputeAccept: { flex: 1, minHeight: 40, borderRadius: radius.md, backgroundColor: colors.brown, alignItems: 'center', justifyContent: 'center' },
  disputeAcceptText: { color: colors.surface, fontSize: font.small, fontWeight: '800' },
  disputeReject: { flex: 1, minHeight: 40, borderRadius: radius.md, borderWidth: 1, borderColor: colors.brown, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  disputeRejectText: { color: colors.brown, fontSize: font.small, fontWeight: '800' },
  acceptedRow: { gap: 2, paddingVertical: space.xs },
  acceptedText: { color: colors.brown, fontSize: font.small, fontWeight: '700' },
  guideBox: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.xs },
  guideTitle: { color: colors.ink, fontSize: font.body, fontWeight: '800' },
  guideText: { color: colors.ink, fontSize: font.small, lineHeight: 19 },
  addButton: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addText: { color: colors.ink, fontSize: font.body, fontWeight: '800' },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: MIN_TOUCH },
  pickAction: { marginLeft: 'auto', color: colors.brown, fontSize: font.small, fontWeight: '800' },
});
