/**
 * 강사 마이 → 강사 소개 · 프로필 고치기(보드 I40) — S2-1.11. 주소 `/instructor/profile`.
 *
 * 회원에게 보이는 강사 프로필의 사진·경력·활동 지역·자격·대회·소개 글을 고친다(FR-025).
 *  - `GET /api/instructor/me/profile` 로 칸을 채우고, 「저장 · 회원 화면에 바로 반영」이
 *    `PUT /api/instructor/me/profile`(11 §2-1, 여섯 칸 전체 교체)을 부른다. 대표 승인은 없다
 *  - 활동 장르와 이름은 보기만 한다(가입 때 고른 값, FR-011b). PUT 에 아예 싣지 않는다
 *  - 세부 종목(룸바 등)은 서버가 강사가 연 수업에서 채운다 — 안내 한 줄로만 보인다
 *  - 보드의 「소개 영상」 줄은 이 판에서 그리지 않는다(11 열린 점 ⑥ — 초상 동의 방식이 사람 결정 대기)
 *  - 「사진 바꾸기」는 기기 사진을 고르는 패키지(expo-image-picker)가 아직 없어 「준비 중」이다.
 *    저장할 때는 지금 사진(fileId)을 그대로 실어 보내 사진이 지워지지 않게 한다
 *
 * 효과 훅 없음: 불러온 프로필을 `ProfileForm` 의 처음 값으로 넘기고(useState 초기값),
 * 저장은 버튼 핸들러 안에서 한다. 저장이 끝나면 서버가 돌려준 값으로 칸을 다시 맞춘다.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useApiResource } from '../../lib/catalog/use-api-resource';
import { LoadingView } from '../../lib/catalog/ui';
import {
  BIO_MAX,
  CREDENTIAL_MAX,
  CREDENTIAL_TITLE_MAX,
  disciplinesNote,
  parseCareerYears,
  REGION_MAX,
  saveInstructorProfile,
  type InstructorProfileDetail,
} from '../../lib/instructor/profile-api';
import { initialOf } from '../../lib/instructor/staff-api';
import { goBack, InstructorShell, StaffErrorView, staffStyles, useAction } from '../../lib/instructor/staff-ui';
import { GENRE_LABELS } from '../../lib/onboarding/labels';
import type { Region } from '../../lib/onboarding/types';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';

const PROFILE_PATH = '/api/instructor/me/profile';

export default function InstructorProfileEditScreen() {
  const profile = useApiResource<InstructorProfileDetail>(PROFILE_PATH);

  let body;
  if (profile.state.status === 'loading') {
    body = <LoadingView label="프로필을 불러오고 있어요" />;
  } else if (profile.state.status === 'error') {
    body = <StaffErrorView error={profile.state.error} onRetry={profile.reload} />;
  } else {
    // key: 다른 계정 프로필이 오면 칸을 처음부터 다시 채운다
    body = <ProfileForm key={profile.state.data.accountId} initial={profile.state.data} />;
  }
  return (
    <InstructorShell title="프로필 고치기" active="my" onBack={() => goBack('/instructor/my')}>
      {body}
    </InstructorShell>
  );
}

/** 자격·대회 한 줄. 같은 카드 안에 섞여 보이므로 종류를 같이 들고 다닌다 */
type CredentialKind = 'qualification' | 'competition';
const KIND_LABEL: Readonly<Record<CredentialKind, string>> = { qualification: '자격', competition: '대회' };

/** 화면 칸 상태 — 서버 응답에서 처음 값을 만든다(렌더 중 계산 함수) */
interface FormValues {
  careerText: string;
  regions: readonly Region[];
  qualifications: readonly string[];
  competitions: readonly string[];
  bio: string;
}

function toFormValues(profile: InstructorProfileDetail): FormValues {
  return {
    careerText: profile.careerYears === null ? '' : String(profile.careerYears),
    regions: profile.regions,
    qualifications: profile.qualifications,
    competitions: profile.competitions,
    bio: profile.bio ?? '',
  };
}

