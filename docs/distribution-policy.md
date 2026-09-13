# 앱 배포 채널 정책

- 날짜: 2026-09-13

## 결정 사항

Google Play 개발자 등록(최초 1회 $25) 대신 **갤럭시 스토어(Galaxy Store)로 배포**한다. 갤럭시 스토어(Samsung Seller Portal)는 등록비가 무료다.

## 주의사항 (별도 확인 필요)

- **Google 로그인(OAuth) 설정은 배포 채널과 무관하게 별도로 필요하다.** 이미 진행 중인 Android OAuth 클라이언트 ID(SHA-1 지문) 작업은 앱이 Google Sign-In 기능을 쓰는 이상 갤럭시 스토어 배포와 상관없이 그대로 필요함. 스토어를 바꾼다고 Google 로그인 설정이 대체되지 않음.
- 갤럭시 스토어는 Samsung 기기(또는 Galaxy Store 앱 설치 기기)에서만 노출됨 — Google Play 대비 도달 범위가 좁아질 수 있음. 두 스토어 동시 배포도 가능.
- 갤럭시 스토어 자체 심사 기준, 인앱결제 정책(자체 IAP 또는 Samsung IAP)이 Google Play와 다르므로 결제 연동 방식 재검토 필요.
- Samsung Developer 계정 생성 및 앱 서명 절차(Galaxy Store용 별도 키 등록 여부)는 추후 확인 필요.
