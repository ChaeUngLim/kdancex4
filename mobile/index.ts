import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent는 AppRegistry.registerComponent('main', () => App)를 호출한다.
// 또한 Expo Go에서 실행하든 네이티브 빌드에서 실행하든
// 실행 환경이 올바르게 설정되도록 보장해 준다.
registerRootComponent(App);