function ProfileForm({ initial }: { initial: InstructorProfileDetail }) {
  // 저장 뒤에는 서버가 돌려준 프로필이 새 기준이다(사진·종목·소속 표시도 그 값을 따른다)
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState<FormValues>(() => toFormValues(initial));
  const [savedNotice, setSavedNotice] = useState(false);
  const save = useAction();

  // 렌더 중 계산: 경력 칸 해석 · 저장 버튼 켜짐
  const career = parseCareerYears(values.careerText);
  const careerInvalid = career === undefined;
  const bioTooLong = values.bio.length > BIO_MAX;
  const canSave = !careerInvalid && !bioTooLong && !save.busy;

  // 칸을 바꾸면 「저장했어요」 안내를 내린다 — 새 객체로 바꿔 끼운다
  const update = (patch: Partial<FormValues>) => {
    setValues((prev) => ({ ...prev, ...patch }));
    setSavedNotice(false);
  };

  const handleSave = async () => {
    if (career === undefined) return;
    const result = await save.run(() =>
      saveInstructorProfile({
        // 사진은 이 판에서 바꾸지 못한다 — 지금 사진을 그대로 보내 지워지지 않게 한다(전체 교체라 빠뜨리면 비워진다)
        photoFileId: saved.photo?.fileId ?? null,
        careerYears: career,
        regions: [...values.regions],
        qualifications: [...values.qualifications],
        competitions: [...values.competitions],
        bio: values.bio.trim() === '' ? null : values.bio,
      }),
    );
    if (result !== null) {
      setSaved(result);
      setValues(toFormValues(result));
      setSavedNotice(true);
    }
  };

  return (
    <View style={styles.stack}>
      <PhotoHeader profile={saved} />

      <View style={styles.twoCol}>
        <View style={styles.careerCol}>
          <Text style={styles.label}>경력</Text>
          <View style={[styles.careerBox, careerInvalid && styles.inputInvalid]}>
            <TextInput
              accessibilityLabel="경력(년)"
              value={values.careerText}
              onChangeText={(text) => update({ careerText: text })}
              keyboardType="number-pad"
              maxLength={2}
              placeholder="0"
              placeholderTextColor={colors.ink3}
              style={styles.careerInput}
            />
            <Text style={styles.careerUnit}>년</Text>
          </View>
        </View>
        <View style={styles.regionCol}>
          <Text style={styles.label}>활동 지역</Text>
          <RegionChips regions={values.regions} onChange={(regions) => update({ regions })} />
        </View>
      </View>
      {careerInvalid && <Text style={styles.error}>경력은 0~80 사이 숫자로 적어 주세요.</Text>}

      <Text style={styles.label}>자격 · 대회</Text>
      <CredentialCard
        qualifications={values.qualifications}
        competitions={values.competitions}
        onChange={(qualifications, competitions) => update({ qualifications, competitions })}
      />
      <Text style={staffStyles.muted}>{disciplinesNote(saved.disciplines)}</Text>

      <Text style={styles.label}>소개 글</Text>
      <View style={[styles.bioBox, bioTooLong && styles.inputInvalid]}>
        <TextInput
          accessibilityLabel="소개 글"
          value={values.bio}
          onChangeText={(text) => update({ bio: text })}
          multiline
          placeholder="회원에게 보일 소개를 적어 주세요"
          placeholderTextColor={colors.ink3}
          style={styles.bioInput}
        />
        <Text style={[styles.counter, bioTooLong && styles.counterOver]}>{`${values.bio.length} / ${BIO_MAX}`}</Text>
      </View>

      {save.error !== null && <Text style={styles.error}>{save.error}</Text>}
      {savedNotice && (
        <Text style={styles.savedNotice} accessibilityLiveRegion="polite">
          저장했어요. 회원 화면의 강사 프로필에 바로 보여요.
        </Text>
      )}
      <Pressable
        style={[styles.saveButton, !canSave && styles.saveButtonOff]}
        onPress={handleSave}
        disabled={!canSave}
        accessibilityRole="button"
        accessibilityLabel="저장 · 회원 화면에 바로 반영"
        accessibilityState={{ disabled: !canSave, busy: save.busy }}
      >
        <Text style={[styles.saveText, !canSave && styles.saveTextOff]}>
          {save.busy ? '저장하고 있어요…' : '저장 · 회원 화면에 바로 반영'}
        </Text>
      </Pressable>
    </View>
  );
}

