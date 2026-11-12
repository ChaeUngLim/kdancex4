/**
 * 회원 탭 묶음 — 홈·캘린더(보드 01-3·01-4).
 *
 * 괄호 폴더 `(tabs)` 는 주소에 나타나지 않는 묶음이다. 그래서 `(tabs)/home.tsx` 의 주소는 `/home`.
 *
 * 탭바는 라이브러리 기본 모양 대신 `MemberTabBar` 를 쓴다. 상세 화면(탭 묶음 밖)도 같은
 * 컴포넌트를 아래에 붙이므로, 어느 화면에서나 탭 모양·순서가 같다(하단 탭은 모든 화면에).
 * `Tabs` 는 `expo-router/js-tabs` 에서 가져온다 — SDK 58 설치본에서 `expo-router` 의
 * `Tabs` 다시 내보내기는 deprecated 로 표시돼 있다.
 */
import { Tabs, type BottomTabBarProps } from 'expo-router/js-tabs';

import { MemberTabBar, type MemberTabKey } from '../../lib/catalog/tab-bar';

function activeTab(props: BottomTabBarProps): MemberTabKey {
  const name = props.state.routes[props.state.index]?.name;
  return name === 'calendar' ? 'calendar' : 'home';
}

export default function MemberTabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <MemberTabBar active={activeTab(props)} />}>
      <Tabs.Screen name="home" options={{ title: '홈' }} />
      <Tabs.Screen name="calendar" options={{ title: '캘린더' }} />
    </Tabs>
  );
}
