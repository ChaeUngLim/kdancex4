// T-M3-5(본인확인·알림 포트와 가짜 구현) — 공유 계약 §4.10 IdentityVerificationPort 의 가짜 구현
//
// FR-003(본인확인 계정 식별). 실제 본인확인 기관 대신 서버가 서명한 토큰을 쓴다.
// 흐름(01-member-onboarding.md §2): dev 경로가 `issue` 로 토큰을 만들고 → 앱이 그 토큰으로
// 가입을 요청하면 → 서버가 `verify` 로 푼다. 기관이 생기면 dev 경로는 사라지고 기관 콜백이
// 같은 결과를 만든다.
//
// 토큰 모양: `base64url(JSON 내용).base64url(HMAC-SHA256(비밀값, "kdance.fake-identity.v1." + 내용 조각))`
// - 서명만 할 뿐 암호화하지 않는다. 내용(이름·전화·personKey)은 토큰을 가진 쪽이 읽을 수 있다.
//   dev 전용 시드 값만 다루므로 받아들인 한계다
// - CI 해시 = HMAC-SHA256(pepper, personKey) 의 hex(06-ports.md 표). 원래 CI 는 저장하지 않는다
//
// 비밀값·pepper·토큰 원문·personKey 는 어떤 오류 메시지에도 넣지 않는다.
import { createHmac, timingSafeEqual } from "node:crypto";

import { GENDERS, type Gender } from "../../domain/constants";
import type { Clock } from "../../domain/time";
import type {
  IdentityVerificationPort,
  IdentityVerificationResult,
} from "../ports/identity";

/** 토큰 유효 시간(01-member-onboarding.md §2: 「토큰 유효 10분」) */
export const FAKE_IDENTITY_TOKEN_TTL_MINUTES = 10;

/** 비밀값·pepper 최소 길이. HMAC-SHA256 키로 32바이트 이상을 요구한다 */
const MIN_KEY_LENGTH = 32;
const TOKEN_VERSION = 1;
const SIGNING_PREFIX = `kdance.fake-identity.v${TOKEN_VERSION}.`;
const SIGNATURE_BYTES = 32; // SHA-256 출력 길이
const PHONE_PATTERN = /^01\d{8,9}$/;
const BIRTH_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_TEXT_LENGTH = 100;

export interface FakeIdentityVerificationOptions {
  /** 토큰 서명 비밀값(`FAKE_IDENTITY_SECRET`) */
  secret: string;
  /** CI 해시용 pepper(`IDENTITY_CI_PEPPER`) */
  ciPepper: string;
  /** 발급 시각·만료 계산용 시계(공유 계약 §4.10 Clock) */
  clock: Clock;
}

/** dev 가짜 본인확인 요청(01-member-onboarding.md §2)과 같은 칸 */
export interface FakeIdentityIssueInput {
  name: string;
  gender: Gender;
  birthDate: Temporal.PlainDate;
  phone: string;
  personKey: string;
}

/** 토큰 안에 서명돼 들어가는 내용 */
interface TokenClaims {
  v: typeof TOKEN_VERSION;
  name: string;
  gender: Gender;
  birthDate: string;
  phone: string;
  personKey: string;
  /** 만료 순간(epoch 밀리초) */
  exp: number;
}

const INVALID: IdentityVerificationResult = Object.freeze({ ok: false, reason: "invalid" });
const EXPIRED: IdentityVerificationResult = Object.freeze({ ok: false, reason: "expired" });

/**
 * 가짜 본인확인을 알아보는 전역 표식(2026-11-23). `instanceof` 대신 이것으로 판별한다.
 * next dev 는 파일이 바뀌면 모듈을 다시 읽어 클래스를 새로 만든다. globalThis 에 남아 있던 옛 인스턴스는
 * 새 클래스의 instanceof 에 걸리지 않아, dev 가짜 본인확인 경로가 404 를 냈다. Symbol.for 는 프로세스 전체에서 같은 값이다.
 */
export const FAKE_IDENTITY_BRAND: unique symbol = Symbol.for("kdance.fakeIdentityVerification") as never;

/** 이 구현이 가짜 본인확인인가 — 모듈을 다시 읽은 뒤에도 같은 답을 준다 */
export function isFakeIdentityVerification(port: unknown): port is FakeIdentityVerification {
  return typeof port === "object" && port !== null && (port as Record<symbol, unknown>)[FAKE_IDENTITY_BRAND] === true;
}

export class FakeIdentityVerification implements IdentityVerificationPort {
  /** 전역 표식 — isFakeIdentityVerification 이 본다 */
  readonly [FAKE_IDENTITY_BRAND] = true;
  readonly #secret: string;
  readonly #ciPepper: string;
  readonly #clock: Clock;

