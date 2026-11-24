// 관리자 웹 로그인 화면(W1a·W1b2)이 부르는 Better Auth 경로 세 개와, 실패를 사람이 읽을 문장으로 바꾸는 표.
//   흐름(계약 README §6-1):
//   ① POST /api/auth/sign-in/username {username, password}
//      ├ 인증 앱을 이미 등록한 계정 → {twoFactorRedirect: true} + 임시 쿠키 → ③ 6자리 입력
//      ├ 같은 기기 30일 쿠키가 살아 있음 → 바로 세션(user.twoFactorEnabled = true) → 콘솔
//      └ 아직 등록 안 함(첫 로그인) → 1단계 세션(user.twoFactorEnabled = false) → ② 등록
//   ② POST /api/auth/two-factor/enable {password} → totpURI(QR 에 담을 주소)
//   ③ POST /api/auth/two-factor/verify-totp {code, trustDevice} → 세션
//
// 왜 이 파일을 화면과 나눴나: 응답 모양 해석과 오류 문장은 화면 없이 단위 테스트로 확인하고 싶어서다.
//   화면 컴포넌트는 결과(kind)만 보고 다음 단계를 고른다.

/** 화면이 다음 단계를 고르는 데 쓰는 로그인 결과. */
export type SignInOutcome =
  | { kind: "needCode" } // 등록된 인증 앱의 6자리를 물어야 한다(W1b2)
  | { kind: "needEnroll" } // 첫 로그인 — QR 로 인증 앱을 먼저 등록한다
  | { kind: "signedIn" } // 같은 기기 30일 기억 덕분에 바로 들어왔다
  | { kind: "error"; message: string };

export type VerifyOutcome =
  | { kind: "signedIn" }
  | { kind: "error"; message: string; restart: boolean }; // restart: 처음(W1a)부터 다시 로그인해야 한다

export type EnableOutcome = { kind: "ok"; totpURI: string } | { kind: "error"; message: string };

// ---- 사람에게 보여 줄 문장 -------------------------------------------------------------------
export const LOGIN_MESSAGES = {
  wrongPassword: "아이디 또는 비밀번호가 맞지 않아요.",
  wrongCode: "코드가 맞지 않아요. 인증 앱에 지금 뜬 6자리를 다시 넣어 주세요.",
  expired: "확인 시간이 지났거나 틀린 횟수가 많아요. 처음부터 다시 로그인해 주세요.",
  rateLimited: "시도가 너무 많아요. 잠시 뒤 다시 시도해 주세요.",
  network: "서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.",
  needCredentials: "아이디와 비밀번호를 넣어 주세요.",
  needSixDigits: "6자리를 모두 넣어 주세요.",
} as const;

/** 실패 응답 본문에서 쓰는 칸만 꺼낸다. Better Auth 는 {code, message}, 우리 429 는 {detail, code, retryAfterSeconds}. */
type ErrorBody = { code?: unknown; detail?: unknown; retryAfterSeconds?: unknown };

/** 429 문장 — 남은 시간이 오면 「약 N분 뒤」를 붙인다(요청 제한 15분, 계약 §6-4). */
export function rateLimitMessage(body: ErrorBody): string {
  const seconds = typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : null;
  if (seconds === null || seconds <= 0) return LOGIN_MESSAGES.rateLimited;
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `시도가 너무 많아요. 약 ${minutes}분 뒤 다시 시도해 주세요.`;
}

/**
 * 6자리 확인(verify-totp) 실패를 문장으로 바꾼다.
 *   - 401 INVALID_CODE: 코드만 틀림 → 같은 화면에서 다시 넣는다
 *   - 400 TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE(같은 확인에서 5번 틀림) · 401 INVALID_TWO_FACTOR_COOKIE(임시 쿠키 만료):
 *     이 확인 자체가 끝났다 → 비밀번호부터 다시
 *   - 429: 계정 잠금(Better Auth) 또는 우리 요청 제한
 */
export function describeVerifyFailure(status: number, body: ErrorBody): VerifyOutcome {
  if (status === 429) return { kind: "error", message: rateLimitMessage(body), restart: false };
  if (body.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" || body.code === "INVALID_TWO_FACTOR_COOKIE") {
    return { kind: "error", message: LOGIN_MESSAGES.expired, restart: true };
  }
  if (status === 401 || status === 400) return { kind: "error", message: LOGIN_MESSAGES.wrongCode, restart: false };
  return { kind: "error", message: LOGIN_MESSAGES.network, restart: false };
}

