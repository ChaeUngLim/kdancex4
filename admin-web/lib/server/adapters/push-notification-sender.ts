// S7-1.5(발송 포트 실구현) — NotificationSenderPort(공유 계약 §4.10)의 실제 푸시 구현.
//   계약: _workspace/03_contracts/15-ops.md §1-2(푸시 토큰) · §1-4(발송 판정) · §1-5 수용 ②
//   경로: S7-1.1(SP-4 푸시 경로 조사)이 고른 Expo 푸시 서비스 형식 — 아래층 PushGatewayPort 로 보낸다
//
// 흐름 한눈에 — 업무 트랜잭션이 커밋된 **뒤** 알림 행 id 목록을 받아:
//   ① 아직 `pending` 인 행만 읽고, 받는 사람(회원 또는 직원)의 살아 있는 토큰 가운데 권한이 `granted` 인 것만 모은다
//   ② 보낼 기기가 하나도 없으면(권한 거절 기기뿐이거나 토큰이 없음) `skipped` 로 바꾸고 **발송을 시도하지 않는다**
//      — 알림함 행은 그대로 남는다(수용 ②: 「알림함에는 행이 있고 발송 시도 0」)
//   ③ 나머지는 조건부 갱신(`pending` → `sending`, attempt_count + 1)으로 먼저 **선점**한다. 같은 id 로 두 번 불러도 한 번만 보낸다
//   ④ 선점한 행마다 기기 토큰 수만큼 메시지를 만들어 한 번에 보낸다
//   ⑤ 결과: 한 기기라도 받았으면 `sent`(+ delivered_at) · 모든 기기가 「등록 안 된 기기」면 토큰을 닫고 `skipped`
//      · 보내지 못했으면 `retry_wait`(1분·5분 뒤 다시) — 세 번째도 실패면 `failed`(S7-1.6(발송 재시도 작업))
//   재시도는 retryDue() 가 한다 — 내부 작업 `POST /api/internal/jobs/notifications/retry` 가 부른다
//
// 문자(SMS)는 쓰지 않는다(로드맵 S7-1.5 method). 광고성(`marketing`) 행은 밤 지연·동의 판정이 필요해 여기서 보내지 않고
// `pending` 으로 남긴다 — 그 판정은 발송 작업(`/api/internal/jobs/notifications/dispatch`)이 한다(계약 §1-4 ②③).
import { NOTIFICATION_KIND_CLASS } from "../../domain/notification-kinds";
import { decideAfterFailure, STALE_SENDING_AFTER } from "../../domain/notification-retry";
import type { NotificationKind } from "../../domain/constants";
import type { Clock } from "../../domain/time";
import type { Db } from "../../../prisma/db";
import type { NotificationRetryPort } from "../ports/notification-retry";
import type { NotificationSenderPort } from "../ports/notification-sender";
import type { PushGatewayPort, PushMessage, PushOutcome } from "../ports/push-gateway";
import { revokeInvalidPushTokens } from "../services/push-tokens";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 푸시 제목·본문이 비었을 때 쓰는 말. 자세한 내용은 앱 알림함에서 본다 */
const FALLBACK_TITLE = "새 알림";
const FALLBACK_BODY = "앱에서 자세히 확인해 주세요";

export type PushNotificationSenderDeps = {
  readonly db: Db;
  readonly pushGateway: PushGatewayPort;
  readonly clock: Clock;
};

/** 한 번 deliver 한 결과 건수 — 테스트와 로그가 본다(포트 자체는 void) */
export type DeliveryReport = {
  /** 한 기기 이상에 보냈다 */
  readonly sent: number;
  /** 보낼 기기가 없었다(권한 거절·토큰 없음·모든 토큰 무효) — 알림함에만 남는다 */
  readonly skipped: number;
  /** 보내지 못했다 — 3번 안쪽이면 retry_wait(다시 보냄), 3번째면 failed(S7-1.6) */
  readonly failed: number;
  /** 광고성이라 이번에 보내지 않고 남겨 둔 행 */
  readonly leftForDispatch: number;
  /** 푸시 서비스에 실제로 넘긴 메시지 수(= 발송 시도 수) */
  readonly attempts: number;
};

/** retryDue 한 번의 결과 — 계약 15 §1-4 retry 응답 `{ retried, failed }` 의 원본(sent 는 로그·테스트용) */
export type RetryReport = {
  /** 이번에 다시 보내려고 선점한 행 수 */
  readonly retried: number;
  /** 그중 이번에 받은 행 수 */
  readonly sent: number;
  /** 이번 실행에서 끝내 `failed` 가 된 행 수(오래 멈춘 sending 정리분 포함) */
  readonly failed: number;
};

