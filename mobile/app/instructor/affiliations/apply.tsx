/**
 * 강사 소속 신청(보드 I27) — S2-1.10. 주소 `/instructor/affiliations/apply`.
 * 학원 탭(I12)의 「+ 소속 신청」, 마이 → 소속 학원(I9E)의 「+ 학원 소속 신청」, 내 소속 신청(I27B)의 「다시 신청하기」에서 들어온다.
 *
 * 흐름(FR-011 · FR-071 보완 — 소속은 학원마다 대표 승인)
 *  1. 학원 이름·시·구로 검색 → `GET /api/instructor/academies?q=`(11 §3-1). 받는 학원(active)만 나온다
 *  2. 결과 줄을 하나 고른다. 이미 소속됐거나 승인 대기 중인 학원은 상태 글자만 보이고 고를 수 없다
 *  3. 활동 장르는 가입 때 고른 것이 그대로 간다(`GET /api/instructor/me/profile`, FR-011b) — 여기서 바꾸지 않는다
 *  4. 대표에게 한마디(선택, 200자) → `POST /api/instructor/affiliations`(08 §2) → 내 소속 신청(I27B)으로
 *
 * 「다시 신청하기」는 주소에 `q`(학원 이름)와 `academyId` 를 실어 와서, 처음부터 그 학원이 검색·선택된 채로 열린다.
 * 주소 값은 믿지 않는다 — q 는 길이를 자르고, academyId 는 검색 결과에 있는 학원과 같을 때만 선택으로 쓴다.
 *
 * 효과 훅 없음: 검색은 「검색」 버튼(또는 키보드 완료)을 누를 때 검색어 상태를 바꾸고, 그 값으로 만든 주소를
 * `useApiResource` 가 읽는다. 고른 학원·버튼 켜짐은 렌더 중에 계산한다.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useApiResource } from '../../../lib/catalog/use-api-resource';
import { LoadingView } from '../../../lib/catalog/ui';
import {
  academySearchPath,
  APPLY_MESSAGE_MAX,
  applyAffiliation,
  canApplyTo,
  searchStatusLabel,
  type AcademySearchItem,
} from '../../../lib/instructor/affiliation-api';
import type { InstructorProfile } from '../../../lib/instructor/staff-api';
import { goBack, InstructorShell, StaffErrorView, staffStyles, useAction } from '../../../lib/instructor/staff-ui';
import { GENRE_LABELS } from '../../../lib/onboarding/labels';
import type { Genre } from '../../../lib/onboarding/types';
import { colors, font, MIN_TOUCH, radius, space } from '../../../lib/theme';

/** 검색어 최대 글자 수 — 서버 ACADEMY_SEARCH_QUERY_MAX(50)와 같다 */
const QUERY_MAX = 50;

/** 주소로 들어온 값 하나를 글자로. 배열이면 첫 값, 없으면 빈 글자 */
function firstParam(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw ?? '').slice(0, QUERY_MAX);
}

function genreName(genre: Genre): string {
  return GENRE_LABELS[genre]?.name ?? genre;
}

