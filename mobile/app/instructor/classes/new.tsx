/**
 * 수업 만들기(보드 I2 → I2D · I2E) — S2-2.9(앱 수업 등록 화면). 주소 `/instructor/classes/new[?classId=…]`.
 *
 * 이 파일은 「불러오기」만 한다. 칸·버튼은 `lib/instructor/class-form.tsx` 의 ClassForm 이 맡는다.
 *   1. GET /api/instructor/me/profile     활동 장르(수업 장르는 이것과 같아야 한다 — 11 §4-2 GENRE_NOT_ALLOWED)
 *   2. GET /api/instructor/affiliations   소속됨(active) 학원 · 소속 id(홀 목록 경로에 쓴다) · 앱 수업 등록 권한(canSubmitClass)
 *   3. (classId 가 있으면) GET /api/classes/{classId}   이어서 고칠 임시 저장(등록 취소 뒤 · 수정 요청 받은 수업)
 * 셋이 다 오면 ClassForm 을 그린다. 폼은 그때 한 번 처음 값을 정하므로, 값을 맞추는 효과 훅이 필요 없다.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { readRouteId, useApiResource } from '../../../lib/catalog/use-api-resource';
import { LoadingView } from '../../../lib/catalog/ui';
import { classPath, type ClassRegistration } from '../../../lib/instructor/class-api';
import { ClassForm, type WritableAcademy } from '../../../lib/instructor/class-form';
import type { InstructorProfile } from '../../../lib/instructor/staff-api';
import { canSubmitClass, type AffiliationCard } from '../../../lib/instructor/staff-api';
import { goBack, InstructorShell, StaffErrorView, staffStyles } from '../../../lib/instructor/staff-ui';
import { colors, MIN_TOUCH, radius, space } from '../../../lib/theme';

export default function NewClassScreen() {
  const params = useLocalSearchParams<{ classId?: string }>();
  // 주소로 받은 id 는 검사한 뒤에만 쓴다(딥링크 값은 믿지 않는다)
  const classId = readRouteId(params.classId);
  const profile = useApiResource<InstructorProfile>('/api/instructor/me/profile');
  const cards = useApiResource<{ items: AffiliationCard[] }>('/api/instructor/affiliations');
  const draft = useApiResource<ClassRegistration>(classId === null ? null : classPath(classId));

  const resources = [profile, cards, ...(classId === null ? [] : [draft])];
  const failed = resources.find((r) => r.state.status === 'error');
  if (failed !== undefined && failed.state.status === 'error') {
    return (
      <InstructorShell title="수업 만들기" active="classes" onBack={() => goBack('/instructor/academy')}>
        <StaffErrorView error={failed.state.error} onRetry={failed.reload} />
      </InstructorShell>
    );
  }
  if (profile.state.status !== 'ready' || cards.state.status !== 'ready' || (classId !== null && draft.state.status !== 'ready')) {
    return (
      <InstructorShell title="수업 만들기" active="classes" onBack={() => goBack('/instructor/academy')}>
        <LoadingView label="수업 만들 준비를 하고 있어요" />
      </InstructorShell>
    );
  }

  // 렌더 중 계산: 소속됨 + 앱 수업 등록 권한이 켜진 학원만 고를 수 있다(11 §0 class_writer)
  const academies: WritableAcademy[] = cards.state.data.items
    .filter((card) => canSubmitClass(card))
    .map((card) => ({ affiliationId: card.affiliationId, academyId: card.academyId, academyName: card.academyName }));
  const loadedDraft = classId !== null && draft.state.status === 'ready' ? draft.state.data : null;

  // 승인 중·공개된 수업은 여기서 고치지 않는다 — 등록한 수업(I2S)으로 보낸다
  if (loadedDraft !== null && loadedDraft.status !== 'draft') {
    return (
      <InstructorShell title="수업 만들기" active="classes" onBack={() => goBack('/instructor/academy')}>
        <View style={staffStyles.card}>
          <Text style={staffStyles.sectionTitle}>임시 저장 상태일 때만 고칠 수 있어요</Text>
          <Text style={staffStyles.muted}>승인 중인 수업은 등록을 취소한 뒤 고쳐 주세요.</Text>
          <Pressable style={styles.link} onPress={() => router.replace(`/instructor/classes/${loadedDraft.classId}`)} accessibilityRole="button">
            <Text style={styles.linkText}>등록한 수업 보기</Text>
          </Pressable>
        </View>
      </InstructorShell>
    );
  }

  if (academies.length === 0) {
    return (
      <InstructorShell title="수업 만들기" active="classes" onBack={() => goBack('/instructor/academy')}>
        <View style={staffStyles.card}>
          <Text style={staffStyles.sectionTitle}>수업을 올릴 수 있는 학원이 없어요</Text>
          <Text style={staffStyles.muted}>
            소속 학원의 대표가 「앱 수업 등록」 권한을 켜야 수업을 만들 수 있어요. 학원 탭에서 권한을 확인해 주세요.
          </Text>
        </View>
      </InstructorShell>
    );
  }

  return <ClassForm key={loadedDraft?.classId ?? 'new'} academies={academies} genre={profile.state.data.activityGenre} draft={loadedDraft} />;
}

const styles = StyleSheet.create({
  link: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.brown,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.sm,
  },
  linkText: { color: colors.brown, fontWeight: '700' },
});
