/**
 * 소속 해제(보드 I28) · 해제 확인 시트(I28B) — S2-3.8(앱 변경·대타·공지 화면).
 * 주소 `/instructor/affiliations/{affiliationId}/release`. 입구는 학원 탭(I12)의 「소속 해제」.
 *
 * FR-082(소속 해제): 남은 회차를 먼저 정해야 해제할 수 있다. 수업마다 대체 강사 · 휴강 · 폐강 중 하나를 고르고,
 * 개인 레슨 수강권이 있으면 해제 전에 마치기 · 환불 · 다른 강사에게 중 하나를 고른다. 다 고르기 전에는 버튼이 꺼져 있다.
 *
 * 강사는 해제를 「요청」한다(계약 11 §3-3 「요청만 만든다」). 고른 값은 대표 화면에 미리 채워지고, 회원 알림과
 * 실제 해제는 대표가 확인할 때 나간다. 그래서 확인 시트(I28B)는 보드의 「알림 보내고 해제」 대신
 * 「해제 요청 보내기」로 적고, 받는 회원 명단과 「받는 회원 M명 · 알림은 회원마다 1건」(열린 점 ⑯ 추천안)을 보인다.
 *
 * 서버: POST …/release-preview(처음엔 빈 선택으로 남은 것 목록, 시트를 열 때 고른 값으로) ·
 *       POST …/release-requests(키 필수) · GET /api/instructor/affiliations(학원 이름·소속 시작일).
 * 처음 미리 보기는 공용 `useApiResource`(POST 미리 보기 모드)가 읽고, 시트·요청은 버튼 핸들러에서만 부른다.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { EmptyView, LoadingView } from '../../../../lib/catalog/ui';
import { newIdempotencyKey, readRouteId, useApiResource } from '../../../../lib/catalog/use-api-resource';
import { kstMonthDayWeekday } from '../../../../lib/instructor/affiliation-api';
import { BottomButtons, Chip, ChipRow, formStyles } from '../../../../lib/instructor/class-form-ui';
import {
  groupRemainingByClass,
  passChoicesOf,
  previewRelease,
  RELEASE_PASS_ACTIONS,
  RELEASE_PASS_LABELS,
  RELEASE_SESSION_ACTIONS,
  RELEASE_SESSION_HINTS,
  RELEASE_SESSION_LABELS,
  requestRelease,
  sessionChoicesOf,
  undecidedCount,
  type ReleaseChoices,
  type ReleasePassAction,
  type ReleasePreview,
  type ReleaseRequested,
  type ReleaseSessionAction,
} from '../../../../lib/instructor/release-api';
import type { AffiliationCard } from '../../../../lib/instructor/staff-api';
import { sessionStyles } from '../../../../lib/instructor/session-ui';
import { goBack, InstructorShell, StaffErrorView, useAction } from '../../../../lib/instructor/staff-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../../../../lib/theme';

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'] as const;
/** 처음 미리 보기 본문 — 빈 선택이면 서버는 남은 회차 목록만 준다(§9-1). 모듈에 두어 렌더마다 같은 값 */
const EMPTY_DECISIONS = { sessionDecisions: [], privateLessonDecisions: [] } as const;

export default function ReleaseScreen() {
  const params = useLocalSearchParams<{ affiliationId?: string }>();
  const affiliationId = readRouteId(params.affiliationId);
  const cards = useApiResource<{ items: AffiliationCard[] }>(affiliationId === null ? null : '/api/instructor/affiliations');
  const preview = useApiResource<ReleasePreview>(
    affiliationId === null ? null : `/api/instructor/affiliations/${encodeURIComponent(affiliationId)}/release-preview`,
    EMPTY_DECISIONS,
  );

  let body;
  if (affiliationId === null) body = <EmptyView title="소속 주소가 올바르지 않아요" />;
  else if (cards.state.status === 'error') body = <StaffErrorView error={cards.state.error} onRetry={cards.reload} />;
  else if (preview.state.status === 'error') body = <StaffErrorView error={preview.state.error} onRetry={preview.reload} />;
  else if (cards.state.status === 'loading' || preview.state.status === 'loading') body = <LoadingView label="남은 회차를 확인하고 있어요" />;
  else {
    const card = cards.state.data.items.find((c) => c.affiliationId === affiliationId);
    body =
      card === undefined || card.status !== 'active' ? (
        <EmptyView title="해제할 수 있는 소속이 아니에요" hint="소속됨 상태인 학원만 해제할 수 있어요." />
      ) : (
        <ReleaseBody card={card} preview={preview.state.data} />
      );
  }
  return (
    <InstructorShell title="소속 해제" active="academy" onBack={() => goBack('/instructor/academy')}>
      {body}
    </InstructorShell>
  );
}

