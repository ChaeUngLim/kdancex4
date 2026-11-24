/**
 * 새 반 열기 추천(보드 I15) — S6-3.6(앱 강사 레벨·후보 화면). 주소 `/instructor/new-class`.
 *
 * 강사가 열고 싶은 반의 조건(장르 · 레벨대 · 요일·시간 · 정원)을 넣고 `후보 찾기`를 누르면
 * 후보 수(남·여)와 「이렇게 골랐어요」 근거 세 줄을 보여 준다(spec FR-164(개강 후보 추천)).
 * 그 아래 「명단을 볼까요?」에서 `명단 보기`를 눌러야 후보 명단(I15B)으로 간다(FR-272(명단 출력 동의)).
 *
 * 흐름이 눈에 보이게 짰다:
 *  - 조건 칸은 모두 useState. 줄을 누르면 그 줄 아래에 고르는 칸이 펼쳐진다(한 번에 하나).
 *  - 서버는 `후보 찾기` 버튼을 눌렀을 때만 부른다 — 누르는 순간의 조건을 `searchPath` 에 넣고,
 *    useApiResource 가 그 경로를 읽는다(경로가 null 이면 부르지 않는다). 조건을 바꿔도 다시 누르기 전까지 결과는 그대로다.
 *  - 강사 멤버십이 아니면 서버가 403 INSTRUCTOR_MEMBERSHIP_REQUIRED → 결과 자리에 잠김 안내.
 *  - 장르의 처음 값은 내 프로필의 활동 장르에서 렌더 중에 계산한다(효과 훅 없음).
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { LoadingView } from '../../../lib/catalog/ui';
import { useApiResource, type ResourceState } from '../../../lib/catalog/use-api-resource';
import {
  candidatesPath,
  dayTimeText,
  DETAIL_GENRE_GROUPS,
  genreRowText,
  levelRangeText,
  queryString,
  readTimeRange,
  WEEKDAYS,
  type CandidateQuery,
  type CandidateSummary,
  type Weekday,
} from '../../../lib/instructor/candidates-api';
import { DETAIL_GENRE_KO, INSTRUCTOR_MEMBERSHIP_REQUIRED, LEVEL_MAX, LEVEL_MIN, stageLabelOf } from '../../../lib/instructor/level-api';
import { Button, Chip, levelUiStyles, LockNotice, Stepper } from '../../../lib/instructor/level-ui';
import type { InstructorProfile } from '../../../lib/instructor/staff-api';
import { goBack, InstructorShell, StaffErrorView, staffStyles } from '../../../lib/instructor/staff-ui';
import type { LevelDetailGenre } from '../../../lib/levels/level-cards-view';
import type { Genre } from '../../../lib/onboarding/types';
import { colors, font, MIN_TOUCH, radius, space } from '../../../lib/theme';

/** 활동 장르 → 처음 고를 세부 장르(그 묶음의 첫 종목) */
const FIRST_DETAIL: Readonly<Record<Genre, LevelDetailGenre>> = {
  dance_sport: 'samba',
  salsa_bachata: 'salsa',
  argentine_tango: 'argentine_tango',
  swing: 'swing',
};

/** 정원 한쪽 최대(서버 CANDIDATE_CAPACITY_MAX 200 보다 작게, 화면에서 누를 만한 범위) */
const CAPACITY_MAX = 50;

type Editor = 'genre' | 'level' | 'dayTime' | 'capacity' | null;

