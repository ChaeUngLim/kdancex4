/**
 * 루트 레이아웃 — 모든 화면을 감싸는 가장 바깥 틀.
 *
 * expo-router 는 app/ 폴더 구조가 곧 화면 주소다. `_layout.tsx` 는 화면이 아니라
 * 그 아래 화면들을 어떤 방식(여기서는 Stack: 화면을 쌓고 뒤로 가기로 꺼냄)으로
 * 보여줄지 정하는 자리다.
 *
 * 이 Task(T-A5-1(라우터·API 클라이언트·세션))는 틀만 둔다.
 * 실제 화면은 T-A5-2(로그인·가입·취향 화면)·T-A5-3(홈·상세·결제 대기·캘린더 화면)이 만든다.
 */
import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <Stack>
      {/* 회원 탭 묶음(홈·캘린더)은 화면마다 자기 머리말을 그린다 — 라우터 기본 머리말 「(tabs)」 글자를 숨긴다(보드 M7, S3-2.5) */}
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      {/* 로그인·기준 장르 화면은 자기 제목을 직접 그린다. 기본 머리말을 두면 주소 이름(login·base-genre)이 그대로 보인다 */}
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="base-genre" options={{ headerShown: false }} />
      {/* 나머지 가입 단계는 뒤로 가기가 필요해 머리말을 두되, 주소 이름 대신 한국어 제목을 단다 */}
      <Stack.Screen name="identity" options={{ title: '본인확인' }} />
      <Stack.Screen name="signup" options={{ title: '회원가입' }} />
      <Stack.Screen name="consent" options={{ title: '약관 동의' }} />
      <Stack.Screen name="preferences" options={{ title: '관심 장르 · 지역 · 시간대' }} />
    </Stack>
  );
}