/** 사진 · 「이준호 강사」 · 활동 장르(보기만) · 「사진 바꾸기」(준비 중) */
function PhotoHeader({ profile }: { profile: InstructorProfileDetail }) {
  const genre = GENRE_LABELS[profile.activityGenre]?.name ?? profile.activityGenre;
  return (
    <View style={styles.header}>
      {/* 사진 주소(/api/files/{id})는 토큰을 실어야 받히고 <Image> 는 토큰을 못 붙인다 — 마이(I9)와 같이 첫 글자로 둔다 */}
      <View style={styles.photo} accessibilityLabel={profile.photo !== null ? '프로필 사진 있음' : '프로필 사진 없음'}>
        <Text style={styles.photoInitial}>{initialOf(profile.displayName)}</Text>
      </View>
      <View style={styles.headerText}>
        <Text style={styles.name}>{`${profile.displayName} 강사`}</Text>
        <Text style={staffStyles.muted}>{`${genre} · 가입 때 고른 장르`}</Text>
        <View style={styles.photoChangeRow} accessibilityLabel="사진 바꾸기, 준비 중">
          <Text style={styles.photoChangeOff}>사진 바꾸기</Text>
          <Text style={staffStyles.pendingBadge}>준비 중</Text>
        </View>
      </View>
    </View>
  );
}

