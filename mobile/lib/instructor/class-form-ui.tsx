/**
 * 수업 만들기(보드 I2 · I2D · I2E · I2S)에 쓰는 작은 부품 — S2-2.9(앱 수업 등록 화면).
 *
 *  - `Chip`·`ChipRow`: 하나만 고르는 칩(라디오) · 여러 개 고르는 칩(체크) 둘 다 이 모양을 쓴다
 *  - `FieldLabel`: 칸 제목 + 「필수」 같은 작은 배지
 *  - `SeatStepper`: 보드 I2D·I2E 의 「남 [−] 0 [+]」 — 버튼과 숫자 직접 입력 둘 다 받는다(11 §4-2)
 *  - `InfoRows`: 왼쪽 이름 · 오른쪽 값 줄 목록(환불 공지 표 · 등록한 수업 상세)
 *  - `BottomButtons`: 화면 맨 아래 「이전 | 수업 등록」 처럼 보조 + 주 버튼 한 줄
 *
 * 색·크기는 `lib/theme.ts` 만 쓴다(staff-ui.tsx 와 같은 판단 — 보드의 딥 플럼 교체는 별도 작업).
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, font, MIN_TOUCH, radius, space } from '../theme';

// ---- 칩 ------------------------------------------------------------------------------------

interface ChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** 여러 개 고르기면 체크박스, 하나 고르기면 라디오로 읽힌다(화면 읽기 프로그램) */
  multi?: boolean;
  disabled?: boolean;
}