/** 비밀번호 로그인(sign-in/username) 실패를 문장으로 바꾼다. 어느 쪽이 틀렸는지는 알려 주지 않는다. */
export function describeSignInFailure(status: number, body: ErrorBody): SignInOutcome {
  if (status === 429) return { kind: "error", message: rateLimitMessage(body) };
  if (status === 401 || status === 400) return { kind: "error", message: LOGIN_MESSAGES.wrongPassword };
  return { kind: "error", message: LOGIN_MESSAGES.network };
}

/** 성공한 로그인 응답을 다음 단계로 옮긴다. */
export function readSignInSuccess(body: unknown): SignInOutcome {
  const data = (body ?? {}) as { twoFactorRedirect?: unknown; user?: { twoFactorEnabled?: unknown } };
  if (data.twoFactorRedirect === true) return { kind: "needCode" };
  // 세션이 바로 나왔는데 인증 앱이 꺼져 있으면 첫 로그인이다 — 등록을 마쳐야 콘솔을 쓴다(FR-303).
  if (data.user?.twoFactorEnabled === true) return { kind: "signedIn" };
  return { kind: "needEnroll" };
}

// ---- 실제 호출 -------------------------------------------------------------------------------
async function postAuth(path: string, body: unknown): Promise<{ status: number; json: unknown } | null> {
  try {
    const res = await fetch(`/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin", // 임시 쿠키(two_factor)·세션 쿠키를 주고받는다
      body: JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } catch {
    return null; // 네트워크가 끊겼다
  }
}

export async function signInWithUsername(username: string, password: string): Promise<SignInOutcome> {
  const res = await postAuth("/sign-in/username", { username, password });
  if (res === null) return { kind: "error", message: LOGIN_MESSAGES.network };
  if (res.status !== 200) return describeSignInFailure(res.status, res.json as ErrorBody);
  return readSignInSuccess(res.json);
}

/** 첫 등록 — 비밀번호를 한 번 더 확인받고 인증 앱에 넣을 주소(totpURI)를 받는다. 백업 코드는 쓰지 않아 버린다(S0-3.9). */
export async function enableAuthenticator(password: string): Promise<EnableOutcome> {
  const res = await postAuth("/two-factor/enable", { password });
  if (res === null) return { kind: "error", message: LOGIN_MESSAGES.network };
  const uri = (res.json as { totpURI?: unknown }).totpURI;
  if (res.status === 200 && typeof uri === "string") return { kind: "ok", totpURI: uri };
  if (res.status === 429) return { kind: "error", message: rateLimitMessage(res.json as ErrorBody) };
  return { kind: "error", message: LOGIN_MESSAGES.expired };
}

/**
 * S0-3.13 — 첫 로그인(1단계 세션만 있음)에서 인증 앱 등록 전에 「관리자 웹에서 쓸 메뉴가 있나」를 묻는다(계약 README §6-1 ④).
 * 위임이 하나도 없는 강사에게 QR 등록을 시키지 않으려는 것이다. false 면 화면은 콘솔(/)로 보내고, 콘솔 틀이 「메뉴 없음」을 띄운다.
 * 묻지 못했으면(네트워크·5xx) true 로 두고 원래대로 등록을 이어 간다 — 콘솔 틀이 어차피 다시 판정한다.
 */
export async function hasConsoleAccess(): Promise<boolean> {
  try {
    const res = await fetch("/api/staff/me", { credentials: "same-origin" });
    if (!res.ok) return true;
    const body = (await res.json()) as { consoleAccess?: unknown };
    return body.consoleAccess !== false;
  } catch {
    return true;
  }
}

export async function verifyAuthenticatorCode(code: string, trustDevice: boolean): Promise<VerifyOutcome> {
  const res = await postAuth("/two-factor/verify-totp", { code, trustDevice });
  if (res === null) return { kind: "error", message: LOGIN_MESSAGES.network, restart: false };
  if (res.status === 200) return { kind: "signedIn" };
  return describeVerifyFailure(res.status, res.json as ErrorBody);
}
