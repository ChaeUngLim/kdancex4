# Phase 5(구현) 보고 — T-A5-1(라우터·API 클라이언트·세션)

- 슬라이스: US1-A5(mobile 화면) · 작성 2026-11-06
- 결과: 코드·설치 완료. `npx tsc --noEmit` 은 통과(exit 0). `npx expo install --check` 은 **불일치 2건이 남았다.** 새로 넣은 6개는 아니고 기존 `expo`·`react-native` 두 개다(아래 「차단·미해결」 1번)

## 1. 설치된 버전 (실측 — `node_modules/*/package.json`)

| 패키지 | package.json 선언 | 설치 | 로컬 `bundledNativeModules.json` 핀 |
|---|---|---|---|
| expo-router | `~58.0.30` | 58.0.30 | ~58.0.7 |
| react-native-screens | `~4.30.1` | 4.30.1 | ~4.28.0 |
| react-native-safe-area-context | `~5.11.1` | 5.11.1 | ~5.9.1 |
| expo-secure-store | `~58.0.2` | 58.0.2 | ~58.0.0 |
| expo-linking | `~58.0.16` | 58.0.16 | ~58.0.6 |
| expo-constants | `~58.0.15` | 58.0.15 | ~58.0.6 |
| (전이) react-dom | 선언 없음 | 19.3.1 | 19.3.0 |
| (전이) @expo/metro-runtime | 선언 없음 | 58.0.17 | — |

**선언 범위를 정한 쪽은 Expo CLI다.** `expo install` 은 로컬 `bundledNativeModules.json`(preview.6 시점 핀)을 보지 않고 Expo 서버의 SDK 58 최신 핀을 받아 쓴다. 그래서 `03_research.md` §1 의 핀 값(로컬 파일 기준)과 위 「선언」 열이 다르다. research §1 은 고쳐 둘 필요가 있다(이 Task 의 쓰는 파일이 아니라 손대지 않았다).

### 「올리기 전에」 5단계 기록

1. **상위 고정 패키지**: Expo `58.0.0-preview.6` 이 RN 생태계를 고정한다. 로컬 핀을 먼저 읽었다
2. **peerDependencies**: `npm view` 로 확인하다가 함정이 하나 나왔다. 로컬 핀대로 `expo-router@~58.0.7` 을 받으면 npm 은 58.0.30 을 고르는데, 58.0.30 은 `react-native-screens ^4.30.1` 을 요구하고 로컬 핀은 `~4.28.0` 이다. `--dry-run` 으로 돌려 보니 ERESOLVE 는 나지 않았다. 대신 **screens 가 4.28.0(최상위)과 4.30.1(expo-router 아래) 두 벌**로 깔렸다. 네이티브 모듈이 두 벌이면 JS 와 네이티브가 어긋난다. screens 4.28 을 받아 주는 마지막 expo-router 는 58.0.17 이다(실측 표)
3. **메이저 재편**: 6개 모두 같은 메이저 안이다(58.x · 4.x · 5.x)
4. **검증선 분리**: 이 Task 는 mobile 만 건드린다. admin-web 쪽과 섞지 않았다
5. **실제 실행**: `expo install` 을 실제로 돌려 보니 Expo CLI 가 서버 핀(screens `~4.30.1` 등)을 쓴다는 사실이 드러났다. 서버 핀끼리는 맞물린다(router 58.0.30 ↔ screens 4.30.1). `npm ls` 를 보면 screens·safe-area 는 한 벌씩만 있다. 그래서 58.0.17 고정은 버리고 Expo 가 고른 값을 따랐다. `--legacy-peer-deps`·`overrides` 둘 다 쓰지 않았다

### 설치 중 막힌 것 — `npx` 로 부르면 npm 이 설치를 거부한다

`npx expo install …` 이 `npm error code EALLOWSCRIPTS — --allow-scripts is not allowed in project-scoped installs` 로 실패했다. 원인은 다음과 같다.
- `~/.npmrc` 에 `allow-scripts=@anthropic-ai/claude-code` 가 있다(사용자 전역 설정)
- `npx`(npm exec)가 이 값을 `npm_config_allow_scripts` 환경 변수로 자식에게 넘긴다. 자식 `npm install` 은 이를 「CLI·환경 변수 층」으로 읽는다
- npm 11.19.1 의 `resolve-allow-scripts.js` 는 프로젝트 설치에서 CLI·환경 변수 층 정책을 막는다

**우회**: `npx` 대신 `./node_modules/.bin/expo install …` 로 직접 불렀다. 같은 CLI 이고 사용자 설정은 바꾸지 않았다. **다른 Task(T-A5-4(웹 실행 시도)·admin-web 설치)에서도 `npx` 로 설치하면 똑같이 막힌다.** 오케스트레이터에 전달할 사항이다.

## 2. 만든·바꾼 파일

