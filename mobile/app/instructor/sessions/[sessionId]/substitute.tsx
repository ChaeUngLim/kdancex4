/**
 * 대타 요청(보드 I14) — S2-3.8(앱 변경·대타·공지 화면). 주소 `/instructor/sessions/{sessionId}/substitute?classId=…`.
 *
 * 같은 학원 · 같은 장르 · 그 시간에 일정이 없는 강사만 고를 수 있다(계약 11 §8-1). 일정이 있는 강사는
 * 「그 시간에 일정이 있어요」로 보이고 고를 수 없다 — 무슨 일정인지는 서버도 주지 않는다(FR-053).
 * 고른 강사 모두에게 알림이 가고, 먼저 수락한 한 명으로 정해진 뒤 대표가 확인하면 수강생에게 알림이 간다.
 *
 * 서버: GET /api/sessions/{id}/substitute-candidates · POST /api/instructor/substitute-requests(키 필수) — S2-3.4.
 * 보낸 뒤에는 진행 상황(I14B)으로 바꿔 끼운다(뒤로 가기로 같은 요청을 또 쓰지 않게).
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { EmptyView, LoadingView } from '../../../../lib/catalog/ui';
import { newIdempotencyKey, useApiResource } from '../../../../lib/catalog/use-api-resource';
import { formStyles } from '../../../../lib/instructor/class-form-ui';
import {
  candidatesPath,
  requestSubstitute,
  SUBSTITUTE_MESSAGE_MAX,
  type SubstituteCandidate,
} from '../../../../lib/instructor/session-api';
import { Notice, SessionCard, SessionGate, sessionStyles, useSessionContext, type SessionContext } from '../../../../lib/instructor/session-ui';
import { goBack, InstructorShell, StaffErrorView, useAction } from '../../../../lib/instructor/staff-ui';
import { genreLabel } from '../../../../lib/catalog/format';
import type { Genre } from '../../../../lib/onboarding/types';
import { colors, font, MIN_TOUCH, radius, space } from '../../../../lib/theme';

/** I14 아래 「이렇게 진행돼요」 네 칸 */
const STEPS = ['요청', '대타 수락', '대표 확인', '수강생 공지'] as const;

export default function SubstituteRequestScreen() {
  const params = useLocalSearchParams<{ sessionId?: string; classId?: string }>();
  const state = useSessionContext(params.classId, params.sessionId);
  return (
    <InstructorShell title="대타 요청" active="classes" onBack={() => goBack('/instructor/academy')}>
      <SessionGate state={state}>{(ctx) => <RequestBody ctx={ctx} />}</SessionGate>
    </InstructorShell>
  );
}