/** 활동 지역 칩(구 이름 · 누르면 뺌) + 「+ 추가」를 누르면 시·구 두 칸이 열린다 */
function RegionChips({ regions, onChange }: { regions: readonly Region[]; onChange: (next: readonly Region[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [sido, setSido] = useState('서울');
  const [gu, setGu] = useState('');
  // 렌더 중 계산: 넣을 수 있나(빈 칸·중복·한도)
  const candidate: Region = { sido: sido.trim(), gu: gu.trim() };
  const duplicate = regions.some((r) => r.sido === candidate.sido && r.gu === candidate.gu);
  const canAdd = candidate.sido !== '' && candidate.gu !== '' && !duplicate && regions.length < REGION_MAX;

  const handleAdd = () => {
    onChange([...regions, candidate]);
    setGu('');
    setAdding(false);
  };

  return (
    <View style={styles.chipWrap}>
      {regions.map((region) => (
        <Pressable
          key={`${region.sido}-${region.gu}`}
          style={styles.regionChip}
          onPress={() => onChange(regions.filter((r) => r !== region))}
          accessibilityRole="button"
          accessibilityLabel={`${region.sido} ${region.gu} 빼기`}
        >
          <Text style={styles.regionChipText}>{region.gu}</Text>
        </Pressable>
      ))}
      {!adding && regions.length < REGION_MAX && (
        <Pressable style={styles.addChip} onPress={() => setAdding(true)} accessibilityRole="button" accessibilityLabel="활동 지역 추가">
          <Text style={styles.addChipText}>+ 추가</Text>
        </Pressable>
      )}
      {adding && (
        <View style={styles.inlineAdd}>
          <TextInput accessibilityLabel="시·도" value={sido} onChangeText={setSido} style={[styles.smallInput, styles.sidoInput]} />
          <TextInput
            accessibilityLabel="구"
            value={gu}
            onChangeText={setGu}
            placeholder="서초구"
            placeholderTextColor={colors.ink3}
            style={[styles.smallInput, styles.guInput]}
            onSubmitEditing={canAdd ? handleAdd : undefined}
          />
          <Pressable
            style={[styles.inlineButton, !canAdd && styles.inlineButtonOff]}
            onPress={handleAdd}
            disabled={!canAdd}
            accessibilityRole="button"
            accessibilityLabel="지역 넣기"
          >
            <Text style={styles.inlineButtonText}>넣기</Text>
          </Pressable>
        </View>
      )}
      {adding && duplicate && <Text style={styles.error}>이미 넣은 지역이에요.</Text>}
    </View>
  );
}

interface CredentialCardProps {
  qualifications: readonly string[];
  competitions: readonly string[];
  onChange: (qualifications: readonly string[], competitions: readonly string[]) => void;
}

/** 자격·대회 카드 — 줄마다 「빼기」, 아래 「+ 자격 추가」·「+ 대회 추가」(보드 I40) */
function CredentialCard({ qualifications, competitions, onChange }: CredentialCardProps) {
  // 지금 글을 적고 있는 종류. null 이면 입력칸을 닫아 둔다
  const [addingKind, setAddingKind] = useState<CredentialKind | null>(null);
  const [draft, setDraft] = useState('');
  const lists: Readonly<Record<CredentialKind, readonly string[]>> = { qualification: qualifications, competition: competitions };

  // 한 종류만 바꾸고 다른 종류는 그대로 넘긴다
  const replace = (kind: CredentialKind, next: readonly string[]) => {
    if (kind === 'qualification') onChange(next, competitions);
    else onChange(qualifications, next);
  };
  const trimmed = draft.trim();
  const canAdd =
    addingKind !== null && trimmed !== '' && trimmed.length <= CREDENTIAL_TITLE_MAX && lists[addingKind].length < CREDENTIAL_MAX;

  const handleAdd = () => {
    if (addingKind === null) return;
    replace(addingKind, [...lists[addingKind], trimmed]);
    setDraft('');
    setAddingKind(null);
  };

  const rows = [
    ...qualifications.map((title, index) => ({ kind: 'qualification' as const, title, index })),
    ...competitions.map((title, index) => ({ kind: 'competition' as const, title, index })),
  ];

  return (
    <View style={staffStyles.card}>
      {rows.length === 0 && <Text style={staffStyles.muted}>아직 넣은 자격·대회가 없어요.</Text>}
      {rows.map((row, position) => (
        <View key={`${row.kind}-${row.index}`} style={[styles.credRow, position > 0 && styles.credDivider]}>
          <Text style={styles.credKind}>{KIND_LABEL[row.kind]}</Text>
          <Text style={styles.credTitle}>{row.title}</Text>
          <Pressable
            onPress={() => replace(row.kind, lists[row.kind].filter((_, i) => i !== row.index))}
            accessibilityRole="button"
            accessibilityLabel={`${row.title} 빼기`}
            hitSlop={10}
          >
            <Text style={styles.credRemove}>빼기</Text>
          </Pressable>
        </View>
      ))}
      {addingKind !== null && (
        <View style={styles.inlineAdd}>
          <TextInput
            accessibilityLabel={`${KIND_LABEL[addingKind]} 이름`}
            value={draft}
            onChangeText={setDraft}
            placeholder={addingKind === 'qualification' ? '댄스스포츠 지도자 2급' : '2025 서울 오픈 라틴 프로 4위'}
            placeholderTextColor={colors.ink3}
            maxLength={CREDENTIAL_TITLE_MAX}
            style={[styles.smallInput, styles.credInput]}
            onSubmitEditing={canAdd ? handleAdd : undefined}
          />
          <Pressable
            style={[styles.inlineButton, !canAdd && styles.inlineButtonOff]}
            onPress={handleAdd}
            disabled={!canAdd}
            accessibilityRole="button"
            accessibilityLabel={`${KIND_LABEL[addingKind]} 넣기`}
          >
            <Text style={styles.inlineButtonText}>넣기</Text>
          </Pressable>
        </View>
      )}
      <View style={styles.credAddRow}>
        {(['qualification', 'competition'] as const).map((kind) => (
          <Pressable
            key={kind}
            style={styles.credAdd}
            onPress={() => {
              setAddingKind(kind);
              setDraft('');
            }}
            disabled={lists[kind].length >= CREDENTIAL_MAX}
            accessibilityRole="button"
            accessibilityLabel={`${KIND_LABEL[kind]} 추가`}
          >
            <Text style={styles.credAddText}>{`+ ${KIND_LABEL[kind]} 추가`}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  photo: {
    width: 64,
    height: 64,
    borderRadius: radius.md,
    backgroundColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoInitial: { color: colors.ink3, fontSize: font.h2, fontWeight: '700' },
  headerText: { flex: 1, gap: 4 },
  name: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  photoChangeRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  photoChangeOff: { color: colors.disabledInk, fontSize: font.small, fontWeight: '700' },
  label: { color: colors.ink3, fontSize: font.small, fontWeight: '700' },
  twoCol: { flexDirection: 'row', gap: space.lg },
  careerCol: { width: 100, gap: space.sm },
  regionCol: { flex: 1, gap: space.sm },
  careerBox: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: MIN_TOUCH - 4,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  careerInput: { flex: 1, fontSize: 16, fontWeight: '700', color: colors.ink, minWidth: 0 },
  careerUnit: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  inputInvalid: { borderColor: colors.danger },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  regionChip: {
    paddingHorizontal: space.md,
    minHeight: 32,
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.brownSoft,
  },
  regionChipText: { color: colors.brown, fontWeight: '700', fontSize: font.small },
  addChip: {
    paddingHorizontal: space.md,
    minHeight: 32,
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  addChipText: { color: colors.ink3, fontSize: font.small },
  inlineAdd: { flexDirection: 'row', alignItems: 'center', gap: space.sm, width: '100%' },
  smallInput: {
    minHeight: 40,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    color: colors.ink,
    fontSize: font.body,
  },
  sidoInput: { width: 56 },
  guInput: { flex: 1, minWidth: 0 },
  credInput: { flex: 1, minWidth: 0 },
  inlineButton: { minHeight: 40, paddingHorizontal: space.md, borderRadius: radius.sm, backgroundColor: colors.ink, justifyContent: 'center' },
  inlineButtonOff: { backgroundColor: colors.disabled },
  inlineButtonText: { color: colors.surface, fontWeight: '700', fontSize: font.small },
  credRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: MIN_TOUCH - 4 },
  credDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  credKind: { width: 36, color: colors.ink3, fontSize: font.small },
  credTitle: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '700' },
  credRemove: { color: colors.ink3, fontSize: font.small },
  credAddRow: { flexDirection: 'row', gap: space.xl, paddingTop: space.sm },
  credAdd: { minHeight: 36, justifyContent: 'center' },
  credAddText: { color: colors.brown, fontWeight: '700', fontSize: font.small },
  bioBox: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    padding: space.md,
    gap: space.xs,
  },
  bioInput: { minHeight: 72, color: colors.ink, fontSize: 15, lineHeight: 22, textAlignVertical: 'top' },
  counter: { alignSelf: 'flex-end', color: colors.ink3, fontSize: font.tiny },
  counterOver: { color: colors.danger, fontWeight: '700' },
  error: { color: colors.danger, fontSize: font.small },
  savedNotice: { color: colors.ok, fontSize: font.small, fontWeight: '700' },
  saveButton: {
    minHeight: MIN_TOUCH + 8,
    borderRadius: radius.lg,
    backgroundColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.sm,
  },
  saveButtonOff: { backgroundColor: colors.disabled },
  saveText: { color: colors.surface, fontSize: 16, fontWeight: '800' },
  saveTextOff: { color: colors.disabledInk },
});
