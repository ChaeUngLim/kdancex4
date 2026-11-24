// S6-3.9(강사 승급 제안 받기·거절 API) — 회원이 강사가 올려 준 레벨 안내에 답한다(계약 14 §5, 보드 M25B).
//   POST /api/me/level-offers/{offerId}/accept   「이 레벨로 승급하기」 → 레벨이 오르고 카드 한 장이 발급된다
//   POST /api/me/level-offers/{offerId}/decline  「지금 레벨에서 내가 키우기」 → 레벨·카드 변화 없음
//   요구: spec FR-169d(강사 레벨 등급 조절 — 회원이 승급을 골라야 오른다) · FR-169e(강사 승급만 「받을지」 묻는다)
//   설계: _workspace/03_data-model.md §11-4(level_offers · level_promotions · level_cards · member_genre_levels)
//
// 제안 목록은 따로 경로를 두지 않는다 — `GET /api/me/levels` 의 `pendingOffers`(S6-3.4, me-levels.ts)가 그 목록이다.
//
// 흐름 한눈에(두 경로 공통):
//   ① 회원 로그인 확인 → ② 제안을 잠그고 읽기(없으면 404) → ③ 내 제안인가(아니면 403 FORBIDDEN)
//   → ④ 아직 열린 제안인가(offered 가 아니면 409 OFFER_NOT_PENDING, reason 에 지금 상태)
//   → ⑤ accept: 레벨 조건부 올리기(지금 레벨 < 제안 레벨일 때만) → 올랐으면 승급 기록 + 카드 + 알림 level_up
//      decline: 아무것도 바꾸지 않는다
//   → ⑥ 제안 닫기(accepted·declined + 답한 시각) + 감사 기록 → 커밋 뒤 알림 발송
//
// 왜 같은 제안에 두 번째 답은 409 인가: 한 번 답한 제안은 닫힌 것이라, 다시 눌러도 레벨·카드가 또 생기면 안 된다.
//   409 본문의 reason(accepted·declined·superseded)으로 앱이 「이미 받았어요」 같은 안내를 고를 수 있다(추천안 — 증거 EVIDENCE.md).
// 지키는 것: 회원 응답·알림에 강사 평가 레벨은 없다(S6-3 수용 ③). 「강사 쪽에 평가 레벨이 남는다」는 말도 쓰지 않는다(2026-10-15 결정).
import { z } from "zod";

