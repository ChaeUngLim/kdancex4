// 앱 진입점 — expo-router 에 맡긴다(plan D18(mobile 구성), T-A5-1(라우터·API 클라이언트·세션)).
//
// expo-router/entry 는 app/ 폴더를 읽어 화면을 자동으로 등록한다.
// 그래서 예전처럼 registerRootComponent(App) 를 직접 부르지 않는다.
// 앱을 켜면 app/index.tsx(진입 화면)가 먼저 열려 로그인 상태를 보고 로그인·가입 단계·홈 중 한 곳으로 보낸다.
// 옛 데모 화면 App.tsx 는 T-A5-3(홈·상세·결제 대기·캘린더 화면 + 취소 화면 이전)이 app/ 아래로 옮기면서 지웠다.
import 'expo-router/entry';
