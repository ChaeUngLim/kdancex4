/**
 * AI 플래너 대화 한 번 — 내 질문 말풍선(오른쪽) + AI 답 말풍선(왼쪽) + 그 아래 수업 카드(SX-5.8(말로 찾기 실동작·챗봇 대화형 AI 답변)).
 *
 * 처음 보는 사람용 요약
 *  - 화면(app/planner.tsx)은 「언제 무엇을 보낼지」만 맡고, 대화 한 번을 어떻게 그릴지는 여기 둔다.
 *  - AI 답 문장은 에이전트가 **검색 결과 값만으로** 쓴 2~4문장이다(서버가 결과 밖 값이 든 문장을 버린다). 앱은 받은 글을 그대로 보인다.
 *    문장이 한 문장씩 흘러 들어오고, 아직 한 글자도 안 왔으면 「···」(입력 중)을 보인다.
 *  - 에이전트가 늦거나 실패해 일반 검색으로 답했으면(SX-5.5) 지금처럼 「수업 n개를 찾았어요」 한 줄과 카드만 보인다.
 *  - 390 폭 휴대폰에 맞춰: 답 문장은 3줄까지만 보이고 「더 보기」로 펼친다. 카드는 세로로 10개씩 보이고 「더 보기」로 늘린다.
 *  - 답 아래 추천 질문 칩(2~3개)은 받은 카드 값으로만 만든다(answer.ts followUpSuggestions). 누르면 앞 조건을 이어받아 좁힌다.
 *  - 상태(펼침·보이는 카드 수)는 이 말풍선 안에서만 쓰는 useState 다. 화면이 열릴 때 저절로 도는 코드(useEffect)는 없다.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, font, radius, space } from '../theme';
import { followUpSuggestions, widenRequest, type PlannerAnswer, type PlannerInstructorCandidate } from './answer';
import {
  ActionChipRow,
  ChipRow,
  conditionChips,
  foundHeading,
  InstructorCandidateView,
  OfferingCardView,
  plannerStyles,
  usableWidenActions,
  type ActionChip,
} from './planner-ui';

/** 질문 한 번 = 회원 말풍선 + 답 한 건 */
export interface Turn {
  key: number;
  question: string;
  /** loading: 답이 오는 중(조각이 오는 대로 answer 가 자란다) · done: 다 옴 · error: 서버에 닿지 못함 등 */
  status: 'loading' | 'done' | 'error';
  answer: PlannerAnswer;
  errorText: string | null;
  /** 앞 답의 조건을 이어받아 물었는지(이어 묻기) */
  followUp: boolean;
}

/** 한 번에 보이는 카드 수(2026-11-24 사용자 지시 「많으면 10개씩 더 보기」) */
export const CARD_PAGE = 10;
/** 이 글자 수를 넘으면 답 문장을 3줄로 접는다. 390 폭 말풍선 한 줄이 한글 약 20자라 3줄 ≈ 60자 */
const COLLAPSE_CHARS = 60;
const COLLAPSED_LINES = 3;

/** 에이전트 단계 이름 → 입력 중 옆에 붙는 말(계약 16 §3-3 data-stage) */
const STAGE_KO: Readonly<Record<string, string>> = {
  conditions: '질문을 읽고 있어요',
  candidates: '수업을 찾고 있어요',
  writing: '답을 쓰고 있어요',
};

export interface TurnViewProps {
  turn: Turn;
  busy: boolean;
  /** 이어 묻기 — 이 답의 조건을 이어받아 묻는다(추천 질문 칩) */
  askFollowUp: (question: string, from: PlannerAnswer) => void;
  /** 새로 묻기 — 앞 조건 없이, 강사만 정해 묻는다(넓히기 버튼) */
  askFresh: (question: string, instructorId: string | null) => void;
  onSelectCandidate: (candidate: PlannerInstructorCandidate) => void;
}

export function TurnView({ turn, busy, askFollowUp, askFresh, onSelectCandidate }: TurnViewProps) {
  return (
    <View style={styles.turn}>
      <View style={styles.userBubble} accessibilityLabel={`내 질문: ${turn.question}`}>
        <Text style={styles.userText}>{turn.question}</Text>
      </View>
      {turn.status === 'error' ? (
        <AiBubble>
          <Text style={styles.errorText}>{turn.errorText}</Text>
        </AiBubble>
      ) : (
        <AnswerView turn={turn} busy={busy} askFollowUp={askFollowUp} askFresh={askFresh} onSelectCandidate={onSelectCandidate} />
      )}
    </View>
  );
}

