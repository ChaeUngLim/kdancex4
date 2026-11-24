/**
 * AI 플래너 — 강사 수업 말로 찾기(보드 M10 · M10F 수업 카드 답 · M10G 강사 고르기, spec FR-037a · SX-5.7).
 *
 * 처음 보는 사람용 요약
 *  - 회원이 「이준호 강사님의 라틴하우스 강남 수업 모두 알려줘」처럼 물으면 `POST /api/ai/chat`(계약 16 §3)에 보낸다.
 *    답은 서버가 DB 에서 찾은 게시 수업 카드다. AI 가 지어낸 수업은 나오지 않는다(FR-039).
 *  - 같은 이름 강사가 여럿이면 수업 대신 강사 후보 카드가 온다(M10G). 「선택」을 누르면 같은 질문을 그 강사로 정해
 *    다시 묻는다(`context.instructorId`).
 *  - 강사 프로필(M15)의 「AI 플래너에게 이 강사 수업 물어보기」는 이 화면을 `instructorId`·`instructorName` 주소 값으로 연다.
 *    그러면 위쪽에 「강사 ○○ · 정해짐」 칩이 붙고, 다음 질문부터 그 강사로 찾는다. ✕ 로 풀 수 있다.
 *  - 「신청하기」는 수업 상세로만 간다. AI 는 예약·결제를 하지 않는다(FR-214). 전용 화면을 따로 만들지 않고 플래너에 합쳤다.
 *  - 보내기는 버튼을 누를 때(이벤트 처리기)만 한다. 화면이 열릴 때 저절로 묻지 않는다(useEffect 를 쓰지 않는 규칙).
 *  - SX-5.8(말로 찾기 실동작·챗봇 대화형 AI 답변): 화면을 대화 흐름으로 바꿨다. 내 질문은 오른쪽, AI 답은 왼쪽 말풍선이고
 *    답 문장은 오는 대로 흘러나온다(`apiFetchStream`). 수업 카드는 AI 말풍선 아래에 붙는다(lib/planner/chat-turn.tsx).
 *    이어 묻기(「그중 토요일만」)는 바로 앞 답의 조건을 `context.previousConditions` 로 실어 보내 좁힌다.
 *    대화 맥락은 이 화면 상태에만 있고 서버에 저장하지 않는다. 「새 대화」는 그 상태를 비운다.
 */
import { useRef, useState } from 'react';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ScrollViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { apiFetchStream } from '../lib/api';
import { MemberTabBar } from '../lib/catalog/tab-bar';
import { toApiError } from '../lib/catalog/use-api-resource';
import { buildPlannerAnswer, completeLines, parseUiChunks, type PlannerAnswer, type PlannerInstructorCandidate } from '../lib/planner/answer';
import { TurnView, type Turn } from '../lib/planner/chat-turn';
import { plannerStyles } from '../lib/planner/planner-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../lib/theme';

/** 정해 둔 강사(M15 입구·M10G 선택) */
interface FixedInstructor {
  id: string;
  name: string;
}

/** 한 질문을 어떻게 보낼지 — 정해 보낼 강사와 이어받을 앞 조건 */
interface AskOptions {
  instructorId: string | null;
  /** 앞 답의 조건(이어 묻기). null 이면 새 질문 */
  previous: PlannerAnswer['carryConditions'];
}

const MAX_QUESTION = 500; // 계약 16 §3 「message 1~500자」
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 주소로 들어온 강사 값 검사 — 딥링크 값은 믿지 않는다. id 가 uuid 가 아니면 정하지 않은 것으로 본다 */
function readFixedInstructor(params: { instructorId?: string | string[]; instructorName?: string | string[] }): FixedInstructor | null {
  const id = Array.isArray(params.instructorId) ? params.instructorId[0] : params.instructorId;
  const name = Array.isArray(params.instructorName) ? params.instructorName[0] : params.instructorName;
  if (id === undefined || !UUID.test(id)) return null;
  const cleanName = (name ?? '').trim().slice(0, 40);
  return { id, name: cleanName === '' ? '이 강사' : cleanName };
}

/** 대화에서 가장 최근에 조건이 나온 답의 조건 — 입력칸으로 새로 물을 때 이어받는다(없으면 새 질문) */
function latestCarry(turns: readonly Turn[]): PlannerAnswer['carryConditions'] {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn !== undefined && turn.status === 'done' && turn.answer.carryConditions !== null) return turn.answer.carryConditions;
  }
  return null;
}