import { LEVEL_MAX, LEVEL_MIN, type LevelDetailGenre } from "../../domain/constants";
import { levelStageLabel } from "../../domain/level-evaluation";
import { systemClock, type Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";
import type { NotificationSenderPort } from "../ports/notification-sender";
import type { Db } from "../../../prisma/db";
import { LEVEL_UP_KIND, levelUpBody } from "./level-evaluation-job";

/** 트랜잭션 안에서 쓰는 쿼리 손잡이 */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Params = { params: Promise<Record<string, string>> };

/** 열린 제안이 아닐 때의 409 코드 — 계약 14 §5 */
export const OFFER_NOT_PENDING = "OFFER_NOT_PENDING";
/** 감사 action — 회원이 답한 것(누가·언제). 보낸 것(level.offer_sent)과 짝이다 */
export const LEVEL_OFFER_ACCEPTED_AUDIT_ACTION = "level.offer_accepted";
export const LEVEL_OFFER_DECLINED_AUDIT_ACTION = "level.offer_declined";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

const DETAIL = {
  notFound: "레벨 안내를 찾을 수 없어요",
  forbidden: "내 레벨 안내만 고를 수 있어요",
  notPending: "이미 답했거나 닫힌 안내예요",
} as const;

export type MeLevelOfferDeps = GuardDeps & {
  readonly clock?: Clock;
  /** 없으면 알림함 행만 남긴다(발송은 재시도 작업이 받는다) */
  readonly notificationSender?: NotificationSenderPort;
};

// ---- 응답 계약(14 §5) — strict: 평가 레벨 같은 칸이 섞이면 parse 가 실패한다 -------------------------

const level = z.number().int().min(LEVEL_MIN).max(LEVEL_MAX);

/** accept 200 — card 는 실제로 레벨이 올랐을 때만 있다(이미 더 높았으면 null — 제안만 닫는다) */
export const levelOfferAcceptResponseSchema = z.strictObject({
  level,
  card: z.strictObject({ cardId: z.uuid(), level }).nullable(),
});
export type LevelOfferAcceptResponse = z.infer<typeof levelOfferAcceptResponseSchema>;

/** decline 200 — 지금 레벨(그대로) */
export const levelOfferDeclineResponseSchema = z.strictObject({ level });
export type LevelOfferDeclineResponse = z.infer<typeof levelOfferDeclineResponseSchema>;

// level_up 알림 payload — 레벨 계산 작업(S6-3.3)과 같은 모양, reason 만 instructor_offer. 평가 레벨 칸은 없다
export const levelUpFromOfferPayloadSchema = z.strictObject({
  title: z.string(),
  body: z.string(),
  detailGenre: z.string(),
  level,
  stageLabel: z.string(),
  cardId: z.uuid(),
  offerId: z.uuid(),
  reason: z.literal("instructor_offer"),
});

// ---- 경로 -------------------------------------------------------------------------------

export function createMeLevelOfferRoutes(deps: MeLevelOfferDeps) {
  const guards = createGuards(deps);
  const clock: Clock = () => (deps.clock ?? systemClock)();

  const accept = withRoute<Params>(async (request, context) => {
    const { memberId } = await guards.requireMember(request);
    const offerId = await readOfferId(context);
    const now = clock();
    const outcome = await deps.db.transaction(async (tx) => {
      const offer = await lockMyOpenOffer(tx, memberId, offerId);
      return acceptOffer(tx, memberId, offer, now);
    });
    await deliver(deps, outcome.notificationId);
    return Response.json(levelOfferAcceptResponseSchema.parse(outcome.body), { headers: NO_STORE });
  });

  const decline = withRoute<Params>(async (request, context) => {
    const { memberId } = await guards.requireMember(request);
    const offerId = await readOfferId(context);
    const now = clock();
    const body = await deps.db.transaction(async (tx) => {
      const offer = await lockMyOpenOffer(tx, memberId, offerId);
      return declineOffer(tx, memberId, offer, now);
    });
    return Response.json(levelOfferDeclineResponseSchema.parse(body), { headers: NO_STORE });
  });

  return { accept, decline };
}

/** 주소의 offerId — uuid 모양이 아니면 「없는 안내」와 같게 404 */
async function readOfferId(context: Params): Promise<string> {
  const parsed = z.object({ offerId: z.uuid() }).safeParse(await context.params);
  if (!parsed.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  return parsed.data.offerId;
}

// ---- ②③④ 제안 잠그고 확인 --------------------------------------------------------------------

type OpenOffer = {
  id: string;
  detailGenre: LevelDetailGenre;
  toLevel: number;
  offeringId: string | null;
  academyId: string | null;
};

/**
 * 제안 한 줄을 잠그고(FOR UPDATE) 내 것인지·열린 것인지 본다.
 * 잠금이 있어서 같은 제안에 두 요청이 동시에 와도 하나만 offered 를 보고, 다른 하나는 409 가 된다.
 * 확인 순서 = 없음 404 → 남의 것 403 → 닫힘 409. 남의 제안이면 상태(답했는지)조차 알려 주지 않는다.
 */
async function lockMyOpenOffer(tx: Tx, memberId: string, offerId: string): Promise<OpenOffer> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT lo.id::text AS id, lo.member_id::text AS member_id, lo.status::text AS status,
                      lo.detail_genre::text AS detail_genre, lo.to_level,
                      lo.offering_id::text AS offering_id, c.academy_id::text AS academy_id
                 FROM level_offers lo
                 LEFT JOIN class_offerings o ON o.id = lo.offering_id
                 LEFT JOIN classes c ON c.id = o.class_id
                WHERE lo.id = ${offerId}::uuid
                FOR UPDATE OF lo`
      .returnsRow({
        id: "pg/text@1",
        member_id: "pg/text@1",
        status: "pg/text@1",
        detail_genre: "pg/text@1",
        to_level: "pg/int4@1",
        offering_id: "pg/text@1",
        academy_id: "pg/text@1",
      })
      .build(),
  );
  if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  if (row.member_id !== memberId) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
  if (row.status !== "offered") throw HttpError.conflict(OFFER_NOT_PENDING, DETAIL.notPending, { reason: row.status });
  return {
    id: row.id,
    detailGenre: row.detail_genre as LevelDetailGenre,
    toLevel: row.to_level,
    offeringId: row.offering_id ?? null,
    academyId: row.academy_id ?? null,
  };
}

// ---- ⑤⑥ accept ------------------------------------------------------------------------------

type AcceptOutcome = { body: LevelOfferAcceptResponse; notificationId: string | null };

/**
 * 「이 레벨로 승급하기」. 한 트랜잭션에서:
 *   레벨 조건부 올리기 → (올랐으면) 승급 기록 · 카드 · 알림 → 제안 accepted → 감사.
 * 그 사이 완주 레벨업으로 이미 제안 레벨 이상이 됐으면 레벨은 그대로, 카드도 없이 제안만 닫는다(계약 14 §5).
 */
async function acceptOffer(tx: Tx, memberId: string, offer: OpenOffer, now: Temporal.Instant): Promise<AcceptOutcome> {
  const nowText = now.toString();
  // 조건부 올리기 — 지금 레벨 < 제안 레벨일 때만 바뀐다. 행이 없으면(레벨 0) 새로 넣는다.
  // RETURNING old.level(PostgreSQL 18) 로 「바로 전 레벨」을 같은 문장에서 받는다 — 따로 읽고 쓰면 그 사이에 다른 쓰기가 끼어들 수 있어서다.
  const [raised] = await tx.query(
    tx.raw.sql`INSERT INTO member_genre_levels (member_id, detail_genre, level, updated_at)
               VALUES (${memberId}::uuid, ${offer.detailGenre}, ${offer.toLevel}, ${nowText}::timestamptz)
               ON CONFLICT (member_id, detail_genre) DO UPDATE
                  SET level = EXCLUDED.level, updated_at = EXCLUDED.updated_at
                WHERE member_genre_levels.level < EXCLUDED.level
               RETURNING COALESCE(old.level, 0) AS from_level`
      .returnsRow({ from_level: "pg/int4@1" })
      .build(),
  );

  let card: { cardId: string; level: number } | null = null;
  let notificationId: string | null = null;
  if (raised !== undefined) {
    // 승급 기록(강사 제안 — 몇 칸이든 제안 레벨까지. 완주처럼 1칸 제한은 없다)
    const [promotion] = await tx.query(
      tx.raw.sql`INSERT INTO level_promotions (id, member_id, detail_genre, from_level, to_level, source, offering_id, offer_id, created_at)
                 VALUES (uuidv7(), ${memberId}::uuid, ${offer.detailGenre}, ${raised.from_level}, ${offer.toLevel},
                         'instructor_offer', NULLIF(${offer.offeringId ?? ""}, '')::uuid, ${offer.id}::uuid, ${nowText}::timestamptz)
                 RETURNING id::text AS id`
        .returnsRow({ id: "pg/text@1" })
        .build(),
    );
    if (promotion === undefined) throw new Error("승급 기록을 쓰지 못했다");
    // 카드 한 장 — 연출(M25C)을 아직 안 봤으니 revealed_at 은 비워 둔다. 앱이 연출 뒤 reveal 을 부른다
    const [issued] = await tx.query(
      tx.raw.sql`INSERT INTO level_cards (id, member_id, detail_genre, level, promotion_id, created_at)
                 VALUES (uuidv7(), ${memberId}::uuid, ${offer.detailGenre}, ${offer.toLevel}, ${promotion.id}::uuid, ${nowText}::timestamptz)
                 RETURNING id::text AS id`
        .returnsRow({ id: "pg/text@1" })
        .build(),
    );
    if (issued === undefined) throw new Error("카드를 쓰지 못했다");
    card = { cardId: issued.id, level: offer.toLevel };
    notificationId = await insertLevelUpNotification(tx, memberId, offer, issued.id, nowText);
  }

  await closeOffer(tx, offer.id, "accepted", nowText);
  const currentLevel = raised !== undefined ? offer.toLevel : await readLevel(tx, memberId, offer.detailGenre);
  await auditResponse(tx, memberId, offer, LEVEL_OFFER_ACCEPTED_AUDIT_ACTION, nowText, {
    detailGenre: offer.detailGenre,
    toLevel: offer.toLevel,
    level: currentLevel,
    cardIssued: card !== null,
  });
  return { body: { level: currentLevel, card }, notificationId };
}

/** level_up 알림 — 본문은 「살사 Lv.4 (초중급) 카드를 받았어요」(레벨 계산 작업과 같은 문장). 강사 평가 레벨은 싣지 않는다 */
async function insertLevelUpNotification(tx: Tx, memberId: string, offer: OpenOffer, cardId: string, nowText: string): Promise<string | null> {
  const payload = levelUpFromOfferPayloadSchema.parse({
    title: "레벨이 올랐어요",
    body: levelUpBody(offer.detailGenre, offer.toLevel),
    detailGenre: offer.detailGenre,
    level: offer.toLevel,
    stageLabel: levelStageLabel(offer.toLevel),
    cardId,
    offerId: offer.id,
    reason: "instructor_offer",
  });
  const [notification] = await tx.query(
    tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, dedupe_key, payload, created_at)
               VALUES (uuidv7(), ${memberId}::uuid, NULLIF(${offer.academyId ?? ""}, '')::uuid, ${LEVEL_UP_KIND},
                       ${`level-card:${cardId}:issued`}, ${JSON.stringify(payload)}::jsonb, ${nowText}::timestamptz)
               ON CONFLICT DO NOTHING
               RETURNING id::text AS id`
      .returnsRow({ id: "pg/text@1" })
      .build(),
  );
  return notification?.id ?? null;
}

