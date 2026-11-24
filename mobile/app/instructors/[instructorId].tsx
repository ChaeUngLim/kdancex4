/**
 * 강사 프로필(회원 화면, 보드 M15) — 이번 회차는 「AI 플래너에게 이 강사 수업 물어보기」 입구까지(SX-5.7, spec FR-037a 「어디서 묻나」).
 *
 * 처음 보는 사람용 요약
 *  - `GET /api/instructors/{instructorId}`(계약 16 §4-8)로 공개 강사 카드(이름·활동 장르·소속 학원·게시 수업 수)를 읽는다.
 *    말로 찾기의 강사 후보 카드와 같은 값·같은 공개 조건이다.
 *  - 맨 아래 버튼을 누르면 AI 플래너(`/planner`)가 이 강사를 정한 채 열린다 — 주소 값 `instructorId`·`instructorName`.
 *    플래너는 그 id 를 `POST /api/ai/chat` 의 `context.instructorId` 로 보낸다.
 *  - 소개 영상·자격·대회·관심 강사·1:1 개인 레슨 입구는 보드에 있지만 각 기능의 API 가 아직 없어 이 화면에 없다.
 *  - 사진은 아직 앱에서 내려받지 않아 이름 첫 글자로 둔다(강사 사진은 AI 로 만들지 않는다, FR-061b).
 *  - 들어오는 길: 수업 상세(M8)의 강사 이름.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { genreLabel } from '../../lib/catalog/format';
import { Card, DetailScreen, ErrorView, LoadingView, shared } from '../../lib/catalog/ui';
import { readRouteId, useApiResource } from '../../lib/catalog/use-api-resource';
import type { Genre } from '../../lib/onboarding/types';
import { InitialAvatar } from '../../lib/planner/planner-ui';
import { colors, font, MIN_TOUCH, radius, space } from '../../lib/theme';

/** `GET /api/instructors/{instructorId}` 응답 */
interface InstructorProfile {
  instructorId: string;
  displayName: string;
  photoUrl: string | null;
  genres: readonly Genre[];
  academies: readonly { id: string; name: string }[];
  publishedOfferingCount: number;
}

export default function InstructorProfileScreen() {
  const instructorId = readRouteId(useLocalSearchParams<{ instructorId: string }>().instructorId);
  const { state, reload } = useApiResource<InstructorProfile>(
    instructorId === null ? null : `/api/instructors/${encodeURIComponent(instructorId)}`,
  );

  return (
    <DetailScreen title="강사" tab="home">
      {instructorId === null && <Text style={shared.muted}>잘못된 강사 주소예요.</Text>}
      {instructorId !== null && state.status === 'loading' && <LoadingView />}
      {instructorId !== null && state.status === 'error' && <ErrorView error={state.error} onRetry={reload} />}
      {instructorId !== null && state.status === 'ready' && <ProfileBody profile={state.data} />}
    </DetailScreen>
  );
}

function ProfileBody({ profile }: { profile: InstructorProfile }) {
  // 플래너를 이 강사로 정해 연다 — 주소 값만 넘기고, 묻기는 플래너에서 회원이 누를 때 한다
  const openPlanner = () =>
    router.push({ pathname: '/planner', params: { instructorId: profile.instructorId, instructorName: profile.displayName } });
  const genres = profile.genres.map(genreLabel).join(' · ');

  return (
    <>
      <View style={styles.top}>
        <InitialAvatar name={profile.displayName} size={64} />
        <View style={styles.topText}>
          <Text style={styles.name}>{profile.displayName}</Text>
          {genres !== '' && <Text style={styles.genres}>{genres}</Text>}
        </View>
      </View>

      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>모든 학원의 수업 {profile.publishedOfferingCount}</Text>
      </View>
      <Card>
        {profile.academies.map((academy, index) => (
          <View key={academy.id} style={[styles.academyRow, index > 0 && styles.academyRowLine]}>
            <Text style={styles.academyName}>{academy.name}</Text>
          </View>
        ))}
      </Card>

      <Pressable
        style={styles.askButton}
        onPress={openPlanner}
        accessibilityRole="button"
        accessibilityLabel={`AI 플래너에게 ${profile.displayName} 강사 수업 물어보기`}
        accessibilityHint="이 강사가 정해진 채로 AI 플래너가 열려요"
      >
        <Text style={styles.askText}>AI 플래너에게 이 강사 수업 물어보기 ›</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  topText: { flex: 1, gap: 4 },
  name: { fontSize: 22, fontWeight: '700', color: colors.ink },
  genres: { fontSize: font.small, color: colors.ink, fontWeight: '600' },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between' },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: colors.ink },
  academyRow: { paddingVertical: space.md },
  academyRowLine: { borderTopWidth: 1, borderTopColor: colors.line },
  academyName: { fontSize: font.body + 1, fontWeight: '600', color: colors.ink },
  askButton: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  askText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
});
