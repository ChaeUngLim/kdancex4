/**
 * 수강생 공지 쓰기(보드 I13) · 미리보기(I13B) — S2-3.8(앱 변경·대타·공지 화면).
 * 주소 `/instructor/sessions/{sessionId}/announce?classId=…`.
 *
 * spec FR-063(강사 공지) 화면 규칙 그대로:
 *  - I13 쓰기: 받는 사람(이 회차 확정 수강생 수와 남·여 — 결제 대기·대기 신청은 받지 않는다), 종류 칩
 *    `일반 · 준비물 · 진도·복습` 중 하나, 제목, 내용(500자), 「앱 알림으로도 보내기」(기본 켜짐) → 「미리보기」
 *  - I13B 미리보기: 회원 알림함에 보일 모양 + 수업 상세 「강사 공지」에 남을 모양 → 「고치기」 · 「N명에게 보내기」
 *  - 시간·장소 변경과 휴강은 공지 종류가 아니다(FR-141 이 따로 다룬다) — 그래서 칩에 없다
 *
 * 서버: GET …/announcement-recipients?sessionId= · POST …/announcements(키 필수) — 계약 11 §6-3, S2-3.5.
 * 「보내기」는 버튼 핸들러에서만 부른다. 같은 미리보기에서 다시 누르면 같은 키를 다시 써서 두 번 쌓이지 않는다.
 */
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { LoadingView } from '../../../../lib/catalog/ui';
import { newIdempotencyKey, useApiResource } from '../../../../lib/catalog/use-api-resource';
import { BottomButtons, Chip, ChipRow, FieldLabel, formStyles } from '../../../../lib/instructor/class-form-ui';
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_KIND_LABELS,
  ANNOUNCEMENT_KINDS,
  ANNOUNCEMENT_TITLE_MAX,
  announcementProblem,
  recipientsPath,
  sendAnnouncement,
  sessionWhen,
  stepWhen,
  type AnnouncementKind,
  type AnnouncementRecipients,
} from '../../../../lib/instructor/session-api';
import { SessionGate, sessionStyles, useSessionContext, type SessionContext } from '../../../../lib/instructor/session-ui';
import { goBack, InstructorShell, StaffErrorView, useAction } from '../../../../lib/instructor/staff-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../../../../lib/theme';

type Stage = 'write' | 'preview' | 'sent';

export default function AnnounceScreen() {
  const params = useLocalSearchParams<{ sessionId?: string; classId?: string }>();
  const state = useSessionContext(params.classId, params.sessionId);
  const [stage, setStage] = useState<Stage>('write');

  const title = stage === 'preview' ? '공지 미리보기' : '수강생 공지';
  // 미리보기에서 뒤로 가면 쓰던 칸으로 돌아간다(화면을 떠나지 않는다)
  const back = () => (stage === 'preview' ? setStage('write') : goBack('/instructor/academy'));
  return (
    <InstructorShell title={title} active="classes" onBack={back}>
      <SessionGate state={state}>{(ctx) => <AnnounceBody ctx={ctx} stage={stage} onStage={setStage} />}</SessionGate>
    </InstructorShell>
  );
}