export function Chip({ label, selected, onPress, multi = false, disabled = false }: ChipProps) {
  return (
    <Pressable
      style={[styles.chip, selected && styles.chipOn, disabled && styles.chipDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={multi ? 'checkbox' : 'radio'}
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, disabled }}
      // 웹(react-native-web)은 accessibilityState 의 checked 를 읽어 주지 않아 aria-checked 를 함께 준다(academy-colors.tsx 와 같은 처리)
      aria-checked={selected}
    >
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

export function ChipRow({ children }: { children: ReactNode }) {
  return <View style={styles.chipRow}>{children}</View>;
}

// ---- 칸 제목 ------------------------------------------------------------------------------

export function FieldLabel({ title, badge, tone = 'muted' }: { title: string; badge?: string; tone?: 'muted' | 'danger' | 'accent' }) {
  return (
    <View style={styles.labelRow}>
      <Text style={styles.label}>{title}</Text>
      {badge !== undefined && (
        <Text style={[styles.badge, tone === 'danger' && styles.badgeDanger, tone === 'accent' && styles.badgeAccent]}>{badge}</Text>
      )}
    </View>
  );
}

// ---- 정원 칸 -------------------------------------------------------------------------------

interface SeatStepperProps {
  label: string;
  value: number;
  onChange: (next: number) => void;
  max: number;
}

/**
 * 「−」「+」는 1씩, 가운데 칸은 숫자를 바로 적는다. 숫자 아닌 글자는 버리고 0~max 로 자른다 —
 * 서버는 정수만 보므로(11 §4-2) 화면에서 정수로 맞춰 보낸다.
 */
export function SeatStepper({ label, value, onChange, max }: SeatStepperProps) {
  const clamp = (n: number) => Math.min(max, Math.max(0, n));
  return (
    <View style={styles.stepper}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepperControls}>
        <Pressable
          style={[styles.stepButton, value <= 0 && styles.stepButtonOff]}
          onPress={() => onChange(clamp(value - 1))}
          disabled={value <= 0}
          accessibilityRole="button"
          accessibilityLabel={`${label} 정원 하나 줄이기`}
          accessibilityState={{ disabled: value <= 0 }}
        >
          <Text style={styles.stepButtonText}>−</Text>
        </Pressable>
        <TextInput
          style={styles.stepInput}
          value={String(value)}
          onChangeText={(text) => {
            const digits = text.replace(/\D/g, '');
            onChange(clamp(digits === '' ? 0 : Number(digits)));
          }}
          keyboardType="number-pad"
          accessibilityLabel={`${label} 정원`}
          maxLength={3}
        />
        <Pressable
          style={styles.stepButton}
          onPress={() => onChange(clamp(value + 1))}
          accessibilityRole="button"
          accessibilityLabel={`${label} 정원 하나 늘리기`}
        >
          <Text style={styles.stepButtonText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---- 이름 · 값 줄 ---------------------------------------------------------------------------

export function InfoRows({ rows, valueTone }: { rows: readonly { label: string; value: string }[]; valueTone?: 'strong' }) {
  return (
    <View style={styles.infoCard}>
      {rows.map((row, index) => (
        <View key={row.label} style={[styles.infoRow, index > 0 && styles.infoDivider]}>
          <Text style={[styles.infoLabel, valueTone === 'strong' && styles.infoLabelWide]}>{row.label}</Text>
          <Text style={[styles.infoValue, valueTone === 'strong' && styles.infoValueStrong]}>{row.value}</Text>
        </View>
      ))}
    </View>
  );
}

// ---- 맨 아래 버튼 한 줄 -----------------------------------------------------------------------

interface BottomButtonsProps {
  secondary: { label: string; onPress: () => void; disabled?: boolean };
  primary: { label: string; onPress: () => void; disabled?: boolean; accessibilityLabel?: string };
}

export function BottomButtons({ secondary, primary }: BottomButtonsProps) {
  const primaryOff = primary.disabled === true;
  return (
    <View style={styles.bottomRow}>
      <Pressable
        style={[styles.secondary, secondary.disabled === true && styles.secondaryOff]}
        onPress={secondary.onPress}
        disabled={secondary.disabled === true}
        accessibilityRole="button"
        accessibilityState={{ disabled: secondary.disabled === true }}
      >
        <Text style={styles.secondaryText}>{secondary.label}</Text>
      </Pressable>
      <Pressable
        style={[styles.primary, primaryOff && styles.primaryOff]}
        onPress={primary.onPress}
        disabled={primaryOff}
        accessibilityRole="button"
        accessibilityLabel={primary.accessibilityLabel ?? primary.label}
        accessibilityState={{ disabled: primaryOff }}
      >
        <Text style={[styles.primaryText, primaryOff && styles.primaryTextOff]}>{primary.label}</Text>
      </Pressable>
    </View>
  );
}

export const formStyles = StyleSheet.create({
  section: { gap: space.sm },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: space.md,
    fontSize: 15,
    color: colors.ink,
  },
  inputRow: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  // 웹의 입력 칸은 글자 폭만큼 최소 너비를 잡아 줄 밖으로 넘친다 — minWidth 0 으로 칸끼리 나눠 갖게 한다
  flex: { flex: 1, minWidth: 0 },
  hint: { color: colors.ink3, fontSize: font.small, lineHeight: 18 },
  danger: { color: colors.danger, fontSize: font.small, fontWeight: '700', lineHeight: 18 },
  okText: { color: colors.ok, fontSize: font.small, fontWeight: '700' },
  noteBox: { backgroundColor: colors.brownSoft, borderRadius: radius.md, padding: space.md, gap: 2 },
  noteText: { color: colors.brown, fontSize: font.small, lineHeight: 18 },
  warnBox: { backgroundColor: colors.dangerSoft, borderRadius: radius.md, padding: space.md, gap: space.sm },
  warnTitle: { color: colors.danger, fontSize: font.small, fontWeight: '700' },
  warnText: { color: colors.ink, fontSize: font.small, lineHeight: 18 },
  summaryCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.lg,
    gap: 4,
  },
  summaryTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  summaryLine: { color: colors.ink3, fontSize: font.small, lineHeight: 18 },
});

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  chipOn: { borderColor: colors.brown, backgroundColor: colors.brownSoft },
  chipDisabled: { backgroundColor: colors.disabled },
  chipText: { color: colors.ink, fontSize: font.body },
  chipTextOn: { color: colors.brown, fontWeight: '700' },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  label: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  badge: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.disabled,
    color: colors.disabledInk,
    fontSize: font.tiny,
    fontWeight: '700',
    overflow: 'hidden',
  },
  badgeDanger: { backgroundColor: colors.dangerSoft, color: colors.danger },
  badgeAccent: { backgroundColor: colors.brownSoft, color: colors.brown },
  stepper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  stepperLabel: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stepButton: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  stepButtonOff: { backgroundColor: colors.disabled },
  stepButtonText: { color: colors.ink, fontSize: 18, fontWeight: '700' },
  stepInput: {
    width: 44,
    height: 36,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.brown,
    textAlign: 'center',
    fontSize: 16,
    color: colors.ink,
    backgroundColor: colors.surface,
  },
  infoCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.lg,
  },
  infoRow: { flexDirection: 'row', gap: space.md, paddingVertical: space.md },
  infoDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  infoLabel: { width: 76, color: colors.ink3, fontSize: font.small },
  // 값이 짧은 표(취소 수수료 %)는 이름 칸을 넓혀 한 줄에 읽히게 한다
  infoLabelWide: { width: undefined, flex: 2 },
  infoValue: { flex: 1, color: colors.ink, fontSize: font.body, lineHeight: 20 },
  infoValueStrong: { fontWeight: '700', textAlign: 'right' },
  bottomRow: { flexDirection: 'row', gap: space.md, marginTop: space.sm },
  secondary: {
    flex: 1,
    minHeight: MIN_TOUCH + 4,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryOff: { backgroundColor: colors.disabled },
  secondaryText: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  primary: {
    flex: 2,
    minHeight: MIN_TOUCH + 4,
    borderRadius: radius.lg,
    backgroundColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryOff: { backgroundColor: colors.disabled },
  primaryText: { color: colors.surface, fontSize: 15, fontWeight: '800' },
  primaryTextOff: { color: colors.disabledInk },
});
