// S6-3.4(강사 레벨 조절과 평가 레벨 숨김) — `GET /api/me/levels`(계약 14 §5, 보드 M25 · M26 · C24A).
//   요구: spec FR-169(세부 장르별 레벨) · FR-161(단계 이름) · FR-169d(강사 레벨 조절) · S6-3 수용 ③(강사 평가 레벨은 회원 응답에 없다)
//
// 회원이 자기 레벨 화면에서 읽는 응답 하나다:
//   items         세부 장르마다 지금 레벨 · 단계 · 게이지(10칸)
//   pendingReveal 아직 연출을 보지 않은 카드(revealed_at 비어 있음) — 앱을 열면 등급 알림 → 카드 공개(M25 → M25C)
//   pendingOffers 강사가 올려 준 승급 안내(열린 것만) — 「○○ 강사님이 쌈바 레벨을 4(초중급)로 올려 줬어요」
//
// **강사 평가 레벨(instructor_level_evaluations)은 이 파일에서 읽지도 않는다.** 응답 스키마도 strict 라
// 평가 레벨 같은 칸이 섞이면 parse 가 실패한다. 강사가 내린 레벨은 회원에게 아무 흔적도 남기지 않는다(I23 · 2026-10-15 결정).
// 출석 횟수·%도 싣지 않는다(결정 D7).
// 하지 않는 것: 수강 기록이 없는 세부 장르의 「가입 경험 수준 매핑」 줄(source: profile)은 카드 화면 Task(S6-3.8)가 화면과 함께 정한다 —
//   지금은 기록이 있는 세부 장르만 내린다(추천안 — 증거 EVIDENCE.md).
import { z } from "zod";

import { LEVEL_DETAIL_GENRES, LEVEL_MAX, LEVEL_MIN, LEVEL_PROMOTION_SOURCES, type LevelDetailGenre, type LevelPromotionSource } from "../../domain/constants";
import { levelCharacterKey } from "../../domain/level-card-art";
import { levelStageLabel } from "../../domain/level-evaluation";
import { levelOfferMessage, levelStageCode } from "../../domain/level-offer";
import { createGuards, type GuardDeps } from "../guards";
import { withRoute } from "../http";
import type { Db } from "../../../prisma/db";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const ISO_S_SQL = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

const level = z.number().int().min(LEVEL_MIN).max(LEVEL_MAX);
const detailGenre = z.enum(LEVEL_DETAIL_GENRES);

// ---- 응답 계약(14 §5) — strict: 모르는 키(평가 레벨·출석 숫자)가 섞이면 parse 가 실패한다 --------------

export const meLevelsResponseSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      detailGenre,
      level,
      stage: z.enum(["entry", "beginner", "novice_intermediate", "intermediate", "advanced", "dancer"]),
      stageLabel: z.string(),
      gauge: z.strictObject({ filled: level, total: z.literal(LEVEL_MAX) }),
      // 수업 기록(완주·승급)으로 정해진 값 — 가입 경험 수준 매핑(profile)은 S6-3.8 이 더한다
      source: z.literal("record"),
    }),
  ),
  // S6-3.10(카드 공개 연출) 이 더한 칸(추천안·사후 확인 2026-11-24): fromLevel(「레벨 9 → 10」) · issuedAt(카드 발급일) ·
  //   characterKey(카드 그림 열쇠 — 카드 모음과 같은 규칙). 연출 한 번에 요청을 하나로 끝내려고 여기에 실었다
  pendingReveal: z.array(
    z.strictObject({
      cardId: z.uuid(),
      detailGenre,
      level,
      stageLabel: z.string(),
      reason: z.enum(LEVEL_PROMOTION_SOURCES),
      fromLevel: level,
      issuedAt: z.iso.datetime({ offset: true }),
      characterKey: z.string().regex(/^(samba|viennese|tango|swing|salsa|bachata)\/[mf]_l(01|23|45|67|89|10)$/),
    }),
  ),
  // instructorName — 카드 받기 선택(M25B) 문장 「오세린 강사님이 Salsa 레벨을 …」을 영어 세부 장르로 앱이 짓기 위해(S6-3.10 추천안)
  pendingOffers: z.array(
    z.strictObject({ offerId: z.uuid(), detailGenre, toLevel: level, toStageLabel: z.string(), message: z.string(), instructorName: z.string() }),
  ),
});
export type MeLevelsResponse = z.infer<typeof meLevelsResponseSchema>;

