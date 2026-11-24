/**
 * 로그인 토큰 보관 — expo-secure-store.
 *
 * 공유 계약 README §2(인증): 모바일은 Better Auth `bearer` 플러그인이 준 세션 토큰을
 * `Authorization: Bearer <token>` 헤더로 보낸다. 그 토큰을 어디에 둘지가 이 파일의 일이다.
 *
 * 왜 AsyncStorage 가 아니라 SecureStore 인가: 토큰은 비밀번호와 같은 무게다.
 * SecureStore 는 Android Keystore·iOS Keychain 에 암호화해 넣고,
 * AsyncStorage 는 평문 파일이다.
 *
 * 웹 실행(react-native-web)에서는 SecureStore 가 없다. 그래서 웹에서는 토큰을 이 모듈의 변수(메모리)에만
 * 둔다(2026-11-23 사용자 결정 — PC 브라우저로 앱을 실서버에 붙여 시연). 디스크·localStorage 같은 평문 저장소에는
 * 쓰지 않으므로 새로고침하면 로그아웃된다. 휴대폰 앱은 계속 SecureStore 만 쓴다.
 */
import * as SecureStore from 'expo-secure-store';

// 저장 키. SecureStore 키는 영문·숫자·`.`·`-`·`_` 만 허용한다.
const SESSION_TOKEN_KEY = 'kdance.session_token';

// 보관소가 없는 환경(웹)에서만 쓰는 메모리 칸. 탭을 닫거나 새로고침하면 사라진다.
let memoryToken: string | null = null;

// 마지막으로 읽거나 저장한 토큰(SX-6.9). <Image> 처럼 기다릴 수 없는 자리(렌더 중)에서 서버 사진을 받을 때만 쓴다.
// 모든 API 호출이 getSessionToken 을 먼저 거치므로, 화면이 데이터를 받아 그릴 때는 이미 채워져 있다. 디스크에는 쓰지 않는다.
let lastKnownToken: string | null = null;

/** 렌더 중에 쓸 수 있는 토큰 — 아직 한 번도 읽지 않았으면 null */
export function peekSessionToken(): string | null {
  return lastKnownToken;
}

/**
 * 저장된 토큰을 읽는다. 없으면 null.
 *
 * 웹 실행(react-native-web)에는 SecureStore 가 없다 — 그대로 부르면 TypeError 가 나서
 * 로그인이 필요한 화면이 모두 「알 수 없는 오류」로 멈춘다. 그래서 보관소가 없는 환경은
 * 메모리 칸을 읽는다(로그인 전이면 null). 평문 저장소에 두지 않는 이유는 위와 같다.
 */
export async function getSessionToken(): Promise<string | null> {
  if (!(await SecureStore.isAvailableAsync())) {
    lastKnownToken = memoryToken;
    return memoryToken;
  }
  lastKnownToken = await SecureStore.getItemAsync(SESSION_TOKEN_KEY);
  return lastKnownToken;
}

/** 로그인 성공 뒤 받은 토큰을 저장한다. 빈 문자열은 저장하지 않는다. */
export async function setSessionToken(token: string): Promise<void> {
  if (token.length === 0) {
    throw new Error('빈 세션 토큰은 저장할 수 없다');
  }
  lastKnownToken = token;
  // 웹: 메모리에만 둔다
  if (!(await SecureStore.isAvailableAsync())) {
    memoryToken = token;
    return;
  }
  await SecureStore.setItemAsync(SESSION_TOKEN_KEY, token);
}

/** 로그아웃하거나 서버가 401(UNAUTHENTICATED)을 돌려줬을 때 토큰을 지운다. */
export async function clearSessionToken(): Promise<void> {
  lastKnownToken = null;
  // 보관소가 없는 환경(웹)은 메모리 칸만 비운다.
  if (!(await SecureStore.isAvailableAsync())) {
    memoryToken = null;
    return;
  }
  await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
}