function ReleaseBody({ card, preview }: { card: AffiliationCard; preview: ReleasePreview }) {
  const [choices, setChoices] = useState<ReleaseChoices>({ classActions: {}, passActions: {} });
  // 시트에 띄울 미리 보기(고른 값으로 다시 계산한 것). null 이면 시트가 닫혀 있다
  const [sheet, setSheet] = useState<ReleasePreview | null>(null);
  const [requestKey] = useState(newIdempotencyKey);
  const [done, setDone] = useState<ReleaseRequested | null>(null);
  const open = useAction();
  const send = useAction();

  // 렌더 중 계산: 수업별 카드 · 아직 안 정한 수 · 정할 것 전체 수
  const groups = groupRemainingByClass(preview.remaining.sessions);
  const passes = preview.remaining.privateLessonPasses;
  const total = groups.length + passes.length;
  const left = undecidedCount(groups, preview, choices);

  const pickClass = (classId: string, action: ReleaseSessionAction) =>
    setChoices({ ...choices, classActions: { ...choices.classActions, [classId]: action } });
  const pickPass = (passId: string, action: ReleasePassAction) =>
    setChoices({ ...choices, passActions: { ...choices.passActions, [passId]: action } });

  // 「해제 요청」 → 고른 값으로 미리 보기를 다시 불러 받는 회원 명단을 시트에 띄운다
  const handleOpen = async () => {
    const result = await open.run(() => previewRelease(card.affiliationId, sessionChoicesOf(groups, choices), passChoicesOf(preview, choices)));
    if (result !== null) setSheet(result);
  };
  const handleSend = async () => {
    const result = await send.run(() => requestRelease(card.affiliationId, sessionChoicesOf(groups, choices), passChoicesOf(preview, choices), requestKey));
    if (result !== null) {
      setSheet(null);
      setDone(result);
    }
  };

  if (done !== null) {
    return (
      <View style={styles.stack}>
        <View style={styles.doneBox}>
          <Text style={styles.doneTitle}>해제를 요청했어요</Text>
          <Text style={styles.doneText}>
            {`${card.academyName} 대표가 확인하면 해제돼요. 고른 처리대로 수강생에게 알림이 가고, 그전까지는 지금처럼 소속돼 있어요.`}
          </Text>
        </View>
        <BottomButtons secondary={{ label: '닫기', onPress: () => goBack('/instructor/academy') }} primary={{ label: '학원 탭으로', onPress: () => router.replace('/instructor/academy') }} />
      </View>
    );
  }

  const since = card.decidedAt === null ? '' : `${kstMonthDayWeekday(card.decidedAt)}부터 소속 · `;
  return (
    <View style={styles.stack}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{card.academyName}</Text>
        <Text style={sessionStyles.hint}>{`${since}이후 수업 ${groups.length}${passes.length > 0 ? ` · 1:1 레슨 ${passes.length}` : ''}`}</Text>
      </View>

      {total === 0 ? (
        <View style={styles.headBlock}>
          <Text style={sessionStyles.sectionTitle}>남은 회차가 없어요</Text>
          <Text style={sessionStyles.hint}>바로 해제를 요청할 수 있어요.</Text>
        </View>
      ) : (
        <View style={styles.headBlock}>
          <Text style={sessionStyles.sectionTitle}>{`해제하기 전에 정할 것 ${total}가지`}</Text>
          <Text style={sessionStyles.hint}>정하지 않으면 해제를 끝낼 수 없어요</Text>
        </View>
      )}

      {groups.map((group, index) => {
        const picked = choices.classActions[group.classId];
        return (
          <View key={group.classId} style={styles.card}>
            <Text style={styles.cardTitle}>{`${CIRCLED[index] ?? `${index + 1}.`} 이후 회차 · ${group.classTitle}`}</Text>
            <Text style={sessionStyles.hint}>{`${group.firstWhen} · 남은 ${group.sessionIds.length}회 · 결제 ${group.maxMemberCount}명`}</Text>
            <ChipRow>
              {RELEASE_SESSION_ACTIONS.map((action) => (
                <Chip key={action} label={RELEASE_SESSION_LABELS[action]} selected={picked === action} onPress={() => pickClass(group.classId, action)} />
              ))}
            </ChipRow>
            {picked !== undefined && (
              <Text style={sessionStyles.hint}>{`${RELEASE_SESSION_HINTS[picked]} · 정하면 ${group.maxMemberCount}명에게 알림이 가요`}</Text>
            )}
          </View>
        );
      })}

      {passes.map((pass, index) => {
        const picked = choices.passActions[pass.passId];
        return (
          <View key={pass.passId} style={styles.card}>
            <Text style={styles.cardTitle}>{`${CIRCLED[groups.length + index] ?? ''} 개인 레슨 남은 회차 · ${pass.memberDisplayName}`}</Text>
            <Text style={sessionStyles.hint}>{`남은 ${pass.remainingSessions}회`}</Text>
            <ChipRow>
              {RELEASE_PASS_ACTIONS.map((action) => (
                <Chip key={action} label={RELEASE_PASS_LABELS[action]} selected={picked === action} onPress={() => pickPass(pass.passId, action)} />
              ))}
            </ChipRow>
            {picked === 'refund' && <Text style={styles.accent}>{`환불 금액은 ${card.academyName} 대표가 정해요`}</Text>}
          </View>
        );
      })}

      <Text style={sessionStyles.caption}>해제한 뒤에도</Text>
      <View style={styles.card}>
        {['진행 중인 정산(보류·예정)은 수업한 만큼 받아요', '이 학원의 지난 정산 내역을 볼 수 있어요', '학원 시간표·공지·학원 색은 사라져요'].map((line) => (
          <View key={line} style={styles.bulletRow}>
            <View style={styles.bullet} />
            <Text style={styles.bulletText}>{line}</Text>
          </View>
        ))}
      </View>
      <Text style={sessionStyles.hint}>
        대표가 먼저 해제를 시작할 수도 있어요. 절차는 같아요. 알림 받을 회원 명단을 한 번 더 보여 드려요. 회원을 빼고 보낼 수는 없어요.
      </Text>

      {open.error !== null && <Text style={formStyles.danger}>{open.error}</Text>}
      <Pressable
        style={[styles.primary, (left > 0 || open.busy) && styles.primaryOff]}
        onPress={() => void handleOpen()}
        disabled={left > 0 || open.busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: left > 0 || open.busy }}
      >
        <Text style={[styles.primaryText, (left > 0 || open.busy) && styles.primaryTextOff]}>
          {left > 0 ? `${total}가지를 정하면 해제할 수 있어요` : open.busy ? '확인하는 중' : '해제 요청'}
        </Text>
      </Pressable>

      <ReleaseSheet preview={sheet} academyName={card.academyName} busy={send.busy} error={send.error} onClose={() => setSheet(null)} onSend={() => void handleSend()} />
    </View>
  );
}

