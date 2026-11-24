// SX-6.5(하루 횟수·생성 요청 API) — 홍보 이미지 만들기의 앱 경로 셋. 「계정마다 하루 N번」을 DB 한 곳에서 센다.
//   계약: _workspace/03_contracts/16-ai-agent.md §1-1 · §1-5 · §4-7 · §7-1 · §7-2 · §10 「횟수」
//   데이터: data-model §13-3(ai_jobs) · §13-6(promo_image_generations · promo_image_usage) + 엔진 하루 표 promo_image_engine_usage
//   요구: FR-061a(홍보 이미지 생성 조건 — 하루 N번, 실패하면 원복, 지난 입력 불러오기, 엔진 고르기) · FR-270(입력 지시문은 데이터)
//
// 경로:
//   POST /api/ai/promo-images                    만들기 요청(횟수 차감 → 에이전트에게 맡김). 헤더 Idempotency-Key 필수
//   GET  /api/ai/promo-images/{generationId}     상태와 결과(실패면 refunded: true)
//   GET  /api/ai/promo-images/history            지난 입력(본인 것 최신순) — 다음 날 같은 문장을 불러와 고쳐 쓴다
// 결과 받기(에이전트 → 내부 경로)는 poster-extraction-jobs.ts 의 결과 경로가 kind 로 갈라 이 파일의 applyPromoImageJobResult 를 부른다.
//
// 횟수를 어떻게 세나(핵심):
//   ① 날짜는 한국 시간 달력(promoUsageDate). 하루는 KST 0시에 바뀐다 — 줄(PK 직원×날짜)이 날마다 새로 생기니 「초기화」가 따로 없다.
//   ② 차감은 조건부 UPDATE 한 문장(`… WHERE used_count < :limit`). 동시에 두 번 눌러도 DB 가 한쪽만 통과시킨다(먼저 읽고 나중에 쓰면 둘 다 통과한다).
//   ③ 차감·생성 행·작업 행은 한 트랜잭션 — 생성 행을 못 만들면 차감도 없던 일이 된다.
//   ④ 실패(모델 오류·공급자 오류·에이전트 없음·결과 모양 틀림)가 되는 순간 같은 트랜잭션에서 그 생성의 차감한 날 줄을 1 돌려준다.
//      한 생성은 한 번만 돌려준다(quota_refunded_at IS NULL 조건).
//   ⑤ 다시 만들기도 새 요청(새 멱등 키)이라 1번으로 센다. 같은 멱등 키로 다시 오면 처음 생성을 돌려주고 다시 차감하지 않는다.
//   ⑥ 앞 단계(권한·필수 칩·엔진·막는 입력)에서 거부되면 행을 만들지 않으니 횟수가 줄지 않는다.
//
// 엔진별 전체 하루 한도(spec FR-061a): 사람 횟수와 따로 엔진×날짜 줄을 같은 방식으로 센다. 막히면 409 PROMO_FREE_QUOTA_EXHAUSTED
//   (+ engineId · resetsAt). 이 셈은 실패해도 돌려주지 않는다 — 요청을 보냈으면 공급자 무료량을 썼을 수 있다(추천안·사후 확인 2026-11-24).
// 이달 무료량(16 §4-7 4단계, SX-6.8): 차감 앞에서 고른 엔진의 이달 장수·오늘 엔진 사용 수를 읽어 decidePromoFreeQuota 로 판정한다.
//   바닥났으면 409 PROMO_FREE_QUOTA_EXHAUSTED + engineId · resetsAt · quotaScope(monthly | engine_daily). 막는 것은 이 생성 요청뿐이고
//   수업 저장·승인 요청 경로는 무료량을 보지 않는다. 공급자가 「한도 끝」을 알리면 failPromoGeneration 이 그날 엔진 줄을 한도까지 채운다.
// 게시 경로는 SX-6.7 이 맡는다.
import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { GENRES, PROMO_IMAGE_FAILURE_CODES, PROMO_IMAGE_GENERATION_STATUSES, type Genre, type PromoImageFailureCode } from "../../domain/constants";
import { buildPromoImageAgentPayload, resolvePromoAutoConditions } from "../../domain/promo-image-conditions";
import { checkPromoRequiredChips, PROMO_REQUIRED_CHIP_KEYS } from "../../domain/promo-image-chips";
import { guardPromoGeneration } from "../../domain/promo-image-blocklist";
import {
  nextPromoResetAt,
  PROMO_IMAGE_QUOTA_SETTINGS,
  promoRemaining,
  promoUsageDate,
  resolvePromoEngine,
  type PromoImageQuotaSettings,
} from "../../domain/promo-image-quota";
import { decidePromoFreeQuota, promoMonthRange, providerExhaustedEngineCount } from "../../domain/promo-image-free-quota";
import { systemClock, type Clock } from "../../domain/time";
import { detectUploadMimeType, MAX_UPLOAD_BYTES, newStorageKey } from "../../domain/upload-file";
import type { AgentJobDispatcher } from "../ai/agent-jobs-client";
import type { GuardDeps, StaffAccountContext } from "../guards";
import { HttpError, parseJsonBody, parseWith, readIdempotencyKey, withRoute } from "../http";
import type { FileStoragePort } from "../ports/file-storage";
import { createClassAccess, findClass } from "./class-registration";
import type { Db } from "../../../prisma/db";
import type { Tx } from "./staff-signup";

