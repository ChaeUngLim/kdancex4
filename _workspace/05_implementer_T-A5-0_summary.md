# Phase 5(구현) 보고 — T-A5-0(Expo·RN 정식판 올림 + app.json 플러그인·scheme)

- 슬라이스: US1-A5(mobile 화면)의 선행 작업 · 작성 2026-11-06
- 결과: **완료.** `expo install --check` 불일치 0, `tsc --noEmit` exit 0, `npm ls --depth=0` 정상. 앱 실행(Metro·기기)은 하지 않았다
- 커밋하지 않았다

## 1. 전후 버전 (실측 — `mobile/node_modules/<pkg>/package.json`)

| 패키지 | 전(선언 / 설치) | 후(선언 / 설치) | Expo 58.0.23 핀 |
|---|---|---|---|
| expo | 58.0.0-preview.6 / 같음 | `~58.0.23` / 58.0.23 | — |
| react-native | 0.88.0-rc.1 / 같음 | `0.88.1` / 0.88.1 | 0.88.1 |
| react | 19.3.0 / 19.3.0 | 변화 없음 | 19.3.0 |
| react-dom(전이) | 선언 없음 / 19.3.1 | `overrides` 로 `$react` / **19.3.0** | 19.3.0 |
| expo-router | ~58.0.30 / 58.0.30 | 변화 없음 | ~58.0.30 |
| react-native-screens | ~4.30.1 / 4.30.1 | 변화 없음 | ~4.30.1 |
| react-native-safe-area-context | ~5.11.1 / 5.11.1 | 변화 없음 | ~5.11.1 |
| expo-secure-store | ~58.0.2 / 58.0.2 | 변화 없음 | ~58.0.2 |
| expo-linking | ~58.0.16 / 58.0.16 | 변화 없음 | ~58.0.16 |
| expo-constants | ~58.0.15 / 58.0.15 | 변화 없음 | ~58.0.15 |
| expo-status-bar | ~58.0.1 / 58.0.4 | 변화 없음 | ~58.0.4 |
| @types/react · typescript | 19.3.0 · 6.0.3 | 변화 없음 | — |

Expo 핀은 `npm pack expo@58.0.23` 으로 받은 패키지의 `bundledNativeModules.json` 에서 읽었다(스크래치 폴더, 저장소 밖). T-A5-1(라우터·API 클라이언트·세션)이 설치한 6개는 이미 Expo 서버 핀과 같아서 바뀌지 않았다.

lockfile 패키지 변화: 제거 6개(`@expo/expo-modules-macros-plugin`·`deepmerge`·`uuid`·`zod`·중첩 `expo-modules-core`·중첩 `@react-native/normalize-colors`), 추가 8개(`expo-modules-core`·`expo-modules-macros`·`expo-modules-cli`·`@expo/platforms`·`@expo/modules-macros-*` 플랫폼별 4개).

## 2. 「올리기 전에」 5단계

1. **상위 고정 패키지** — RN·react·react-dom 버전은 Expo 가 고정한다. `expo@58.0.23` 의 `bundledNativeModules.json` 이 `react-native 0.88.1`·`react 19.3.0`·`react-dom 19.3.0` 이다. dist-tags: expo `latest`=58.0.23, react-native `latest`=0.88.1(`next` 0.89.0-rc.0), react `latest`=19.3.1
2. **peerDependencies** — `expo@58.0.23` 의 peer 는 전부 `*`(react·react-dom·react-native 등). `react-native@0.88.1` peer 는 `react ^19.3.0`. 막힌 지점은 둘이었다(아래 3절)
   - `react-dom@19.3.1`(expo-router 경유 전이 의존성) 의 peer `react ^19.3.1` ↔ 프로젝트 react 19.3.0
   - `react-native-reanimated@4.7.1`(expo-router 의 optional peer) 의 peer `react-native 0.86 - 0.88` 은 사전 릴리스 `0.88.0-rc.1` 을 받지 않는다 → RN 을 0.88.1 로 같이 올리면 풀린다