interface SheetProps {
  preview: ReleasePreview | null;
  academyName: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSend: () => void;
}

/** I28B 확인 시트 — 처리별 묶음(휴강·대체 강사·폐강)마다 회원에게 갈 문구와 받는 회원 명단 */
function ReleaseSheet({ preview, academyName, busy, error, onClose, onSend }: SheetProps) {
  const [openBundle, setOpenBundle] = useState<number>(0);
  if (preview === null) return null;
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} accessibilityViewIsModal>
          <View style={styles.grabber} />
          <ScrollView contentContainerStyle={styles.sheetBody}>
            <Text style={styles.sheetTitle} accessibilityRole="header">
              해제를 요청할까요?
            </Text>
            <Text style={sessionStyles.hint}>{`${academyName} · 대표가 확인하면 아래 회원에게 알림이 가요`}</Text>

            {preview.bundles.map((bundle, index) => {
              const expanded = openBundle === index;
              return (
                <View key={bundle.action} style={styles.bundle}>
                  <Pressable
                    style={styles.bundleHead}
                    onPress={() => setOpenBundle(expanded ? -1 : index)}
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                  >
                    <Text style={styles.bundleTag}>{RELEASE_SESSION_LABELS[bundle.action]}</Text>
                    <Text style={styles.bundleTitle}>{`${bundle.sessionCount}회 · ${bundle.memberCount}명`}</Text>
                    <Text style={styles.bundleToggle}>{expanded ? '접기 ▲' : '명단 보기 ▼'}</Text>
                  </Pressable>
                  {expanded && (
                    <>
                      <View style={styles.quote}>
                        <Text style={styles.quoteText}>{bundle.messagePreview}</Text>
                      </View>
                      <Text style={styles.membersHead}>{`받는 회원 ${bundle.memberCount}명`}</Text>
                      <View style={styles.members}>
                        {bundle.members.map((member, i) => (
                          <View key={`${member.displayName}-${i}`} style={styles.member}>
                            <Text style={styles.memberName}>{member.displayName}</Text>
                            <Text style={styles.memberKind}>{member.payKind === 'paid' ? '결제' : '수강권'}</Text>
                          </View>
                        ))}
                      </View>
                    </>
                  )}
                </View>
              );
            })}

            <View style={styles.totals}>
              <Text style={styles.totalsTitle}>{`받는 회원 ${preview.totals.memberCount}명 · 알림은 회원마다 1건`}</Text>
              <Text style={sessionStyles.hint}>회차가 여러 개여도 회원마다 한 번에 모아 보내요</Text>
            </View>
            {error !== null && <Text style={formStyles.danger}>{error}</Text>}
            <BottomButtons
              secondary={{ label: '돌아가기', onPress: onClose, disabled: busy }}
              primary={{ label: busy ? '보내는 중' : '해제 요청 보내기', onPress: onSend, disabled: busy }}
            />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  headBlock: { gap: 2, marginTop: space.xs },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.sm },
  cardTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  accent: { color: colors.brown, fontSize: font.small, fontWeight: '700' },
  bulletRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  bullet: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.brown },
  bulletText: { color: colors.ink, fontSize: font.small, flex: 1 },
  primary: { minHeight: MIN_TOUCH + 4, borderRadius: radius.lg, backgroundColor: colors.brown, alignItems: 'center', justifyContent: 'center', marginTop: space.sm },
  primaryOff: { backgroundColor: colors.disabled },
  primaryText: { color: colors.surface, fontSize: 15, fontWeight: '800' },
  primaryTextOff: { color: colors.disabledInk },
  doneBox: { backgroundColor: colors.brownSoft, borderRadius: radius.md, padding: space.lg, gap: 4 },
  doneTitle: { color: colors.brown, fontSize: 15, fontWeight: '800' },
  doneText: { color: colors.ink, fontSize: font.small, lineHeight: 18 },
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
  bundleToggle: { color: colors.brown, fontSize: font.small, fontWeight: '700' },
  quote: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: space.md },
  quoteText: { color: colors.ink, fontSize: font.small, lineHeight: 19 },
  membersHead: { color: colors.ink3, fontSize: font.small, fontWeight: '700' },
  members: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 6 },
  member: { width: '50%', flexDirection: 'row', gap: space.sm },
  memberName: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  memberKind: { color: colors.ink3, fontSize: font.small },
  totals: { backgroundColor: colors.brownSoft, borderRadius: radius.md, padding: space.md, gap: 2 },
  totalsTitle: { color: colors.brown, fontSize: 15, fontWeight: '800' },
});