const DETAIL = {
  notFound: "홍보 이미지 만들기를 찾을 수 없어요",
  classNotFound: "수업을 찾을 수 없어요",
  forbidden: "이 홍보 이미지를 볼 권한이 없어요",
  engine: "지금 쓸 수 없는 엔진이에요",
  dailyLimit: "오늘 만들 수 있는 횟수를 다 썼어요. 내일 다시 만들 수 있어요",
  engineLimit: "이 엔진의 오늘 무료 사용량이 끝났어요. 내일 다시 만들 수 있어요",
  monthlyLimit: "이번 달 무료 생성량을 모두 썼어요. 사진을 올려 주세요",
} as const;

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** 에이전트가 끝내야 하는 기한(추천 120초 — 포스터와 같다). 넘기면 sweep 이 TIMEOUT 으로 닫고 횟수를 돌려준다 */
export const PROMO_JOB_DEADLINE_MS = 120_000;
/** 지난 입력 불러오기 기본·최대 개수(계약 예시 limit=20) */
const HISTORY_DEFAULT = 20;
const HISTORY_MAX = 50;

/** 실패 이유(§13-8). 이 다섯 밖의 코드가 오면 공급자 오류로 묶는다 */
export const PROMO_FAILURE_CODES = PROMO_IMAGE_FAILURE_CODES;
export type PromoFailureCode = PromoImageFailureCode;

// ---- 요청·응답 모양 ----------------------------------------------------------------------------

const chipValueSchema = z.union([z.string().max(40), z.strictObject({ custom: z.string().max(40) })]);
const chipsSchema = z.strictObject(
  Object.fromEntries(PROMO_REQUIRED_CHIP_KEYS.map((k) => [k, chipValueSchema.optional()])) as Record<
    (typeof PROMO_REQUIRED_CHIP_KEYS)[number],
    z.ZodOptional<typeof chipValueSchema>
  >,
);

const createBodySchema = z.strictObject({
  classId: z.uuid(),
  chips: chipsSchema,
  sentence: z.string().trim().min(1).max(200),
  autoConditionIds: z.array(z.string().max(40)).max(10).default([]),
  // 고른 엔진(FR-061a 「생성 엔진은 사용자가 고른다」). 없으면 기본 엔진(추천안·사후 확인 2026-11-24)
  engineId: z.string().max(60).optional(),
});

export const promoCreateResponseSchema = z.strictObject({
  generationId: z.uuid(),
  status: z.enum(PROMO_IMAGE_GENERATION_STATUSES),
  remaining: z.int().min(0),
});

export const promoGenerationSchema = z.strictObject({
  generationId: z.uuid(),
  status: z.enum(PROMO_IMAGE_GENERATION_STATUSES),
  aiGenerated: z.literal(true),
  imageFileId: z.uuid().nullable(),
  imageUrl: z.string().nullable(),
  engine: z.string(),
  refunded: z.boolean(),
  remaining: z.int().min(0),
  failureCode: z.enum(PROMO_FAILURE_CODES).nullable(),
});

export const promoHistorySchema = z.strictObject({
  items: z.array(
    z.strictObject({
      generationId: z.uuid(),
      createdOn: z.iso.date(),
      sentence: z.string(),
      chips: chipsSchema,
      autoConditionIds: z.array(z.string()),
      engine: z.string(),
      status: z.enum(PROMO_IMAGE_GENERATION_STATUSES),
    }),
  ),
});

const historyQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(HISTORY_MAX).default(HISTORY_DEFAULT) });
const idSchema = z.uuid();