function RequestBody({ ctx }: { ctx: SessionContext }) {
  const { cls, session } = ctx;
  const candidates = useApiResource<{ sessionId: string; items: SubstituteCandidate[] }>(candidatesPath(session.sessionId));
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [message, setMessage] = useState('');
  const [sendKey] = useState(newIdempotencyKey);
  const send = useAction();

  if (candidates.state.status === 'error') return <StaffErrorView error={candidates.state.error} onRetry={candidates.reload} />;
  if (candidates.state.status === 'loading') return <LoadingView label="대타를 맡을 수 있는 강사를 찾고 있어요" />;
  const items = candidates.state.data.items;

  // 고를 수 없는(busy) 강사는 눌러도 바뀌지 않는다. 새 배열로 바꿔 끼운다
  const toggle = (item: SubstituteCandidate) => {
    if (!item.available) return;
    setPicked(picked.includes(item.accountId) ? picked.filter((id) => id !== item.accountId) : [...picked, item.accountId]);
  };

  const handleSend = async () => {
    const result = await send.run(() => requestSubstitute(session.sessionId, picked, message, sendKey));
    if (result !== null) {
      router.replace(`/instructor/sessions/${encodeURIComponent(session.sessionId)}/substitute-status?classId=${encodeURIComponent(cls.classId)}`);
    }
  };

  const place = session.room === null ? cls.academyName : `${cls.academyName} ${session.room.name}`;
  return (
    <View style={styles.stack}>
      <Text style={sessionStyles.caption}>대타가 필요한 회차</Text>
      <SessionCard title={cls.title} startsAt={session.startsAt} endsAt={session.endsAt} sub={`${place} · 수강생 ${session.confirmedMemberCount}명`} />

      <View style={styles.headBlock}>
        <Text style={sessionStyles.sectionTitle}>누구에게 알릴까요</Text>
        <Text style={sessionStyles.hint}>같은 학원 · 같은 장르 · 그 시간에 일정이 없는 강사만 고를 수 있어요</Text>
      </View>
      {items.length === 0 ? (
        <EmptyView title="대타를 맡을 수 있는 강사가 없어요" hint="같은 학원에 같은 장르 강사가 소속되면 여기에 보여요." />
      ) : (
        <View style={styles.list}>
          {items.map((item, index) => {
            const on = picked.includes(item.accountId);
            const genre = genreLabel(item.genre as Genre) || '';
            return (
              <Pressable
                key={item.accountId}
                style={[styles.row, index > 0 && styles.divider]}
                onPress={() => toggle(item)}
                disabled={!item.available}
                accessibilityRole="checkbox"
                accessibilityLabel={item.available ? `${item.displayName} 강사` : `${item.displayName} 강사, 그 시간에 일정이 있어요`}
                accessibilityState={{ checked: on, disabled: !item.available }}
                aria-checked={on}
              >
                <View style={styles.avatar} />
                <View style={styles.flex}>
                  <Text style={[styles.name, !item.available && styles.nameOff]}>{`${item.displayName} 강사`}</Text>
                  {item.available ? (
                    <Text style={sessionStyles.hint}>{`${genre} · 그 시간 비어 있음`}</Text>
                  ) : (
                    <Text style={styles.busy}>그 시간에 일정이 있어요</Text>
                  )}
                </View>
                <View style={[styles.box, on && styles.boxOn, !item.available && styles.boxOff]}>
                  {on && <Text style={styles.check}>✓</Text>}
                </View>
              </Pressable>
            );
          })}
        </View>
      )}

      <View style={formStyles.section}>
        <Text style={sessionStyles.caption}>전할 말 · 선택</Text>
        <TextInput
          style={[formStyles.input, styles.message]}
          value={message}
          onChangeText={setMessage}
          placeholder="예: 이번 회차만 부탁드려요. 진도는 베이직 3번까지 나갔어요."
          placeholderTextColor={colors.ink3}
          maxLength={SUBSTITUTE_MESSAGE_MAX}
          multiline
          textAlignVertical="top"
          accessibilityLabel="전할 말"
        />
      </View>

      <View style={formStyles.section}>
        <Text style={sessionStyles.caption}>이렇게 진행돼요</Text>
        <View style={styles.steps}>
          {STEPS.map((step, index) => (
            <View key={step} style={styles.stepItem}>
              <Text style={[styles.step, index === 0 && styles.stepOn]}>{step}</Text>
              {index < STEPS.length - 1 && <Text style={styles.stepArrow}>›</Text>}
            </View>
          ))}
        </View>
        <Text style={sessionStyles.hint}>먼저 수락한 강사로 정해져요. 대표가 확인하면 수강생에게 알림이 가요.</Text>
      </View>

      <Notice>이 회차의 정산은 실제로 수업한 강사 몫으로 잡혀요.</Notice>

      {send.error !== null && <Text style={formStyles.danger}>{send.error}</Text>}
      <Pressable
        style={[styles.primary, (picked.length === 0 || send.busy) && styles.primaryOff]}
        onPress={() => void handleSend()}
        disabled={picked.length === 0 || send.busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: picked.length === 0 || send.busy }}
      >
        <Text style={[styles.primaryText, (picked.length === 0 || send.busy) && styles.primaryTextOff]}>
          {send.busy ? '보내는 중' : picked.length === 0 ? '대타 강사를 골라 주세요' : `${picked.length}명에게 대타 요청 보내기`}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  flex: { flex: 1 },
  headBlock: { gap: 2, marginTop: space.xs },
  list: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, paddingHorizontal: space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: MIN_TOUCH + 12, paddingVertical: space.md },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  avatar: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.disabled },
  name: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  nameOff: { color: colors.disabledInk },
  busy: { color: colors.danger, fontSize: font.small },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 1.5, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  boxOn: { backgroundColor: colors.brown, borderColor: colors.brown },
  boxOff: { backgroundColor: colors.disabled },
  check: { color: colors.surface, fontSize: 14, fontWeight: '800' },
  message: { minHeight: 72, paddingTop: space.md },
  steps: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
  stepItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  step: {
    paddingHorizontal: space.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    color: colors.ink,
    fontSize: font.small,
    fontWeight: '700',
    overflow: 'hidden',
  },
  stepOn: { backgroundColor: colors.brown, borderColor: colors.brown, color: colors.surface },
  stepArrow: { color: colors.ink3, fontSize: font.small },
  primary: { minHeight: MIN_TOUCH + 4, borderRadius: radius.lg, backgroundColor: colors.brown, alignItems: 'center', justifyContent: 'center', marginTop: space.sm },
  primaryOff: { backgroundColor: colors.disabled },
  primaryText: { color: colors.surface, fontSize: 15, fontWeight: '800' },
  primaryTextOff: { color: colors.disabledInk },
});