export default function PlannerScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ instructorId?: string; instructorName?: string }>();
  // 주소 값은 처음 한 번만 읽어 상태로 둔다(✕ 로 풀 수 있게)
  const [fixed, setFixed] = useState<FixedInstructor | null>(() => readFixedInstructor(params));
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const nextKey = useRef(1);
  const scrollRef = useRef<ScrollViewInstance>(null);

  const busy = turns.some((t) => t.status === 'loading');
  const placeholder = fixed === null ? '강사·학원·요일로 물어보세요' : `${fixed.name} 강사님 수업을 물어보세요`;

  // 한 턴의 값만 새 값으로 바꾼다(다른 턴은 그대로)
  const updateTurn = (key: number, patch: Partial<Turn>) =>
    setTurns((current) => current.map((t) => (t.key === key ? { ...t, ...patch } : t)));

  /**
   * 질문 하나를 보낸다. 답 조각이 올 때마다 그때까지 온 줄로 답을 다시 만들어 말풍선을 키운다(글이 흘러나오듯).
   * 다 오면 전체 글로 한 번 더 읽어 마무리한다.
   */
  const ask = async (question: string, options: AskOptions) => {
    const text = question.trim().slice(0, MAX_QUESTION);
    if (text === '' || busy) return;
    const key = nextKey.current;
    nextKey.current += 1;
    const followUp = options.previous !== null;
    setTurns((current) => [
      ...current,
      { key, question: text, status: 'loading', answer: buildPlannerAnswer([]), errorText: null, followUp },
    ]);
    let raw = '';
    try {
      const whole = await apiFetchStream(
        '/api/ai/chat',
        {
          method: 'POST',
          body: {
            conversationId: null,
            context: {
              kind: 'planner',
              academyId: null,
              offeringId: null,
              instructorId: options.instructorId,
              // 이어 묻기 — 앞 답의 조건. 서버는 저장하지 않고 이번 질문에만 쓴다
              previousConditions: options.previous,
            },
            message: text,
          },
        },
        (piece) => {
          raw += piece;
          updateTurn(key, { answer: buildPlannerAnswer(parseUiChunks(completeLines(raw))) });
        },
      );
      updateTurn(key, { status: 'done', answer: buildPlannerAnswer(parseUiChunks(whole)) });
    } catch (error: unknown) {
      updateTurn(key, { status: 'error', errorText: toApiError(error).detail });
    }
    // 새 답이 보이게 맨 아래로
    scrollRef.current?.scrollToEnd({ animated: true });
  };

  // 입력칸으로 보내기 — 대화가 이어지는 중이면 앞 조건을 이어받는다(다른 강사를 말하면 서버가 새 대화로 본다)
  const onSend = () => {
    const question = draft;
    setDraft('');
    void ask(question, { instructorId: fixed?.id ?? null, previous: latestCarry(turns) });
  };

  // 추천 질문 칩 — 그 답의 조건을 이어받아 좁힌다
  const askFollowUp = (question: string, from: PlannerAnswer) =>
    void ask(question, { instructorId: fixed?.id ?? null, previous: from.carryConditions });

  // 넓히기 버튼 — 앞 조건 없이 새로 찾는다(좁힌 조건을 푸는 버튼이라서)
  const askFresh = (question: string, instructorId: string | null) => void ask(question, { instructorId, previous: null });

  // M10G 「선택」 — 그 강사로 정하고 같은 질문을 다시 묻는다
  const onSelectCandidate = (question: string) => (candidate: PlannerInstructorCandidate) => {
    setFixed({ id: candidate.instructorId, name: candidate.displayName });
    void ask(question, { instructorId: candidate.instructorId, previous: null });
  };

  // M15 로 연 뒤 첫 질문을 쉽게 — 누르면 바로 그 강사의 수업 전체를 묻는다
  const onAskAllOfFixed = () => {
    if (fixed !== null) void ask(`${fixed.name} 강사님 수업 모두 알려줘`, { instructorId: fixed.id, previous: null });
  };

  // 새 대화 — 이 화면의 대화 기록(이어 묻기 맥락)을 비운다. 정해 둔 강사 칩은 남긴다(✕ 로 따로 푼다)
  const onNewChat = () => {
    setTurns([]);
    setDraft('');
  };

  const goBack = () => (router.canGoBack() ? router.back() : router.navigate('/home'));

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable onPress={goBack} style={styles.back} accessibilityRole="button" accessibilityLabel="뒤로 가기">
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.headerTitle} accessibilityRole="header">
          AI 플래너
        </Text>
        <Pressable
          onPress={onNewChat}
          disabled={busy || turns.length === 0}
          style={[styles.newChat, (busy || turns.length === 0) && styles.newChatDisabled]}
          accessibilityRole="button"
          accessibilityLabel="새 대화"
          accessibilityState={{ disabled: busy || turns.length === 0 }}
        >
          <Text style={styles.newChatText}>＋ 새 대화</Text>
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        // 답이 오는 중에 말풍선이 자라면 따라 내려간다(이벤트 처리기 — 화면이 열릴 때 저절로 돌지 않는다)
        onContentSizeChange={() => {
          if (busy) scrollRef.current?.scrollToEnd({ animated: true });
        }}
      >
        {fixed !== null && (
          <View style={styles.fixedRow}>
            <View style={styles.fixedChip}>
              <Text style={styles.fixedChipText}>강사 {fixed.name} · 정해짐</Text>
              <Pressable
                onPress={() => setFixed(null)}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel={`${fixed.name} 강사 정하기 풀기`}
              >
                <Text style={styles.fixedChipX}>✕</Text>
              </Pressable>
            </View>
          </View>
        )}

        {turns.length === 0 && <Welcome fixed={fixed} onAskAll={onAskAllOfFixed} />}

        {turns.map((turn) => (
          <TurnView
            key={turn.key}
            turn={turn}
            busy={busy}
            askFollowUp={askFollowUp}
            askFresh={askFresh}
            onSelectCandidate={onSelectCandidate(turn.question)}
          />
        ))}
      </ScrollView>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={placeholder}
          placeholderTextColor={colors.ink3}
          maxLength={MAX_QUESTION}
          onSubmitEditing={onSend}
          returnKeyType="send"
          accessibilityLabel="AI 플래너에게 질문"
        />
        <Pressable
          style={[styles.send, (busy || draft.trim() === '') && styles.sendDisabled]}
          onPress={onSend}
          disabled={busy || draft.trim() === ''}
          accessibilityRole="button"
          accessibilityLabel="보내기"
          accessibilityState={{ disabled: busy || draft.trim() === '' }}
        >
          <Text style={styles.sendText}>↑</Text>
        </Pressable>
      </View>
      <MemberTabBar active="planner" />
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------- 첫 화면

