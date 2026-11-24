// SX-2.3(검토 API) — 에이전트 서버가 부르는 Next.js 내부 경로 둘(층 B2, `X-Internal-Token`).
//   계약: _workspace/03_contracts/16-ai-agent.md §1-2 · §7-2 · ADR-004(DB 쓰기는 Next.js 하나 — 에이전트는 결과를 보내기만 한다)
//   GET  /api/internal/ai/jobs/{jobId}/file    포스터 원본 바이트(작업이 running 인 동안만, 그 밖은 404)
//   POST /api/internal/ai/jobs/{jobId}/result  작업 결과 전달 — 먼저 온 결과가 이기고 늦게 온 결과는 200 applied:false
//
// 결과를 받으면(포스터): 칸 17개를 한 줄씩 쓰고(못 읽은 칸은 value NULL · 확인필요), 읽기를 ready 로 바꾼다.
// AI 결과는 지시가 아니라 데이터다(FR-270) — 칸 키 밖·값 모양 밖이 하나라도 있으면 422 로 받지 않고 작업을 INVALID_RESULT 로 닫는다.
import { z } from "zod";

import { AI_JOB_ERROR_CODES, POSTER_FIELD_KEYS, type PosterFailureCode, type PosterFieldKey } from "../../domain/constants";
import { needsCheckFor, parseFieldValue, roundConfidence, type PosterFieldValue } from "../../domain/poster-extraction";
import { HttpError } from "../http";
import { withInternalRoute } from "../internal-routes";
import type { FileStoragePort } from "../ports/file-storage";
import { applyPromoImageJobResult } from "./promo-image-generations";
import type { Db } from "../../../prisma/db";

export type PosterJobDeps = { readonly db: Db; readonly fileStorage: FileStoragePort; readonly env?: Readonly<Record<string, string | undefined>> };

const NOT_FOUND = "작업을 찾을 수 없어요";

const resultFieldSchema = z.strictObject({
  key: z.string(),
  value: z.unknown(),
  confidence: z.number().min(0).max(1).nullable(),
});

