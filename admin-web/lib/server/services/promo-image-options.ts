// SX-6.9(앱 홍보 이미지·소개 문구 화면) — `GET /api/ai/promo-image/options?classId=…`(계약 16 §4-7 첫 경로).
//   앱의 「홍보 이미지 만들기」 화면(보드 I32B·I32C·I32·I42)이 처음 열릴 때 한 번 부른다. 쓰지 않는 읽기 경로다.
//
// 돌려주는 것:
//   genre · genreChip     수업에서 가져온 잠긴 장르 칩(문장에 들어갈 춤 이름 포함 — 앱이 문장을 채울 때 쓴다)
//   requiredChips         필수 4항목 칩 낱말(설정 promo-image-chips.json)
//   examples              완성 예시(설정 promo-image-examples.json, 이 수업 장르가 맨 앞)
//   autoConditions        「자동으로 더해지는 조건」 카드(설정 promo-image-conditions.json, 글자 없음은 끌 수 없음)
//   engines · preselectedEngineId   엔진 카드(켜진 엔진만)와 처음 골라 둘 엔진
//   usage                 오늘 남은 횟수 n/N · 다음 초기화 시각 · 켜진 엔진이 모두 막혔나
//   lastGeneration        이 사람이 이 수업에서 마지막으로 만든(만드는 중 포함) 이미지 — 화면을 다시 열어도 검토 단계로 이어 간다
//   maxSentenceLength     200
//
// 권한은 만들기 요청(POST /api/ai/promo-images)과 같다 — 그 수업을 고칠 수 있는 사람(올린 강사·위임 강사·그 학원 대표).
// 판정 함수도 만들기 요청과 같은 것을 써서(decidePromoFreeQuota·promoRemaining) 「카드는 된다는데 누르면 막히는」 일이 없게 한다.
import { z } from "zod";

import { GENRES, type Genre } from "../../domain/constants";
import { promoGenreChip, PROMO_CHIP_SETTINGS } from "../../domain/promo-image-chips";
import { promoAutoConditionOptions } from "../../domain/promo-image-conditions";
import { promoMonthRange } from "../../domain/promo-image-free-quota";
import {
  promoEngineCards,
  promoExamplesFor,
  promoPreselectedEngineId,
  promoUsageSummary,
  type PromoEngineUsage,
} from "../../domain/promo-image-options";
import { PROMO_IMAGE_QUOTA_SETTINGS, promoUsageDate, type PromoImageQuotaSettings } from "../../domain/promo-image-quota";
import { systemClock, type Clock } from "../../domain/time";
import type { GuardDeps } from "../guards";
import { HttpError, parseWith, withRoute } from "../http";
import { createClassAccess, findClass } from "./class-registration";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_SENTENCE_LENGTH = 200;

const querySchema = z.object({ classId: z.uuid() });

export type PromoImageOptionsDeps = GuardDeps & {
  clock?: Clock;
  /** 하루 횟수·엔진 설정(테스트가 작은 한도를 넘길 수 있게). 기본은 설정 파일 */
  settings?: PromoImageQuotaSettings;
};