// ---------------------------------------------------------------- 말풍선

function AiBubble({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.aiRow}>
      <View style={styles.aiAvatar} accessibilityElementsHidden importantForAccessibility="no">
        <Text style={styles.aiAvatarText}>AI</Text>
      </View>
      <View style={styles.aiBubble}>{children}</View>
    </View>
  );
}

/** 입력 중 표시 「···」 + 지금 단계 */
function Typing({ stage }: { stage: string | null }) {
  const label = (stage !== null ? STAGE_KO[stage] : undefined) ?? '수업을 찾고 있어요';
  return (
    <AiBubble>
      <View style={styles.typingRow} accessibilityLiveRegion="polite" accessibilityLabel={`AI 가 ${label}`}>
        <Text style={styles.typingDots}>···</Text>
        <Text style={plannerStyles.muted}>{label}</Text>
      </View>
    </AiBubble>
  );
}

/** 답 문장 — 길면 3줄로 접고 「더 보기」로 펼친다 */
function CollapsibleText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > COLLAPSE_CHARS;
  return (
    <View style={styles.textBlock}>
      <Text style={styles.aiText} numberOfLines={long && !open ? COLLAPSED_LINES : undefined}>
        {text}
      </Text>
      {long && (
        <Pressable onPress={() => setOpen(!open)} hitSlop={8} accessibilityRole="button">
          <Text style={styles.moreText}>{open ? '접기' : '더 보기'}</Text>
        </Pressable>
      )}
    </View>
  );
}

// ---------------------------------------------------------------- 답 한 건

function AnswerView({ turn, busy, askFollowUp, askFresh, onSelectCandidate }: TurnViewProps) {
  const { answer } = turn;
  const loading = turn.status === 'loading';
  const text = answer.text.trim();

  // 아직 글도 카드도 안 왔으면 입력 중만
  if (loading && text === '' && answer.offeringCards.length === 0 && answer.instructorCandidates.length === 0) {
    return <Typing stage={answer.stage} />;
  }

  // 강사 후보(M10G) — 이름이 하나로 정해지지 않았다. 카드 대신 후보를 고르게 한다
  if (answer.instructorCandidates.length > 0) {
    const name = answer.instructorCandidates[0]?.displayName ?? '';
    const count = answer.instructorCandidates.length;
    return (
      <View style={styles.answer}>
        <AiBubble>
          <CollapsibleText text={text !== '' ? text : `${name} 강사가 ${count === 2 ? '두' : count} 분 있어요. 어느 분인지 골라 주세요.`} />
          {answer.usedPlainSearch && <Text style={plannerStyles.notice}>AI 가 응답하지 않아 일반 검색 결과를 보여 드려요</Text>}
        </AiBubble>
        <View style={styles.attached}>
          {answer.instructorCandidates.map((candidate) => (
            <InstructorCandidateView key={candidate.instructorId} candidate={candidate} onSelect={onSelectCandidate} disabled={busy} />
          ))}
          <Text style={plannerStyles.notice}>이름이 하나로 정해지지 않으면 AI 가 짐작해서 답하지 않아요.</Text>
        </View>
      </View>
    );
  }

  if (answer.offeringCards.length > 0) {
    // 일반 검색 대체면 「n개를 찾았어요」 한 줄. 에이전트 경로면 에이전트가 쓴 문장(아직 안 왔으면 같은 한 줄)
    const bubbleText = answer.usedPlainSearch || text === '' ? foundHeading(answer) : text;
    const suggestions = loading ? [] : followUpSuggestions(answer);
    return (
      <View style={styles.answer}>
        <AiBubble>
          <CollapsibleText text={bubbleText} />
          {loading && <Text style={styles.typingDots}>···</Text>}
          {answer.usedPlainSearch && <Text style={plannerStyles.notice}>AI 가 응답하지 않아 일반 검색 결과를 보여 드려요</Text>}
        </AiBubble>
        <View style={styles.attached}>
          <ChipRow labels={conditionChips(answer.conditions)} />
          <CardList answer={answer} />
          <SuggestionRow suggestions={suggestions} disabled={busy} onPress={(q) => askFollowUp(q, answer)} />
          <Text style={plannerStyles.notice}>신청하기를 누르면 수업 상세로 가요. 결제는 그 화면에서 직접 해요. AI 는 예약·결제를 하지 않아요.</Text>
        </View>
      </View>
    );
  }

  // 결과 없음·이름 없음·실패 — 서버 문장을 그대로 보인다(문장은 서버 고정 문구)
  const widenChips: ActionChip[] = usableWidenActions(answer.noResult?.actions ?? []).map((action) => ({
    label: action.label,
    onPress: () => {
      const request = widenRequest(action);
      askFresh(request.message, request.instructorId);
    },
  }));
  return (
    <View style={styles.answer}>
      <AiBubble>
        <CollapsibleText text={text === '' ? '답을 받지 못했어요. 잠시 뒤 다시 물어봐 주세요.' : text} />
        {answer.usedPlainSearch && <Text style={plannerStyles.notice}>AI 가 응답하지 않아 일반 검색 결과를 보여 드려요</Text>}
      </AiBubble>
      <View style={styles.attached}>
        <ChipRow labels={conditionChips(answer.conditions)} />
        <ActionChipRow title="조건을 넓혀 볼까요?" chips={widenChips} disabled={busy} />
      </View>
    </View>
  );
}

