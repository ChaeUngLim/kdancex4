// S0-3.12(관리자 웹 로그인·인증 앱 화면) — 로그인 응답을 다음 화면 단계로 옮기는 규칙과 오류 문장.
// 화면(W1a·W1b2)은 이 결과(kind)만 보고 6자리·QR 등록·콘솔 중 하나로 간다.
import { describe, expect, test } from "vitest";

import {
  LOGIN_MESSAGES,
  describeSignInFailure,
  describeVerifyFailure,
  rateLimitMessage,
  readSignInSuccess,
} from "@/lib/staff-login-client";

describe("로그인 성공 응답 → 다음 단계", () => {
  test("인증 앱을 등록한 계정은 6자리를 묻는다", () => {
    expect(readSignInSuccess({ twoFactorRedirect: true, twoFactorMethods: ["totp"] })).toEqual({ kind: "needCode" });
  });
  test("같은 기기 30일 기억으로 바로 세션이 나오면 콘솔로 간다", () => {
    expect(readSignInSuccess({ token: "t", user: { twoFactorEnabled: true } })).toEqual({ kind: "signedIn" });
  });
  test("첫 로그인(인증 앱 미등록)은 QR 등록으로 간다", () => {
    expect(readSignInSuccess({ token: "t", user: { twoFactorEnabled: false } })).toEqual({ kind: "needEnroll" });
    expect(readSignInSuccess({ token: "t", user: {} })).toEqual({ kind: "needEnroll" });
  });
});

describe("실패 문장", () => {
  test("비밀번호가 틀리면 어느 쪽이 틀렸는지 말하지 않는다", () => {
    expect(describeSignInFailure(401, { code: "INVALID_USERNAME_OR_PASSWORD" })).toEqual({
      kind: "error",
      message: LOGIN_MESSAGES.wrongPassword,
    });
  });
  test("6자리가 틀리면 같은 화면에서 다시 넣는다", () => {
    expect(describeVerifyFailure(401, { code: "INVALID_CODE" })).toEqual({
      kind: "error",
      message: LOGIN_MESSAGES.wrongCode,
      restart: false,
    });
  });
  test("같은 확인에서 너무 많이 틀렸거나 임시 쿠키가 끝나면 처음부터", () => {
    expect(describeVerifyFailure(400, { code: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" })).toMatchObject({ restart: true });
    expect(describeVerifyFailure(401, { code: "INVALID_TWO_FACTOR_COOKIE" })).toMatchObject({ restart: true });
  });
  test("429 는 남은 시간을 분으로 올림해 알려 준다(계약 §6-4)", () => {
    expect(rateLimitMessage({ code: "RATE_LIMITED", retryAfterSeconds: 840 })).toBe("시도가 너무 많아요. 약 14분 뒤 다시 시도해 주세요.");
    expect(rateLimitMessage({ code: "RATE_LIMITED", retryAfterSeconds: 61 })).toBe("시도가 너무 많아요. 약 2분 뒤 다시 시도해 주세요.");
    expect(rateLimitMessage({ code: "ACCOUNT_TEMPORARILY_LOCKED" })).toBe(LOGIN_MESSAGES.rateLimited);
    expect(describeSignInFailure(429, { retryAfterSeconds: 30 })).toEqual({
      kind: "error",
      message: "시도가 너무 많아요. 약 1분 뒤 다시 시도해 주세요.",
    });
  });
  test("그 밖의 실패는 연결 안내", () => {
    expect(describeSignInFailure(500, {})).toEqual({ kind: "error", message: LOGIN_MESSAGES.network });
  });
});
