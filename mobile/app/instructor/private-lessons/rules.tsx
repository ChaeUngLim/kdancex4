/**
 * 개인 레슨 규칙(보드 I20C) — S2-4.8(앱 개인 레슨 수강생·회차·규칙 화면).
 * 주소 `/instructor/private-lessons/rules?academyId=&academyName=`. 수강생 상세(I20)의 「규칙 바꾸기」에서 열린다.
 *
 * 강사가 학원마다 정하는 개인 레슨 전용 취소·환불 규칙이다. 바꿀 수 있는 칸은 둘뿐이다.
 *  - 바꾸기·취소 기한: 12 · 24 · 48시간 전(기본 24)
 *  - 수강권 사용 기한: 결제일부터 2 · 3 · 6개월(기본·추천 3)
 * 나머지 셋은 고정이라 「바꿀 수 없어요」로만 보인다 — 기한 뒤 취소·오지 않음은 1회 차감, 강사 사정 취소는 회차 복구,
 * 남은 회차 환불 금액은 학원 대표가 정한다(계약 11 §10-1).
 *
 * 부르는 API(서버는 S2-4.7)
 *  1. `GET  /api/instructor/private-lesson-rules?academyId=`   지금 판본(없으면 기본값 + isDefault)
 *  2. `POST /api/instructor/private-lesson-rules`(Idempotency-Key)  저장 — 같은 값이면 200(판본 그대로), 다르면 201 새 판본
 *
 * 저장한 뒤 결제하는 수강권부터 새 판본이 붙는다. 이미 결제한 수강권은 결제 때 판본 그대로다.
 * 칩을 누르면 화면 상태(useState)만 바뀌고, 「회원에게 이렇게 보여요」는 렌더 중에 다시 계산한다. 효과 훅을 쓰지 않는다.
 */
import { useLocalSearchParams } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { LoadingView } from '../../../lib/catalog/ui';
import { newIdempotencyKey, readRouteId, useApiResource } from '../../../lib/catalog/use-api-resource';
import {
  CHANGE_DEADLINE_HOURS,
  effectiveFromLabel,
  isDeadline,
  isValidity,
  memberNoticeLines,
  RECOMMENDED_VALIDITY_MONTHS,
  rulePath,
  saveRule,
  VALIDITY_MONTHS,
  type ChangeDeadlineHours,
  type PrivateLessonRuleView,
  type ValidityMonths,
} from '../../../lib/instructor/private-lesson-api';
import { goBack, InstructorShell, StaffErrorView, staffStyles, useAction } from '../../../lib/instructor/staff-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../../../lib/theme';

