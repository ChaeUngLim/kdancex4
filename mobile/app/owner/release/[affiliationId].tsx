/**
 * 대표 앱 「소속 해제」(보드 O39) · 받는 회원 명단 확인 시트(O39B) — S2-3.10(관리자 웹·대표 앱 해제 확인 화면).
 * 주소 `/owner/release/{affiliationId}`. 입구는 강사 권한(O38)의 「소속 해제 ›」.
 *
 * FR-082(소속 해제): 남은 회차를 모두 처리해야 해제가 끝난다. 회차마다 대체 강사 · 휴강 · 폐강을 고르고,
 * 대체 강사는 대표가 바로 배정한다(그 시간이 빈 같은 학원·같은 장르 강사만 고를 수 있다).
 * 버튼을 누르면 확인 시트(O39B)에서 묶음별 문구 · 받는 회원 명단 · 「받는 회원 M명 · 알림은 회원마다 1건」(열린 점 ⑯)을 보고 해제한다.
 * 관리자 웹 W3b · W3b2 와 같은 API(계약 11 §9)를 쓴다.
 *
 * 처음 남은 회차는 공용 `useApiResource`(POST 미리 보기 모드)가 읽고, 후보 · 명단 · 시트 · 해제는 누를 때(onPress)만 부른다.
 * 효과 훅을 새로 쓰지 않는다.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { EmptyView, ErrorView, LoadingView } from '../../../lib/catalog/ui';
import { newIdempotencyKey, readRouteId, toApiError, useApiResource } from '../../../lib/catalog/use-api-resource';
import { BottomButtons, Chip, ChipRow, formStyles } from '../../../lib/instructor/class-form-ui';
import { useAction } from '../../../lib/instructor/staff-ui';
import { OwnerScreen } from '../../../lib/owner/owner-screen';
import {
  bundleHeading,
  fetchCandidates,
  isDecided,
  noticeLine,
  previewPath,
  previewRelease,
  RELEASE_BUNDLE_BADGES,
  RELEASE_SESSION_ACTIONS,
  RELEASE_SESSION_LABELS,
  releaseAffiliation,
  remainingCount,
  sessionDecisionsOf,
  sessionSubline,
  sessionTitle,
  totalsLine,
  type Choices,
  type OwnerReleasePreview,
  type ReleasedAffiliation,
  type ReleaseSessionAction,
  type RemainingSession,
  type SubstituteCandidate,
} from '../../../lib/owner/release-api';
import { pickOwnerAcademy, type StaffMe } from '../../../lib/owner/terms-api';
import { colors, font, MIN_TOUCH, radius, space } from '../../../lib/theme';

/** 처음 미리 보기 본문 — 빈 선택이면 서버는 남은 회차 목록만 준다(§9-1). 모듈에 두어 렌더마다 같은 값 */
const EMPTY_DECISIONS = { sessionDecisions: [], privateLessonDecisions: [] } as const;

type Candidates = { status: 'loading' } | { status: 'ready'; items: SubstituteCandidate[] } | { status: 'error'; text: string };
type Roster = { status: 'loading' } | { status: 'ready'; members: OwnerReleasePreview['bundles'][number]['members'] } | { status: 'error'; text: string };

export default function OwnerReleaseScreen() {
  const affiliationId = readRouteId(useLocalSearchParams<{ affiliationId: string }>().affiliationId);
  const me = useApiResource<StaffMe>('/api/staff/me');
  const academy = me.state.status === 'ready' ? pickOwnerAcademy(me.state.data) : null;
  const preview = useApiResource<OwnerReleasePreview>(
    academy === null || affiliationId === null ? null : previewPath(academy.academyId, affiliationId),
    EMPTY_DECISIONS,
  );

  let body;
  if (affiliationId === null) body = <EmptyView title="강사를 찾을 수 없어요" hint="강사 관리에서 다시 골라 주세요." />;
  else if (me.state.status === 'loading') body = <LoadingView label="내 학원을 확인하고 있어요" />;
  else if (me.state.status === 'error') body = <ErrorView error={me.state.error} onRetry={me.reload} />;
  else if (academy === null) body = <EmptyView title="대표로 있는 학원이 없어요" />;
  else if (preview.state.status === 'loading') body = <LoadingView label="남은 회차를 확인하고 있어요" />;
  else if (preview.state.status === 'error') body = <ErrorView error={preview.state.error} onRetry={preview.reload} />;
  else body = <ReleaseBody academyId={academy.academyId} affiliationId={affiliationId} preview={preview.state.data} />;

  return <OwnerScreen title="소속 해제">{body}</OwnerScreen>;
}

