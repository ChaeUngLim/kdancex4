// S6-3.8(앱 회원 레벨 카드 화면) — `GET /api/me/level-cards?detailGenre=&cursor=`(계약 14 §5, 보드 M26 · C24A).
//   요구: spec FR-169f(카드 모음 화면) · FR-169c(레벨 성장 캐릭터) · FR-161(단계 이름)
//
// 회원이 받은 등급 카드를 모두 돌려준다. 카드 하나에 담는 것:
//   cardId · detailGenre · level · stageLabel(입문~댄서) · issuedAt · isFeatured(대표 캐릭터로 골랐나)
//   · characterKey(그림을 고르는 열쇠 「묶음/성별_단계」) · isCurrent(그 세부 장르의 지금 레벨 카드인가)
// isCurrent 는 계약에 없던 칸을 더한 것이다(추천안·사후 확인 2026-11-24) — 카드 모음의 「지금」 표시(M26)를
//   앱이 다른 응답과 맞춰 계산하지 않게 서버가 한 번에 정한다.
//
// 읽는 표는 「나」(member_id) 의 level_cards · member_genre_levels · members(성별·대표 카드) 뿐이다.
// 강사 평가 레벨·출석 숫자는 읽지도 싣지도 않는다(S6-3 수용 ③, 결정 D7). 응답은 strict 스키마로 검사하고 내보낸다.
//
// 순서: 세부 장르 이름 → 레벨 오름차순. 쪽 나누기는 (세부 장르, 레벨) 을 커서로 쓴다.
//   한 회원이 가질 수 있는 카드는 세부 장르 14 × 레벨 11 = 154장이 끝이라(같은 장르·레벨은 한 장), 기본 한 쪽(200)에 다 들어간다.
import { z } from "zod";

import { LEVEL_DETAIL_GENRES, LEVEL_MAX, LEVEL_MIN, type LevelDetailGenre } from "../../domain/constants";
import { levelCharacterKey } from "../../domain/level-card-art";
import { levelStageLabel } from "../../domain/level-evaluation";
import { createGuards, type GuardDeps } from "../guards";
import { parseWith, withRoute } from "../http";
import type { Db } from "../../../prisma/db";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const BAD_CURSOR = "목록 위치(cursor)가 올바르지 않아요. 처음부터 다시 불러 주세요";
const ISO_S_SQL = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

/** 한 쪽 카드 수 — 한 회원의 최대 카드 수(154)보다 크게 잡아 보통은 한 번에 다 온다 */
export const ME_LEVEL_CARDS_PAGE_SIZE = 200;

const level = z.number().int().min(LEVEL_MIN).max(LEVEL_MAX);
const detailGenre = z.enum(LEVEL_DETAIL_GENRES);

// ---- 커서: (세부 장르, 레벨) 을 JSON → base64url 로 싼다 ----------------------------------------------

const cursorSchema = z.strictObject({ g: detailGenre, l: level });
type Cursor = z.infer<typeof cursorSchema>;

export function encodeLevelCardCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeLevelCardCursor(value: string): Cursor | null {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---- 요청·응답 스키마 ------------------------------------------------------------------------------

export const meLevelCardsQuerySchema = z.strictObject({
  detailGenre: detailGenre.optional(),
  cursor: z
    .string()
    .max(200)
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") return undefined;
      const decoded = decodeLevelCardCursor(value);
      if (decoded === null) {
        ctx.addIssue({ code: "custom", message: BAD_CURSOR });
        return z.NEVER;
      }
      return decoded;
    }),
});

export const meLevelCardSchema = z.strictObject({
  cardId: z.uuid(),
  detailGenre,
  level,
  stageLabel: z.string(),
  issuedAt: z.iso.datetime({ offset: true }),
  isFeatured: z.boolean(),
  isCurrent: z.boolean(),
  characterKey: z.string().regex(/^(samba|viennese|tango|swing|salsa|bachata)\/[mf]_l(01|23|45|67|89|10)$/),
});
export const meLevelCardListSchema = z.strictObject({
  items: z.array(meLevelCardSchema),
  nextCursor: z.string().nullable(),
});
export type MeLevelCardList = z.infer<typeof meLevelCardListSchema>;

export function createMeLevelCardsRoute(deps: GuardDeps) {
  const guards = createGuards(deps);
  return withRoute<unknown>(async (request) => {
    // 순서: 인증(401·403) → 쿼리(422)
    const { memberId } = await guards.requireMember(request);
    const query = parseWith(meLevelCardsQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    const body = await readMeLevelCards(deps.db, memberId, query);
    return Response.json(meLevelCardListSchema.parse(body), { headers: NO_STORE });
  });
}

/** 내 카드 한 쪽. detailGenre 를 주면 그 세부 장르만 */
export async function readMeLevelCards(
  db: Db,
  memberId: string,
  query: { detailGenre?: LevelDetailGenre | undefined; cursor?: Cursor | undefined },
  pageSize = ME_LEVEL_CARDS_PAGE_SIZE,
): Promise<MeLevelCardList> {
  const genreFilter = query.detailGenre ?? "";
  // 커서가 없으면 빈 글자·-1 — 모든 (장르, 레벨) 이 그 뒤다
  const afterGenre = query.cursor?.g ?? "";
  const afterLevel = query.cursor?.l ?? -1;
  // 한 쪽 + 하나 더 읽어 다음 쪽이 있는지 안다.
  // 지금 레벨 카드 = 그 세부 장르의 member_genre_levels.level 과 같은 레벨의 카드
  const rows = await db.query(
    db.raw.sql`SELECT lc.id::text AS card_id, lc.detail_genre::text AS detail_genre, lc.level,
                      to_char(lc.created_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS issued_at,
                      (m.featured_level_card_id IS NOT DISTINCT FROM lc.id) AS is_featured,
                      (g.level IS NOT DISTINCT FROM lc.level) AS is_current,
                      m.gender::text AS gender
                 FROM level_cards lc
                 JOIN members m ON m.id = lc.member_id
                 LEFT JOIN member_genre_levels g ON g.member_id = lc.member_id AND g.detail_genre = lc.detail_genre
                WHERE lc.member_id = ${memberId}::uuid
                  AND (${genreFilter} = '' OR lc.detail_genre::text = ${genreFilter})
                  AND (lc.detail_genre::text, lc.level) > (${afterGenre}::text, ${afterLevel}::int)
                ORDER BY lc.detail_genre::text, lc.level
                LIMIT ${pageSize + 1}::int`
      .returnsRow({
        card_id: "pg/text@1",
        detail_genre: "pg/text@1",
        level: "pg/int4@1",
        issued_at: "pg/text@1",
        is_featured: "pg/bool@1",
        is_current: "pg/bool@1",
        gender: "pg/text@1",
      })
      .build(),
  );
  const page = rows.slice(0, pageSize);
  const last = page.at(-1);
  const nextCursor =
    rows.length > pageSize && last !== undefined
      ? encodeLevelCardCursor({ g: last.detail_genre as LevelDetailGenre, l: last.level })
      : null;
  return {
    items: page.map((r) => ({
      cardId: r.card_id,
      detailGenre: r.detail_genre as LevelDetailGenre,
      level: r.level,
      stageLabel: levelStageLabel(r.level),
      issuedAt: r.issued_at,
      isFeatured: r.is_featured,
      isCurrent: r.is_current,
      // 성별은 DB CHECK(enum male·female)가 지키는 값이다
      characterKey: levelCharacterKey(r.detail_genre as LevelDetailGenre, r.level, r.gender as "male" | "female"),
    })),
    nextCursor,
  };
}