export type PromoImageDeps = GuardDeps & {
  clock?: Clock;
  /** 에이전트에게 작업을 맡기는 연결. 테스트는 가짜를 넘긴다 */
  dispatchJob: AgentJobDispatcher;
  /** 하루 횟수·엔진 설정. 테스트가 작은 한도를 넘길 수 있게 받는다(기본은 설정 파일) */
  settings?: PromoImageQuotaSettings;
};

/** 횟수 한도에 걸려 트랜잭션을 되돌릴 때 던지는 표시(바깥에서 409 로 바꾼다) */
class QuotaStop extends Error {
  constructor(readonly which: "staff" | "engine") {
    super(which);
  }
}
/** 같은 멱등 키가 동시에 두 번 왔다 — 먼저 들어간 쪽이 이긴다 */
class LostCreateRace extends Error {}

// ---- 횟수 읽기·원복(결과 경로와 같이 쓴다) ------------------------------------------------------

/** 그 직원의 그날 쓴 횟수(줄이 없으면 0) */
async function usedOn(db: Db | Tx, staffAccountId: string, usageDate: string): Promise<number> {
  const [row] = await db.query(
    db.raw.sql`SELECT used_count FROM promo_image_usage WHERE staff_account_id = ${staffAccountId}::uuid AND usage_date = ${usageDate}::date`
      .returnsRow({ used_count: "pg/int4@1" })
      .build(),
  );
  return row?.used_count ?? 0;
}

/**
 * 생성을 실패로 닫고 차감했던 날 횟수를 1 돌려준다 — 한 트랜잭션 안에서 부른다.
 * 이미 끝났거나(succeeded·failed) 이미 돌려줬으면 아무것도 하지 않고 false.
 */
export async function failPromoGeneration(
  tx: Tx,
  generationId: string,
  code: PromoFailureCode,
  settings: PromoImageQuotaSettings = PROMO_IMAGE_QUOTA_SETTINGS,
): Promise<boolean> {
  const [closed] = await tx.query(
    tx.raw.sql`UPDATE promo_image_generations
               SET status = 'failed', failure_code = ${code}, finished_at = now(), quota_refunded_at = now()
               WHERE id = ${generationId}::uuid AND status IN ('queued', 'running') AND quota_refunded_at IS NULL
               RETURNING staff_account_id::text AS staff_account_id, usage_date::text AS usage_date, engine`
      .returnsRow({ staff_account_id: "pg/text@1", usage_date: "pg/text@1", engine: "pg/text@1" })
      .build(),
  );
  if (closed === undefined) return false;
  // 원복은 차감한 날의 줄에서 — 자정을 넘겨 실패해도 그날 횟수를 돌려준다. 0 밑으로는 내려가지 않는다
  await tx.execute(
    tx.raw.sql`UPDATE promo_image_usage SET used_count = GREATEST(used_count - 1, 0)
               WHERE staff_account_id = ${closed.staff_account_id}::uuid AND usage_date = ${closed.usage_date}::date`
      .affectedCount()
      .build(),
  );
  // SX-6.8: 공급자가 「무료 한도 끝」을 알렸다 — 그 엔진의 그날 줄을 엔진 하루 한도까지 채워, 다음 KST 0시까지 그 엔진 생성만 막는다.
  //   새 표·설정 칸 없이 SX-6.5 의 엔진 하루 표를 그대로 쓴다(추천안·사후 확인 2026-11-24). 하루 한도가 없는 엔진은 건드리지 않는다
  if (code === "PROVIDER_QUOTA_EXHAUSTED") {
    const engine = settings.engines.find((e) => e.id === closed.engine);
    const fill = engine === undefined ? null : providerExhaustedEngineCount(engine);
    if (fill !== null) {
      await tx.execute(
        tx.raw.sql`INSERT INTO promo_image_engine_usage (engine, usage_date, used_count) VALUES (${closed.engine}, ${closed.usage_date}::date, ${fill})
                   ON CONFLICT (engine, usage_date) DO UPDATE SET used_count = GREATEST(promo_image_engine_usage.used_count, EXCLUDED.used_count)`
          .affectedCount()
          .build(),
      );
    }
  }
  return true;
}

// ---- 경로 ----------------------------------------------------------------------------------

type GenerationRow = {
  id: string;
  staff_account_id: string;
  academy_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  image_file_id: string;
  engine: string;
  failure_code: string;
  refunded: boolean;
};

