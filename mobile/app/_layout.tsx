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
  return <Stack />;
}