export default function NewClassCandidatesScreen() {
  const profile = useApiResource<InstructorProfile>('/api/instructor/me/profile');
  // 조건 칸 — 장르는 고르기 전까지 null(그때는 활동 장르에서 계산한 값을 쓴다)
  const [pickedGenre, setPickedGenre] = useState<LevelDetailGenre | null>(null);
  const [levelFrom, setLevelFrom] = useState(0);
  const [levelTo, setLevelTo] = useState(3);
  const [weekdays, setWeekdays] = useState<Weekday[]>([]);
  const [timeFromText, setTimeFromText] = useState('');
  const [timeToText, setTimeToText] = useState('');
  const [capacityMale, setCapacityMale] = useState(8);
  const [capacityFemale, setCapacityFemale] = useState(8);
  const [editor, setEditor] = useState<Editor>(null);
  // 누른 순간의 조건 — 결과 화면과 명단 화면이 같은 조건을 쓰게 함께 둔다
  const [searched, setSearched] = useState<CandidateQuery | null>(null);
  // 「명단을 볼까요?」에서 「나중에」를 누르면 상자를 접는다
  const [listLater, setListLater] = useState(false);
  const result = useApiResource<CandidateSummary>(searched === null ? null : candidatesPath(searched));

  // 렌더 중 계산: 장르 처음 값 · 시간 칸 검사
  const defaultGenre = profile.state.status === 'ready' ? FIRST_DETAIL[profile.state.data.activityGenre] ?? 'samba' : null;
  const genre = pickedGenre ?? defaultGenre;
  const time = readTimeRange(timeFromText, timeToText);
  const canSearch = genre !== null && time.ok;

  const toggle = (next: Editor) => setEditor(editor === next ? null : next);
  const toggleDay = (day: Weekday) => setWeekdays(weekdays.includes(day) ? weekdays.filter((d) => d !== day) : [...weekdays, day]);

  // `후보 찾기` — 이 순간의 조건으로 서버를 부른다(이미 같은 조건이면 다시 읽기)
  const onSearch = () => {
    if (genre === null || !time.ok) return;
    const next: CandidateQuery = { detailGenre: genre, levelFrom, levelTo, weekdays, timeFrom: time.from, timeTo: time.to, capacityMale, capacityFemale };
    setEditor(null);
    setListLater(false);
    if (searched !== null && queryString(searched) === queryString(next)) result.reload();
    else setSearched(next);
  };

  return (
    <InstructorShell title="새 반 열기 추천" active="classes" onBack={() => goBack('/instructor')}>
      <Text style={levelUiStyles.tag}>멤버십</Text>
      <Text style={styles.groupLabel}>열고 싶은 반</Text>
      <View style={styles.card}>
        <ConditionRow label="장르" value={genre === null ? '고르기' : genreRowText(genre)} open={editor === 'genre'} onPress={() => toggle('genre')} />
        {editor === 'genre' && (
          <View style={styles.editor}>
            {DETAIL_GENRE_GROUPS.map((g) => (
              <View key={g.group} style={styles.editorGroup}>
                <Text style={staffStyles.muted}>{g.group}</Text>
                <View style={styles.chips}>
                  {g.genres.map((d) => (
                    <Chip key={d} label={DETAIL_GENRE_KO[d]} selected={genre === d} onPress={() => setPickedGenre(d)} />
                  ))}
                </View>
              </View>
            ))}
          </View>
        )}
        <ConditionRow label="레벨대" value={levelRangeText(levelFrom, levelTo)} open={editor === 'level'} onPress={() => toggle('level')} divided />
        {editor === 'level' && (
          <View style={styles.editor}>
            <Text style={staffStyles.muted}>시작</Text>
            {/* 시작이 끝을 넘지 않게 — 시작을 올리면 끝도 같이 민다 */}
            <Stepper
              label="레벨대 시작"
              value={levelFrom}
              min={LEVEL_MIN}
              max={LEVEL_MAX}
              caption={stageLabelOf(levelFrom)}
              onChange={(v) => {
                setLevelFrom(v);
                if (v > levelTo) setLevelTo(v);
              }}
            />
            <Text style={staffStyles.muted}>끝</Text>
            <Stepper label="레벨대 끝" value={levelTo} min={levelFrom} max={LEVEL_MAX} caption={stageLabelOf(levelTo)} onChange={setLevelTo} />
          </View>
        )}
        <ConditionRow
          label="요일 · 시간"
          value={dayTimeText({ weekdays, timeFrom: time.ok ? time.from : null, timeTo: time.ok ? time.to : null })}
          open={editor === 'dayTime'}
          onPress={() => toggle('dayTime')}
          divided
        />
        {editor === 'dayTime' && (
          <View style={styles.editor}>
            <View style={styles.chips}>
              {WEEKDAYS.map((w) => (
                <Chip key={w.key} label={w.label} selected={weekdays.includes(w.key)} onPress={() => toggleDay(w.key)} />
              ))}
            </View>
            <View style={levelUiStyles.row}>
              <TextInput
                style={styles.input}
                value={timeFromText}
                onChangeText={setTimeFromText}
                placeholder="시작 20:30"
                accessibilityLabel="시작 시간"
                placeholderTextColor={colors.ink3}
              />
              <TextInput
                style={styles.input}
                value={timeToText}
                onChangeText={setTimeToText}
                placeholder="끝 21:30"
                accessibilityLabel="끝 시간"
                placeholderTextColor={colors.ink3}
              />
            </View>
            {!time.ok && <Text style={styles.error}>{time.message}</Text>}
            <Text style={staffStyles.muted}>요일은 기록만 하고, 후보는 선호 시간대가 겹치는지로 골라요. 시간을 비우면 시간은 보지 않아요.</Text>
          </View>
        )}
        <ConditionRow
          label="정원"
          value={`남 ${capacityMale} · 여 ${capacityFemale}`}
          open={editor === 'capacity'}
          onPress={() => toggle('capacity')}
          divided
        />
        {editor === 'capacity' && (
          <View style={styles.editor}>
            <Text style={staffStyles.muted}>남</Text>
            <Stepper label="남 정원" value={capacityMale} min={0} max={CAPACITY_MAX} onChange={setCapacityMale} />
            <Text style={staffStyles.muted}>여</Text>
            <Stepper label="여 정원" value={capacityFemale} min={0} max={CAPACITY_MAX} onChange={setCapacityFemale} />
          </View>
        )}
      </View>

      <Button label="후보 찾기" onPress={onSearch} disabled={!canSearch} />

      {searched !== null && (
        <SearchResult
          state={result.state}
          onRetry={result.reload}
          listLater={listLater}
          onLater={() => setListLater(true)}
          onOpenList={() => router.push(`/instructor/new-class/candidates?${queryString(searched)}`)}
        />
      )}
    </InstructorShell>
  );
}