export function createPromoImageRoutes(deps: PromoImageDeps) {
  const { db } = deps;
  const clock = deps.clock ?? systemClock;
  const settings = deps.settings ?? PROMO_IMAGE_QUOTA_SETTINGS;
  const { readStaff, requireClassAccess } = createClassAccess(deps);

  const remainingToday = async (staffAccountId: string): Promise<number> =>
    promoRemaining(await usedOn(db, staffAccountId, promoUsageDate(clock())), settings.dailyLimit);

  /** 그 엔진의 그날 전체 사용 수(줄이 없으면 0) */
  async function engineUsedOn(engineId: string, usageDate: string): Promise<number> {
    const [row] = await db.query(
      db.raw.sql`SELECT used_count FROM promo_image_engine_usage WHERE engine = ${engineId} AND usage_date = ${usageDate}::date`
        .returnsRow({ used_count: "pg/int4@1" })
        .build(),
    );
    return row?.used_count ?? 0;
  }

  /** 그 엔진으로 이번 달(KST) 만든 장수 — 성공과 만드는 중을 센다(실패는 그림이 없으니 빼고, 만드는 중은 넣어 넘치지 않게) */
  async function engineMonthUsed(engineId: string, at: Temporal.Instant): Promise<number> {
    const month = promoMonthRange(at);
    const [row] = await db.query(
      db.raw.sql`SELECT count(*)::int AS n FROM promo_image_generations
                 WHERE engine = ${engineId} AND status IN ('queued', 'running', 'succeeded')
                   AND usage_date >= ${month.from}::date AND usage_date < ${month.to}::date`
        .returnsRow({ n: "pg/int4@1" })
        .build(),
    );
    return row?.n ?? 0;
  }

  async function findGeneration(id: string): Promise<GenerationRow | null> {
    const [row] = await db.query(
      db.raw.sql`SELECT g.id, g.staff_account_id, c.academy_id, g.status, COALESCE(g.image_file_id::text, '') AS image_file_id,
                        g.engine, COALESCE(g.failure_code, '') AS failure_code, (g.quota_refunded_at IS NOT NULL) AS refunded
                 FROM promo_image_generations g JOIN classes c ON c.id = g.class_id WHERE g.id = ${id}::uuid`
        .returnsRow({
          id: "pg/uuid@1",
          staff_account_id: "pg/uuid@1",
          academy_id: "pg/uuid@1",
          status: "pg/text@1",
          image_file_id: "pg/text@1",
          engine: "pg/text@1",
          failure_code: "pg/text@1",
          refunded: "pg/bool@1",
        })
        .build(),
    );
    return (row as GenerationRow | undefined) ?? null;
  }

  /** 멱등 키로 이미 만든 생성 — 다시 오면 그대로 돌려준다(횟수 다시 차감하지 않음) */
  async function findByIdempotency(staffAccountId: string, key: string): Promise<{ id: string; status: string } | null> {
    const [row] = await db.query(
      db.raw.sql`SELECT id, status FROM promo_image_generations
                 WHERE staff_account_id = ${staffAccountId}::uuid AND idempotency_key = ${key}`
        .returnsRow({ id: "pg/uuid@1", status: "pg/text@1" })
        .build(),
    );
    return row ?? null;
  }

  const created = async (staff: StaffAccountContext, id: string, httpStatus: number): Promise<Response> => {
    const row = await findGeneration(id);
    if (row === null) throw new Error("방금 만든 홍보 이미지 생성을 다시 읽지 못했다");
    const body = promoCreateResponseSchema.parse({ generationId: row.id, status: row.status, remaining: await remainingToday(staff.staffAccountId) });
    return Response.json(body, { status: httpStatus, headers: NO_STORE });
  };

  // ---- ① POST /api/ai/promo-images — 만들기 요청 ------------------------------------------------

  const create = withRoute<unknown>(async (request) => {
    const staff = await readStaff(request);
    const key = readIdempotencyKey(request, { required: true });
    const body = await parseJsonBody(request, createBodySchema);

    // 같은 키로 다시 왔다 — 처음 생성 그대로(200)
    const again = await findByIdempotency(staff.staffAccountId, key);
    if (again !== null) return created(staff, again.id, 200);

    // 1단계: 수업 편집 권한(S2-2 의 판정 그대로) + 장르는 수업에서 가져온다
    const cls = await findClass(db, body.classId);
    if (cls === null) throw new HttpError("NOT_FOUND", DETAIL.classNotFound);
    await requireClassAccess(request, staff, cls);
    const [genreRow] = await db.query(
      db.raw.sql`SELECT genre FROM classes WHERE id = ${body.classId}::uuid`.returnsRow({ genre: "pg/text@1" })
        .build(),
    );
    const genre = parseWith(z.enum(GENRES), genreRow?.genre) as Genre;

    // 2단계: 필수 4항목(SX-6.1) — 빠지면 422, 횟수 그대로
    const required = checkPromoRequiredChips(body.chips);
    if (!required.ok) throw HttpError.unprocessable("PROMO_REQUIRED_MISSING", required.message, { missing: required.missing });

    // 엔진 — 꺼졌거나 목록 밖이면 접수 전에 막는다(받아 놓고 실패시키면 횟수가 줄었다 돌아온다)
    const engine = resolvePromoEngine(body.engineId, settings);
    if (engine === null) {
      throw new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", { fields: [{ path: "engineId", message: DETAIL.engine }] });
    }

    const now = clock();
    const usageDate = promoUsageDate(now);
    const resetsAt = nextPromoResetAt(now).toString();
    const remainingBefore = promoRemaining(await usedOn(db, staff.staffAccountId, usageDate), settings.dailyLimit);

    // 3단계: 막는 입력(SX-6.3) — 판정을 차감 「앞」에 세운다. 막히면 아래 트랜잭션(차감·생성)을 아예 부르지 않는다.
    // 문장은 데이터다(FR-270) — 낱말 대조만 하고, 로그에 문장을 남기지 않는다
    const guarded = guardPromoGeneration({ sentence: body.sentence, chips: body.chips }, remainingBefore, () => true);
    if (!guarded.ok) {
      throw HttpError.unprocessable("PROMO_INPUT_BLOCKED", guarded.body.message, {
        blockedKind: guarded.body.blockedKind,
        remaining: guarded.body.remaining,
        reason: guarded.body.reason,
      });
    }

    // 4단계(SX-6.8): 이달 무료량·엔진 하루 한도. 바닥났으면 차감 앞에서 409 — 사람 횟수는 줄지 않는다.
    //   여기는 읽고 판정만 한다. 동시에 들어온 요청이 엔진 하루 한도를 넘지 않게 지키는 것은 아래 consume 의 조건부 UPDATE 다.
    //   이달 장수는 읽기 셈이라 동시에 몰리면 한두 장 넘을 수 있다 — 달 한도는 무료량보다 조금 낮게 잡는다
    const freeQuota = decidePromoFreeQuota({
      engine,
      monthUsed: engine.monthlyFreeCap === null ? 0 : await engineMonthUsed(engine.id, now),
      engineUsedToday: engine.engineDailyLimit === null ? 0 : await engineUsedOn(engine.id, usageDate),
      now,
    });
    if (freeQuota.exhausted) {
      throw HttpError.conflict("PROMO_FREE_QUOTA_EXHAUSTED", freeQuota.scope === "monthly" ? DETAIL.monthlyLimit : DETAIL.engineLimit, {
        engineId: freeQuota.engineId,
        resetsAt: freeQuota.resetsAt,
        quotaScope: freeQuota.scope,
      });
    }

    // 실제로 붙일 조건(글자 없음은 늘 포함, SX-6.2) — 생성 행에 남긴다
    const { appliedIds } = resolvePromoAutoConditions(genre, body.autoConditionIds);
    const generationId = randomUUID();
    const jobId = randomUUID();
    const deadline = now.add({ milliseconds: PROMO_JOB_DEADLINE_MS }).toString();

    // 5·6단계: 차감(사람·엔진)과 생성 행·작업 행을 한 트랜잭션으로. 한도에 걸리면 던져서 통째로 되돌린다
    const outcome = await db
      .transaction(async (tx) => {
        await consume(tx, "staff", staff.staffAccountId, usageDate, settings.dailyLimit);
        if (engine.engineDailyLimit !== null) await consume(tx, "engine", engine.id, usageDate, engine.engineDailyLimit);
        await tx.execute(
          tx.raw.sql`INSERT INTO ai_jobs (id, kind, status, subject_id, deadline_at)
                     VALUES (${jobId}::uuid, 'promo_image', 'queued', ${generationId}::uuid, ${deadline}::timestamptz)`
            .affectedCount()
            .build(),
        );
        const inserted = await tx.execute(
          tx.raw.sql`INSERT INTO promo_image_generations (id, staff_account_id, class_id, genre, chips, sentence, auto_condition_ids, engine,
                                                          usage_date, status, idempotency_key, job_id)
                     VALUES (${generationId}::uuid, ${staff.staffAccountId}::uuid, ${body.classId}::uuid, ${genre},
                             ${JSON.stringify(body.chips)}::json, ${body.sentence}, ${JSON.stringify(appliedIds)}::json, ${engine.id},
                             ${usageDate}::date, 'queued', ${key}, ${jobId}::uuid)
                     ON CONFLICT (staff_account_id, idempotency_key) DO NOTHING`
            .affectedCount()
            .build(),
        );
        if (inserted.affectedRows === 0) throw new LostCreateRace();
        return "created" as const;
      })
      .catch((error: unknown) => {
        if (error instanceof QuotaStop || error instanceof LostCreateRace) return error;
        throw error;
      });

    if (outcome instanceof QuotaStop) {
      if (outcome.which === "staff") {
        throw HttpError.conflict("PROMO_DAILY_LIMIT_REACHED", DETAIL.dailyLimit, { resetsAt, remaining: 0 });
      }
      throw HttpError.conflict("PROMO_FREE_QUOTA_EXHAUSTED", DETAIL.engineLimit, { engineId: engine.id, resetsAt, quotaScope: "engine_daily" });
    }
    if (outcome instanceof LostCreateRace) {
      const winner = await findByIdempotency(staff.staffAccountId, key);
      if (winner === null) throw new Error("동시 요청 뒤 이긴 홍보 이미지 생성을 찾지 못했다");
      return created(staff, winner.id, 200);
    }

    // 커밋 뒤 에이전트에게 맡긴다. 받지 않으면(꺼짐·거절) 기다리게 두지 않고 곧바로 실패로 닫아 횟수를 돌려준다(추천안·사후 확인 2026-11-24)
    await markRunning(jobId, generationId);
    const payload = buildPromoImageAgentPayload({ generationId, genre, sentenceKo: body.sentence, autoConditionIds: body.autoConditionIds });
    const accepted = await deps.dispatchJob({
      jobId,
      kind: "promo_image",
      deadlineMs: PROMO_JOB_DEADLINE_MS,
      payload: { ...payload, engineId: engine.id },
    });
    if (!accepted) {
      await db.transaction(async (tx) => {
        await tx.execute(
          tx.raw.sql`UPDATE ai_jobs SET status = 'failed', finished_at = now(), error_code = 'AGENT_UNAVAILABLE'
                     WHERE id = ${jobId}::uuid AND status IN ('queued', 'running')`
            .affectedCount()
            .build(),
        );
        await failPromoGeneration(tx, generationId, "AGENT_UNAVAILABLE", settings);
      });
    }
    return created(staff, generationId, 202);
  });

  /**
   * 조건부 갱신으로 1 차감한다. 그날 줄이 없으면 0 으로 먼저 만든다(동시에 와도 PK 가 한 줄만 남긴다).
   * 한도에 이미 닿았으면 0행 → QuotaStop 을 던져 트랜잭션을 되돌린다.
   */
  async function consume(tx: Tx, which: "staff" | "engine", id: string, usageDate: string, limit: number): Promise<void> {
    if (which === "staff") {
      await tx.execute(
        tx.raw.sql`INSERT INTO promo_image_usage (staff_account_id, usage_date, used_count) VALUES (${id}::uuid, ${usageDate}::date, 0)
                   ON CONFLICT (staff_account_id, usage_date) DO NOTHING`
          .affectedCount()
          .build(),
      );
      const done = await tx.execute(
        tx.raw.sql`UPDATE promo_image_usage SET used_count = used_count + 1
                   WHERE staff_account_id = ${id}::uuid AND usage_date = ${usageDate}::date AND used_count < ${limit}`
          .affectedCount()
          .build(),
      );
      if (done.affectedRows === 0) throw new QuotaStop("staff");
      return;
    }
    await tx.execute(
      tx.raw.sql`INSERT INTO promo_image_engine_usage (engine, usage_date, used_count) VALUES (${id}, ${usageDate}::date, 0)
                 ON CONFLICT (engine, usage_date) DO NOTHING`
        .affectedCount()
        .build(),
    );
    const done = await tx.execute(
      tx.raw.sql`UPDATE promo_image_engine_usage SET used_count = used_count + 1
                 WHERE engine = ${id} AND usage_date = ${usageDate}::date AND used_count < ${limit}`
        .affectedCount()
        .build(),
    );
    if (done.affectedRows === 0) throw new QuotaStop("engine");
  }

  /** 작업·생성을 함께 queued → running 으로(에이전트가 받으러 오기 전에) */
  async function markRunning(jobId: string, generationId: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.execute(
        tx.raw.sql`UPDATE ai_jobs SET status = 'running', accepted_at = now() WHERE id = ${jobId}::uuid AND status = 'queued'`
          .affectedCount()
          .build(),
      );
      await tx.execute(
        tx.raw.sql`UPDATE promo_image_generations SET status = 'running' WHERE id = ${generationId}::uuid AND status = 'queued'`
          .affectedCount()
          .build(),
      );
    });
  }

  // ---- ② GET /api/ai/promo-images/{generationId} — 상태와 결과 -----------------------------------

  const read = withRoute<{ params: Promise<{ generationId: string }> }>(async (request, context) => {
    const staff = await readStaff(request);
    const id = idSchema.safeParse((await context.params).generationId);
    if (!id.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const row = await findGeneration(id.data);
    if (row === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    // 만든 직원 또는 그 수업 학원의 대표만
    if (row.staff_account_id !== staff.staffAccountId && !staff.actor.ownedAcademyIds.includes(row.academy_id)) {
      throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    }
    const body = promoGenerationSchema.parse({
      generationId: row.id,
      status: row.status,
      aiGenerated: true,
      imageFileId: row.image_file_id === "" ? null : row.image_file_id,
      imageUrl: row.image_file_id === "" ? null : `/api/files/${row.image_file_id}`,
      engine: row.engine,
      refunded: row.refunded,
      // 남은 횟수는 읽는 사람의 오늘 횟수다(실패해 돌려받으면 여기서 다시 늘어 보인다)
      remaining: await remainingToday(staff.staffAccountId),
      failureCode: row.failure_code === "" ? null : row.failure_code,
    });
    return Response.json(body, { headers: NO_STORE });
  });

  // ---- ③ GET /api/ai/promo-images/history — 지난 입력 -------------------------------------------

  const history = withRoute<unknown>(async (request) => {
    const staff = await readStaff(request);
    const query = parseWith(historyQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    // 본인 것만, 최신순. 막힌 입력은 행이 없으니 목록에 없다. 날짜는 차감한 KST 날짜
    const rows = await db.query(
      db.raw.sql`SELECT id, usage_date::text AS created_on, sentence, chips::text AS chips, auto_condition_ids::text AS auto_condition_ids,
                        engine, status
                 FROM promo_image_generations WHERE staff_account_id = ${staff.staffAccountId}::uuid
                 ORDER BY created_at DESC, id DESC LIMIT ${query.limit}`
        .returnsRow({
          id: "pg/uuid@1",
          created_on: "pg/text@1",
          sentence: "pg/text@1",
          chips: "pg/text@1",
          auto_condition_ids: "pg/text@1",
          engine: "pg/text@1",
          status: "pg/text@1",
        })
        .build(),
    );
    const body = promoHistorySchema.parse({
      items: rows.map((r) => ({
        generationId: r.id,
        createdOn: r.created_on,
        sentence: r.sentence,
        chips: JSON.parse(r.chips) as unknown,
        autoConditionIds: JSON.parse(r.auto_condition_ids) as unknown,
        engine: r.engine,
        status: r.status,
      })),
    });
    return Response.json(body, { headers: NO_STORE });
  });

  return { create, read, history };
}

// ---- 결과 받기(16 §7-2, kind = promo_image) ------------------------------------------------------

/** 에이전트 결과 본문(§7-1 promo_image 결과 · §7-2). 성공은 그림 한 장 */
const promoResultBodySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("succeeded"),
    result: z.strictObject({
      englishPrompt: z.string().min(1).max(4000),
      image: z.strictObject({ contentType: z.enum(["image/jpeg", "image/png", "image/webp"]), base64: z.string().min(1) }),
      engine: z.string().max(60),
      model: z.string().max(200),
      elapsedMs: z.int().min(0).nullable().optional(),
    }),
    elapsedMs: z.int().min(0).nullable().optional(),
  }),
  z.strictObject({
    status: z.literal("failed"),
    error: z.object({ code: z.string().max(60), message: z.string().max(500).optional() }),
    elapsedMs: z.int().min(0).nullable().optional(),
  }),
]);