// ---- ⑥ decline -------------------------------------------------------------------------------

/** 「지금 레벨에서 내가 키우기」 — 레벨·카드는 건드리지 않고 제안만 닫는다 */
async function declineOffer(tx: Tx, memberId: string, offer: OpenOffer, now: Temporal.Instant): Promise<LevelOfferDeclineResponse> {
  const nowText = now.toString();
  await closeOffer(tx, offer.id, "declined", nowText);
  const currentLevel = await readLevel(tx, memberId, offer.detailGenre);
  await auditResponse(tx, memberId, offer, LEVEL_OFFER_DECLINED_AUDIT_ACTION, nowText, {
    detailGenre: offer.detailGenre,
    toLevel: offer.toLevel,
    level: currentLevel,
  });
  return { level: currentLevel };
}

// ---- 공통 쓰기 ------------------------------------------------------------------------------

/** 제안 닫기 — 잠근 뒤라 offered 가 맞다. 답한 시각을 찍는다(ck_level_offers_responded) */
async function closeOffer(tx: Tx, offerId: string, status: "accepted" | "declined", nowText: string): Promise<void> {
  const closed = await tx.execute(
    tx.raw.sql`UPDATE level_offers SET status = ${status}, responded_at = ${nowText}::timestamptz, updated_at = ${nowText}::timestamptz
                WHERE id = ${offerId}::uuid AND status = 'offered'`
      .affectedCount()
      .build(),
  );
  if (closed.affectedRows !== 1) throw new Error("제안을 닫지 못했다");
}

