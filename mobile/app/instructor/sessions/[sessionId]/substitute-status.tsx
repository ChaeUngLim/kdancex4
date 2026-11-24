/**
 * 대타 요청 진행 상황(보드 I14B) — S2-3.8(앱 변경·대타·공지 화면).
 * 주소 `/instructor/sessions/{sessionId}/substitute-status?classId=…`.
 *
 * 내가 보낸 요청을 네 단계(요청 → 대타 수락 → 대표 확인 → 수강생 공지)로 보여 준다.
 * 대표가 확인하기 전(open·accepted)까지만 「요청 취소」를 누를 수 있다(계약 11 §8-2 — 확인 뒤에는 409).
 *
 * 서버: GET /api/instructor/substitute-requests?role=requested 에서 이 회차의 요청을 고른다 · POST …/{id}/cancel — S2-3.4.
 * 학원 이름은 수업 상세(GET /api/classes/{classId})에서 읽는다(「라틴하우스 강남 대표에게 알림이 갔어요」).
 */
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { EmptyView, LoadingView } from '../../../../lib/catalog/ui';
import { readRouteId, useApiResource } from '../../../../lib/catalog/use-api-resource';
import { classPath, type ClassRegistration } from '../../../../lib/instructor/class-api';
import {
  cancelSubstitute,
  latestRequestOf,
  memberCountLine,
  requestedListPath,
  SUBSTITUTE_STATUS_LABELS,
  substituteTimeline,
  type SubstituteRequestItem,
} from '../../../../lib/instructor/session-api';
import { Notice, SessionCard, sessionStyles } from '../../../../lib/instructor/session-ui';
import { BottomButtons, formStyles } from '../../../../lib/instructor/class-form-ui';
import { goBack, InstructorShell, StaffErrorView, useAction } from '../../../../lib/instructor/staff-ui';
import { colors, font, radius, space } from '../../../../lib/theme';

export default function SubstituteStatusScreen() {
  const params = useLocalSearchParams<{ sessionId?: string; classId?: string }>();
  const sessionId = readRouteId(params.sessionId);
  const classId = readRouteId(params.classId);
  const list = useApiResource<{ items: SubstituteRequestItem[] }>(sessionId === null ? null : requestedListPath);
  // 학원 이름 한 줄만 쓰므로, 못 읽어도 화면은 그린다(「학원 대표」로 대신)
  const cls = useApiResource<ClassRegistration>(classId === null ? null : classPath(classId));
  const cancel = useAction();

  const back = () => goBack('/instructor/academy');
  let body;
  if (sessionId === null) {
    body = <EmptyView title="회차 주소가 올바르지 않아요" />;
  } else if (list.state.status === 'error') {
    body = <StaffErrorView error={list.state.error} onRetry={list.reload} />;
  } else if (list.state.status === 'loading') {
    body = <LoadingView label="요청 상황을 불러오고 있어요" />;
  } else {
    const item = latestRequestOf(list.state.data.items, sessionId);
    if (item === null) {
      body = <EmptyView title="이 회차에 보낸 대타 요청이 없어요" hint="회차 상세의 「대타 요청」에서 보낼 수 있어요." />;
    } else {
      const academyName = cls.state.status === 'ready' ? cls.state.data.academyName : null;
      const steps = substituteTimeline(item, academyName);
      const cancellable = item.status === 'open' || item.status === 'accepted';
      const handleCancel = async () => {
        const result = await cancel.run(() => cancelSubstitute(item.requestId));
        // 취소되면 목록을 다시 읽어 「요청을 취소했어요」 상태로 다시 그린다
        if (result !== null) list.reload();
      };
      body = (
        <View style={styles.stack}>
          <SessionCard
            title={item.session.classTitle}
            startsAt={item.session.startsAt}
            endsAt={item.session.endsAt}
            sub={`${academyName ?? ''} ${item.session.roomName} · 수강생 ${memberCountLine(item.session.memberCount)}`.trim()}
          />

          {!cancellable && <Text style={styles.status}>{SUBSTITUTE_STATUS_LABELS[item.status] ?? item.status}</Text>}

          <View style={styles.timeline}>
            {steps.map((step, index) => (
              <View key={step.key} style={styles.stepRow}>
                <View style={styles.rail}>
                  <View style={[styles.dot, step.state === 'done' && styles.dotDone, step.state === 'current' && styles.dotCurrent]}>
                    {step.state === 'done' && <Text style={styles.dotCheck}>✓</Text>}
                  </View>
                  {index < steps.length - 1 && <View style={[styles.line, step.state === 'done' && styles.lineDone]} />}
                </View>
                <View style={styles.stepText} accessible accessibilityLabel={`${step.title}, ${step.detail}`}>
                  <Text style={[styles.stepTitle, step.state === 'todo' && styles.stepTitleTodo]}>{step.title}</Text>
                  <Text style={sessionStyles.hint}>{step.detail}</Text>
                </View>
              </View>
            ))}
          </View>

          <Notice>이 회차의 정산은 실제로 수업한 강사 몫으로 잡혀요.</Notice>
          {cancellable && <Text style={sessionStyles.hint}>대표가 확인하기 전까지는 요청을 취소할 수 있어요.</Text>}
          {cancel.error !== null && <Text style={formStyles.danger}>{cancel.error}</Text>}
          {cancellable && (
            <BottomButtons
              secondary={{ label: '뒤로', onPress: back, disabled: cancel.busy }}
              primary={{ label: cancel.busy ? '취소하는 중' : '요청 취소', onPress: () => void handleCancel(), disabled: cancel.busy }}
            />
          )}
        </View>
      );
    }
  }

  return (
    <InstructorShell title="대타 요청" active="classes" onBack={back}>
      {body}
    </InstructorShell>
  );
}

const DOT = 22;

const styles = StyleSheet.create({
  stack: { gap: space.md },
  status: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.disabled,
    color: colors.disabledInk,
    fontSize: font.small,
    fontWeight: '800',
    overflow: 'hidden',
  },
  timeline: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg },
  stepRow: { flexDirection: 'row', gap: space.md },
  rail: { width: DOT, alignItems: 'center' },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  dotDone: { backgroundColor: colors.brown, borderColor: colors.brown },
  dotCurrent: { borderColor: colors.brown, borderWidth: 6 },
  dotCheck: { color: colors.surface, fontSize: 12, fontWeight: '800' },
  line: { flex: 1, width: 2, minHeight: 28, backgroundColor: colors.line },
  lineDone: { backgroundColor: colors.brown },
  stepText: { flex: 1, gap: 2, paddingBottom: space.lg },
  stepTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  stepTitleTodo: { color: colors.ink3, fontWeight: '700' },
});
