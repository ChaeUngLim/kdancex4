/**
 * 홍보 이미지·소개 문구 화면의 작은 부품 — SX-6.9(앱 홍보 이미지·소개 문구 화면).
 *
 *  - `PromoSteps`: 맨 위 「1 만들기 › 2 검토·고치기 › 3 등록」 칩(누르면 그 단계로)
 *  - `CoverCard`: 만든 이미지 + 그 위에 앱이 얹는 글자(수업명·요일 시간·학원 홀·회차·금액). 이미지 안에는 글자가 없다(FR-061a)
 *  - `EngineCards`: 엔진 카드 줄(보드 I32B 2026-11-24 — 켜진 엔진만, 막히면 흐리게)
 *  - `ConfirmDialog`: 만들기 직전 확인 창(보드 I41)
 *  - `WideButton`: 화면 폭 버튼(주 · 보조 · 잠김)
 *
 * 색은 lib/theme.ts 만 쓴다. 강조색 `brown` 은 이름만 옛것이고 값은 딥 플럼이다(theme.ts 머리 주석).
 */
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, font, MIN_TOUCH, radius, space } from '../theme';
import { serverImageSource, type PromoEngineCard } from './promo-api';

// ---- 단계 칩 -------------------------------------------------------------------------------------

export type PromoStep = 1 | 2 | 3;
const STEP_LABELS: Readonly<Record<PromoStep, string>> = { 1: '1 만들기', 2: '2 검토·고치기', 3: '3 등록' };