function ConditionRow({ label, value, open, onPress, divided = false }: { label: string; value: string; open: boolean; onPress: () => void; divided?: boolean }) {
  return (
    <Pressable
      style={[styles.row, divided && styles.divider]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${value}`}
      accessibilityState={{ expanded: open }}
    >
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
      <Text style={styles.chevron}>{open ? '⌃' : '›'}</Text>
    </Pressable>
  );
}

interface SearchResultProps {
  state: ResourceState<CandidateSummary>;
  onRetry: () => void;
  listLater: boolean;
  onLater: () => void;
  onOpenList: () => void;
}

/** 후보 수 카드 + 「명단을 볼까요?」 — 멤버십이 아니면 잠김 안내 */
function SearchResult({ state, onRetry, listLater, onLater, onOpenList }: SearchResultProps) {
  if (state.status === 'loading') return <LoadingView label="후보를 찾고 있어요" />;
  if (state.status === 'error') {
    if (state.error.code === INSTRUCTOR_MEMBERSHIP_REQUIRED) {
      return (
        <LockNotice title="멤버십 강사만 쓸 수 있어요">
          <Text style={staffStyles.muted}>새 반 후보 찾기는 강사 멤버십 기능이에요. 멤버십을 다시 시작하면 바로 쓸 수 있고, 지난 기록은 그대로 있어요.</Text>
        </LockNotice>
      );
    }
    return <StaffErrorView error={state.error} onRetry={onRetry} />;
  }
  const data = state.data;
  const consenting = data.contactConsent.consenting;
  return (
    <>
      <View style={styles.card} accessibilityLiveRegion="polite">
        <View style={styles.resultHead}>
          <Text style={styles.total}>{`후보 ${data.total}명`}</Text>
          <Text style={styles.resultSub}>{`남 ${data.male} · 여 ${data.female} · 정원 ${data.capacity}명`}</Text>
          <Text style={[levelUiStyles.tag, styles.aiTag]}>AI 추천</Text>
        </View>
        <Text style={staffStyles.muted}>이렇게 골랐어요</Text>
        {data.basis.map((b) => (
          <View key={b.kind} style={[styles.basisRow, styles.divider]}>
            <Text style={styles.basisCount}>{`${b.count}명`}</Text>
            <Text style={styles.basisLabel}>{b.label}</Text>
          </View>
        ))}
        <Text style={[staffStyles.muted, styles.divider, styles.disclaimer]}>
          수강 이력·레벨·선호 시간으로 골랐어요. 실제 신청으로 이어진다는 뜻은 아니에요.
        </Text>
      </View>

      {data.total > 0 && !listLater && (
        <View style={styles.askBox}>
          <Text style={styles.askTitle}>명단을 볼까요?</Text>
          {consenting > 0 ? (
            <Text style={levelUiStyles.softText}>{`연락처 제공에 동의한 수강생 ${consenting}명만 이름과 연락처가 보여요.\n누가 봤는지 기록이 남아요.`}</Text>
          ) : (
            <Text style={levelUiStyles.softText}>아직 연락처 제공에 동의한 후보가 없어요. 동의하지 않은 후보는 숫자로만 보여요.</Text>
          )}
          <View style={levelUiStyles.row}>
            <Button label="나중에" outline onPress={onLater} flex={1} />
            <Button label="명단 보기" onPress={onOpenList} disabled={consenting === 0} flex={1.6} />
          </View>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  groupLabel: { color: colors.ink3, fontSize: font.small, fontWeight: '700' },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: MIN_TOUCH, gap: space.sm },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  rowLabel: { color: colors.ink3, fontSize: font.small, fontWeight: '700', width: 72 },
  rowValue: { flex: 1, color: colors.ink, fontSize: font.body, fontWeight: '800', textAlign: 'right' },
  chevron: { color: colors.ink3, fontSize: 18, width: 14, textAlign: 'right' },
  editor: { gap: space.sm, paddingBottom: space.md },
  editorGroup: { gap: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  input: {
    flex: 1,
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: space.md,
    fontSize: 15,
    color: colors.ink,
  },
  error: { color: colors.danger, fontSize: font.small, fontWeight: '700' },
  resultHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingTop: space.sm },
  total: { color: colors.ink, fontSize: font.h2, fontWeight: '800' },
  resultSub: { flex: 1, color: colors.ink3, fontSize: font.small },
  aiTag: { alignSelf: 'center' },
  basisRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: space.md },
  basisCount: { color: colors.brown, fontSize: 16, fontWeight: '800', width: 44 },
  basisLabel: { flex: 1, color: colors.ink, fontSize: font.small, lineHeight: 18 },
  disclaimer: { paddingTop: space.sm, paddingBottom: space.xs },
  askBox: { backgroundColor: '#FBF3E4', borderRadius: radius.lg, borderWidth: 1, borderColor: '#E8D3A8', padding: space.lg, gap: space.sm },
  askTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' },
});