/** 지금 레벨 — 기록이 없으면 0(S6-3.2 「행이 없으면 0」) */
async function readLevel(tx: Tx, memberId: string, detailGenre: LevelDetailGenre): Promise<number> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT level FROM member_genre_levels WHERE member_id = ${memberId}::uuid AND detail_genre = ${detailGenre}`
      .returnsRow({ level: "pg/int4@1" })
      .build(),
  );
  return row?.level ?? 0;
}

/** 감사 — 회원 행위, 대상 level_offers. before 는 열린 상태, after 는 고른 결과 */
async function auditResponse(
  tx: Tx,
  memberId: string,
  offer: OpenOffer,
  action: string,
  nowText: string,
  after: Record<string, unknown>,
): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, occurred_at, actor_kind, actor_member_id, academy_id, action, target_table, target_id, before, after)
               VALUES (uuidv7(), ${nowText}::timestamptz, 'member', ${memberId}::uuid, NULLIF(${offer.academyId ?? ""}, '')::uuid,
                       ${action}, 'level_offers', ${offer.id}::uuid,
                       ${JSON.stringify({ status: "offered" })}::json, ${JSON.stringify(after)}::json)`
      .affectedCount()
      .build(),
  );
}

/** 커밋 뒤 발송 — 실패해도 알림함 행은 남고 재시도 작업(S7-1.6)이 다시 보낸다. 승급 결과를 되돌리지 않는다 */
async function deliver(deps: MeLevelOfferDeps, notificationId: string | null): Promise<void> {
  if (notificationId === null || deps.notificationSender === undefined) return;
  await deps.notificationSender.deliver([notificationId]).catch((error: unknown) => {
    console.warn("[me-level-offers] 알림 발송 실패 — 알림함 행은 그대로", error);
  });
}