/** 재시도 작업이 한 번에 집는 행 수 기본값(계약 dispatch 의 limit 200 과 맞춤) */
export const DEFAULT_RETRY_LIMIT = 200;

type CandidateRow = { id: string; kind: string; payload: string; tokens: string };
type Candidate = { id: string; kind: string; payload: Record<string, unknown>; tokens: string[] };
type SettleResult = DeliveryReportCore & { readonly finalFailed: number; readonly claimed: number };
type DeliveryReportCore = Omit<DeliveryReport, "leftForDispatch">;

/** 결과가 비어 온 메시지 — 실패로 친다(보낸 순서와 같다는 포트 약속이 깨진 경우) */
const MISSING_OUTCOME: PushOutcome = { to: "", status: "error", code: "missing_outcome", retryable: true };

function parseCandidates(rows: readonly CandidateRow[]): Candidate[] {
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    tokens: JSON.parse(row.tokens) as string[],
  }));
}

/** 한 행의 실패 이유 하나 — 기기 결과 중 첫 오류 코드(예: http_503). 없으면 unknown. 토큰 값은 담지 않는다 */
function errorCodeOf(outcomes: readonly PushOutcome[]): string {
  const error = outcomes.find((outcome) => outcome.status === "error");
  return error !== undefined && error.status === "error" ? error.code.slice(0, 64) : "unknown";
}