export function createPromoImageOptionsRoute(deps: PromoImageOptionsDeps) {
  const { db } = deps;
  const clock = deps.clock ?? systemClock;
  const settings = deps.settings ?? PROMO_IMAGE_QUOTA_SETTINGS;
  const { readStaff, requireClassAccess } = createClassAccess(deps);

  /** 켜진 엔진마다 오늘 전체 사용 수와 이번 달 장수(만들기 요청 4단계와 같은 셈) */
  async function engineUsage(now: Temporal.Instant): Promise<PromoEngineUsage[]> {
    const usageDate = promoUsageDate(now);
    const month = promoMonthRange(now);
    const enabled = settings.engines.filter((x) => x.enabled).map((x) => x.id);
    // 켜진 엔진은 한두 개뿐이라 엔진마다 한 번씩 읽는다
    return Promise.all(
      enabled.map(async (engineId) => {
        const [row] = await db.query(
          db.raw.sql`SELECT
                       COALESCE((SELECT u.used_count FROM promo_image_engine_usage u WHERE u.engine = ${engineId} AND u.usage_date = ${usageDate}::date), 0)::int AS used_today,
                       (SELECT count(*) FROM promo_image_generations g
                         WHERE g.engine = ${engineId} AND g.status IN ('queued', 'running', 'succeeded')
                           AND g.usage_date >= ${month.from}::date AND g.usage_date < ${month.to}::date)::int AS month_used`
            .returnsRow({ used_today: "pg/int4@1", month_used: "pg/int4@1" })
            .build(),
        );
        return { engineId, usedToday: row?.used_today ?? 0, monthUsed: row?.month_used ?? 0 };
      }),
    );
  }

  return withRoute<unknown>(async (request) => {
    const staff = await readStaff(request);
    const query = parseWith(querySchema, Object.fromEntries(new URL(request.url).searchParams));

    // 권한 — 만들기 요청 1단계와 같은 판정
    const cls = await findClass(db, query.classId);
    if (cls === null) throw new HttpError("NOT_FOUND", "수업을 찾을 수 없어요");
    await requireClassAccess(request, staff, cls);
    const [genreRow] = await db.query(
      db.raw.sql`SELECT genre, COALESCE(sub_genre, '') AS sub_genre FROM classes WHERE id = ${query.classId}::uuid`
        .returnsRow({ genre: "pg/text@1", sub_genre: "pg/text@1" })
        .build(),
    );
    const genre = parseWith(z.enum(GENRES), genreRow?.genre) as Genre;
    const subGenre = genreRow?.sub_genre === "" || genreRow === undefined ? null : genreRow.sub_genre;

    const now = clock();
    const [usedRow] = await db.query(
      db.raw.sql`SELECT used_count FROM promo_image_usage
                 WHERE staff_account_id = ${staff.staffAccountId}::uuid AND usage_date = ${promoUsageDate(now)}::date`
        .returnsRow({ used_count: "pg/int4@1" })
        .build(),
    );
    // 지난번에 고른 엔진 = 이 사람의 가장 최근 생성의 엔진(수업과 상관없이)
    const [lastEngine] = await db.query(
      db.raw.sql`SELECT engine FROM promo_image_generations WHERE staff_account_id = ${staff.staffAccountId}::uuid
                 ORDER BY created_at DESC, id DESC LIMIT 1`
        .returnsRow({ engine: "pg/text@1" })
        .build(),
    );
    // 이 수업에서 마지막으로 만든 것 — 실패는 그림이 없으니 빼고(횟수도 돌려받았다) 성공·만드는 중만
    const [last] = await db.query(
      db.raw.sql`SELECT id, status, COALESCE(image_file_id::text, '') AS image_file_id, engine, sentence, chips::text AS chips,
                        auto_condition_ids::text AS auto_condition_ids, usage_date::text AS created_on
                 FROM promo_image_generations
                 WHERE staff_account_id = ${staff.staffAccountId}::uuid AND class_id = ${query.classId}::uuid
                   AND status IN ('queued', 'running', 'succeeded')
                 ORDER BY created_at DESC, id DESC LIMIT 1`
        .returnsRow({
          id: "pg/uuid@1",
          status: "pg/text@1",
          image_file_id: "pg/text@1",
          engine: "pg/text@1",
          sentence: "pg/text@1",
          chips: "pg/text@1",
          auto_condition_ids: "pg/text@1",
          created_on: "pg/text@1",
        })
        .build(),
    );

    const cards = promoEngineCards({ settings, usage: await engineUsage(now), lastEngineId: lastEngine?.engine ?? null, now });
    const genreChip = promoGenreChip({ genre, subGenre: subGenre as Parameters<typeof promoGenreChip>[0]["subGenre"] });
    const body = {
      genre,
      genreChip: { genre, label: genreChip.label, locked: true },
      requiredChips: PROMO_CHIP_SETTINGS.requiredChips,
      examples: promoExamplesFor(genre),
      autoConditions: promoAutoConditionOptions(genre),
      engines: cards,
      preselectedEngineId: promoPreselectedEngineId(cards, settings.defaultEngineId),
      usage: promoUsageSummary({ settings, usedToday: usedRow?.used_count ?? 0, cards, now }),
      lastGeneration:
        last === undefined
          ? null
          : {
              generationId: last.id,
              status: last.status,
              imageUrl: last.image_file_id === "" ? null : `/api/files/${last.image_file_id}`,
              engine: last.engine,
              sentence: last.sentence,
              chips: JSON.parse(last.chips) as unknown,
              autoConditionIds: JSON.parse(last.auto_condition_ids) as unknown,
              createdOn: last.created_on,
            },
      maxSentenceLength: MAX_SENTENCE_LENGTH,
    };
    return Response.json(body, { headers: NO_STORE });
  });
}