3. **메이저 재편** — expo 58→58, RN 0.88→0.88. 같은 메이저·마이너 안이라 패키지 이름·API 재편 없음. 대신 Expo 내부 모듈이 재편됐다(`expo-modules-core` 가 expo 아래 중첩에서 최상위로, `expo-modules-macros` 신설)
4. **검증선 분리** — mobile 만 건드렸다. admin-web 은 손대지 않았다
5. **실제 실행** — 설치 후 `expo install --fix`·`--check`·`tsc`·`npm ls`·`npm audit` 를 실제로 돌렸다(5절)

## 3. 설치 과정 — 막힌 것과 고른 길

1. `npm install expo@~58.0.23 react-native@0.88.1 --dry-run` → **ERESOLVE**: `react-dom@19.3.1` 이 `react@^19.3.1` 을 요구
2. `./node_modules/.bin/expo install expo@~58.0.23` → 같은 ERESOLVE. Expo CLI 는 `expo` 가 목록에 있으면 그것만 먼저 따로 설치하고, 실패하면 "npm 으로 expo 를 먼저 설치하라" 고 안내한다
3. **`overrides` 한 건 추가**: `"overrides": {"react-dom": "$react"}`. 이유 — react-dom 은 react 와 정확히 같은 버전이어야 하고, Expo 58.0.23 의 핀도 react-dom 19.3.0 이다. `$react` 는 루트 react 선언(19.3.0)을 따라가므로 나중에 Expo 가 react 를 올려도 따로 고칠 필요가 없다. `--legacy-peer-deps` 처럼 peer 검증 전체를 끄지 않고 이 한 항목만 덮는다
4. 그다음 dry-run 에서 reanimated 충돌(2절 2번 두 번째 항목)이 나왔다. 이건 RN 을 같이 올리면 풀리는 충돌이라 overrides 를 더 쓰지 않았다. `expo install expo@~58.0.23 react-native@0.88.1` 은 여전히 expo 단독 설치로 실패해서, Expo 안내대로 `npm install expo@~58.0.23 react-native@0.88.1`(플래그 없음, exit 0)로 둘을 함께 올리고 `./node_modules/.bin/expo install --fix` 를 돌렸다 → "Dependencies are up to date"
5. npm 이 RN 을 `^0.88.1` 로 적어서 Expo 핀 형식(정확한 값)과 기존 선언에 맞춰 `0.88.1` 로 고치고 `npm install` 로 lockfile 을 맞췄다(lock 루트 `react-native: 0.88.1` 확인)

T-A5-1 보고서의 peer 경고 두 종류는 **둘 다 풀렸다** — react-dom 은 19.3.0 으로 내려왔고, rc 판 RN 이 사라져 masked-view·reanimated 범위 문제가 없어졌다. `npx` 는 쓰지 않았다(EALLOWSCRIPTS). `~/.npmrc` 는 건드리지 않았다.

## 4. 바꾼 파일과 줄

| 파일 | 변경 |
|---|---|
| `mobile/package.json` | 6행 `expo` → `~58.0.23`, 13행 `react-native` → `0.88.1`, 21~23행 `"overrides": {"react-dom": "$react"}` 추가 |
| `mobile/package-lock.json` | 위 설치 결과 |
| `mobile/app.json` | `expo` 객체 끝에 `"plugins": ["expo-router", "expo-secure-store"]`, `"scheme": "kdancex4"` 추가. 다른 키는 그대로 |
| `docs/planning/kdancex4_service_definition_and_tech_stack.md` | 「11. 기술 스택 고정표」 742·743행(Expo SDK 58.0.23, React Native 0.88.1). React 행(19.3.0)은 값이 같아 그대로. 「11-2. 알려진 위험」의 「Expo 58 preview」 행을 **해소(2026-11-06)** 로, 근거 명령과 overrides 이유를 적었다 |
| `CLAUDE.md` | 10행 Project Overview 문구 → `Expo SDK 58 (58.0.23) + React Native 0.88.1 + TS (mobile — 2026-11-06 정식판으로 올림, …` |
| `_workspace/03_research.md` | §1 표의 expo/react-native 행을 실측값·58.0.23 핀으로 고치고, T-A5-1 설치분 6개 행을 추가 |

## 5. 검증 — 실제 출력

```
$ cd /home/user/kdance/mobile && npx tsc --noEmit; echo "TSC_EXIT=$?"
TSC_EXIT=0
```

