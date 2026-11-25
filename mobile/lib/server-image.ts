/**
 * 서버 사진(/api/files/{id})을 화면에 그릴 수 있는 data URI 로 바꾸는 순수 함수 — 2026-11-25 홍보 이미지 버그 수정.
 *
 * 왜 data URI 인가: 서버 사진은 로그인 토큰(Authorization: Bearer)을 실어야 받힌다. 처음에는 <Image source={{ uri, headers }}>
 * 로 토큰을 붙였는데, 안드로이드(Expo Go 58 · RN 0.88.1) 에뮬레이터에서 이미지 요청에 Authorization 이 아예 실리지 않아
 * 401 이 났다(개발 서버에서 헤더 유무를 찍어 확인 — 앱 쪽 토큰은 있었다). 그래서 플랫폼의 이미지 헤더 지원에 기대지 않고,
 * 앱의 보통 API 요청(Bearer 확실)으로 바이트를 받아 data URI 로 만들어 <Image> 에 넣는다. 웹·안드로이드·iOS 모두 같은 길이다.
 *
 * 이 파일은 react-native 를 가져오지 않는다 — admin-web 의 단위 테스트(vitest)가 그대로 불러 시험한다.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 바이트 → base64 글자. 휴대폰 엔진에 btoa 가 없거나 이진 글자를 못 받을 수 있어 직접 계산한다 */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  // 3바이트(24비트)를 6비트 4개로 나눈다. 끝에 남는 1~2바이트는 「=」로 채운다
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const triple = (a << 16) | (b << 8) | c;
    parts.push(
      BASE64_ALPHABET[(triple >> 18) & 63]! +
        BASE64_ALPHABET[(triple >> 12) & 63]! +
        (i + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63]! : '=') +
        (i + 2 < bytes.length ? BASE64_ALPHABET[triple & 63]! : '='),
    );
  }
  return parts.join('');
}

/** 이미지로 받아도 되는 형식만 통과시킨다. 모르는 형식(빈 값 · HTML 오류 페이지 등)은 null */
export function imageContentType(header: string | null): string | null {
  const type = (header ?? '').split(';')[0]!.trim().toLowerCase();
  return /^image\/(jpeg|png|webp|gif)$/.test(type) ? type : null;
}

/** 형식 + 바이트 → `data:image/jpeg;base64,…` */
export function toImageDataUri(contentType: string, bytes: Uint8Array): string {
  return `data:${contentType};base64,${bytesToBase64(bytes)}`;
}