/** payload 에서 글자 칸 하나를 꺼낸다. 비었거나 글자가 아니면 null */
function text(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** 원 단위 금액 — 「12,000원」 */
function won(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("ko-KR")}원` : null;
}

/**
 * 알림 행 → 휴대폰에 뜰 제목·본문(순수 함수).
 * 앱 알림함 줄(mobile/lib/me/notifications-view.ts)과 같은 규칙으로 만든다 — 휴대폰 알림과 알림함 글이 어긋나지 않게.
 * 계좌번호 같은 값은 애초에 payload 에 없다(쓰는 쪽 계약). 여기서도 정해 둔 칸만 읽는다.
 */
export function pushTextOf(kind: string, payload: Readonly<Record<string, unknown>>): { title: string; body: string } {
  if (kind === "payment_confirmed_member") {
    return {
      title: `결제 완료 · ${text(payload, "title") ?? text(payload, "offeringTitle") ?? "수업"}`,
      body: won(payload, "amount") ?? FALLBACK_BODY,
    };
  }
  if (kind === "payment_deadline_soon") {
    return {
      title: text(payload, "title") ?? "입금 기한이 곧 끝나요",
      body: [text(payload, "offeringTitle"), won(payload, "amount")].filter(Boolean).join(" · ") || FALLBACK_BODY,
    };
  }
  return {
    title: text(payload, "title") ?? text(payload, "offeringTitle") ?? FALLBACK_TITLE,
    body: text(payload, "body") ?? text(payload, "classTitle") ?? FALLBACK_BODY,
  };
}

/** kind 가 광고성인가. 표에 없는 값(DB 에서 글자로 읽힘)은 광고성으로 보지 않는다 — 거래 알림을 놓치지 않게 */
function isMarketingKind(kind: string): boolean {
  return NOTIFICATION_KIND_CLASS[kind as NotificationKind] === "marketing";
}

/** uuid 배열을 postgres 배열 글자 `{a,b}` 로. 모양이 틀린 id 는 미리 빼서 SQL 형 변환 오류를 막는다 */
function uuidArray(ids: readonly string[]): string {
  return `{${ids.filter((id) => UUID_PATTERN.test(id)).join(",")}}`;
}

export class PushNotificationSender implements NotificationSenderPort, NotificationRetryPort {
  readonly #deps: PushNotificationSenderDeps;

  constructor(deps: PushNotificationSenderDeps) {
    this.#deps = deps;
  }

  async deliver(notificationIds: readonly string[]): Promise<void> {
    await this.deliverWithReport(notificationIds);
  }

  /** deliver 와 같고 건수를 돌려준다 */
  async deliverWithReport(notificationIds: readonly string[]): Promise<DeliveryReport> {
    const empty: DeliveryReport = { sent: 0, skipped: 0, failed: 0, leftForDispatch: 0, attempts: 0 };
    const idArray = uuidArray(notificationIds);
    if (idArray === "{}") return empty;
    const { db } = this.#deps;

    // ① 아직 안 보낸 행 + 받는 사람의 「보내도 되는」 토큰. 권한 거절(denied)·모름(unknown)·닫힌 토큰은 빠진다.
    //    회원·직원 중 한쪽만 차 있으므로(ck_notifications_one_recipient) OR 한쪽만 맞는다
    const rows = await db.query(
      db.raw.sql`SELECT n.id, n.kind, n.payload::text AS payload, COALESCE((SELECT jsonb_agg(t.token ORDER BY t.last_seen_at DESC, t.id)
                                  FROM push_tokens t
                                  WHERE t.revoked_at IS NULL
                                    AND t.permission_state = 'granted'
                                    AND (t.member_id = n.recipient_member_id OR t.staff_account_id = n.recipient_staff_account_id)),
                                 '[]'::jsonb)::text AS tokens
                 FROM notifications n
                 WHERE n.id = ANY(${idArray}::uuid[]) AND n.delivery_status = 'pending'
                 ORDER BY n.created_at, n.id`
        .returnsRow({ id: "pg/uuid@1", kind: "pg/text@1", payload: "pg/text@1", tokens: "pg/text@1" })
        .build(),
    );

    const candidates = parseCandidates(rows as readonly CandidateRow[]);
    const marketing = candidates.filter((row) => isMarketingKind(row.kind));
    const pushable = candidates.filter((row) => !isMarketingKind(row.kind));

    const { sent, skipped, failed, attempts } = await this.#claimSendSettle(pushable, "pending");
    return { sent, skipped, failed, attempts, leftForDispatch: marketing.length };
  }

  /**
   * S7-1.6(발송 재시도 작업) — 기다림이 끝난 `retry_wait` 행을 다시 보낸다(계약 15 §1-4 retry · 수용 ④).
   *   ⓐ 선점한 채 오래 멈춘 `sending` 행(발송 중 서버가 꺼진 경우)은 실패 1번으로 센다 — 안 그러면 영영 sending 에 갇힌다
   *   ⓑ `next_attempt_at <= 지금` 인 행을 오래 기다린 순으로 limit 개 골라, deliver 와 같은 길(선점 → 보내기 → 정리)로 보낸다
   *   ⓒ 세 번째 시도도 실패하면 `failed` + `delivery_error_code`. 알림함 행은 지우지 않는다
   * 같은 작업이 겹쳐 돌아도 선점(조건부 갱신)에서 한쪽만 이긴다.
   */
  async retryDue(limit: number = DEFAULT_RETRY_LIMIT): Promise<RetryReport> {
    const { db, clock } = this.#deps;
    const now = clock();
    const staleFailed = await this.#settleStaleSending(now);

    const rows = await db.query(
      db.raw.sql`SELECT n.id, n.kind, n.payload::text AS payload, COALESCE((SELECT jsonb_agg(t.token ORDER BY t.last_seen_at DESC, t.id)
                                  FROM push_tokens t
                                  WHERE t.revoked_at IS NULL
                                    AND t.permission_state = 'granted'
                                    AND (t.member_id = n.recipient_member_id OR t.staff_account_id = n.recipient_staff_account_id)),
                                 '[]'::jsonb)::text AS tokens
                 FROM notifications n
                 WHERE n.delivery_status = 'retry_wait' AND n.next_attempt_at <= ${now.toString()}::timestamptz
                 ORDER BY n.next_attempt_at, n.id
                 LIMIT ${Math.max(1, Math.trunc(limit))}`
        .returnsRow({ id: "pg/uuid@1", kind: "pg/text@1", payload: "pg/text@1", tokens: "pg/text@1" })
        .build(),
    );
    const result = await this.#claimSendSettle(parseCandidates(rows as readonly CandidateRow[]), "retry_wait");
    return { retried: result.claimed, sent: result.sent, failed: result.finalFailed + staleFailed };
  }

  /**
   * 공통 길 — from 상태(pending·retry_wait)의 행을:
   *   ② 보낼 기기가 없으면 발송 시도 없이 skipped(수용 ②) ③ 나머지는 `sending` 으로 선점(attempt_count + 1)
   *   ④ 기기 수만큼 메시지를 보내고 ⑤ 결과대로 sent · skipped · retry_wait · failed 로 정리한다
   */
  async #claimSendSettle(rows: readonly Candidate[], from: "pending" | "retry_wait"): Promise<SettleResult> {
    const noDevice = rows.filter((row) => row.tokens.length === 0);
    const withDevice = rows.filter((row) => row.tokens.length > 0);
    const empty: SettleResult = { sent: 0, skipped: 0, failed: 0, finalFailed: 0, attempts: 0, claimed: 0 };

    // ② 보낼 기기가 없는 행 — 발송 시도 없이 skipped. 알림함 행은 지우지 않는다(수용 ②)
    const skippedNow = await this.#markSkipped(noDevice.map((row) => row.id), from);

    // ③ 선점 — from 상태인 것만 sending 으로 바꾸고, 바뀐 행만 보낸다(같은 id 를 두 번 불러도 한 번만 보낸다)
    const attemptsById = await this.#claim(withDevice.map((row) => row.id), from);
    const toSend = withDevice.filter((row) => attemptsById.has(row.id));
    if (toSend.length === 0) return { ...empty, skipped: skippedNow.length };

    // ④ 행 × 기기 토큰 만큼 메시지. 앱이 눌렀을 때 열 알림을 알 수 있게 id·kind 만 싣는다(개인정보 없음)
    const plan = toSend.flatMap((row) => {
      const { title, body } = pushTextOf(row.kind, row.payload);
      return row.tokens.map((token) => ({
        notificationId: row.id,
        message: { to: token, title, body, data: { notificationId: row.id, kind: row.kind } } satisfies PushMessage,
      }));
    });
    const outcomes = await this.#sendSafely(plan.map((item) => item.message));

    // ⑤ 결과 정리 — 등록 안 된 기기 토큰은 닫는다(revokeInvalidPushTokens, S7-1.1)
    const invalidTokens = outcomes.filter((outcome) => outcome.status === "invalid_token").map((outcome) => outcome.to);
    await revokeInvalidPushTokens(this.#deps.db, invalidTokens, this.#deps.clock);

    const outcomesOf = (id: string) => plan.flatMap((item, index) => (item.notificationId === id ? [outcomes[index] ?? MISSING_OUTCOME] : []));
    const delivered = toSend.filter((row) => outcomesOf(row.id).some((o) => o.status === "ok"));
    const allInvalid = toSend.filter((row) => outcomesOf(row.id).every((o) => o.status === "invalid_token"));
    const failed = toSend.filter((row) => !delivered.includes(row) && !allInvalid.includes(row));

    await this.#markSent(delivered.map((row) => row.id));
    // 모든 기기가 무효였던 행은 받을 기기가 없다 → skipped
    const skippedAfter = await this.#markSkipped(allInvalid.map((row) => row.id), "sending");
    // 보내지 못한 행 — 몇 번째 시도였는지로 「다시 기다림」과 「끝내 실패」를 가른다(S7-1.6)
    let finalFailed = 0;
    for (const row of failed) {
      const outcome = await this.#markFailedAttempt(row.id, attemptsById.get(row.id) ?? 1, errorCodeOf(outcomesOf(row.id)));
      if (outcome === "failed") finalFailed += 1;
    }

    return {
      sent: delivered.length,
      skipped: skippedNow.length + skippedAfter.length,
      failed: failed.length,
      finalFailed,
      attempts: plan.length,
      claimed: toSend.length,
    };
  }

  /** 푸시 서비스 부르기. 예상 못 한 예외(어댑터 버그 등)도 「보내지 못함」으로 바꿔 선점한 행이 sending 으로 굳지 않게 한다 */
  async #sendSafely(messages: readonly PushMessage[]): Promise<readonly PushOutcome[]> {
    try {
      const outcomes = await this.#deps.pushGateway.send(messages);
      // 결과 수가 모자라면 남은 것은 실패로 친다(보낸 순서와 같다는 포트 약속이 깨진 경우)
      return messages.map((message, index) => outcomes[index] ?? { ...MISSING_OUTCOME, to: message.to });
    } catch {
      return messages.map((message) => ({ to: message.to, status: "error" as const, code: "gateway_exception", retryable: true }));
    }
  }

  /** from 상태인 행만 sending 으로 선점하고 「이번이 몇 번째 시도인지」를 돌려준다(조건부 갱신 한 문장) */
  async #claim(ids: readonly string[], from: "pending" | "retry_wait"): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const { db, clock } = this.#deps;
    const claimed = await db.query(
      db.raw.sql`UPDATE notifications
                 SET delivery_status = 'sending', attempt_count = attempt_count + 1,
                     last_attempt_at = ${clock().toString()}::timestamptz, next_attempt_at = NULL
                 WHERE id = ANY(${uuidArray(ids)}::uuid[]) AND delivery_status = ${from}
                 RETURNING id, attempt_count`
        .returnsRow({ id: "pg/uuid@1", attempt_count: "pg/int4@1" })
        .build(),
    );
    return new Map((claimed as readonly { id: string; attempt_count: number }[]).map((row) => [row.id, row.attempt_count]));
  }

  async #markSent(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const { db, clock } = this.#deps;
    await db.query(
      db.raw.sql`UPDATE notifications
                 SET delivery_status = 'sent', delivered_at = ${clock().toString()}::timestamptz, delivery_error_code = NULL
                 WHERE id = ANY(${uuidArray(ids)}::uuid[]) AND delivery_status = 'sending'
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
  }

  /** from 상태인 행만 skipped 로 바꾸고 바뀐 id 를 돌려준다 */
  async #markSkipped(ids: readonly string[], from: "pending" | "retry_wait" | "sending"): Promise<string[]> {
    if (ids.length === 0) return [];
    const { db } = this.#deps;
    const changed = await db.query(
      db.raw.sql`UPDATE notifications SET delivery_status = 'skipped', next_attempt_at = NULL
                 WHERE id = ANY(${uuidArray(ids)}::uuid[]) AND delivery_status = ${from}
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    return (changed as readonly { id: string }[]).map((row) => row.id);
  }

  /**
   * sending 인 행 하나의 시도가 실패했다 → 3번 안쪽이면 retry_wait(+ 다음 시각), 3번째면 failed.
   * 판정은 순수 함수 decideAfterFailure(lib/domain/notification-retry.ts)가 한다. 이미 다른 상태면 건드리지 않는다
   */
  async #markFailedAttempt(id: string, attemptCount: number, code: string): Promise<"retry_wait" | "failed" | "untouched"> {
    const { db, clock } = this.#deps;
    const decision = decideAfterFailure(attemptCount, clock());
    const next = decision.kind === "retry" ? "retry_wait" : "failed";
    // 끝내 실패면 다음 시각이 없다 — 빈 글자를 NULLIF 로 NULL 로 바꾼다(raw SQL 자리에는 null 을 직접 못 넣는다)
    const nextAt = decision.kind === "retry" ? decision.nextAttemptAt.toString() : "";
    const changed = await db.query(
      db.raw.sql`UPDATE notifications
                 SET delivery_status = ${next}, next_attempt_at = NULLIF(${nextAt}, '')::timestamptz, delivery_error_code = ${code}
                 WHERE id = ${id}::uuid AND delivery_status = 'sending'
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    return (changed as readonly unknown[]).length > 0 ? next : "untouched";
  }

  /** 선점한 지 STALE_SENDING_AFTER 가 지나도록 sending 인 행 → 실패 1번(sending_timeout). 끝내 failed 가 된 수를 돌려준다 */
  async #settleStaleSending(now: Temporal.Instant): Promise<number> {
    const { db } = this.#deps;
    const cutoff = now.subtract(STALE_SENDING_AFTER).toString();
    const stale = await db.query(
      db.raw.sql`SELECT id, attempt_count FROM notifications
                 WHERE delivery_status = 'sending' AND last_attempt_at < ${cutoff}::timestamptz
                 ORDER BY last_attempt_at, id`
        .returnsRow({ id: "pg/uuid@1", attempt_count: "pg/int4@1" })
        .build(),
    );
    let failed = 0;
    for (const row of stale as readonly { id: string; attempt_count: number }[]) {
      if ((await this.#markFailedAttempt(row.id, row.attempt_count, "sending_timeout")) === "failed") failed += 1;
    }
    return failed;
  }
}