export function createMeLevelsRoute(deps: GuardDeps) {
  const guards = createGuards(deps);
  return withRoute<unknown>(async (request) => {
    const { memberId } = await guards.requireMember(request);
    const body = await readMeLevels(deps.db, memberId);
    // 계약 스키마로 한 번 더 검사하고 내보낸다 — 평가 레벨 같은 칸이 끼어들면 여기서 막힌다
    return Response.json(meLevelsResponseSchema.parse(body), { headers: NO_STORE });
  });
}

/** 내 레벨 · 안 본 카드 · 열린 승급 안내. 세 표 모두 「나」(member_id) 줄만 읽는다 */
export async function readMeLevels(db: Db, memberId: string): Promise<MeLevelsResponse> {
  const levels = await db.query(
    db.raw.sql`SELECT detail_genre::text AS detail_genre, level FROM member_genre_levels
                WHERE member_id = ${memberId}::uuid ORDER BY level DESC, detail_genre`
      .returnsRow({ detail_genre: "pg/text@1", level: "pg/int4@1" })
      .build(),
  );
  const cards = await db.query(
    db.raw.sql`SELECT lc.id::text AS card_id, lc.detail_genre::text AS detail_genre, lc.level, lp.source::text AS source,
                      lp.from_level, to_char(lc.created_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS issued_at, m.gender::text AS gender
                 FROM level_cards lc JOIN level_promotions lp ON lp.id = lc.promotion_id JOIN members m ON m.id = lc.member_id
                WHERE lc.member_id = ${memberId}::uuid AND lc.revealed_at IS NULL
                ORDER BY lc.created_at, lc.id`
      .returnsRow({
        card_id: "pg/text@1",
        detail_genre: "pg/text@1",
        level: "pg/int4@1",
        source: "pg/text@1",
        from_level: "pg/int4@1",
        issued_at: "pg/text@1",
        gender: "pg/text@1",
      })
      .build(),
  );
  // 안내 문구에 쓰는 강사 이름은 보여 주는 이름(display_name)뿐 — 강사의 평가 표는 잇지 않는다
  const offers = await db.query(
    db.raw.sql`SELECT lo.id::text AS offer_id, lo.detail_genre::text AS detail_genre, lo.to_level, st.display_name
                 FROM level_offers lo JOIN staff_accounts st ON st.id = lo.instructor_account_id
                WHERE lo.member_id = ${memberId}::uuid AND lo.status = 'offered'
                ORDER BY lo.offered_at DESC, lo.id`
      .returnsRow({ offer_id: "pg/text@1", detail_genre: "pg/text@1", to_level: "pg/int4@1", display_name: "pg/text@1" })
      .build(),
  );
  return {
    items: levels.map((r) => ({
      detailGenre: r.detail_genre as LevelDetailGenre,
      level: r.level,
      stage: levelStageCode(r.level),
      stageLabel: levelStageLabel(r.level),
      gauge: { filled: r.level, total: LEVEL_MAX },
      source: "record" as const,
    })),
    pendingReveal: cards.map((c) => ({
      cardId: c.card_id,
      detailGenre: c.detail_genre as LevelDetailGenre,
      level: c.level,
      stageLabel: levelStageLabel(c.level),
      reason: c.source as LevelPromotionSource,
      fromLevel: c.from_level,
      issuedAt: c.issued_at,
      // 성별은 DB CHECK(male·female)가 지키는 값 — 카드 모음(me-level-cards.ts)과 같은 열쇠 규칙
      characterKey: levelCharacterKey(c.detail_genre as LevelDetailGenre, c.level, c.gender as "male" | "female"),
    })),
    pendingOffers: offers.map((o) => ({
      offerId: o.offer_id,
      detailGenre: o.detail_genre as LevelDetailGenre,
      toLevel: o.to_level,
      toStageLabel: levelStageLabel(o.to_level),
      message: levelOfferMessage(o.display_name, o.detail_genre as LevelDetailGenre, o.to_level),
      instructorName: o.display_name,
    })),
  };
}
