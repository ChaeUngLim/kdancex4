/**
 * 강사 레벨·후보 화면이 같이 쓰는 작은 부품 — S6-3.6(앱 강사 레벨·후보 화면).
 *   Stepper(− 숫자 +) · Chip(고르기 칩) · Button(가득 찬 버튼 / 테두리 버튼) · LockNotice(멤버십 잠김 안내)
 * 모양은 보드 I15 · I15B · I23 의 딥 플럼(brown) 주 버튼과 흰 테두리 버튼을 따른다.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, font, MIN_TOUCH, radius, space } from '../theme';

interface StepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  /** 숫자 아래 작은 글자(예: 단계 이름 「초중급」) */
  caption?: string;
  big?: boolean;
}

/** − 숫자 + — 끝에 닿으면 그쪽 버튼이 잠긴다 */
export function Stepper({ label, value, min, max, onChange, caption, big = false }: StepperProps) {
  return (
    <View style={styles.stepper} accessible={false}>
      <StepButton text="−" label={`${label} 하나 내리기`} disabled={value <= min} onPress={() => onChange(value - 1)} big={big} />
      <View style={styles.stepValue} accessible accessibilityLabel={`${label} ${value}${caption === undefined ? '' : ` ${caption}`}`}>
        <Text style={big ? styles.stepNumBig : styles.stepNum}>{value}</Text>
        {caption !== undefined && <Text style={styles.stepCaption}>{caption}</Text>}
      </View>
      <StepButton text="+" label={`${label} 하나 올리기`} disabled={value >= max} onPress={() => onChange(value + 1)} big={big} />
    </View>
  );
}

function StepButton({ text, label, disabled, onPress, big }: { text: string; label: string; disabled: boolean; onPress: () => void; big: boolean }) {
  return (
    <Pressable
      style={[styles.stepButton, big && styles.stepButtonBig, disabled && styles.stepButtonOff]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
    >
      <Text style={[styles.stepButtonText, disabled && styles.stepButtonTextOff]}>{text}</Text>
    </Pressable>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.chip, selected && styles.chipOn]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      aria-selected={selected}
    >
      <Text style={selected ? styles.chipTextOn : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

interface ButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** 테두리만 있는 보조 버튼(「취소」·「나중에」) */
  outline?: boolean;
  /** 줄 안에서 나눠 가질 비율 */
  flex?: number;
}

export function Button({ label, onPress, disabled = false, outline = false, flex }: ButtonProps) {
  return (
    <Pressable
      style={[styles.button, outline ? styles.buttonOutline : styles.buttonFill, disabled && styles.buttonOff, flex !== undefined && { flex }]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
    >
      <Text style={[outline ? styles.buttonTextOutline : styles.buttonTextFill, disabled && styles.buttonTextOff]}>{label}</Text>
    </Pressable>
  );
}

/** 멤버십이 아닌 강사에게 보이는 잠김 안내(FR-169d · FR-164 — 둘 다 강사 멤버십 기능) */
export function LockNotice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={styles.lock} accessibilityLiveRegion="polite">
      <Text style={styles.lockTitle}>{title}</Text>
      {children}
    </View>
  );
}

export const levelUiStyles = StyleSheet.create({
  softBox: { backgroundColor: '#EFE6F1', borderRadius: radius.md, padding: space.md, gap: 6 },
  softTitle: { color: colors.brown, fontSize: font.body, fontWeight: '800' },
  softText: { color: colors.ink, fontSize: font.small, lineHeight: 19 },
  row: { flexDirection: 'row', gap: space.sm },
  tag: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: '#EFE6F1',
    color: colors.brown,
    fontSize: font.tiny,
    fontWeight: '800',
    overflow: 'hidden',
  },
});

const styles = StyleSheet.create({
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  stepValue: { flex: 1, alignItems: 'center' },
  stepNum: { color: colors.ink, fontSize: 20, fontWeight: '800' },
  stepNumBig: { color: colors.ink, fontSize: 34, fontWeight: '800' },
  stepCaption: { color: colors.brown, fontSize: font.small, fontWeight: '700' },
  stepButton: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepButtonBig: { width: 56, height: 56 },
  stepButtonOff: { backgroundColor: colors.disabled },
  stepButtonText: { color: colors.ink, fontSize: 20, fontWeight: '800' },
  stepButtonTextOff: { color: colors.disabledInk },
  chip: {
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: colors.brown, borderColor: colors.brown },
  chipText: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  chipTextOn: { color: colors.surface, fontSize: font.small, fontWeight: '800' },
  button: { minHeight: MIN_TOUCH + 4, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.md },
  buttonFill: { backgroundColor: colors.brown },
  buttonOutline: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  buttonOff: { backgroundColor: colors.disabled, borderColor: colors.disabled },
  buttonTextFill: { color: colors.surface, fontSize: font.body, fontWeight: '800' },
  buttonTextOutline: { color: colors.ink, fontSize: font.body, fontWeight: '800' },
  buttonTextOff: { color: colors.disabledInk },
  lock: { backgroundColor: colors.disabled, borderRadius: radius.md, padding: space.md, gap: 4 },
  lockTitle: { color: colors.ink, fontSize: font.body, fontWeight: '800' },
});