  constructor(options: FakeIdentityVerificationOptions) {
    assertKey(options.secret, "FAKE_IDENTITY_SECRET");
    assertKey(options.ciPepper, "IDENTITY_CI_PEPPER");
    // 같은 값을 쓰면 서명 키와 CI 해시 키가 한 비밀에 묶인다
    if (options.secret === options.ciPepper) {
      throw new RangeError("FAKE_IDENTITY_SECRET 과 IDENTITY_CI_PEPPER 는 서로 달라야 한다");
    }
    this.#secret = options.secret;
    this.#ciPepper = options.ciPepper;
    this.#clock = options.clock;
  }

  /** dev 가짜 본인확인 — 서명 토큰과 만료 순간을 낸다. 입력이 틀리면 RangeError */
  issue(input: FakeIdentityIssueInput): {
    verificationToken: string;
    expiresAt: Temporal.Instant;
  } {
    const expiresAt = this.#clock().add({ minutes: FAKE_IDENTITY_TOKEN_TTL_MINUTES });
    const claims: TokenClaims = {
      v: TOKEN_VERSION,
      name: input.name.trim(),
      gender: input.gender,
      birthDate: input.birthDate.toString(),
      phone: input.phone,
      personKey: input.personKey,
      exp: expiresAt.epochMilliseconds,
    };
    if (!isValidClaims(claims)) {
      // 어느 칸이 틀렸는지는 칸 이름까지만 — 값(특히 personKey)은 싣지 않는다
      throw new RangeError("가짜 본인확인 입력이 형식에 맞지 않는다(이름·성별·생년월일·전화·personKey)");
    }
    const payloadPart = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    return {
      verificationToken: `${payloadPart}.${this.#sign(payloadPart).toString("base64url")}`,
      expiresAt,
    };
  }

  async verify(token: string, now: Temporal.Instant): Promise<IdentityVerificationResult> {
    const claims = this.#readSignedClaims(token);
    if (claims === null) {
      return INVALID;
    }
    // 서명을 먼저 보고 시각은 나중에 본다 — 위조 토큰에 「만료」라는 정보를 주지 않는다
    if (now.epochMilliseconds >= claims.exp) {
      return EXPIRED;
    }
    return {
      ok: true,
      ciHash: this.#ciHash(claims.personKey),
      name: claims.name,
      gender: claims.gender,
      birthDate: Temporal.PlainDate.from(claims.birthDate),
      phone: claims.phone,
    };
  }

  /** 서명이 맞고 내용이 계약 모양일 때만 내용을 돌려준다. 그 밖에는 모두 null */
  #readSignedClaims(token: string): TokenClaims | null {
    const parts = token.split(".");
    if (parts.length !== 2) {
      return null;
    }
    const [payloadPart, signaturePart] = parts;
    if (!BASE64URL_PATTERN.test(payloadPart) || !BASE64URL_PATTERN.test(signaturePart)) {
      return null;
    }
    const given = Buffer.from(signaturePart, "base64url");
    // 길이가 다르면 timingSafeEqual 이 예외를 던진다 — 길이는 비밀이 아니니 먼저 거른다.
    // 같은 서명의 다른 표기(끝 비트만 다른 base64url)도 받지 않는다
    if (given.length !== SIGNATURE_BYTES || given.toString("base64url") !== signaturePart) {
      return null;
    }
    // 상수 시간 비교 — 몇 바이트까지 맞았는지가 응답 시간으로 새지 않게
    if (!timingSafeEqual(given, this.#sign(payloadPart))) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    return isValidClaims(parsed) ? parsed : null;
  }

  #sign(payloadPart: string): Buffer {
    return createHmac("sha256", this.#secret).update(SIGNING_PREFIX + payloadPart, "utf8").digest();
  }

  #ciHash(personKey: string): string {
    return createHmac("sha256", this.#ciPepper).update(personKey, "utf8").digest("hex");
  }
}

function assertKey(value: string, envName: string): void {
  if (typeof value !== "string" || value.length < MIN_KEY_LENGTH) {
    throw new RangeError(`${envName} 는 ${MIN_KEY_LENGTH}자 이상이어야 한다`);
  }
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT_LENGTH;
}

function isValidBirthDate(value: unknown): value is string {
  if (typeof value !== "string" || !BIRTH_DATE_PATTERN.test(value)) {
    return false;
  }
  try {
    Temporal.PlainDate.from(value, { overflow: "reject" });
    return true;
  } catch {
    return false;
  }
}

/** 토큰 내용 검사 — 서명이 맞아도 모양이 틀리면 쓰지 않는다(AC-9(가입 정보): 셋 중 하나라도 비면 가입하지 않는다) */
function isValidClaims(value: unknown): value is TokenClaims {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const c = value as Record<string, unknown>;
  return (
    c.v === TOKEN_VERSION &&
    isNonEmptyText(c.name) &&
    (GENDERS as readonly unknown[]).includes(c.gender) &&
    isValidBirthDate(c.birthDate) &&
    typeof c.phone === "string" &&
    PHONE_PATTERN.test(c.phone) &&
    isNonEmptyText(c.personKey) &&
    typeof c.exp === "number" &&
    Number.isSafeInteger(c.exp)
  );
}