export type PromoJobResultDeps = { readonly db: Db; readonly fileStorage: FileStoragePort };

/**
 * 홍보 이미지 작업 결과를 반영한다(작업이 queued·running 일 때 결과 경로가 부른다).
 *   성공 → 그림을 저장소에 넣고 uploaded_files(class_promo_image · 비공개) 한 줄 + 생성 succeeded(번역 기록·엔진·모델)
 *   실패 → 작업 failed · 생성 failed + 그날 횟수 원복(같은 트랜잭션)
 *   모양이 틀림(그림이 아님·10MB 넘음 포함) → INVALID_RESULT 로 닫고 횟수 원복 + 422
 */
export async function applyPromoImageJobResult(deps: PromoJobResultDeps, job: { id: string; subject_id: string }, raw: unknown): Promise<Response> {
  const { db } = deps;
  const body = promoResultBodySchema.safeParse(raw);
  if (!body.success) {
    await closeFailed(db, job, "INVALID_RESULT");
    throw new HttpError("VALIDATION_FAILED", "결과 모양이 맞지 않아요", {
      fields: body.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    });
  }
  if (body.data.status === "failed") {
    const reported = body.data.error.code;
    const code: PromoFailureCode = (PROMO_FAILURE_CODES as readonly string[]).includes(reported) ? (reported as PromoFailureCode) : "PROVIDER_ERROR";
    return Response.json({ applied: await closeFailed(db, job, code) });
  }

  const ok = body.data.result;
  // 그림 바이트를 직접 본다 — 에이전트가 적은 형식이 아니라 바이트로 판정한 형식을 믿는다
  const bytes = new Uint8Array(Buffer.from(ok.image.base64, "base64"));
  const mime = detectUploadMimeType(bytes);
  if (mime === null || mime === "application/pdf" || bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) {
    await closeFailed(db, job, "INVALID_RESULT");
    throw new HttpError("VALIDATION_FAILED", "결과 모양이 맞지 않아요", { fields: [{ path: "result.image", message: "사진 바이트가 아니에요" }] });
  }

  const storageKey = newStorageKey(mime);
  await deps.fileStorage.put(storageKey, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const applied = await db.transaction(async (tx) => {
    // 작업을 먼저 닫는다(조건부) — 결과 둘이 동시에 와도 한쪽만 통과한다
    const closed = await tx.execute(
      tx.raw.sql`UPDATE ai_jobs SET status = 'succeeded', finished_at = now() WHERE id = ${job.id}::uuid AND status IN ('queued', 'running')`
        .affectedCount()
        .build(),
    );
    if (closed.affectedRows === 0) return false;
    const [file] = await tx.query(
      tx.raw.sql`INSERT INTO uploaded_files (id, uploader_account_id, purpose, visibility, storage_key, mime_type, size_bytes, sha256,
                                             display_name, attached_at)
                 SELECT uuidv7(), g.staff_account_id, 'class_promo_image', 'private', ${storageKey}, ${mime}, ${bytes.length}, ${sha256},
                        ${`promo-image-${job.subject_id}`}, now()
                 FROM promo_image_generations g WHERE g.id = ${job.subject_id}::uuid
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (file === undefined) throw new Error("홍보 이미지 생성 행이 없어 그림을 붙이지 못했다");
    await tx.execute(
      tx.raw.sql`UPDATE promo_image_generations
                 SET status = 'succeeded', image_file_id = ${file.id}::uuid, english_prompt = ${ok.englishPrompt}, engine = ${ok.engine},
                     model = ${ok.model}, finished_at = now()
                 WHERE id = ${job.subject_id}::uuid AND status IN ('queued', 'running')`
        .affectedCount()
        .build(),
    );
    return true;
  });
  // 이미 끝난 작업이었다 — 넣어 둔 그림은 주인이 없으니 지운다
  if (!applied) await deps.fileStorage.delete(storageKey);
  return Response.json({ applied });
}

/** 작업 failed + 생성 failed + 횟수 원복을 한 트랜잭션으로. 이미 끝났으면 false */
async function closeFailed(db: Db, job: { id: string; subject_id: string }, code: PromoFailureCode): Promise<boolean> {
  return db.transaction(async (tx) => {
    const closed = await tx.execute(
      tx.raw.sql`UPDATE ai_jobs SET status = 'failed', finished_at = now(), error_code = ${code}
                 WHERE id = ${job.id}::uuid AND status IN ('queued', 'running')`
        .affectedCount()
        .build(),
    );
    if (closed.affectedRows === 0) return false;
    await failPromoGeneration(tx, job.subject_id, code);
    return true;
  });
}