export default function InstructorAffiliationApplyScreen() {
  const params = useLocalSearchParams<{ q?: string; academyId?: string }>();
  const initialQuery = firstParam(params.q);
  const [draft, setDraft] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [pickedId, setPickedId] = useState<string | null>(firstParam(params.academyId) || null);
  const [message, setMessage] = useState('');
  const { busy, error, run } = useAction();

  const results = useApiResource<{ items: AcademySearchItem[] }>(academySearchPath(query));
  const profile = useApiResource<InstructorProfile>('/api/instructor/me/profile');

  // 렌더 중 계산: 고른 학원 = 결과 안에서 신청할 수 있는 학원일 때만. 검색어가 바뀌어 사라지면 선택도 풀린 것으로 본다
  const items = results.state.status === 'ready' ? results.state.data.items : [];
  const selected = items.find((item) => item.academyId === pickedId && canApplyTo(item)) ?? null;

  const handleSearch = () => setQuery(draft);

  const handleApply = async () => {
    if (selected === null) return;
    const applied = await run(() => applyAffiliation(selected.academyId, message));
    // 신청이 들어갔다 — 승인 대기 카드가 있는 내 소속 신청(I27B)으로. 뒤로 가기로 이 양식에 돌아오지 않게 바꿔 끼운다
    if (applied !== null) router.replace('/instructor/affiliations');
  };

  let resultBody;
  if (results.state.status === 'loading') {
    resultBody = <LoadingView label="학원을 찾고 있어요" />;
  } else if (results.state.status === 'error') {
    resultBody = <StaffErrorView error={results.state.error} onRetry={results.reload} />;
  } else if (items.length === 0) {
    resultBody = <Text style={staffStyles.muted}>{`「${query}」로 찾은 학원이 없어요. 학원 이름이나 구 이름으로 찾아보세요.`}</Text>;
  } else {
    resultBody = (
      <View style={styles.resultCard} accessibilityRole="radiogroup">
        {items.map((item, index) => (
          <ResultRow
            key={item.academyId}
            item={item}
            selected={selected?.academyId === item.academyId}
            divided={index > 0}
            onPick={() => setPickedId(item.academyId)}
          />
        ))}
      </View>
    );
  }

  const genreLine =
    profile.state.status === 'ready' ? `활동 장르 · ${genreName(profile.state.data.activityGenre)}` : '활동 장르를 불러오고 있어요';

  return (
    <InstructorShell title="소속 신청" active="academy" onBack={() => goBack('/instructor/academy')}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={handleSearch}
          placeholder="학원 이름 · 시 · 구"
          placeholderTextColor={colors.ink3}
          returnKeyType="search"
          maxLength={QUERY_MAX}
          accessibilityLabel="학원 검색어"
        />
        <Pressable style={styles.searchButton} onPress={handleSearch} accessibilityRole="button" accessibilityLabel="학원 검색">
          <Text style={styles.searchButtonText}>검색</Text>
        </Pressable>
      </View>

      <Text style={styles.label}>{results.state.status === 'ready' ? `검색 결과 ${items.length}곳` : '검색 결과'}</Text>
      {resultBody}

      <Text style={styles.label}>신청 내용</Text>
      <View style={staffStyles.card}>
        <Text style={styles.strong}>{genreLine}</Text>
        <Text style={staffStyles.muted}>가입할 때 고른 장르가 그대로 가요</Text>
      </View>

      <Text style={styles.label}>대표에게 한마디 · 선택</Text>
      <TextInput
        style={styles.messageInput}
        value={message}
        onChangeText={setMessage}
        placeholder="경력이나 가능한 시간대를 적어 주세요"
        placeholderTextColor={colors.ink3}
        multiline
        maxLength={APPLY_MESSAGE_MAX}
        accessibilityLabel="대표에게 한마디"
      />

      <View style={styles.infoBox}>
        <Text style={styles.infoTitle}>대표가 승인하면 알려 드려요</Text>
        <Text style={staffStyles.muted}>
          승인되면 학원 탭에 시간표·공지가 보이고 개인 레슨을 열 수 있어요. 수업 등록 권한은 대표가 따로 켜요.
        </Text>
      </View>
      <Text style={staffStyles.muted}>초대 링크를 받았다면 링크로 들어와요. 링크로 들어와도 대표가 승인하면 소속돼요.</Text>

      {error !== null && (
        <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      <Pressable
        style={[styles.primary, (selected === null || busy) && styles.primaryDisabled]}
        onPress={handleApply}
        disabled={selected === null || busy}
        accessibilityRole="button"
        accessibilityLabel={selected === null ? '학원을 고르면 소속 신청' : `${selected.name}에 소속 신청`}
        accessibilityState={{ disabled: selected === null || busy, busy }}
      >
        <Text style={[styles.primaryText, selected === null && styles.primaryTextDisabled]}>
          {busy ? '신청하고 있어요…' : selected === null ? '학원을 고르면 신청할 수 있어요' : `${selected.name}에 소속 신청`}
        </Text>
      </Pressable>
    </InstructorShell>
  );
}

interface ResultRowProps {
  item: AcademySearchItem;
  selected: boolean;
  divided: boolean;
  onPick: () => void;
}

/** 검색 결과 한 줄 — 이름 · 「서울 강남구 · 댄스스포츠」 · 오른쪽에 상태 글자 또는 고르기 동그라미 */
function ResultRow({ item, selected, divided, onPick }: ResultRowProps) {
  const status = searchStatusLabel(item);
  const pickable = canApplyTo(item);
  const detail = [`${item.region.sido} ${item.region.gu}`, ...item.genres.map(genreName)].join(' · ');
  return (
    <Pressable
      style={[styles.row, divided && styles.divider]}
      onPress={onPick}
      disabled={!pickable}
      accessibilityRole="radio"
      accessibilityLabel={status !== null ? `${item.name}, ${status}` : item.name}
      accessibilityState={{ checked: selected, disabled: !pickable }}
    >
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{item.name}</Text>
        <Text style={staffStyles.muted}>{detail}</Text>
        {item.affiliation?.status === 'rejected' && <Text style={styles.rowNote}>지난 신청이 거절됐어요 · 다시 신청할 수 있어요</Text>}
      </View>
      {status !== null ? (
        <Text style={item.affiliation?.status === 'pending' ? styles.statusPending : styles.statusActive}>{status}</Text>
      ) : (
        <View style={[styles.radio, selected && styles.radioOn]}>{selected && <View style={styles.radioDot} />}</View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  searchRow: { flexDirection: 'row', gap: space.sm },
  searchInput: {
    flex: 1,
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    paddingHorizontal: space.md,
    fontSize: font.body,
    color: colors.ink,
  },
  searchButton: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    backgroundColor: colors.ink,
    justifyContent: 'center',
  },
  searchButtonText: { color: colors.surface, fontWeight: '700' },
  label: { color: colors.ink3, fontSize: font.small, fontWeight: '700', marginTop: space.xs },
  resultCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.lg,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: MIN_TOUCH + 12, paddingVertical: space.md },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  rowTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  rowNote: { color: colors.brown, fontSize: font.tiny, marginTop: 2 },
  statusActive: { color: colors.ink3, fontSize: font.small, fontWeight: '700' },
  statusPending: { color: colors.brown, fontSize: font.small, fontWeight: '800' },
  radio: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: colors.brown, backgroundColor: colors.brown },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.surface },
  strong: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  messageInput: {
    minHeight: 88,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    padding: space.md,
    fontSize: font.body,
    color: colors.ink,
    textAlignVertical: 'top',
  },
  infoBox: { padding: space.lg, borderRadius: radius.md, backgroundColor: colors.brownSoft, gap: space.xs },
  infoTitle: { color: colors.brown, fontSize: font.body, fontWeight: '800' },
  error: { color: colors.danger, fontSize: font.body, lineHeight: 20 },
  primary: {
    minHeight: 52,
    borderRadius: radius.md,
    backgroundColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    marginTop: space.sm,
  },
  primaryDisabled: { backgroundColor: colors.disabled },
  primaryText: { color: colors.surface, fontSize: 16, fontWeight: '700' },
  primaryTextDisabled: { color: colors.disabledInk },
});
