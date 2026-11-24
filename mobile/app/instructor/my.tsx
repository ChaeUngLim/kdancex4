/**
 * 강사 「마이」(보드 I9) — S2-1.7(앱 강사 가입·소속·프로필 화면). 주소 `/instructor/my`.
 *
 * 이 Task 가 살리는 것은 맨 위 **프로필 줄**이다(로드맵 goal 「I9(프로필 줄)」).
 *  - `GET /api/instructor/me/profile`(계약 11 §2-1) 하나로 그린다:
 *    사진(없으면 이름 첫 글자) · 「이준호 강사」 · 「라틴하우스 강남 외 1」(소속됨만 센다) · 활동 장르
 *  - 「소속 학원 N곳」은 소속 학원 · 학원 색 화면(I9E, S2-1.10)으로 간다
 *  - 「로그아웃」은 서버 세션을 끝내고 기기 토큰을 지운 뒤 강사·대표 로그인으로 돌아간다
 *
 *  - 「강사 소개 · 프로필」은 프로필 고치기(I40, S2-1.11)로 간다
 *  - 「개인 일정 넣기」는 개인 일정 시트(I36, S2-1.11)로 간다. 보드에서는 캘린더(I5)의 `+ 개인 일정` 이 입구인데
 *    강사 캘린더는 S2-4 몫이라, 그 전까지 이 줄을 임시 입구로 둔다
 *
 * 「고객센터 · 문의」는 운영 문의(I16, S7-2.8)로 간다. 나머지 줄(멤버십 S6-1 · 정산 계좌 S5-2 · 약관 · 탈퇴)은
 * 보드 자리 그대로 두되 「준비 중」으로 눌리지 않게 한다. 줄 순서가 바뀌면 사용자가 위치를 다시 익혀야 해서다.
 *
 * 읽기는 기존 `useApiResource` 를 쓰고, 효과 훅을 새로 쓰지 않는다. 로그아웃은 버튼 핸들러 안에서 한다.
 */
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { useApiResource } from '../../lib/catalog/use-api-resource';
import { LoadingView } from '../../lib/catalog/ui';
import { affiliationSummary, initialOf, signOutStaff, type InstructorProfile } from '../../lib/instructor/staff-api';
import { InstructorShell, MenuGroup, MenuRow, StaffErrorView, useAction } from '../../lib/instructor/staff-ui';
import { GENRE_LABELS } from '../../lib/onboarding/labels';
import { colors, font, radius, space } from '../../lib/theme';

const PROFILE_PATH = '/api/instructor/me/profile';

export default function InstructorMyScreen() {
  const profile = useApiResource<InstructorProfile>(PROFILE_PATH);
  const logout = useAction();

  const handleLogout = async () => {
    await logout.run(signOutStaff);
    router.replace('/staff-login');
  };

  let body;
  if (profile.state.status === 'loading') {
    body = <LoadingView label="내 정보를 불러오고 있어요" />;
  } else if (profile.state.status === 'error') {
    body = <StaffErrorView error={profile.state.error} onRetry={profile.reload} />;
  } else {
    body = <MyBody profile={profile.state.data} onLogout={handleLogout} loggingOut={logout.busy} />;
  }
  return (
    <InstructorShell title="마이" active="my">
      {body}
    </InstructorShell>
  );
}

function MyBody({ profile, onLogout, loggingOut }: { profile: InstructorProfile; onLogout: () => void; loggingOut: boolean }) {
  // 렌더 중에 바로 계산한다 — 소속됨(active)만 센다. 승인 대기는 「소속 학원」 숫자에 넣지 않는다
  const activeCount = profile.affiliations.filter((a) => a.status === 'active').length;
  const version = Constants.expoConfig?.version ?? '1.0.0';
  return (
    <View style={styles.stack}>
      <ProfileRow profile={profile} />

      <MenuGroup>
        <MenuRow title="활동 장르" detail={GENRE_LABELS[profile.activityGenre]?.name ?? profile.activityGenre} />
        <MenuRow title="멤버십" detail="인원·명단·캘린더·AI 기능" pending divided />
        <MenuRow title="정산 계좌" detail="본인확인 뒤 계좌를 등록해요" pending divided />
      </MenuGroup>

      <MenuGroup>
        {/* 소속 학원 · 학원 색(I9E, S2-1.10) — 학원마다 캘린더 색을 고르고 소속 신청으로 이어진다 */}
        <MenuRow title={`소속 학원 ${activeCount}곳`} detail="학원 색 · 소속 신청" onPress={() => router.push('/instructor/academy-colors')} />
        <MenuRow
          title="강사 소개 · 프로필"
          detail="회원에게 보이는 사진·경력·소개 글"
          onPress={() => router.push('/instructor/profile')}
          divided
        />
        {/* 임시 입구 — 강사 캘린더(I5, S2-4)의 「+ 개인 일정」이 생기면 그쪽으로 옮긴다 */}
        <MenuRow
          title="개인 일정 넣기"
          detail="나만 보이고, 학원에는 「불가 시간」으로만 보여요"
          onPress={() => router.push('/instructor/personal-event')}
          divided
        />
      </MenuGroup>

      <MenuGroup>
        {/* 운영 문의(I16, S7-2.8) — 소속 학원 대표 · 운영자에게 묻고 보낸 문의의 상태를 본다 */}
        <MenuRow title="고객센터 · 문의" detail="소속 학원 대표 · 운영자에게 운영 문의" onPress={() => router.push('/instructor/inquiries')} />
        <MenuRow title="약관 · 개인정보 처리방침" pending divided />
        <MenuRow
          title={loggingOut ? '로그아웃하고 있어요…' : '로그아웃'}
          detail="이 기기에서 강사 계정 로그아웃"
          onPress={loggingOut ? undefined : onLogout}
          divided
        />
      </MenuGroup>

      <Text style={styles.footer}>{`버전 ${version}`}</Text>
      <Text style={styles.footer}>강사 탈퇴 · 준비 중</Text>
    </View>
  );
}

/** 프로필 줄 — 사진 · 「이름 강사」 · 소속 요약(보드 I9 맨 위 흰 카드) */
function ProfileRow({ profile }: { profile: InstructorProfile }) {
  const summary = affiliationSummary(profile.affiliations);
  return (
    <View style={styles.profile} accessible accessibilityLabel={`${profile.displayName} 강사, ${summary}`}>
      {/* 사진 자리. 올린 사진 주소(/api/files/{id})는 로그인 토큰을 실어야 받히는데 <Image> 는 저장된 토큰을
          읽어 붙이지 못한다. 공개 사진 경로가 생기기 전(S2-1.6 한계 ③)에는 사진 유무와 상관없이 이름 첫 글자를 보인다 */}
      <View style={[styles.photo, styles.photoEmpty]} accessibilityLabel={profile.photo !== null ? '프로필 사진 있음' : '프로필 사진 없음'}>
        <Text style={styles.photoInitial}>{initialOf(profile.displayName)}</Text>
      </View>
      <View style={styles.profileText}>
        <Text style={styles.name}>{`${profile.displayName} 강사`}</Text>
        <Text style={styles.summary}>{summary}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.lg,
  },
  photo: { width: 56, height: 56, borderRadius: radius.md },
  photoEmpty: { backgroundColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  photoInitial: { color: colors.ink3, fontSize: font.h2, fontWeight: '700' },
  profileText: { flex: 1, gap: 4 },
  name: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  summary: { color: colors.ink3, fontSize: font.small },
  footer: { color: colors.ink3, fontSize: font.small },
});