function Welcome({ fixed, onAskAll }: { fixed: FixedInstructor | null; onAskAll: () => void }) {
  if (fixed !== null) {
    return (
      <View style={styles.welcome}>
        <Text style={plannerStyles.heading}>{fixed.name} 강사님의 수업을 찾아 드릴게요</Text>
        <Text style={plannerStyles.muted}>이 강사님이 지금 모집 중인 수업을 찾아요. 실제로 등록된 수업만 보여 드려요.</Text>
        <Pressable style={styles.suggest} onPress={onAskAll} accessibilityRole="button">
          <Text style={styles.suggestText}>{fixed.name} 강사님 수업 모두 보기</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.welcome}>
      <Text style={plannerStyles.heading}>강사·학원 이름으로 수업을 찾아요</Text>
      <Text style={plannerStyles.muted}>예) ○○ 강사님 주말 수업 전체 알려줘 · ○○ 학원 평일 저녁 초급 수업</Text>
      <Text style={plannerStyles.muted}>답을 받은 뒤 「그중 토요일만」처럼 이어서 물으면 조건을 좁혀 드려요.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.sm },
  back: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: { fontSize: 22, color: colors.ink },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', color: colors.ink },
  newChat: { minHeight: 40, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: colors.surface },
  newChatDisabled: { opacity: 0.45 },
  newChatText: { fontSize: font.small, color: colors.brown, fontWeight: '700' },
  body: { padding: space.lg, gap: space.lg, paddingBottom: space.xl },
  fixedRow: { flexDirection: 'row' },
  fixedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: '#EBDDF0',
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 6,
  },
  fixedChipText: { fontSize: font.small, color: colors.brown, fontWeight: '700' },
  fixedChipX: { fontSize: font.small, color: colors.brown },
  welcome: { gap: space.sm, paddingTop: space.sm },
  suggest: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    minHeight: 40,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line,
  },
  suggestText: { fontSize: font.body, color: colors.brown, fontWeight: '700' },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  input: {
    flex: 1,
    minHeight: MIN_TOUCH,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.lg,
    fontSize: font.body,
    color: colors.ink,
  },
  send: { width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: MIN_TOUCH / 2, backgroundColor: colors.brown, alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.45 },
  sendText: { color: colors.surface, fontSize: 20, fontWeight: '700' },
});
