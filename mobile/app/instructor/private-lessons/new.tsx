/**
 * 개인 레슨 개설 1/2 — 학원 고르기 · 수강권(보드 I10B). S2-4.6(앱 개인 레슨·일정 화면). 주소 `/instructor/private-lessons/new`.
 *
 * 개인 레슨은 소속만 있으면 대표 승인 없이 바로 열린다. **판매자 = 여기서 고른 학원**이다(수용 ①) —
 * 회원 결제도, 강사 정산도 그 학원에서 받는다. 그래서 학원 고르기가 맨 위에 있다.
 *
 * 부르는 API
 *  1. `GET /api/instructor/me/profile`  활동 장르 — 장르는 활동 장르로 고정이고 세부 장르만 고른다(계약 11 §10-1)
 *  2. `GET /api/instructor/academies?q=`  학원 검색(§3-1). `canOpenPrivateLesson`(소속됨)인 학원만 고를 수 있다
 *  3. `POST /api/instructor/private-lesson-products`(Idempotency-Key)  「다음」을 누를 때 상품을 연다(§10-1, S2-4.2)
 *     → 성공하면 열 시간 정하기(I10C)로 넘어간다
 *
 * 종목(룸바·차차차…)은 강사가 아니라 **회원이 살 때 하나 고른다**(FR-021). 그래서 종목 칩은 고르는 칸이 아니라 안내로만 보인다.
 * 소속이 아닌 학원은 「소속 신청」(I27)으로 이어 준다.
 *
 * 입력은 화면 상태(useState), 검사는 렌더 중 계산, 서버 호출은 버튼 핸들러 안에서만 한다(효과 훅 없음).
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatWon } from '../../../lib/catalog/format';
import { LoadingView, PrimaryButton } from '../../../lib/catalog/ui';
import { newIdempotencyKey, useApiResource } from '../../../lib/catalog/use-api-resource';
import { academySearchPath, type AcademySearchItem } from '../../../lib/instructor/affiliation-api';
import { DISCIPLINES_OF, SUB_GENRES_OF } from '../../../lib/instructor/class-api';
import {
  DEFAULT_SESSION_COUNT,
  LESSON_MINUTES,
  openPrivateLessonProduct,
  parsePrice,
  SESSION_COUNT_MAX,
  type LessonMinutes,
} from '../../../lib/instructor/schedule-api';
import type { InstructorProfile } from '../../../lib/instructor/staff-api';
import { goBack, InstructorShell, StaffErrorView, staffStyles, useAction } from '../../../lib/instructor/staff-ui';
import { GENRE_LABELS } from '../../../lib/onboarding/labels';
import { colors, font, MIN_TOUCH, radius, space } from '../../../lib/theme';

export default function PrivateLessonOpenScreen() {
  const profile = useApiResource<InstructorProfile>('/api/instructor/me/profile');
  const [queryText, setQueryText] = useState('');
  // 검색 버튼을 눌렀을 때의 검색어 — 글자를 칠 때마다 서버를 부르지 않는다
  const [query, setQuery] = useState('');
  const results = useApiResource<{ items: AcademySearchItem[] }>(academySearchPath(query));

  const [pickedAcademyId, setPickedAcademyId] = useState<string | null>(null);
  const [pickedSubGenre, setPickedSubGenre] = useState<string | null>(null);
  const [sessionCount, setSessionCount] = useState(DEFAULT_SESSION_COUNT);
  const [minutes, setMinutes] = useState<LessonMinutes>(50);
  const [priceText, setPriceText] = useState('');
  // 멱등 키는 화면이 처음 열릴 때 한 번 만든다 — 응답을 못 받고 다시 눌러도 상품은 하나만 생긴다
  const [idempotencyKey] = useState(newIdempotencyKey);
  const open = useAction();

  if (profile.state.status === 'loading') {
    return (
      <InstructorShell title="개인 레슨 개설 · 1 / 2" active="classes" onBack={() => goBack('/instructor/private-lessons')}>
        <LoadingView label="내 활동 장르를 불러오고 있어요" />
      </InstructorShell>
    );
  }
  if (profile.state.status === 'error') {
    return (
      <InstructorShell title="개인 레슨 개설 · 1 / 2" active="classes" onBack={() => goBack('/instructor/private-lessons')}>
        <StaffErrorView error={profile.state.error} onRetry={profile.reload} />
      </InstructorShell>
    );
  }

  const genre = profile.state.data.activityGenre;
  const subGenres = SUB_GENRES_OF[genre] ?? [];
  const items = results.state.status === 'ready' ? results.state.data.items : [];

  // ---- 렌더 중 계산: 무엇이 골라져 있나 ----
  // 아직 안 골랐으면 개설할 수 있는 첫 학원 · 첫 세부 장르를 고른 것으로 본다(보드 I10B 처음 모습)
  const openable = items.filter((item) => item.canOpenPrivateLesson);
  const academy = openable.find((item) => item.academyId === pickedAcademyId) ?? openable[0] ?? null;
  const subGenre = subGenres.length === 0 ? null : subGenres.find((s) => s.value === pickedSubGenre)?.value ?? subGenres[0]!.value;
  const disciplines = subGenre !== null ? DISCIPLINES_OF[subGenre] ?? [] : [];
  const price = parsePrice(priceText);
  const problem =
    academy === null ? '개인 레슨을 열 소속 학원을 골라 주세요.' : price === null ? '수강권 금액을 숫자로 적어 주세요(1,000만 원까지).' : null;

  const handleNext = async () => {
    if (academy === null || price === null) return;
    const product = await open.run(() =>
      openPrivateLessonProduct({ academyId: academy.academyId, subGenre, lessonMinutes: minutes, sessionCount, priceAmount: price }, idempotencyKey),
    );
    if (product === null) return;
    // 열 시간 정하기(I10C)는 방금 연 상품의 요약을 주소 인자로 받는다(상품 하나를 다시 읽는 경로가 아직 없다)
    router.push({
      pathname: '/instructor/private-lessons/[classId]/slots',
      params: {
        classId: product.classId,
        academyId: product.academyId,
        academyName: product.academyName,
        subGenre: product.subGenre ?? '',
        minutes: String(product.lessonMinutes),
        count: String(product.sessionCount),
        price: String(product.priceAmount),
      },
    });
  };

  return (
    <InstructorShell title="개인 레슨 개설 · 1 / 2" active="classes" onBack={() => goBack('/instructor/private-lessons')}>
      {/* ① 학원 */}
      <View style={staffStyles.card}>
        <Text style={staffStyles.sectionTitle}>학원 검색 · 어느 학원에서 열까요</Text>
        <View style={styles.searchRow}>
          <TextInput
            style={styles.input}
            value={queryText}
            onChangeText={setQueryText}
            onSubmitEditing={() => setQuery(queryText)}
            placeholder="학원 이름"
            placeholderTextColor={colors.ink3}
            accessibilityLabel="학원 이름 검색"
            returnKeyType="search"
          />
          <Pressable style={styles.searchButton} onPress={() => setQuery(queryText)} accessibilityRole="button" accessibilityLabel="학원 검색">
            <Text style={styles.searchButtonText}>⌕</Text>
          </Pressable>
        </View>
        {results.state.status === 'loading' && <LoadingView label="학원을 찾고 있어요" />}
        {results.state.status === 'error' && <StaffErrorView error={results.state.error} onRetry={results.reload} />}
        {results.state.status === 'ready' && items.length === 0 && <Text style={staffStyles.muted}>찾는 학원이 없어요.</Text>}
        {items.map((item, index) => (
          <AcademyRow
            key={item.academyId}
            item={item}
            selected={academy?.academyId === item.academyId}
            divided={index > 0}
            onPick={() => setPickedAcademyId(item.academyId)}
          />
        ))}
      </View>

      {/* ② 장르 · 종목 */}
      <View style={staffStyles.card}>
        <Text style={staffStyles.sectionTitle}>장르 · 종목 (회원이 하나 골라요)</Text>
        {subGenres.length === 0 ? (
          <Text style={styles.genreFixed}>{GENRE_LABELS[genre]?.name ?? genre}</Text>
        ) : (
          <View style={styles.chips} accessibilityRole="radiogroup">
            {subGenres.map((option) => (
              <Pressable
                key={option.value}
                style={[styles.chip, subGenre === option.value && styles.chipOn]}
                onPress={() => setPickedSubGenre(option.value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: subGenre === option.value }}
                aria-checked={subGenre === option.value}
              >
                <Text style={[styles.chipText, subGenre === option.value && styles.chipTextOn]}>{option.label}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {disciplines.length > 0 && (
          <View style={styles.chips}>
            {disciplines.map((d) => (
              <Text key={d.value} style={styles.tag}>
                {d.label}
              </Text>
            ))}
          </View>
        )}
      </View>

      {/* ③ 수강권 */}
      <View style={staffStyles.card}>
        <Text style={staffStyles.sectionTitle}>수강권</Text>
        <View style={styles.countRow}>
          <Stepper label="−" a11y="횟수 줄이기" disabled={sessionCount <= 1} onPress={() => setSessionCount((n) => n - 1)} />
          <Text style={styles.count} accessibilityLabel={`${sessionCount}회`}>
            {sessionCount}회
          </Text>
          <Stepper label="+" a11y="횟수 늘리기" disabled={sessionCount >= SESSION_COUNT_MAX} onPress={() => setSessionCount((n) => n + 1)} />
          <TextInput
            style={[styles.input, styles.priceInput]}
            value={priceText}
            onChangeText={setPriceText}
            placeholder="금액"
            placeholderTextColor={colors.ink3}
            keyboardType="number-pad"
            accessibilityLabel="수강권 금액(원)"
          />
          <Text style={styles.won}>원</Text>
        </View>
        <View style={styles.chips} accessibilityRole="radiogroup">
          {LESSON_MINUTES.map((m) => (
            <Pressable
              key={m}
              style={[styles.chip, minutes === m && styles.chipOn]}
              onPress={() => setMinutes(m)}
              accessibilityRole="radio"
              accessibilityState={{ selected: minutes === m }}
              aria-checked={minutes === m}
            >
              <Text style={[styles.chipText, minutes === m && styles.chipTextOn]}>{m}분</Text>
            </Pressable>
          ))}
        </View>
        <Text style={staffStyles.muted}>
          기본 {DEFAULT_SESSION_COUNT}회 · 횟수·금액은 직접{price !== null ? ` · ${sessionCount}회 ${formatWon(price)}` : ''}
        </Text>
      </View>

      {academy !== null && (
        <Text style={styles.payout}>회원 결제는 {academy.name}으로 들어가요. 강사 정산도 이 학원에서 받아요.</Text>
      )}
      {(open.error ?? problem) !== null && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {open.error ?? problem}
        </Text>
      )}
      <PrimaryButton label={open.busy ? '여는 중…' : '다음 · 열 시간 정하기'} onPress={handleNext} disabled={problem !== null || open.busy} />
    </InstructorShell>
  );
}

function AcademyRow({ item, selected, divided, onPick }: { item: AcademySearchItem; selected: boolean; divided: boolean; onPick: () => void }) {
  // 줄 오른쪽에 무엇을 둘지 — 소속됨이면 고르기, 승인 대기면 기다림 안내, 아니면 소속 신청(I27)으로 보낸다
  const pending = item.affiliation?.status === 'pending';
  const detail = item.canOpenPrivateLesson
    ? '소속 승인'
    : pending
      ? '승인 대기 · 대표 승인 뒤 개설할 수 있어요'
      : '소속 아님 · 대표 승인 뒤 개설할 수 있어요';
  return (
    <View style={[styles.academyRow, divided && styles.divider, selected && styles.academyRowOn]}>
      <View style={styles.academyText}>
        <Text style={styles.academyName}>{item.name}</Text>
        <Text style={[styles.academyDetail, !item.canOpenPrivateLesson && styles.academyDetailOff]}>{detail}</Text>
      </View>
      {item.canOpenPrivateLesson ? (
        <Pressable
          style={[styles.pick, selected && styles.pickOn]}
          onPress={onPick}
          accessibilityRole="radio"
          accessibilityState={{ selected }}
          aria-checked={selected}
          accessibilityLabel={`${item.name} 고르기`}
        >
          <Text style={[styles.pickText, selected && styles.pickTextOn]}>{selected ? '✓ 선택' : '고르기'}</Text>
        </Pressable>
      ) : (
        !pending && (
          <Pressable style={styles.pick} onPress={() => router.push('/instructor/affiliations/apply')} accessibilityRole="button" accessibilityLabel={`${item.name} 소속 신청`}>
            <Text style={styles.pickText}>소속 신청</Text>
          </Pressable>
        )
      )}
    </View>
  );
}

function Stepper({ label, a11y, disabled, onPress }: { label: string; a11y: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.stepper, disabled && styles.stepperOff]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
    >
      <Text style={styles.stepperText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  searchRow: { flexDirection: 'row', gap: space.sm },
  input: {
    flex: 1,
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    color: colors.ink,
    backgroundColor: colors.surface,
    fontSize: font.body,
  },
  searchButton: { width: MIN_TOUCH, minHeight: MIN_TOUCH, borderRadius: radius.md, backgroundColor: colors.brown, alignItems: 'center', justifyContent: 'center' },
  searchButtonText: { color: colors.surface, fontSize: 18, fontWeight: '700' },
  academyRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, minHeight: MIN_TOUCH + 8 },
  academyRowOn: { backgroundColor: colors.brownSoft, marginHorizontal: -space.sm, paddingHorizontal: space.sm, borderRadius: radius.sm },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  academyText: { flex: 1, gap: 2 },
  academyName: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  academyDetail: { color: colors.ok, fontSize: font.tiny, fontWeight: '700' },
  academyDetailOff: { color: colors.ink3, fontWeight: '400' },
  pick: { minHeight: 40, paddingHorizontal: space.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.brown, justifyContent: 'center' },
  pickOn: { backgroundColor: colors.brown },
  pickText: { color: colors.brown, fontSize: font.small, fontWeight: '700' },
  pickTextOn: { color: colors.surface },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { minHeight: 40, paddingHorizontal: space.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, justifyContent: 'center' },
  chipOn: { borderColor: colors.brown, backgroundColor: colors.brownSoft },
  chipText: { color: colors.ink, fontSize: font.small },
  chipTextOn: { fontWeight: '700' },
  tag: { paddingHorizontal: space.sm, paddingVertical: 4, borderRadius: radius.sm, backgroundColor: colors.bg, color: colors.ink3, fontSize: font.tiny, overflow: 'hidden' },
  genreFixed: { color: colors.ink, fontSize: font.body, fontWeight: '700' },
  countRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  stepper: { width: 40, height: 40, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  stepperOff: { backgroundColor: colors.disabled },
  stepperText: { fontSize: 18, color: colors.ink },
  count: { minWidth: 44, textAlign: 'center', fontSize: 16, fontWeight: '800', color: colors.ink },
  priceInput: { textAlign: 'right' },
  won: { color: colors.ink, fontSize: font.body },
  payout: { color: colors.ink, fontSize: font.small, lineHeight: 19, backgroundColor: colors.brownSoft, padding: space.md, borderRadius: radius.md },
  error: { color: colors.danger, fontSize: font.small, lineHeight: 18 },
});
