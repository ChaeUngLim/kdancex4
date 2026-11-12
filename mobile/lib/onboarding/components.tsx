/**
 * 가입·취향 화면 공용 부품 — T-A5-2(가입·취향 화면 5종).
 *
 * 화면 틀(안전 영역 + 스크롤 + 아래 고정 버튼), 주 버튼, 오류 상자, 선택 칩, 입력칸.
 * 색·크기는 `lib/theme.ts`(회원 앱 공용 토큰) 만 쓴다.
 */
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radius, space } from '../theme';

interface ScreenProps {
  /** 오른쪽 위 진행 표시. 예: "2 / 4" */
  step?: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** 화면 아래에 붙는 영역(주 버튼 등). */
  footer?: ReactNode;
}

export function OnboardingScreen({ step, title, subtitle, children, footer }: ScreenProps) {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {step ? <Text style={styles.step}>{step}</Text> : null}
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          {children}
        </ScrollView>
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

interface PrimaryButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}

export function PrimaryButton({ label, onPress, disabled = false, loading = false }: PrimaryButtonProps) {
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={[styles.primary, inactive && styles.primaryDisabled]}
    >
      {loading ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>{label}</Text>}
    </Pressable>
  );
}

/** 보조 버튼(테두리만). 다시 시도·되돌아가기 같은 두 번째 동작에 쓴다. */
export function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.secondary}>
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

/** 오류 문구. 화면 낭독기가 바로 읽도록 live region 으로 둔다. */
export function ErrorBox({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }
  return (
    <View style={styles.errorBox} accessibilityLiveRegion="polite" accessibilityRole="alert">
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

interface ChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** 하나만 고르는 묶음이면 radio, 여러 개면 checkbox. */
  kind?: 'radio' | 'checkbox';
}

export function Chip({ label, selected, onPress, kind = 'checkbox' }: ChipProps) {
  return (
    <Pressable
      accessibilityRole={kind}
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      hitSlop={6}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
        {selected ? '✓ ' : ''}
        {label}
      </Text>
    </Pressable>
  );
}

interface FieldProps extends TextInputProps {
  label: string;
  hint?: string;
}

export function Field({ label, hint, ...inputProps }: FieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.ink3}
        style={styles.input}
        {...inputProps}
      />
    </View>
  );
}

export function SectionLabel({ text, hint }: { text: string; hint?: string }) {
  return (
    <View style={styles.section}>
      <Text style={styles.label}>{text}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export const onboardingStyles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  spacedRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.lg },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.lg,
    marginTop: space.lg,
    gap: space.sm,
  },
  body: { fontSize: 14, color: colors.ink, lineHeight: 20 },
  muted: { fontSize: 12, color: colors.ink3, lineHeight: 18 },
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  scroll: { padding: space.xl, paddingBottom: space.xl * 2 },
  step: { alignSelf: 'flex-end', fontSize: 12, color: colors.ink3 },
  title: { fontSize: 28, fontWeight: '800', color: colors.ink, marginTop: space.sm },
  subtitle: { fontSize: 14, color: colors.ink3, marginTop: space.sm, lineHeight: 20 },
  footer: { padding: space.lg, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.bg },
  primary: {
    minHeight: 52,
    borderRadius: radius.md,
    backgroundColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  primaryDisabled: { backgroundColor: colors.disabled },
  primaryDisabledText: { color: colors.disabledInk },
  primaryText: { color: colors.surface, fontSize: 16, fontWeight: '700' },
  secondary: {
    marginTop: space.md,
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  secondaryText: { color: colors.brown, fontSize: 15, fontWeight: '700' },
  errorBox: {
    marginTop: space.lg,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.dangerSoft,
  },
  errorText: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  chip: {
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  chipSelected: { borderColor: colors.brown, backgroundColor: colors.brownSoft },
  chipText: { fontSize: 14, color: colors.ink },
  chipTextSelected: { color: colors.brown, fontWeight: '700' },
  field: { marginTop: space.lg },
  section: { marginTop: space.xl, marginBottom: space.sm },
  label: { fontSize: 14, fontWeight: '700', color: colors.ink },
  hint: { fontSize: 12, color: colors.ink3, marginTop: 2 },
  input: {
    marginTop: space.sm,
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    paddingHorizontal: space.md,
    fontSize: 16,
    color: colors.ink,
  },
});
