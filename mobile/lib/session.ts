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
 * 웹 실행(react-native-web)에서는 SecureStore 가 없다. 그 환경의 동작은
 * T-A5-4(웹 실행 시도)에서 확인한다 — 지금은 미검증이다.
 */
import * as SecureStore from 'expo-secure-store';

// 저장 키. SecureStore 키는 영문·숫자·`.`·`-`·`_` 만 허용한다.
const SESSION_TOKEN_KEY = 'kdance.session_token';

/** 저장된 토큰을 읽는다. 없으면 null. */
export async function getSessionToken(): Promise<string | null> {
  return SecureStore.getItemAsync(SESSION_TOKEN_KEY);
}

/** 로그인 성공 뒤 받은 토큰을 저장한다. 빈 문자열은 저장하지 않는다. */
export async function setSessionToken(token: string): Promise<void> {
  if (token.length === 0) {
    throw new Error('빈 세션 토큰은 저장할 수 없다');
  }
  await SecureStore.setItemAsync(SESSION_TOKEN_KEY, token);
}

/** 로그아웃하거나 서버가 401(UNAUTHENTICATED)을 돌려줬을 때 토큰을 지운다. */
export async function clearSessionToken(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
}
