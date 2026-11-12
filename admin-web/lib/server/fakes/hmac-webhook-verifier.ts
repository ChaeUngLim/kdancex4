// 공유 계약 §4.10(포트) — WebhookVerifier 의 HMAC-SHA256 구현(Standard Webhooks 모양).
// T-M3-4(PG 포트·가짜 PG·웹훅 검증기 이식). FR-287(웹훅 확정) 1단계(계약 03 §6 1행)가 쓴다.
//
// 서명 = `v1,` + base64(HMAC-SHA256(key, `${webhook-id}.${webhook-timestamp}.${rawBody}`)).
// 포트원 V2 실제 규격과 같은지는 미검증(research R-11). 그래서 fakes 폴더에 둔다 — 실 PG 를 붙일 때
// 규격이 같으면 옮기고, 다르면 새 구현을 만든다(포트 뒤라 서비스 영향 없음).
//
// 보안 결정
// - 비교는 `crypto.timingSafeEqual` 로 상수 시간에 한다. 길이가 다르면 그 함수가 예외를 던지므로 먼저 거부한다.
//   (길이는 HMAC-SHA256 이면 항상 32바이트라 길이 자체는 비밀이 아니다.)
// - timestamp 가 허용 오차(계약 03 §6: 5분)를 넘으면 과거든 미래든 거부한다 — 가로챈 요청을 나중에 다시
//   보내는 재전송 공격을 막는다. 같은 webhook-id 재전송은 DB 유니크(계약 03 §6 2행)가 따로 막는다.
// - 비밀값은 생성자로만 받는다. 환경 변수(`PG_WEBHOOK_SECRET`)는 `lib/server/deps.ts` 가 읽어 넘긴다.
// - 비밀값·서명 원문은 오류 문구나 로그에 넣지 않는다.
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type WebhookVerifier,
} from "../ports/webhook-verifier";

/** 계약 03 §6 1행 「허용 오차 5분」 */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

const SIGNATURE_VERSION = "v1";
const HMAC_SHA256_BYTES = 32;
/** 서명 헤더 안 항목 수 상한 — 비밀값 교체 기간에 2~3개면 충분하다. 큰 헤더로 연산을 늘리는 것을 막는다 */
const MAX_SIGNATURE_ENTRIES = 5;
const STANDARD_WEBHOOKS_SECRET_PREFIX = "whsec_";
const TIMESTAMP_PATTERN = /^\d{1,12}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * 비밀값 → HMAC 키 바이트. `whsec_` 로 시작하면 Standard Webhooks 관례대로 뒤를 base64 로 푼다.
 * 그 밖에는 UTF-8 바이트를 그대로 쓴다. 서명·검증 양쪽이 이 함수 하나를 쓰므로 어긋나지 않는다.
 */
function secretToKey(secret: string): Buffer {
  if (secret.startsWith(STANDARD_WEBHOOKS_SECRET_PREFIX)) {
    const encoded = secret.slice(STANDARD_WEBHOOKS_SECRET_PREFIX.length);
    if (!BASE64_PATTERN.test(encoded)) throw new Error("웹훅 비밀값 형식이 올바르지 않습니다.");
    return Buffer.from(encoded, "base64");
  }
  return Buffer.from(secret, "utf8");
}

function computeSignature(key: Buffer, webhookId: string, timestamp: string, rawBody: string): Buffer {
  return createHmac("sha256", key).update(`${webhookId}.${timestamp}.${rawBody}`, "utf8").digest();
}

export interface HmacWebhookVerifierOptions {
  secret: string;
  toleranceSeconds?: number;
}

export class HmacWebhookVerifier implements WebhookVerifier {
  private readonly key: Buffer;
  private readonly toleranceSeconds: number;

  constructor(options: HmacWebhookVerifierOptions) {
    const key = secretToKey(options.secret);
    if (key.length === 0) throw new Error("웹훅 비밀값이 비어 있습니다.");
    const tolerance = options.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
    if (!Number.isSafeInteger(tolerance) || tolerance <= 0) {
      throw new Error("웹훅 시각 허용 오차는 양의 정수(초)여야 합니다.");
    }
    this.key = key;
    this.toleranceSeconds = tolerance;
  }

  verify(headers: Headers, rawBody: string, now: Temporal.Instant): boolean {
    const webhookId = headers.get(WEBHOOK_ID_HEADER);
    const timestamp = headers.get(WEBHOOK_TIMESTAMP_HEADER);
    const signatureHeader = headers.get(WEBHOOK_SIGNATURE_HEADER);
    if (!webhookId || !timestamp || !signatureHeader) return false;

    if (!this.isTimestampFresh(timestamp, now)) return false;

    const expected = computeSignature(this.key, webhookId, timestamp, rawBody);
    const entries = signatureHeader.split(" ").filter((entry) => entry !== "");
    if (entries.length === 0 || entries.length > MAX_SIGNATURE_ENTRIES) return false;

    // 항목마다 같은 비교를 끝까지 돈다 — 몇 번째 항목이 맞았는지가 시간으로 드러나지 않게
    let matched = false;
    for (const entry of entries) {
      if (signatureMatches(entry, expected)) matched = true;
    }
    return matched;
  }

  private isTimestampFresh(timestamp: string, now: Temporal.Instant): boolean {
    if (!TIMESTAMP_PATTERN.test(timestamp)) return false;
    const sentAtSeconds = Number(timestamp);
    const nowSeconds = Math.floor(now.epochMilliseconds / 1000);
    return Math.abs(nowSeconds - sentAtSeconds) <= this.toleranceSeconds;
  }
}

/** `v1,<base64>` 항목 하나를 기대값과 상수 시간으로 비교한다 */
function signatureMatches(entry: string, expected: Buffer): boolean {
  const comma = entry.indexOf(",");
  if (comma < 0 || entry.slice(0, comma) !== SIGNATURE_VERSION) return false;
  const encoded = entry.slice(comma + 1);
  if (!BASE64_PATTERN.test(encoded)) return false;
  const provided = Buffer.from(encoded, "base64");
  // 길이가 다르면 timingSafeEqual 이 예외를 던진다 — 먼저 거부한다
  if (provided.length !== HMAC_SHA256_BYTES || provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export interface SignWebhookInput {
  secret: string;
  webhookId: string;
  /** 유닉스 초 */
  timestampSeconds: number;
  rawBody: string;
}

/**
 * 가짜 PG 가 보낼 웹훅 헤더 3개를 만든다. dev 경로(`/api/dev/fake-pg/**`, 계약 03 §7)와 테스트가 쓴다.
 * 돌려주는 값에 서명이 들어 있으니 로그에 남기지 않는다.
 */
export function signWebhook(input: SignWebhookInput): Record<string, string> {
  if (!Number.isSafeInteger(input.timestampSeconds) || input.timestampSeconds < 0) {
    throw new Error("웹훅 timestamp 는 0 이상의 정수(초)여야 합니다.");
  }
  const key = secretToKey(input.secret);
  if (key.length === 0) throw new Error("웹훅 비밀값이 비어 있습니다.");
  const timestamp = String(input.timestampSeconds);
  const signature = computeSignature(key, input.webhookId, timestamp, input.rawBody).toString("base64");
  return {
    [WEBHOOK_ID_HEADER]: input.webhookId,
    [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
    [WEBHOOK_SIGNATURE_HEADER]: `${SIGNATURE_VERSION},${signature}`,
  };
}