export function PromoSteps({ current, onPick }: { current: PromoStep; onPick: (step: PromoStep) => void }) {
  return (
    <View style={styles.steps}>
      {([1, 2, 3] as const).map((step, index) => (
        <View key={step} style={styles.stepItem}>
          {index > 0 && <Text style={styles.stepArrow}>›</Text>}
          <Pressable
            style={[styles.stepChip, step === current && styles.stepChipOn, step < current && styles.stepChipDone]}
            onPress={() => onPick(step)}
            accessibilityRole="tab"
            accessibilityState={{ selected: step === current }}
            accessibilityLabel={STEP_LABELS[step]}
          >
            <Text style={[styles.stepText, step === current && styles.stepTextOn]}>{STEP_LABELS[step]}</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

// ---- 필수 칩(고르면 플럼으로 채움, 보드 I32B) ----------------------------------------------------

export function PromoChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.pchip, selected && styles.pchipOn]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      aria-checked={selected}
    >
      <Text style={[styles.pchipText, selected && styles.pchipTextOn]}>{label}</Text>
    </Pressable>
  );
}

// ---- 이미지 + 앱이 얹는 글자 ----------------------------------------------------------------------

interface CoverCardProps {
  imageUrl: string | null;
  badge: string;
  title: string;
  /** 「월·수 20:30–21:30 · 라틴하우스 강남 A홀」 */
  whenWhere: string;
  /** 「16회 · 300,000원」 */
  countPrice: string;
  /** 만드는 중이면 그림 자리에 보일 글 */
  pendingText?: string;
}

/**
 * 이미지 위 글자는 이미지가 아니라 이 카드가 수업 데이터로 그린다 — 생성 모델은 한글을 제대로 못 그려서(FR-061a).
 * 그래서 수업 정보를 고치면 이미지를 다시 만들지 않아도 글자가 같이 바뀐다.
 */
export function CoverCard({ imageUrl, badge, title, whenWhere, countPrice, pendingText }: CoverCardProps) {
  return (
    <View style={styles.cover} accessible accessibilityLabel={`${badge}. ${title}. ${whenWhere}. ${countPrice}`}>
      {imageUrl !== null && <Image source={serverImageSource(imageUrl)} style={styles.coverImage} resizeMode="cover" accessibilityIgnoresInvertColors />}
      {/* 글자가 잘 읽히게 아래쪽을 어둡게 깐다 */}
      <View style={styles.coverShade} />
      <Text style={styles.coverBadge}>{badge}</Text>
      {pendingText !== undefined && <Text style={styles.coverPending}>{pendingText}</Text>}
      <View style={styles.coverText}>
        <Text style={styles.coverTitle} numberOfLines={2}>
          {title}
        </Text>
        <Text style={styles.coverLine} numberOfLines={1}>
          {whenWhere}
        </Text>
        <Text style={styles.coverPrice}>{countPrice}</Text>
      </View>
    </View>
  );
}

// ---- 엔진 카드 ----------------------------------------------------------------------------------

interface EngineCardsProps {
  cards: readonly PromoEngineCard[];
  selectedId: string | null;
  onPick: (id: string) => void;
}

/** 엔진 카드 상태 한 줄 — 막힘 > 지난번 > 쓸 수 있음 */
function engineState(card: PromoEngineCard): string {
  if (!card.available) return card.blockedScope === 'monthly' ? '이번 달은 더 쓸 수 없어요' : '오늘은 더 쓸 수 없어요';
  return card.lastPicked ? '지난번에 고른 엔진' : '쓸 수 있어요';
}

export function EngineCards({ cards, selectedId, onPick }: EngineCardsProps) {
  return (
    <View style={styles.engineSection}>
      <View style={styles.engineHead}>
        <Text style={styles.engineTitle}>생성 엔진 · 옆으로 밀어 더 보기</Text>
        <Text style={styles.engineNote}>하루 횟수는 엔진과 상관없어요</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.engineRow}>
        {cards.map((card) => {
          const selected = card.id === selectedId;
          return (
            <Pressable
              key={card.id}
              style={[styles.engineCard, selected && styles.engineCardOn, !card.available && styles.engineCardOff]}
              onPress={() => onPick(card.id)}
              disabled={!card.available}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled: !card.available }}
              aria-checked={selected}
              accessibilityLabel={`${card.label} 엔진`}
            >
              <Text style={styles.engineName}>{card.label}</Text>
              <Text style={styles.engineSpeed}>{card.etaSeconds === null ? card.speed : `${card.speed} · 약 ${card.etaSeconds}초`}</Text>
              <Text style={[styles.engineStateText, !card.available && styles.engineStateOff]}>{engineState(card)}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ---- 확인 창(I41) -------------------------------------------------------------------------------

interface ConfirmDialogProps {
  visible: boolean;
  remaining: number;
  limit: number;
  sentence: string;
  betaPhase: boolean;
  busy: boolean;
  onEdit: () => void;
  onConfirm: () => void;
}

/** 실수로 하루 횟수를 날리지 않게 한 번 더 묻는다(spec FR-061a 「누르기 직전 확인 창」) */
export function ConfirmDialog({ visible, remaining, limit, sentence, betaPhase, busy, onEdit, onConfirm }: ConfirmDialogProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onEdit}>
      <View style={styles.dim}>
        <View style={styles.dialog} accessibilityViewIsModal>
          <Text style={styles.dialogTitle} accessibilityRole="header">
            1번 사용할까요?
          </Text>
          <Text style={styles.dialogCount}>{`남은 횟수 ${remaining}/${limit} → ${Math.max(remaining - 1, 0)}/${limit}`}</Text>
          <View style={styles.quote}>
            <Text style={styles.quoteText}>{`“${sentence}”`}</Text>
          </View>
          <Text style={styles.dialogNote}>
            {`${betaPhase ? '베타 기간에는 ' : ''}AI 이미지를\n하루 ${limit}번까지 무료로 만들 수 있어요.\n다시 만들어도 1번으로 세요.`}
          </Text>
          <Text style={styles.dialogSmall}>만들다가 실패하면 횟수를 돌려드려요</Text>
          <View style={styles.dialogButtons}>
            <Pressable style={styles.dialogSecondary} onPress={onEdit} disabled={busy} accessibilityRole="button">
              <Text style={styles.dialogSecondaryText}>고치기</Text>
            </Pressable>
            <Pressable style={[styles.dialogPrimary, busy && styles.wideOff]} onPress={onConfirm} disabled={busy} accessibilityRole="button">
              <Text style={styles.dialogPrimaryText}>{busy ? '보내는 중' : '만들기'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ---- 넓은 버튼 ----------------------------------------------------------------------------------

interface WideButtonProps {
  label: string;
  onPress: () => void;
  tone?: 'primary' | 'secondary';
  disabled?: boolean;
  /** 남은 횟수가 마지막 1번이면 숫자를 경고색으로(spec 「주황 대신 경고색」) */
  warn?: boolean;
}

export function WideButton({ label, onPress, tone = 'secondary', disabled = false, warn = false }: WideButtonProps) {
  return (
    <Pressable
      style={[styles.wide, tone === 'primary' ? styles.widePrimary : styles.wideSecondary, disabled && styles.wideOff]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={label}
    >
      <Text
        style={[
          styles.wideText,
          tone === 'primary' ? styles.wideTextPrimary : styles.wideTextSecondary,
          warn && (tone === 'primary' ? styles.wideTextWarnOnPrimary : styles.wideTextWarn),
          disabled && styles.wideTextOff,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export const promoStyles = StyleSheet.create({
  section: { gap: space.sm },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm },
  heading: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  link: { color: colors.brown, fontSize: font.small, fontWeight: '700', paddingVertical: space.xs },
  sentenceBox: {
    minHeight: 96,
    borderWidth: 1,
    borderColor: '#D9C58F',
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    padding: space.md,
  },
  sentenceBoxDanger: { borderColor: colors.danger, borderWidth: 2 },
  introInput: { minHeight: 170 },
  sentenceInput: { minHeight: 52, fontSize: 15, color: colors.ink, lineHeight: 22, textAlignVertical: 'top' },
  counter: { alignSelf: 'flex-end', color: colors.ink3, fontSize: font.tiny },
  hint: { color: colors.ink3, fontSize: font.small, lineHeight: 18 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tag: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    color: colors.ink,
    fontSize: font.small,
    fontWeight: '700',
    overflow: 'hidden',
  },
  tagSoft: { backgroundColor: '#EFE6F0', color: colors.brown },
  lockedTag: { backgroundColor: colors.brownSoft, color: colors.ink3 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.lg,
    gap: space.sm,
  },
  cardTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  body: { color: colors.ink, fontSize: font.body, lineHeight: 21 },
  bullet: { color: colors.ink, fontSize: font.body, lineHeight: 24 },
  bulletDot: { color: colors.danger },
  dangerBox: { backgroundColor: colors.dangerSoft, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  dangerTitle: { color: colors.danger, fontSize: 15, fontWeight: '800', lineHeight: 21 },
  noteBox: { borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg, borderRadius: radius.lg, padding: space.lg, gap: 4 },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  toggle: { width: 44, height: 26, borderRadius: 13, backgroundColor: colors.disabled, padding: 3 },
  toggleOn: { backgroundColor: colors.brown },
  toggleKnob: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.surface },
  toggleKnobOn: { alignSelf: 'flex-end' },
  required: { color: colors.brown, fontSize: font.small, fontWeight: '800' },
  requiredMissing: { color: colors.danger },
  warnCount: { color: colors.danger },
  sectionLabel: { color: colors.ink3, fontSize: font.small, fontWeight: '700', marginTop: space.sm },
});

const styles = StyleSheet.create({
  pchip: {
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  pchipOn: { backgroundColor: colors.brown, borderColor: colors.brown },
  pchipText: { color: colors.ink, fontSize: font.body },
  pchipTextOn: { color: colors.surface, fontWeight: '800' },
  steps: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 2 },
  stepItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stepArrow: { color: colors.ink3, fontSize: font.small },
  stepChip: {
    paddingHorizontal: space.md,
    minHeight: 32,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  stepChipOn: { backgroundColor: colors.brown, borderColor: colors.brown },
  stepChipDone: { backgroundColor: '#EFE6F0', borderColor: '#EFE6F0' },
  stepText: { color: colors.ink3, fontSize: font.small, fontWeight: '700' },
  stepTextOn: { color: colors.surface },
  cover: { height: 210, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#2A2030' },
  coverImage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  coverShade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 120, backgroundColor: 'rgba(20,18,22,0.55)' },
  coverBadge: {
    position: 'absolute',
    top: space.md,
    left: space.lg,
    paddingHorizontal: space.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: '#F3E6F0',
    color: colors.brown,
    fontSize: font.small,
    fontWeight: '800',
    overflow: 'hidden',
  },
  coverPending: { position: 'absolute', top: 80, left: 0, right: 0, textAlign: 'center', color: colors.surface, fontWeight: '700' },
  coverText: { position: 'absolute', left: space.lg, right: space.lg, bottom: space.md, gap: 2 },
  coverTitle: { color: colors.surface, fontSize: font.h2, fontWeight: '800' },
  coverLine: { color: colors.surface, fontSize: font.small, fontWeight: '600' },
  coverPrice: { color: '#E8C36A', fontSize: font.small, fontWeight: '800' },
  engineSection: { gap: space.sm },
  engineHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  engineTitle: { color: colors.ink, fontSize: font.small, fontWeight: '800' },
  engineNote: { color: colors.ink3, fontSize: font.tiny },
  engineRow: { gap: space.sm },
  engineCard: {
    width: 150,
    minHeight: 84,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    padding: space.md,
    gap: 2,
  },
  engineCardOn: { borderColor: colors.brown, borderWidth: 2 },
  engineCardOff: { opacity: 0.5 },
  engineName: { color: colors.ink, fontSize: font.small, fontWeight: '800' },
  engineSpeed: { color: colors.ink3, fontSize: font.tiny },
  engineStateText: { color: colors.brown, fontSize: font.tiny, fontWeight: '700', marginTop: 4 },
  engineStateOff: { color: colors.disabledInk },
  dim: { flex: 1, backgroundColor: 'rgba(20,18,22,0.45)', alignItems: 'center', justifyContent: 'center', padding: space.xl },
  dialog: { width: '100%', maxWidth: 340, backgroundColor: colors.surface, borderRadius: radius.lg + 4, padding: space.xl, gap: space.md },
  dialogTitle: { color: colors.ink, fontSize: font.h2, fontWeight: '800', textAlign: 'center' },
  dialogCount: { color: colors.brown, fontSize: 15, fontWeight: '800', textAlign: 'center' },
  quote: { backgroundColor: colors.bg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: space.md },
  quoteText: { color: colors.ink, fontSize: font.body, fontWeight: '700', lineHeight: 20 },
  dialogNote: { color: colors.ink, fontSize: font.small, lineHeight: 20, textAlign: 'center' },
  dialogSmall: { color: colors.ink3, fontSize: font.small, textAlign: 'center' },
  dialogButtons: { flexDirection: 'row', gap: space.md, marginTop: space.sm },
  dialogSecondary: {
    flex: 1,
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialogSecondaryText: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  dialogPrimary: { flex: 1, minHeight: MIN_TOUCH, borderRadius: radius.md, backgroundColor: colors.brown, alignItems: 'center', justifyContent: 'center' },
  dialogPrimaryText: { color: colors.surface, fontSize: 15, fontWeight: '800' },
  wide: { minHeight: MIN_TOUCH + 4, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.md },
  widePrimary: { backgroundColor: colors.brown },
  wideSecondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  wideOff: { backgroundColor: colors.disabled, borderColor: colors.disabled },
  wideText: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
  wideTextPrimary: { color: colors.surface },
  wideTextSecondary: { color: colors.ink },
  wideTextWarn: { color: colors.danger },
  // 플럼 바탕 위의 경고색 — 진한 빨강은 읽히지 않아 밝은 붉은색으로(대비 약 4.6:1)
  wideTextWarnOnPrimary: { color: '#FFC9C4' },
  wideTextOff: { color: colors.disabledInk },
});