function ReleaseBody({ academyId, affiliationId, preview }: { academyId: string; affiliationId: string; preview: OwnerReleasePreview }) {
  const sessions = preview.remaining.sessions;
  const name = preview.instructor.displayName;
  const [choices, setChoices] = useState<Choices>({});
  const [candidates, setCandidates] = useState<Readonly<Record<string, Candidates>>>({});
  const [rosters, setRosters] = useState<Readonly<Record<string, Roster>>>({});
  const [sheet, setSheet] = useState<OwnerReleasePreview | null>(null);
  const [releaseKey] = useState(newIdempotencyKey);
  const [done, setDone] = useState<ReleasedAffiliation | null>(null);
  const open = useAction();
  const send = useAction();

  // 렌더 중 계산: 아직 덜 정한 회차 수(버튼 켜짐)
  const left = remainingCount(sessions, choices);

  /** 처리 고르기. 대체 강사면 그 회차 후보를 받아 온다(이미 받았으면 다시 부르지 않는다) */
  const pick = async (session: RemainingSession, action: ReleaseSessionAction) => {
    setChoices({ ...choices, [session.sessionId]: { action, substituteAccountId: null, substituteName: null } });
    setRosters(Object.fromEntries(Object.entries(rosters).filter(([id]) => id !== session.sessionId)));
    if (action !== 'substitute' || candidates[session.sessionId]?.status === 'ready') return;
    setCandidates((prev) => ({ ...prev, [session.sessionId]: { status: 'loading' } }));
    try {
      const items = await fetchCandidates(session.sessionId);
      setCandidates((prev) => ({ ...prev, [session.sessionId]: { status: 'ready', items } }));
    } catch (caught: unknown) {
      setCandidates((prev) => ({ ...prev, [session.sessionId]: { status: 'error', text: toApiError(caught).detail } }));
    }
  };

  const pickSubstitute = (sessionId: string, candidate: SubstituteCandidate) =>
    setChoices({ ...choices, [sessionId]: { action: 'substitute', substituteAccountId: candidate.accountId, substituteName: candidate.displayName } });

  /** 「명단 보기」 — 그 회차 하나만 넣은 미리 보기의 첫 묶음이 그 회차의 받는 회원이다 */
  const toggleRoster = async (session: RemainingSession) => {
    const choice = choices[session.sessionId];
    if (choice === undefined) return;
    if (rosters[session.sessionId] !== undefined) {
      setRosters(Object.fromEntries(Object.entries(rosters).filter(([id]) => id !== session.sessionId)));
      return;
    }
    setRosters((prev) => ({ ...prev, [session.sessionId]: { status: 'loading' } }));
    try {
      const one = await previewRelease(academyId, affiliationId, [{ sessionId: session.sessionId, action: choice.action }]);
      setRosters((prev) => ({ ...prev, [session.sessionId]: { status: 'ready', members: one.bundles[0]?.members ?? [] } }));
    } catch (caught: unknown) {
      setRosters((prev) => ({ ...prev, [session.sessionId]: { status: 'error', text: toApiError(caught).detail } }));
    }
  };

  /** 버튼 → 고른 처리로 다시 계산해 확인 시트(O39B)를 연다. 그사이 대체 강사에게 일정이 생겼으면 열지 않는다 */
  const handleOpen = async () => {
    const result = await open.run(() => previewRelease(academyId, affiliationId, sessionDecisionsOf(sessions, choices)));
    if (result === null) return;
    if (!result.canRelease) {
      open.setError('고른 대체 강사에게 그 시간 일정이 생겼어요. 다른 강사를 골라 주세요');
      return;
    }
    setSheet(result);
  };

  const handleRelease = async () => {
    const result = await send.run(() => releaseAffiliation(academyId, affiliationId, sessionDecisionsOf(sessions, choices), releaseKey));
    if (result !== null) {
      setSheet(null);
      setDone(result);
    }
  };

  if (done !== null) {
    return (
      <View style={styles.stack}>
        <View style={styles.doneBox}>
          <Text style={styles.doneTitle}>{`${name} 강사의 소속을 해제했어요`}</Text>
          <Text style={styles.doneText}>
            {`대체 강사 ${done.sessions.substituted}회 · 휴강 ${done.sessions.cancelled}회 · 폐강 ${done.sessions.closed}회\n받는 회원 ${done.notified.memberCount}명에게 알림 ${done.notified.notificationCount}건을 보냈어요`}
          </Text>
        </View>
        <BottomButtons
          secondary={{ label: '닫기', onPress: () => (router.canGoBack() ? router.back() : router.replace('/owner/instructors')) }}
          primary={{ label: '강사 관리로', onPress: () => router.replace('/owner/instructors') }}
        />
      </View>
    );
  }

  const disabled = left > 0 || open.busy;
  return (
    <View style={styles.stack}>
      <View style={styles.headBlock}>
        <Text style={styles.headTitle}>
          {sessions.length === 0 ? `${name} 강사 · 남은 회차가 없어요` : `${name} 강사 · 게시된 회차 ${sessions.length}개가 남아 있어요`}
        </Text>
        <Text style={styles.hint}>{sessions.length === 0 ? '바로 해제할 수 있어요' : '회차마다 하나를 골라야 해제할 수 있어요'}</Text>
      </View>

      {sessions.map((session) => {
        const choice = choices[session.sessionId];
        const list = candidates[session.sessionId];
        const roster = rosters[session.sessionId];
        return (
          <View key={session.sessionId} style={styles.card} accessibilityLabel={sessionTitle(session)}>
            <Text style={styles.cardTitle}>{sessionTitle(session)}</Text>
            <Text style={styles.hint}>{sessionSubline(session)}</Text>
            <ChipRow>
              {RELEASE_SESSION_ACTIONS.map((action) => (
                <Chip key={action} label={RELEASE_SESSION_LABELS[action]} selected={choice?.action === action} onPress={() => void pick(session, action)} />
              ))}
            </ChipRow>

            {choice?.action === 'substitute' && <CandidateChips list={list} selected={choice.substituteAccountId} onPick={(c) => pickSubstitute(session.sessionId, c)} />}
            {choice?.action === 'substitute' && choice.substituteName !== null && (
              <Text style={styles.strong}>{`${choice.substituteName} 강사 · 그 시간 비어 있음`}</Text>
            )}
            {choice === undefined && <Text style={formStyles.danger}>아직 고르지 않았어요</Text>}
            {choice?.action === 'substitute' && choice.substituteName === null && <Text style={formStyles.danger}>대체 강사를 골라 주세요</Text>}

            {choice !== undefined && (
              <Pressable onPress={() => void toggleRoster(session)} accessibilityRole="button" accessibilityState={{ expanded: roster !== undefined }} style={styles.linkRow}>
                <Text style={styles.link}>{`${noticeLine(session.memberCount, choice.action)} · 명단 ${roster === undefined ? '보기 ▾' : '접기 ▴'}`}</Text>
              </Pressable>
            )}
            {choice?.action === 'cancel_session' && <Text style={styles.hint}>회원이 원하면 환불을 요청할 수 있어요</Text>}
            {roster?.status === 'loading' && <Text style={styles.hint}>명단을 불러오고 있어요</Text>}
            {roster?.status === 'error' && <Text style={formStyles.danger}>{roster.text}</Text>}
            {roster?.status === 'ready' && <MemberGrid members={roster.members} />}
          </View>
        );
      })}

      <Text style={styles.hint}>버튼을 누르면 보낼 알림과 받는 회원을 한 번 더 확인해요.</Text>
      {open.error !== null && <Text style={formStyles.danger}>{open.error}</Text>}
      <Pressable
        style={[styles.primary, disabled && styles.primaryOff]}
        onPress={() => void handleOpen()}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
      >
        <Text style={[styles.primaryText, disabled && styles.primaryTextOff]}>
          {left > 0 ? `${left}개 남았어요` : open.busy ? '확인하는 중' : '소속 해제'}
        </Text>
      </Pressable>

      <ReleaseSheet
        preview={sheet}
        name={name}
        sessions={sessions}
        choices={choices}
        busy={send.busy}
        error={send.error}
        onClose={() => setSheet(null)}
        onSend={() => void handleRelease()}
      />
    </View>
  );
}