/** 결과 본문(16 §7-2). 성공은 result, 실패는 error */
export const jobResultBodySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("succeeded"),
    result: z.object({
      fields: z.array(resultFieldSchema).max(POSTER_FIELD_KEYS.length * 2),
      overallConfidence: z.number().min(0).max(1).nullable(),
      model: z.string().max(200).nullable().optional(),
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

const jobIdSchema = z.uuid();
type JobParams = { params: Promise<{ jobId: string }> };

const JOB_ROW = { id: "pg/uuid@1", kind: "pg/text@1", status: "pg/text@1", subject_id: "pg/uuid@1" } as const;

/** 작업 실패 이유 → 포스터 실패 이유. 포스터에 없는 값(공급자 오류 등)은 「읽기 실패」로 묶는다 */
function posterFailureOf(code: string): PosterFailureCode {
  if (code === "AGENT_UNAVAILABLE" || code === "TIMEOUT" || code === "INVALID_RESULT") return code;
  return "EXTRACTION_FAILED";
}

export function createPosterJobRoutes(deps: PosterJobDeps) {
  const { db } = deps;

  async function loadJob(context: JobParams) {
    const jobId = jobIdSchema.safeParse((await context.params).jobId);
    if (!jobId.success) throw new HttpError("NOT_FOUND", NOT_FOUND);
    const [job] = await db.query(
      db.raw.sql`SELECT id, kind, status, subject_id FROM ai_jobs WHERE id = ${jobId.data}::uuid`.returnsRow(JOB_ROW).build(),
    );
    if (job === undefined) throw new HttpError("NOT_FOUND", NOT_FOUND);
    return job;
  }

  // ---- GET …/file — 포스터 원본 ---------------------------------------------------------------

  const file = withInternalRoute<JobParams>(async (_request, context) => {
    const job = await loadJob(context);
    // 일하는 중(running)인 포스터 작업에만 연다 — 끝난 작업의 토큰이 새도 원본을 다시 꺼내 갈 수 없게
    if (job.kind !== "poster_extract" || job.status !== "running") throw new HttpError("NOT_FOUND", NOT_FOUND);
    const [found] = await db.query(
      db.raw.sql`SELECT f.storage_key, f.mime_type FROM poster_extractions p JOIN uploaded_files f ON f.id = p.source_file_id
                 WHERE p.id = ${job.subject_id}::uuid AND p.job_id = ${job.id}::uuid`
        .returnsRow({ storage_key: "pg/text@1", mime_type: "pg/text@1" })
        .build(),
    );
    if (found === undefined) throw new HttpError("NOT_FOUND", NOT_FOUND);
    const bytes = await deps.fileStorage.get(found.storage_key);
    if (bytes === null) throw new HttpError("NOT_FOUND", NOT_FOUND);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": found.mime_type, "Cache-Control": "no-store" } });
  }, deps.env);

  // ---- POST …/result — 결과 전달 -----------------------------------------------------------------

  const result = withInternalRoute<JobParams>(async (request, context) => {
    const job = await loadJob(context);
    let raw: unknown;
    try {
      raw = JSON.parse(await request.text());
    } catch {
      throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
    }
    const body = jobResultBodySchema.safeParse(raw);

    // 이미 끝난 작업(두 번째 결과·늦게 온 결과)은 아무것도 바꾸지 않는다 — 본문이 틀려도 같은 답(먼저 온 결과가 이긴다)
    if (job.status !== "queued" && job.status !== "running") return Response.json({ applied: false });
    // 홍보 이미지(SX-6.5)는 그 서비스가 반영한다 — 그림 저장 · 실패면 그날 횟수 원복(같은 트랜잭션)
    if (job.kind === "promo_image") return applyPromoImageJobResult(deps, job, raw);
    // 그 밖에 결과를 받는 종류는 포스터뿐이다(FAQ 초안은 SX-3 Task 가 더한다)
    if (job.kind !== "poster_extract") throw new HttpError("NOT_FOUND", NOT_FOUND);

    if (!body.success) {
      await closeInvalid(job.id, job.subject_id);
      throw new HttpError("VALIDATION_FAILED", "결과 모양이 맞지 않아요", {
        fields: body.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      });
    }

    if (body.data.status === "failed") {
      const code = (AI_JOB_ERROR_CODES as readonly string[]).includes(body.data.error.code) ? body.data.error.code : "EXTRACTION_FAILED";
      const applied = await closeFailed(job.id, job.subject_id, code);
      return Response.json({ applied });
    }

    const ok = body.data;
    // 칸 검사 — 칸 키 밖이거나 값 모양 밖이 하나라도 있으면 통째로 받지 않는다(16 §7-2 「스키마를 못 넘음」)
    const seen = new Map<PosterFieldKey, { value: PosterFieldValue; confidence: number | null }>();
    const problems: { path: string; message: string }[] = [];
    ok.result.fields.forEach((f, i) => {
      const key = POSTER_FIELD_KEYS.find((k) => k === f.key);
      if (key === undefined || seen.has(key)) {
        problems.push({ path: `result.fields.${i}.key`, message: "모르는 칸이거나 두 번 온 칸이에요" });
        return;
      }
      const checked = parseFieldValue(key, f.value);
      if (!checked.ok) {
        problems.push({ path: `result.fields.${i}.value`, message: checked.message });
        return;
      }
      // 값이 없으면 신뢰도도 없다(못 읽은 칸)
      seen.set(key, { value: checked.value, confidence: checked.value === null || f.confidence === null ? null : roundConfidence(f.confidence) });
    });
    if (problems.length > 0) {
      await closeInvalid(job.id, job.subject_id);
      throw new HttpError("VALIDATION_FAILED", "결과 모양이 맞지 않아요", { fields: problems });
    }

    const applied = await db.transaction(async (tx) => {
      // 작업을 먼저 닫는다(조건부) — 동시에 결과 둘이 와도 한쪽만 통과한다
      const closed = await tx.execute(
        tx.raw.sql`UPDATE ai_jobs SET status = 'succeeded', finished_at = now() WHERE id = ${job.id}::uuid AND status IN ('queued', 'running')`
          .affectedCount()
          .build(),
      );
      if (closed.affectedRows === 0) return false;
      // 칸 17개 전부 한 줄씩 — 결과에 없는 칸은 「못 읽음」(value NULL · 확인필요)
      for (const key of POSTER_FIELD_KEYS) {
        const got = seen.get(key) ?? { value: null, confidence: null };
        await tx.execute(
          tx.raw.sql`INSERT INTO poster_extraction_fields (extraction_id, field_key, value, confidence, needs_check, value_source, updated_at)
                     VALUES (${job.subject_id}::uuid, ${key}, NULLIF(${got.value === null ? "" : JSON.stringify(got.value)}, '')::json,
                             NULLIF(${got.confidence === null ? "" : String(got.confidence)}, '')::float8, ${needsCheckFor(got.value, got.confidence)}, 'ai', now())`
            .affectedCount()
            .build(),
        );
      }
      const overall = ok.result.overallConfidence;
      await tx.execute(
        tx.raw.sql`UPDATE poster_extractions
                   SET status = 'ready', overall_confidence = NULLIF(${overall === null ? "" : String(roundConfidence(overall))}, '')::float8,
                       model = NULLIF(${ok.result.model ?? ""}, ''), elapsed_ms = NULLIF(${String(ok.result.elapsedMs ?? ok.elapsedMs ?? "")}, '')::int4,
                       updated_at = now()
                   WHERE id = ${job.subject_id}::uuid AND status IN ('queued', 'running')`
          .affectedCount()
          .build(),
      );
      return true;
    });
    return Response.json({ applied });
  }, deps.env);

  /** 실패 결과 — 작업 failed · 읽기 failed(이유). 이미 끝났으면 false */
  async function closeFailed(jobId: string, extractionId: string, code: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const closed = await tx.execute(
        tx.raw.sql`UPDATE ai_jobs SET status = 'failed', finished_at = now(), error_code = ${code}
                   WHERE id = ${jobId}::uuid AND status IN ('queued', 'running')`
          .affectedCount()
          .build(),
      );
      if (closed.affectedRows === 0) return false;
      await tx.execute(
        tx.raw.sql`UPDATE poster_extractions SET status = 'failed', failure_code = ${posterFailureOf(code)}, updated_at = now()
                   WHERE id = ${extractionId}::uuid AND status IN ('queued', 'running')`
          .affectedCount()
          .build(),
      );
      return true;
    });
  }

  const closeInvalid = (jobId: string, extractionId: string) => closeFailed(jobId, extractionId, "INVALID_RESULT");

  return { file, result };
}
