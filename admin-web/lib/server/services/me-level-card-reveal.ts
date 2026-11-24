// S6-3.10(앱 등급 알림·카드 받기·카드 공개 연출) — `POST /api/me/level-cards/{cardId}/reveal`(계약 14 §5, 보드 M25 · M25C).
//   요구: spec FR-169e(등급 카드 발급 애니메이션 — 「앱을 열었을 때 받지 않은 카드가 있으면 연출을 보여 준다」)
//   설계: _workspace/03_data-model.md §11-4 level_cards.revealed_at(연출을 본 시각)
//
// 앱이 카드 공개 연출(M25C)을 끝까지 보여 준 뒤 부른다. 그 카드의 revealed_at 에 지금 시각을 적는다.
// 그러면 `GET /api/me/levels` 의 pendingReveal 에서 빠져서, 다음에 앱을 열어도 같은 연출이 또 뜨지 않는다.
//
// 흐름: ① 회원 로그인 확인 → ② 주소의 cardId(uuid 아니면 404) → ③ 「내 카드이고 아직 안 본 것」만 시각을 적는다
//   → ④ 바뀐 줄이 없으면 이유를 가린다: 내 카드인데 이미 봤다 = 200(같은 시각 그대로) · 남의 카드 403 · 없는 카드 404
//
// 왜 이미 봤어도 200 인가: 연출 끝에 네트워크가 끊겨 앱이 다시 부를 수 있다. 다시 불러도 결과(봤다)는 같으니
//   오류로 돌려줄 까닭이 없다(계약 14 §5 멱등 칸 「이미 봤으면 200」). 처음 본 시각은 덮어쓰지 않는다.
import { z } from "zod";

import { systemClock, type Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";

type Params = { params: Promise<Record<string, string>> };

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const ISO_S_SQL = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

const DETAIL = {
  notFound: "레벨 카드를 찾을 수 없어요",
  forbidden: "내 레벨 카드만 고를 수 있어요",
} as const;

export type MeLevelCardRevealDeps = GuardDeps & { readonly clock?: Clock };

/** 200 — 연출을 본 시각(처음 본 시각이 그대로 남는다) */
export const levelCardRevealResponseSchema = z.strictObject({
  cardId: z.uuid(),
  revealedAt: z.iso.datetime({ offset: true }),
});
export type LevelCardRevealResponse = z.infer<typeof levelCardRevealResponseSchema>;

export function createMeLevelCardRevealRoute(deps: MeLevelCardRevealDeps) {
  const guards = createGuards(deps);
  const clock: Clock = () => (deps.clock ?? systemClock)();

  return withRoute<Params>(async (request, context) => {
    const { memberId } = await guards.requireMember(request);
    const cardId = await readCardId(context);
    const nowText = clock().toString();

    // ③ 내 카드이고 revealed_at 이 비어 있을 때만 적는다 — 한 문장이라 두 번 동시에 불러도 처음 시각 하나만 남는다
    const [marked] = await deps.db.query(
      deps.db.raw.sql`UPDATE level_cards SET revealed_at = ${nowText}::timestamptz
                       WHERE id = ${cardId}::uuid AND member_id = ${memberId}::uuid AND revealed_at IS NULL
                   RETURNING to_char(revealed_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS revealed_at`
        .returnsRow({ revealed_at: "pg/text@1" })
        .build(),
    );
    if (marked !== undefined) {
      return Response.json(levelCardRevealResponseSchema.parse({ cardId, revealedAt: marked.revealed_at }), { headers: NO_STORE });
    }

    // ④ 바뀐 줄이 없다 — 이미 봤나, 남의 카드인가, 없는 카드인가
    const [card] = await deps.db.query(
      deps.db.raw.sql`SELECT member_id::text AS member_id,
                             to_char(revealed_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS revealed_at
                        FROM level_cards WHERE id = ${cardId}::uuid`
        .returnsRow({ member_id: "pg/text@1", revealed_at: "pg/text@1" })
        .build(),
    );
    if (card === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    // 남의 카드면 봤는지 여부조차 알려 주지 않는다
    if (card.member_id !== memberId) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    return Response.json(levelCardRevealResponseSchema.parse({ cardId, revealedAt: card.revealed_at }), { headers: NO_STORE });
  });
}

/** 주소의 cardId — uuid 모양이 아니면 「없는 카드」와 같게 404 */
async function readCardId(context: Params): Promise<string> {
  const parsed = z.object({ cardId: z.uuid() }).safeParse(await context.params);
  if (!parsed.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  return parsed.data.cardId;
}