function AnnounceBody({ ctx, stage, onStage }: { ctx: SessionContext; stage: Stage; onStage: (next: Stage) => void }) {
  const { cls, session } = ctx;
  const recipients = useApiResource<AnnouncementRecipients>(recipientsPath(cls.classId, session.sessionId));
  const [kind, setKind] = useState<AnnouncementKind>('general');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [pushToo, setPushToo] = useState(true);
  const [tried, setTried] = useState(false);
  // 한 번의 「보내기」 시도에 쓰는 키. 칸을 고치면 새 공지이므로 새 키를 만든다
  const [sendKey, setSendKey] = useState(newIdempotencyKey);
  const [sent, setSent] = useState<{ recipientCount: number; createdAt: string } | null>(null);
  const send = useAction();

  if (recipients.state.status === 'error') return <StaffErrorView error={recipients.state.error} onRetry={recipients.reload} />;
  if (recipients.state.status === 'loading') return <LoadingView label="받는 사람을 세고 있어요" />;
  const who = recipients.state.data;

  const problem = announcementProblem({ title: subject, body });
  const edit = (apply: () => void) => {
    apply();
    setSendKey(newIdempotencyKey());
  };

  const handlePreview = () => {
    setTried(true);
    if (problem === null) onStage('preview');
  };

  const handleSend = async () => {
    const result = await send.run(() =>
      sendAnnouncement(cls.classId, { sessionId: session.sessionId, kind, title: subject, body, pushToo }, sendKey),
    );
    if (result !== null) {
      setSent({ recipientCount: result.recipientCount, createdAt: result.createdAt });
      onStage('sent');
    }
  };

  // ---- 보낸 뒤 ----
  if (stage === 'sent' && sent !== null) {
    return (
      <View style={styles.stack}>
        <View style={styles.doneBox}>
          <Text style={styles.doneTitle}>{`공지를 보냈어요 · ${sent.recipientCount}명`}</Text>
          <Text style={styles.doneText}>
            {pushToo
              ? '수강생 알림함과 수업 상세의 「강사 공지」에 남아요.'
              : '앱 알림은 보내지 않았어요. 수강생 알림함과 수업 상세의 「강사 공지」에는 남아요.'}
          </Text>
        </View>
        <BottomButtons
          secondary={{ label: '새 공지 쓰기', onPress: () => edit(() => { setSubject(''); setBody(''); setTried(false); setSent(null); onStage('write'); }) }}
          primary={{ label: '회차로 돌아가기', onPress: () => goBack('/instructor/academy') }}
        />
      </View>
    );
  }

  // ---- I13B 미리보기 ----
  if (stage === 'preview') {
    const kindLabel = ANNOUNCEMENT_KIND_LABELS[kind];
    return (
      <View style={styles.stack}>
        <Text style={sessionStyles.caption}>회원 알림함에 이렇게 보여요</Text>
        <View style={styles.inboxCard}>
          <View style={styles.inboxHead}>
            <Text style={styles.tag}>{kindLabel}</Text>
            <Text style={styles.inboxFrom}>{`${cls.title} · ${cls.instructor?.displayName ?? ''} 강사`}</Text>
          </View>
          <Text style={styles.inboxTitle}>{subject.trim()}</Text>
          <Text style={styles.inboxBody} numberOfLines={2}>
            {body.trim()}
          </Text>
          {!pushToo && <Text style={styles.pushOff}>앱 알림은 보내지 않아요 · 알림함에만 남아요</Text>}
        </View>

        <Text style={sessionStyles.caption}>수업 상세 「강사 공지」에 이렇게 남아요</Text>
        <View style={styles.detailCard}>
          <Text style={styles.detailHead}>강사 공지</Text>
          <View style={styles.detailRow}>
            <Text style={styles.tag}>{kindLabel}</Text>
            <Text style={styles.detailMeta}>{`${stepWhen(new Date().toISOString())} · ${cls.instructor?.displayName ?? ''} 강사`}</Text>
          </View>
          <Text style={styles.detailTitle}>{subject.trim()}</Text>
          <Text style={styles.detailBody}>{body.trim()}</Text>
        </View>

        {send.error !== null && <Text style={formStyles.danger}>{send.error}</Text>}
        <BottomButtons
          secondary={{ label: '고치기', onPress: () => onStage('write'), disabled: send.busy }}
          primary={{
            label: send.busy ? '보내는 중' : `${who.recipientCount}명에게 보내기`,
            onPress: () => void handleSend(),
            disabled: send.busy,
          }}
        />
      </View>
    );
  }

  // ---- I13 쓰기 ----
  return (
    <View style={styles.stack}>
      <View style={styles.whoCard}>
        <Text style={sessionStyles.caption}>받는 사람</Text>
        <Text style={styles.whoMain}>{`${cls.title} 수강생 ${who.recipientCount}명`}</Text>
        <Text style={sessionStyles.hint}>{`남 ${who.male} · 여 ${who.female} · ${sessionWhen(session.startsAt, session.endsAt)} 회차`}</Text>
        <Text style={sessionStyles.hint}>{who.excluded}</Text>
      </View>

      <View style={formStyles.section}>
        <FieldLabel title="종류" />
        <ChipRow>
          {ANNOUNCEMENT_KINDS.map((value) => (
            <Chip key={value} label={ANNOUNCEMENT_KIND_LABELS[value]} selected={kind === value} onPress={() => edit(() => setKind(value))} />
          ))}
        </ChipRow>
        <Text style={sessionStyles.hint}>시간·장소 변경과 휴강은 회차 상세의 「시간·장소 변경」 · 「휴강 알리기」로 알려요.</Text>
      </View>

      <View style={formStyles.section}>
        <FieldLabel title="제목" badge={`${subject.trim().length}/${ANNOUNCEMENT_TITLE_MAX}`} />
        <TextInput
          style={formStyles.input}
          value={subject}
          onChangeText={(text) => edit(() => setSubject(text))}
          placeholder="예: 다음 주는 개인 매트를 챙겨 주세요"
          placeholderTextColor={colors.ink3}
          maxLength={ANNOUNCEMENT_TITLE_MAX}
          accessibilityLabel="공지 제목"
        />
      </View>

      <View style={formStyles.section}>
        <FieldLabel title="내용" badge={`${body.trim().length}/${ANNOUNCEMENT_BODY_MAX}`} />
        <TextInput
          style={[formStyles.input, styles.bodyInput]}
          value={body}
          onChangeText={(text) => edit(() => setBody(text))}
          placeholder="수강생에게 전할 내용을 적어 주세요"
          placeholderTextColor={colors.ink3}
          maxLength={ANNOUNCEMENT_BODY_MAX}
          multiline
          textAlignVertical="top"
          accessibilityLabel="공지 내용"
        />
      </View>

      <Pressable
        style={styles.pushRow}
        onPress={() => edit(() => setPushToo(!pushToo))}
        accessibilityRole="switch"
        accessibilityLabel="앱 알림으로도 보내기"
        accessibilityState={{ checked: pushToo }}
        // 웹(react-native-web)은 accessibilityState 의 checked 를 읽어 주지 않아 aria-checked 를 함께 준다(class-form-ui Chip 과 같은 처리)
        aria-checked={pushToo}
      >
        <View style={styles.flex}>
          <Text style={styles.pushTitle}>앱 알림으로도 보내기</Text>
          <Text style={sessionStyles.hint}>끄면 알림은 울리지 않고 알림함과 수업 상세에만 남아요</Text>
        </View>
        <Switch value={pushToo} onValueChange={(value) => edit(() => setPushToo(value))} trackColor={{ true: colors.brown, false: colors.line }} thumbColor={colors.surface} />
      </Pressable>

      {tried && problem !== null && <Text style={formStyles.danger}>{problem}</Text>}
      <BottomButtons secondary={{ label: '취소', onPress: () => goBack('/instructor/academy') }} primary={{ label: '미리보기', onPress: handlePreview }} />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  flex: { flex: 1 },
  whoCard: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: 4 },
  whoMain: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  bodyInput: { minHeight: 140, paddingTop: space.md },
  pushRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: MIN_TOUCH,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.md,
  },
  pushTitle: { color: colors.ink, fontSize: font.body, fontWeight: '700' },
  tag: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.brownSoft,
    color: colors.brown,
    fontSize: font.tiny,
    fontWeight: '800',
    overflow: 'hidden',
  },
  inboxCard: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: 6 },
  inboxHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  inboxFrom: { color: colors.ink3, fontSize: font.small, flexShrink: 1 },
  inboxTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  inboxBody: { color: colors.ink, fontSize: font.small, lineHeight: 18 },
  pushOff: { color: colors.disabledInk, fontSize: font.tiny, fontWeight: '700' },
  detailCard: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: 6 },
  detailHead: { color: colors.ink, fontSize: 15, fontWeight: '800', marginBottom: 2 },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  detailMeta: { color: colors.ink3, fontSize: font.small },
  detailTitle: { color: colors.ink, fontSize: font.body, fontWeight: '700' },
  detailBody: { color: colors.ink, fontSize: font.small, lineHeight: 19 },
  doneBox: { backgroundColor: colors.brownSoft, borderRadius: radius.md, padding: space.lg, gap: 4 },
  doneTitle: { color: colors.brown, fontSize: 15, fontWeight: '800' },
  doneText: { color: colors.ink, fontSize: font.small, lineHeight: 18 },
});