| 파일 | 변경 |
|---|---|
| `mobile/package.json` | 의존성 6개 추가(위 표). `main` 은 `index.ts` 그대로 |
| `mobile/package-lock.json` | 설치 결과(54개 추가, 9개 변경) |
| `mobile/index.ts` | `registerRootComponent(App)` 을 빼고 `import 'expo-router/entry'` 로 바꿈. `App.tsx` 는 손대지 않았고 진입점에서만 빠졌다 |
| `mobile/app/_layout.tsx` | 새 파일. 루트 `<Stack />` 만 둔다. 화면 없음 |
| `mobile/lib/api.ts` | 새 파일. `apiFetch<T>(path, {method, body, idempotencyKey, auth, signal})`, `ApiError{status, code, detail, fields}`. §4.8(오류 응답 형식)의 `{detail, code}` 를 해석하고 `fields` 는 형식을 검사해서 받는다. 클라이언트 전용 코드 `NETWORK_ERROR`(status 0)·`UNEXPECTED_RESPONSE`(본문이 §4.8 모양이 아님)를 더했다. `EXPO_PUBLIC_API_URL` 이 비어 있으면 바로 오류를 던진다. 토큰이 있으면 `Authorization: Bearer`, `Idempotency-Key` 는 호출자가 넘길 때만 붙인다. 취소(AbortError)는 그대로 다시 던진다 |
| `mobile/lib/session.ts` | 새 파일. `getSessionToken`·`setSessionToken`(빈 문자열 거부)·`clearSessionToken`. 키는 `kdance.session_token` |
| `mobile/.env.example` | 기본 주소를 `http://localhost:8000`(FastAPI)에서 `http://localhost:3000`(Next.js)으로 바꿈. 에뮬레이터·실기기 주소 안내를 더했다 |

## 3. 완료 판정 — 실제 출력

```
$ cd /home/user/kdance/mobile && npx tsc --noEmit; echo "TSC_EXIT=$?"
TSC_EXIT=0
```

```
$ cd /home/user/kdance/mobile && ./node_modules/.bin/expo install --check
env: load .env
The following packages should be updated for best compatibility with the installed expo version:
  expo@58.0.0-preview.6 - expected version: ~58.0.23
  react-native@0.88.0-rc.1 - expected version: 0.88.1
Your project may not work correctly until you install the expected versions of the packages.
Found outdated dependencies
CHECK_EXIT=1
```

(`npx expo install --check` 대신 로컬 바이너리를 쓴 이유는 1절의 EALLOWSCRIPTS 다. `--check` 는 설치를 하지 않으니 npx 로 돌려도 결과는 같을 것으로 보지만, 그 경로로는 돌려 보지 않았다)

`git status --short mobile/`:
```
 M .env.example
 M index.ts
 M package-lock.json
 M package.json
?? app/
?? lib/
```
쓰는 파일 목록 밖은 바뀌지 않았다. `app.json` 은 아래 3번에서 원래대로 되돌렸다.

## 4. 차단·미해결

1. **`expo install --check` 불일치 2건(완료 판정 미달)** — `expo` 는 stable `58.0.23`(레지스트리 `latest`), `react-native` 는 `0.88.1` 이 나와 있어 Expo 가 preview.6·rc.1 을 올리라고 한다. 이번 설치와는 상관없이 원래 있던 불일치다. 이 둘을 올리는 일은 「11. 기술 스택 고정표」를 바꾸는 별도 작업이라 이 Task 범위가 아니다. 버전 정책 「올리기 전에」 4번(한 번에 둘을 건드리지 않는다)에 따라 손대지 않았다. **판단 필요: 별도 Task 로 Expo 58 stable·RN 0.88.1 올리기.** 그 뒤 `expo install --fix` 를 돌리면 새 6개의 핀도 다시 맞춰진다
2. **app.json 변경 필요** — `expo install` 이 `"plugins": ["expo-router", "expo-secure-store"]` 를 저절로 추가했다. 쓰는 파일 목록 밖이라 Edit 로 되돌렸다(`git checkout` 은 훅이 막았다). 네이티브 빌드(prebuild)에 필요하고, 딥링크를 쓰려면 `"scheme"` 도 있어야 한다. 이 둘을 넣을 Task 를 정해야 한다
3. **peer 경고(ERESOLVE overriding peer dependency 5건, 설치는 성공)** — `npm ls` 기준으로 두 종류다. ① 전이 의존성 `react-dom@19.3.1` 이 `react ^19.3.1` 을 요구하는데 프로젝트는 `react 19.3.0` 이다. react-dom 은 웹에서만 쓰고, Expo 핀은 19.3.0 이다. T-A5-4(웹 실행 시도)가 `expo install react-dom react-native-web` 으로 19.3.0 을 선언하면 해소될 것으로 보이나 미검증 ② `@react-native-masked-view/masked-view` 의 `react-native >=0.57` 범위는 semver 상 사전 릴리스(`0.88.0-rc.1`)를 받지 않는다. 1번에서 RN 을 0.88.1 로 올리면 사라진다
4. **SecureStore 가 없는 웹 환경의 동작은 미검증이다.** T-A5-4(웹 실행 시도)에서 확인한다
5. **앱 실행은 미검증이다.** 타입 검사만 했고 Metro 기동과 기기 실행은 하지 않았다. `App.tsx` 는 진입점에서 빠진 채 남아 있어 지금 앱을 켜면 `app/` 에 화면이 없는 빈 Stack 이 뜬다. T-A5-2·T-A5-3 이 화면을 채운다
6. **`mobile/.env`(git 추적 안 함)** — `expo` 실행 때 이 파일을 읽어 서버용 비밀값 이름(`JWT_SECRET_KEY`·`NVIDIA_API_KEY` 등)을 export 한다. 번들에는 `EXPO_PUBLIC_*` 만 들어가므로 바로 새는 것은 아니다. 다만 mobile 에 서버 비밀값이 있을 이유가 없고, `EXPO_PUBLIC_API_URL` 값도 새 기본값(포트 3000)과 맞는지 확인해야 한다. 값은 출력하지 않았고 파일도 손대지 않았다(쓰는 파일 아님)
7. **`npm audit` 15건**(critical 1 포함) — 설치 출력에 나왔다. 이 Task 에서는 조사하지 않았다