/** 대체 강사 후보 칩 — 그 시간에 일정이 있는 강사는 고를 수 없고 이유만 보인다(무슨 일정인지는 보이지 않는다) */
function CandidateChips({ list, selected, onPick }: { list: Candidates | undefined; selected: string | null; onPick: (c: SubstituteCandidate) => void }) {
  if (list === undefined || list.status === 'loading') return <Text style={styles.hint}>대체 강사 후보를 불러오고 있어요</Text>;
  if (list.status === 'error') return <Text style={formStyles.danger}>{list.text}</Text>;
  if (list.items.length === 0) return <Text style={formStyles.danger}>같은 장르의 다른 소속 강사가 없어요 · 휴강이나 폐강을 골라 주세요</Text>;
  return (
    <View style={styles.candidates}>
      {list.items.map((c) => (
        <Pressable
          key={c.accountId}
          onPress={() => onPick(c)}
          disabled={!c.available}
          style={[styles.candidate, selected === c.accountId && styles.candidateOn, !c.available && styles.candidateOff]}
          accessibilityRole="radio"
          accessibilityState={{ checked: selected === c.accountId, disabled: !c.available }}
          accessibilityLabel={`${c.displayName} 강사 ${c.available ? '그 시간 비어 있음' : '그 시간에 일정이 있어요'}`}
        >
          <Text style={[styles.candidateName, !c.available && styles.candidateNameOff]}>{`${c.displayName} 강사`}</Text>
          <Text style={[styles.candidateSub, !c.available && styles.candidateBusy]}>{c.available ? '그 시간 비어 있음' : '그 시간에 일정이 있어요'}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function MemberGrid({ members }: { members: OwnerReleasePreview['bundles'][number]['members'] }) {
  return (
    <View style={styles.members}>
      {members.map((m, i) => (
        <Text key={`${m.displayName}-${i}`} style={styles.member}>
          <Text style={styles.memberName}>{m.displayName}</Text>
          <Text style={styles.memberKind}>{` · ${m.payKind === 'paid' ? '결제' : '수강권'}`}</Text>
        </Text>
      ))}
    </View>
  );
}

interface SheetProps {
  preview: OwnerReleasePreview | null;
  name: string;
  sessions: readonly RemainingSession[];
  choices: Choices;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSend: () => void;
}

/** O39B 확인 시트 — 처리별 묶음마다 회원에게 갈 문구와 받는 회원 명단, 합계. 회원을 빼고 보낼 수는 없다 */
function ReleaseSheet({ preview, name, sessions, choices, busy, error, onClose, onSend }: SheetProps) {
  const [openBundle, setOpenBundle] = useState<number>(0);
  if (preview === null) return null;
  const substitutes = [...new Set(sessions.map((s) => choices[s.sessionId]?.substituteName).filter((n): n is string => typeof n === 'string'))];
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} accessibilityViewIsModal>
          <View style={styles.grabber} />
          <ScrollView contentContainerStyle={styles.sheetBody}>
            <Text style={styles.sheetTitle} accessibilityRole="header">
              알림을 보내고 해제할까요?
            </Text>
            <Text style={styles.hint}>{`${name} 강사 · 받는 사람을 확인해 주세요`}</Text>

            {preview.bundles.map((bundle, index) => {
              const expanded = openBundle === index;
              return (
                <View key={bundle.action} style={styles.bundle}>
                  <Pressable style={styles.bundleHead} onPress={() => setOpenBundle(expanded ? -1 : index)} accessibilityRole="button" accessibilityState={{ expanded }}>
                    <Text style={styles.bundleTag}>{RELEASE_BUNDLE_BADGES[bundle.action]}</Text>
                    <Text style={styles.bundleTitle}>{bundleHeading(bundle, sessions, choices)}</Text>
                    <Text style={styles.link}>{expanded ? '접기 ▴' : '명단 보기 ▾'}</Text>
                  </Pressable>
                  {expanded && (
                    <>
                      <View style={styles.quote}>
                        <Text style={styles.quoteText}>{bundle.messagePreview}</Text>
                      </View>
                      <Text style={styles.membersHead}>{`받는 회원 ${bundle.memberCount}명`}</Text>
                      <MemberGrid members={bundle.members} />
                      {bundle.action === 'substitute' && substitutes.length > 0 && (
                        <Text style={styles.hint}>{`대체 강사 ${substitutes.join(' · ')}에게 배정 알림이 가요`}</Text>
                      )}
                    </>
                  )}
                </View>
              );
            })}

            <View style={styles.totals}>
              <Text style={styles.totalsTitle}>{totalsLine(preview.totals)}</Text>
              <Text style={styles.hint}>여러 회차를 예약한 회원에게는 한 번에 모아 보내요 · 회원을 빼고 보낼 수는 없어요</Text>
            </View>
            {error !== null && <Text style={formStyles.danger}>{error}</Text>}
            <BottomButtons secondary={{ label: '돌아가기', onPress: onClose }} primary={{ label: busy ? '보내는 중' : '알림 보내고 해제', onPress: onSend, disabled: busy }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  headBlock: { gap: 2 },
  headTitle: { color: colors.ink, fontSize: font.body, fontWeight: '800' },
  hint: { color: colors.ink3, fontSize: font.small, lineHeight: 18 },
  strong: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.sm },
  cardTitle: { color: colors.ink, fontSize: font.body, fontWeight: '800' },
  linkRow: { minHeight: 32, justifyContent: 'center' },
  link: { color: colors.brown, fontSize: font.small, fontWeight: '700' },
  candidates: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  candidate: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  candidateOn: { borderColor: colors.brown, backgroundColor: colors.brownSoft },
  candidateOff: { backgroundColor: colors.bg },
  candidateName: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  candidateNameOff: { color: colors.disabledInk },
  candidateSub: { color: colors.ink3, fontSize: font.tiny },
  candidateBusy: { color: colors.danger },
  members: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 6 },
  member: { width: '50%' },
  memberName: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  memberKind: { color: colors.ink3, fontSize: font.small },
  primary: { minHeight: 52, borderRadius: radius.lg, backgroundColor: colors.brown, alignItems: 'center', justifyContent: 'center' },
  primaryOff: { backgroundColor: colors.disabled },
  primaryText: { color: colors.surface, fontSize: font.body, fontWeight: '800' },
  primaryTextOff: { color: colors.disabledInk },
  doneBox: { backgroundColor: colors.brownSoft, borderRadius: radius.lg, padding: space.lg, gap: space.xs },
  doneTitle: { color: colors.brown, fontSize: font.body + 1, fontWeight: '800' },
  doneText: { color: colors.ink, fontSize: font.small, lineHeight: 20 },
  backdrop: { flex: 1, backgroundColor: 'rgba(20,18,22,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: radius.lg + 8, borderTopRightRadius: radius.lg + 8, maxHeight: '88%' },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.line, marginTop: space.sm },
  sheetBody: { padding: space.lg, gap: space.md },
  sheetTitle: { color: colors.ink, fontSize: font.h2, fontWeight: '800' },
  bundle: { backgroundColor: colors.bg, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.md, gap: space.sm },
  bundleHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 36 },
  bundleTag: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.brownSoft,
    color: colors.brown,
    fontSize: font.small,
    fontWeight: '800',
    overflow: 'hidden',
  },
  bundleTitle: { flex: 1, color: colors.ink, fontSize: font.body, fontWeight: '800' },
  quote: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: space.md },
  quoteText: { color: colors.ink, fontSize: font.small, lineHeight: 19 },
  membersHead: { color: colors.ink3, fontSize: font.small, fontWeight: '700' },
  totals: { backgroundColor: colors.brownSoft, borderRadius: radius.md, padding: space.md, gap: 2 },
  totalsTitle: { color: colors.brown, fontSize: 15, fontWeight: '800' },
});