/** 수업 카드 세로 목록 — 10개씩 보이고 「더 보기」로 10개씩 늘린다 */
function CardList({ answer }: { answer: PlannerAnswer }) {
  const [shown, setShown] = useState(CARD_PAGE);
  const cards = answer.offeringCards.slice(0, shown);
  const left = answer.offeringCards.length - cards.length;
  return (
    <View style={styles.cards}>
      {cards.map((card) => (
        <OfferingCardView key={`${card.offeringId ?? 'p'}-${card.classId}`} card={card} />
      ))}
      {left > 0 && (
        <Pressable style={styles.moreCards} onPress={() => setShown(shown + CARD_PAGE)} accessibilityRole="button">
          <Text style={styles.moreCardsText}>수업 더 보기 ({left}개 남음)</Text>
        </Pressable>
      )}
    </View>
  );
}

/** 추천 질문 칩 — 누르면 그 글로 이어 묻는다 */
function SuggestionRow({ suggestions, disabled, onPress }: { suggestions: readonly string[]; disabled: boolean; onPress: (q: string) => void }) {
  if (suggestions.length === 0) return null;
  return (
    <View style={styles.suggestRow}>
      {suggestions.map((q) => (
        <Pressable
          key={q}
          style={[styles.suggestChip, disabled && styles.suggestChipDisabled]}
          onPress={() => onPress(q)}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`이어 묻기: ${q}`}
          accessibilityState={{ disabled }}
        >
          <Text style={styles.suggestText}>{q}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const AVATAR = 30;

const styles = StyleSheet.create({
  turn: { gap: space.md },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '82%',
    backgroundColor: colors.brown,
    borderRadius: radius.lg,
    borderBottomRightRadius: 4,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  userText: { color: colors.surface, fontSize: font.body, fontWeight: '600', lineHeight: 20 },
  answer: { gap: space.sm },
  aiRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, maxWidth: '92%' },
  aiAvatar: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, backgroundColor: '#EBDDF0', alignItems: 'center', justifyContent: 'center' },
  aiAvatarText: { fontSize: font.tiny, fontWeight: '700', color: colors.brown },
  aiBubble: {
    flexShrink: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderTopLeftRadius: 4,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.xs,
  },
  textBlock: { gap: space.xs },
  aiText: { fontSize: font.body, color: colors.ink, lineHeight: 21 },
  moreText: { fontSize: font.small, color: colors.brown, fontWeight: '700' },
  typingRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  typingDots: { fontSize: 20, lineHeight: 22, color: colors.brown, fontWeight: '700', letterSpacing: 2 },
  errorText: { color: colors.danger, fontSize: font.body, lineHeight: 20 },
  // 카드·칩은 AI 말풍선 아래, 말풍선 글 시작선에 맞춰 붙인다
  attached: { gap: space.md, paddingLeft: AVATAR + space.sm },
  cards: { gap: space.md },
  moreCards: {
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreCardsText: { fontSize: font.body, color: colors.brown, fontWeight: '700' },
  suggestRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  suggestChip: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.brown,
    backgroundColor: colors.brownSoft,
  },
  suggestChipDisabled: { opacity: 0.5 },
  suggestText: { fontSize: font.small, color: colors.brown, fontWeight: '700' },
});