```
$ ./node_modules/.bin/expo install --check; echo "CHECK_EXIT=$?"
env: load .env
env: export (… .env 의 변수 이름 목록 — 생략 …)
Dependencies are up to date
CHECK_EXIT=0
```

```
$ npm ls --depth=0; echo "LS_EXIT=$?"
mobile@1.0.0 /home/user/kdance/mobile
├── @types/react@19.3.0
├── expo-constants@58.0.15
├── expo-linking@58.0.16
├── expo-router@58.0.30
├── expo-secure-store@58.0.2
├── expo-status-bar@58.0.4
├── expo@58.0.23
├── react-native-safe-area-context@5.11.1
├── react-native-screens@4.30.1
├── react-native@0.88.1
├── react@19.3.0
└── typescript@6.0.3

LS_EXIT=0
```

`npm ls --all` 에서 `invalid`·`missing` 은 0건. 나오는 것은 `UNMET OPTIONAL DEPENDENCY` 뿐이다(`@expo/ui`·`@types/react-dom`·`@testing-library/react-native`·`expo-symbols`·`react-native-web`·`react-server-dom-webpack` — 모두 optional peer).

`npm audit` 요약(조사는 하지 않음):

| 시점 | 합계 | low | moderate | high | critical |
|---|---|---|---|---|---|
| 전 | 15 | 1 | 9 | 4 | 1 |
| 후 | 6 | 0 | 5 | 0 | 1 |

## 6. 다른 문서에 남은 옛 버전 표기 (고치지 않음 — 범위 밖)

`grep -rn "58.0.0-preview.6\|0.88.0-rc.1" --include=*.md --include=*.html .` 결과에서 이번에 고친 3곳을 뺀 나머지:

- `docs/planning/kdancex4_service_definition_and_tech_stack.md` 781·787·791행 — 「11-1. 버전을 이렇게 정한 이유」의 RN 앵커 설명(preview 를 택한 이유). 이력 서술이라 지시 범위(11절 표 행·11-2)에서 뺐다. 796행 "58 안정판이 나오면 그리로 옮긴다" 는 이제 끝난 일이므로 후속 갱신이 필요하다
- `docs/agent/ai-coding-agent.html` 109·193·215·216·672행 — 에이전트용 스택 개요. 버전 표와 캐럿(`^58.0.0-preview.6`) 설명. **갱신 권장**(에이전트가 옛 값을 기준으로 삼을 수 있다)
- `docs/structure-map.md` 231·256행, `docs/guide/structure-map.html` 89행 — 구조 지도(생성기 `scripts/build_structure_map.py` 로 다시 만들면 된다)
- `docs/Review.md` 518·528행 — 과거 일지라 고칠 대상이 아니다
- `_workspace/02_code-searcher_structure.md` 268행, `_workspace/05_implementer_T-A5-1_summary.md` — 그 시점 기록
- `docs/graphify-out/*` — 자동 생성물

## 7. 차단·미해결

1. **앱 실행 미검증** — Metro 기동·기기·웹 실행은 하지 않았다. 타입 검사와 의존성 정합성만 확인했다. `plugins`·`scheme` 이 실제 prebuild 에서 먹는지도 확인하지 않았다(T-A5-4(웹 실행 시도) 또는 화면 Task 에서 확인)
2. **`mobile/AGENTS.md` 가 v57 문서를 가리킨다** — "Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/" 인데 설치본은 SDK 58 이다. 쓰는 파일이 아니라 고치지 않았다. 화면 Task 가 이 안내를 따르면 한 버전 옛 문서를 읽게 된다 — 오케스트레이터 판단 필요
3. **`expo install --check` 가 `mobile/.env` 를 읽어 변수 이름을 출력한다** — 값은 출력되지 않는다. T-A5-1 보고서 6번(mobile 에 서버 비밀값 이름이 있음)과 같은 건이고, 사용자가 직접 정리하기로 한 사항이라 파일은 열지 않았다
4. **npm audit critical 1건 남음** — 조사하지 않았다
5. **`expo install expo@…` 단독 경로는 이 프로젝트에서 실패한다** — 다음에 Expo 를 올릴 때도 `npm install expo@… react-native@…` 를 함께 한 뒤 `expo install --fix` 순서를 쓴다. 11-2 행에 적어 두었다