export default function PrivateLessonRulesScreen() {
  const params = useLocalSearchParams<{ academyId: string; academyName: string }>();
  const academyId = readRouteId(params.academyId);
  const academyName = typeof params.academyName === 'string' ? params.academyName.slice(0, 60) : '';
  const rule = useApiResource<PrivateLessonRuleView>(academyId === null ? null : rulePath(academyId));

  // 고른 값 — null 이면 아직 안 건드린 것이라 서버의 지금 값을 보인다(서버 값을 상태로 복사하지 않는다)
  const [deadline, setDeadline] = useState<ChangeDeadlineHours | null>(null);
  const [validity, setValidity] = useState<ValidityMonths | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [saved, setSaved] = useState<string | null>(null);
  const save = useAction();

  const shell = (children: ReactNode) => (
    <InstructorShell title="개인 레슨 규칙" active="classes" onBack={() => goBack('/instructor/private-lessons')}>
      {children}
    </InstructorShell>
  );

  if (academyId === null) return shell(<Text style={styles.error}>학원 정보를 읽지 못했어요. 수강생 화면에서 다시 열어 주세요.</Text>);
  if (rule.state.status === 'loading') return shell(<LoadingView label="규칙을 불러오고 있어요" />);
  if (rule.state.status === 'error') return shell(<StaffErrorView error={rule.state.error} onRetry={rule.reload} />);

  // ---- 렌더 중 계산: 지금 보일 값 = 고른 값 ?? 서버 값 ----
  const view = rule.state.data;
  const serverDeadline: ChangeDeadlineHours = isDeadline(view.changeDeadlineHours) ? view.changeDeadlineHours : 24;
  const serverValidity: ValidityMonths = isValidity(view.validityMonths) ? view.validityMonths : RECOMMENDED_VALIDITY_MONTHS;
  const hours = deadline ?? serverDeadline;
  const months = validity ?? serverValidity;
  const notice = memberNoticeLines(hours, months);
  const changed = hours !== serverDeadline || months !== serverValidity;

  const versionLine = view.isDefault
    ? '아직 저장한 규칙이 없어 기본값(24시간 전 · 3개월)을 보여 줘요.'
    : `지금 판본 ${view.version ?? '-'}${view.effectiveFrom !== null ? ` · ${effectiveFromLabel(view.effectiveFrom)}` : ''}`;

  const handleSave = async () => {
    const result = await save.run(() => saveRule({ academyId, changeDeadlineHours: hours, validityMonths: months }, idempotencyKey));
    if (result === null) return;
    // 판본 번호가 그대로면 서버가 「같은 값」으로 보고 새 판본을 만들지 않은 것이다(200)
    setSaved(
      !view.isDefault && result.version === view.version
        ? '바뀐 값이 없어 지금 판본 그대로예요.'
        : `판본 ${result.version} 으로 저장했어요. 이제부터 결제하는 수강권에 적용돼요.`,
    );
    setDeadline(null);
    setValidity(null);
    setIdempotencyKey(newIdempotencyKey());
    rule.reload();
  };

  return shell(
    <>
      <View style={styles.gapXs}>
        <Text style={styles.heading}>{academyName !== '' ? `${academyName} · ` : ''}개인 레슨 수강권</Text>
        <Text style={staffStyles.muted}>강사가 정하는 개인 레슨 전용 규칙이에요. 회원이 결제하기 전에 그대로 보여요.</Text>
        <Text style={styles.version}>{versionLine}</Text>
      </View>

      <Text style={styles.label}>바꾸기·취소 기한</Text>
      <View style={styles.chips} accessibilityRole="radiogroup">
        {CHANGE_DEADLINE_HOURS.map((h) => (
          <Chip key={h} label={`${h}시간 전`} selected={hours === h} onPress={() => pick(() => setDeadline(h))} />
        ))}
      </View>

      <Text style={styles.label}>기한이 지난 뒤 취소 · 오지 않음</Text>
      <FixedRow title="1회 차감" />
      <Text style={styles.label}>강사 사정 취소</Text>
      <FixedRow title="회차를 돌려줘요" />

      <Text style={styles.label}>수강권 사용 기한 · 결제일부터</Text>
      <View style={styles.chips} accessibilityRole="radiogroup">
        {VALIDITY_MONTHS.map((m) => (
          <Chip
            key={m}
            label={m === RECOMMENDED_VALIDITY_MONTHS ? `${m}개월 · 추천` : `${m}개월`}
            selected={months === m}
            onPress={() => pick(() => setValidity(m))}
          />
        ))}
      </View>

      <Text style={styles.label}>남은 회차 환불</Text>
      <View style={styles.fixed}>
        <Text style={styles.fixedTitle}>금액은 학원 대표가 정해요</Text>
        <Text style={styles.sub}>회원이 앱 문의로 요청 · {academyName !== '' ? `${academyName} ` : ''}대표가 처리</Text>
      </View>

      <Text style={styles.label}>회원에게 이렇게 보여요</Text>
      <View style={styles.notice}>
        <Text style={styles.noticeTitle}>개인 레슨 취소·환불 안내</Text>
        {notice.map((line) => (
          <Text key={line} style={styles.noticeLine}>
            · {line}
          </Text>
        ))}
      </View>

      <Text style={staffStyles.muted}>저장한 뒤 결제하는 수강권부터 적용돼요. 이미 결제한 수강권은 결제할 때 규칙 그대로예요.</Text>

      {saved !== null && (
        <Text style={styles.done} accessibilityLiveRegion="polite">
          {saved}
        </Text>
      )}
      {save.error !== null && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {save.error}
        </Text>
      )}

      <Pressable
        // 기본값을 처음 저장할 때는 값이 같아도 판본 1 을 만든다(서버 규칙) — 그래서 isDefault 면 켜 둔다
        style={[styles.primary, (save.busy || (!changed && !view.isDefault)) && styles.primaryOff]}
        onPress={handleSave}
        disabled={save.busy || (!changed && !view.isDefault)}
        accessibilityRole="button"
        accessibilityState={{ disabled: save.busy || (!changed && !view.isDefault) }}
      >
        <Text style={[styles.primaryText, (save.busy || (!changed && !view.isDefault)) && styles.primaryTextOff]}>
          {save.busy ? '저장하는 중…' : '저장'}
        </Text>
      </Pressable>
    </>,
  );

  /** 칩을 누르면 지난 저장 결과 문구를 지우고 값을 바꾼다 */
  function pick(apply: () => void) {
    setSaved(null);
    save.setError(null);
    apply();
  }
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.chip, selected && styles.chipOn]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      aria-checked={selected}
      accessibilityLabel={label}
    >
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

/** 값을 바꿀 수 없는 고정 규칙 한 줄 */
function FixedRow({ title }: { title: string }) {
  return (
    <View style={[styles.fixed, styles.fixedRow]}>
      <Text style={styles.fixedTitle}>{title}</Text>
      <Text style={styles.sub}>바꿀 수 없어요</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  gapXs: { gap: space.xs },
  heading: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  version: { color: colors.brown, fontSize: font.small, fontWeight: '700' },
  label: { color: colors.ink3, fontSize: font.small, marginTop: space.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 40,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: colors.brown, borderColor: colors.brown },
  chipText: { color: colors.ink, fontSize: font.small, fontWeight: '700' },
  chipTextOn: { color: colors.surface },
  fixed: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: 2 },
  fixedRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: MIN_TOUCH },
  fixedTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  sub: { color: colors.ink3, fontSize: font.tiny },
  notice: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: space.md, gap: space.xs },
  noticeTitle: { color: colors.ink, fontSize: font.small, fontWeight: '800' },
  noticeLine: { color: colors.ink, fontSize: font.small, lineHeight: 19 },
  done: { color: colors.ok, fontSize: font.small, fontWeight: '700', backgroundColor: colors.okSoft, padding: space.md, borderRadius: radius.md },
  error: { color: colors.danger, fontSize: font.small },
  primary: { minHeight: 56, borderRadius: radius.lg, backgroundColor: colors.brown, alignItems: 'center', justifyContent: 'center' },
  primaryOff: { backgroundColor: colors.disabled },
  primaryText: { color: colors.surface, fontSize: 16, fontWeight: '800' },
  primaryTextOff: { color: colors.disabledInk },
});