/** 어떤 발송기를 쓸지 — `expo`(실제 푸시) · `fake`(기록만). deps.ts 가 쓴다 */
export type PushDelivery = "expo" | "fake";

export const PUSH_DELIVERY_ENV = "PUSH_DELIVERY";

export class InvalidPushDeliveryError extends Error {
  constructor() {
    super(`${PUSH_DELIVERY_ENV} 는 expo · fake 중 하나여야 합니다(비우면 개발은 fake, 베타·운영은 expo).`);
    this.name = "InvalidPushDeliveryError";
  }
}

/**
 * 설정 PUSH_DELIVERY 를 읽는다. 비우면 개발 PC 는 가짜(기록만), 베타·운영은 실제 Expo 푸시다.
 * 왜 개발은 가짜가 기본인가: 개발 DB 의 시연 토큰은 가짜 값이라 실제 Expo 에 보내면 「등록 안 된 기기」로 토큰이 닫힌다.
 */
export function pushDeliveryOf(value: string | undefined, deployEnv: "development" | "beta" | "production"): PushDelivery {
  const raw = value?.trim() ?? "";
  if (raw === "") return deployEnv === "development" ? "fake" : "expo";
  if (raw === "expo" || raw === "fake") return raw;
  throw new InvalidPushDeliveryError();
}
