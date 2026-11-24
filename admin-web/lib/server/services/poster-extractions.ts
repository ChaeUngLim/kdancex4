// SX-2.3(검토 API) — 포스터 읽기의 앱 경로 다섯 개. 「AI 초안은 검토를 거쳐야만 S2-2 수업 등록 경로로 들어간다」를 API 수준에서 지킨다.
//   계약: _workspace/03_contracts/16-ai-agent.md §1-1 · §1-5 · §4-6 · §9(상태 전이) · §10 「검토 우회 없음」
//   데이터: data-model §13-3(ai_jobs) · §13-5(poster_extractions · poster_extraction_fields)
//   요구: FR-073(포스터 자동 추출) · FR-074(추출 검토 필수) · FR-075(확인필요 표시) · FR-076(게시 3종 동시 준비) · FR-050a(수업 등록 승인)
//
// 경로:
//   POST  /api/academies/{academyId}/poster-extractions                       포스터 올려 읽기 시작(에이전트에게 맡김)
//   GET   /api/academies/{academyId}/poster-extractions/{extractionId}        칸별 값·신뢰도·확인필요
//   PATCH /api/academies/{academyId}/poster-extractions/{extractionId}        검토 중 값 고치기(revision 낙관 잠금)
//   POST  …/{extractionId}/review                                             「검토 끝」 — 확인필요 칸이 남으면 409
//   POST  …/{extractionId}/submit                                             검토 끝난 초안 → S2-2 등록(임시 저장 + 승인 요청)
//
// 검토를 건너뛰는 길이 없는 이유(FR-074) — 세 겹으로 막는다.
//   ① submit 은 status = reviewed 일 때만 S2-2 를 부른다. ready(검토 전)·queued·failed 는 409 REVIEW_REQUIRED
//   ② 검토 뒤 값을 고치면(PATCH) reviewed → ready 로 돌아가 검토를 다시 해야 한다
//   ③ DB 의 ck_poster_reviewed 가 검토 칸(reviewed_at·reviewed_by) 없이 reviewed·submitted 가 되는 행을 거부한다
// 게시는 여기서 하지 않는다. submit 은 S2-2 의 「임시 저장 만들기 + 승인 요청」 처리기를 **그대로** 부르고(같은 권한·검증·겹침 거부),
// 공개는 S2-2.7(대표 승인)이 한다. 대표 본인이 올린 수업이 승인 요청과 함께 공개되는 것은 S2-2 의 기존 규칙(auto_published)이다.
//
// 누가:
//   시작 — 「수업 편집 직원」(16 §1-5) = S2-2 의 class_writer 판정 그대로(대표 · 소속 + 수업 등록 위임 강사)
//   읽기·고치기·검토·제출 — 올린 사람 · 그 학원 대표. 남의 읽기는 403, 다른 학원 경로로 부르면 404
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { POSTER_FIELD_KEYS, POSTER_TARGET_KINDS, type PosterFieldKey } from "../../domain/constants";
import { missingPeriodKeys, parseFieldValue, posterFieldKeySchema, toClassDraft, type ReviewedFields } from "../../domain/poster-extraction";
import type { AgentJobDispatcher } from "../ai/agent-jobs-client";
import type { StaffAccountContext } from "../guards";
import { HttpError, parseJsonBody, readIdempotencyKey, withRoute } from "../http";
import { classRegistrationSchema, createClassAccess, createClassRegistrationRoutes, type ClassRegistrationDeps } from "./class-registration";
import {
  findExtraction,
  posterStartSchema,
  posterSubmitSchema,
  readFields,
  respondWithExtraction,
  type ExtractionRow,
} from "./poster-extraction-reads";

const DETAIL = {
  notFound: "포스터 읽기를 찾을 수 없어요",
  forbidden: "이 포스터 읽기를 다룰 권한이 없어요",
  validation: "입력값을 확인해 주세요",
  fileNotUsable: "직접 올린 포스터 사진만 읽을 수 있어요",
  fileUnsupported: "JPEG·PNG·WebP 사진(10MB 이하)만 읽을 수 있어요",
  notReady: "아직 읽기가 끝나지 않았어요",
  revision: "그 사이 다른 곳에서 고쳤어요. 새로 불러온 뒤 다시 고쳐 주세요",
  incomplete: "확인필요 칸을 고치거나 맞다고 확인해 주세요",
  reviewRequired: "검토를 마친 뒤에 등록할 수 있어요",
  periodRequired: "개강일과 종료일(또는 회차 수)을 채워야 등록할 수 있어요",
} as const;

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** 에이전트가 끝내야 하는 기한(계약 16 §4-6 추천 120초) — 넘기면 sweep 이 닫는다 */
export const POSTER_JOB_DEADLINE_MS = 120_000;
/** 포스터로 받는 사진 형식(16 §1-5 POSTER_FILE_UNSUPPORTED). PDF 는 파일 경로가 받아도 읽기는 못 한다 */
const POSTER_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

// ---- 요청 본문 ------------------------------------------------------------------------------

const startBodySchema = z.strictObject({ fileId: z.uuid(), targetKind: z.enum(POSTER_TARGET_KINDS) });
const patchBodySchema = z.strictObject({
  revision: z.int().min(1),
  fields: z
    .array(z.strictObject({ key: posterFieldKeySchema, value: z.unknown() }))
    .min(1)
    .max(POSTER_FIELD_KEYS.length)
    .refine((fields) => new Set(fields.map((f) => f.key)).size === fields.length, "같은 칸을 두 번 보냈어요"),
});
const reviewBodySchema = z.strictObject({
  revision: z.int().min(1),
  confirmedKeys: z.array(posterFieldKeySchema).max(POSTER_FIELD_KEYS.length).default([]),
});
const submitBodySchema = z.strictObject({});
const idSchema = z.uuid();

/** S2-2 임시 저장의 멱등키 — 포스터 읽기 하나에 수업 임시 저장 하나(다시 submit 해도 두 벌 생기지 않는다) */
export const posterClassIdempotencyKey = (extractionId: string): string => `poster-extraction:${extractionId}`;

export type PosterExtractionDeps = ClassRegistrationDeps & {
  /** 에이전트에게 작업을 맡기는 연결. 테스트는 가짜를 넘긴다 */
  dispatchJob: AgentJobDispatcher;
};

type ExtractionParams = { params: Promise<{ academyId: string; extractionId: string }> };

export function createPosterExtractionRoutes(deps: PosterExtractionDeps) {
  const { db } = deps;
  const { readStaff, requireClassWriter } = createClassAccess(deps);
  // submit 이 부르는 S2-2 처리기 — 포스터 경로만의 등록 길을 따로 만들지 않는다(같은 권한·검증·겹침 거부를 거친다)
  const classes = createClassRegistrationRoutes(deps);

  const roleOf = (staff: StaffAccountContext, academyId: string) => (staff.actor.ownedAcademyIds.includes(academyId) ? "owner" : "instructor");

  /** 경로의 읽기 한 건 + 다룰 수 있나(올린 사람 · 그 학원 대표). 다른 학원 경로로 부르면 없는 것과 같다(404) */
  async function loadAccessible(context: ExtractionParams, staff: StaffAccountContext): Promise<ExtractionRow> {
    const { academyId, extractionId } = await context.params;
    if (!idSchema.safeParse(academyId).success || !idSchema.safeParse(extractionId).success) {
      throw new HttpError("NOT_FOUND", DETAIL.notFound);
    }
    const row = await findExtraction(db, extractionId);
    if (row === null || row.academy_id !== academyId) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    if (!staff.actor.ownedAcademyIds.includes(row.academy_id) && row.uploaded_by !== staff.staffAccountId) {
      throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    }
    return row;
  }

  async function reread(id: string): Promise<ExtractionRow> {
    const row = await findExtraction(db, id);
    if (row === null) throw new Error("방금 다룬 포스터 읽기를 다시 읽지 못했다");
    return row;
  }

  // ---- ① POST …/poster-extractions — 읽기 시작 ---------------------------------------------------

  const start = withRoute<{ params: Promise<{ academyId: string }> }>(async (request, context) => {
    const staff = await readStaff(request);
    const key = readIdempotencyKey(request, { required: true });
    void key; // 멱등은 「파일 하나에 읽기 하나」(uq_poster_source_file)가 맡는다 — 같은 파일로 다시 오면 처음 읽기를 돌려준다
    const { academyId } = await context.params;
    if (!idSchema.safeParse(academyId).success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const body = await parseJsonBody(request, startBodySchema);
    await requireClassWriter(request, staff, academyId);

    // 파일 확인 — 내가 올린 poster 파일만(남의 것·다른 목적·없는 파일은 같은 422 — 남의 fileId 를 떠보지 못하게)
    const [file] = await db.query(
      db.raw.sql`SELECT mime_type FROM uploaded_files
                 WHERE id = ${body.fileId}::uuid AND uploader_account_id = ${staff.staffAccountId}::uuid AND purpose = 'poster'`
        .returnsRow({ mime_type: "pg/text@1" })
        .build(),
    );
    if (file === undefined) {
      throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path: "fileId", message: DETAIL.fileNotUsable }] });
    }
    if (!(POSTER_IMAGE_MIME as readonly string[]).includes(file.mime_type)) {
      throw HttpError.unprocessable("POSTER_FILE_UNSUPPORTED", DETAIL.fileUnsupported, {
        fields: [{ path: "fileId", message: DETAIL.fileUnsupported }],
      });
    }

    // 같은 파일로 이미 읽기가 있으면 그것을 돌려준다(두 번 눌러도 작업이 둘 생기지 않는다)
    const [existing] = await db.query(
      db.raw.sql`SELECT id FROM poster_extractions WHERE source_file_id = ${body.fileId}::uuid`.returnsRow({ id: "pg/uuid@1" }).build(),
    );
    if (existing !== undefined) {
      const row = await reread(existing.id);
      if (row.academy_id !== academyId) {
        throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path: "fileId", message: DETAIL.fileNotUsable }] });
      }
      return Response.json(posterStartSchema.parse({ extractionId: row.id, status: row.status, revision: row.revision }), {
        status: 200,
        headers: NO_STORE,
      });
    }

    // 한 트랜잭션: 작업 한 줄 → 읽기 한 줄(job_id 로 작업을 가리킨다) → 파일 「주인 있음」 표시
    const extractionId = randomUUID();
    const jobId = randomUUID();
    const deadline = Temporal.Now.instant().add({ milliseconds: POSTER_JOB_DEADLINE_MS }).toString();
    const created = await db
      .transaction(async (tx) => {
        await tx.execute(
          tx.raw.sql`INSERT INTO ai_jobs (id, kind, status, subject_id, deadline_at)
                     VALUES (${jobId}::uuid, 'poster_extract', 'queued', ${extractionId}::uuid, ${deadline}::timestamptz)`
            .affectedCount()
            .build(),
        );
        const inserted = await tx.execute(
          tx.raw.sql`INSERT INTO poster_extractions (id, academy_id, uploaded_by_staff_account_id, source_file_id, target_kind, status,
                                                     job_id, updated_at)
                     VALUES (${extractionId}::uuid, ${academyId}::uuid, ${staff.staffAccountId}::uuid, ${body.fileId}::uuid,
                             ${body.targetKind}, 'queued', ${jobId}::uuid, now())
                     ON CONFLICT (source_file_id) DO NOTHING`
            .affectedCount()
            .build(),
        );
        // 동시에 같은 파일로 두 번 왔다 — 먼저 들어간 쪽이 이긴다. 이쪽 작업 행도 지우려고 롤백한다
        if (inserted.affectedRows === 0) throw new LostStartRace();
        // 24시간 정리 작업(S1-1.35)이 읽는 중인 원본을 지우지 않게
        await tx.execute(
          tx.raw.sql`UPDATE uploaded_files SET attached_at = COALESCE(attached_at, now()) WHERE id = ${body.fileId}::uuid`.affectedCount().build(),
        );
        return true;
      })
      .catch((error: unknown) => {
        if (error instanceof LostStartRace) return false;
        throw error;
      });
    if (!created) {
      const [winner] = await db.query(
        db.raw.sql`SELECT id FROM poster_extractions WHERE source_file_id = ${body.fileId}::uuid`.returnsRow({ id: "pg/uuid@1" }).build(),
      );
      if (winner === undefined) throw new Error("동시 시작 뒤 이긴 포스터 읽기를 찾지 못했다");
      const row = await reread(winner.id);
      return Response.json(posterStartSchema.parse({ extractionId: row.id, status: row.status, revision: row.revision }), { headers: NO_STORE });
    }

    // 커밋 뒤 에이전트에게 맡긴다. 에이전트는 202 를 준 뒤 곧바로 원본을 받으러 오므로(파일 경로는 running 일 때만 열린다)
    // 먼저 running 으로 바꾸고 맡긴다. 받지 않으면 queued 로 되돌린다 — sweep 이 기한 뒤 AGENT_UNAVAILABLE 로 닫는다(16 §4-6)
    await markJob(jobId, extractionId, "running");
    const accepted = await deps.dispatchJob({
      jobId,
      kind: "poster_extract",
      deadlineMs: POSTER_JOB_DEADLINE_MS,
      payload: { extractionId, fileUrl: `/api/internal/ai/jobs/${jobId}/file`, targetKind: body.targetKind, fieldKeys: POSTER_FIELD_KEYS },
    });
    if (!accepted) await markJob(jobId, extractionId, "queued");

    const row = await reread(extractionId);
    return Response.json(posterStartSchema.parse({ extractionId: row.id, status: row.status, revision: row.revision }), {
      status: 202,
      headers: NO_STORE,
    });
  });

  /** 작업·읽기를 함께 queued ↔ running 으로. 그 사이 결과가 먼저 와서 끝났으면(ready·failed) 건드리지 않는다 */
  async function markJob(jobId: string, extractionId: string, to: "running" | "queued"): Promise<void> {
    const from = to === "running" ? "queued" : "running";
    await db.transaction(async (tx) => {
      await tx.execute(
        tx.raw.sql`UPDATE ai_jobs SET status = ${to}, accepted_at = CASE WHEN ${to} = 'running' THEN now() END
                   WHERE id = ${jobId}::uuid AND status = ${from}`
          .affectedCount()
          .build(),
      );
      await tx.execute(
        tx.raw.sql`UPDATE poster_extractions SET status = ${to}, updated_at = now() WHERE id = ${extractionId}::uuid AND status = ${from}`
          .affectedCount()
          .build(),
      );
    });
  }

  // ---- ② GET …/{extractionId} — 상태와 칸 --------------------------------------------------------

  const read = withRoute<ExtractionParams>(async (request, context) => {
    const staff = await readStaff(request);
    const row = await loadAccessible(context, staff);
    return Response.json(await respondWithExtraction(db, row), { headers: NO_STORE });
  });

  // ---- ③ PATCH …/{extractionId} — 검토 중 값 고치기 ------------------------------------------------

  const patch = withRoute<ExtractionParams>(async (request, context) => {
    const staff = await readStaff(request);
    const row = await loadAccessible(context, staff);
    const body = await parseJsonBody(request, patchBodySchema);

    // 칸마다 값 모양을 본다 — 틀린 칸은 한꺼번에 알려 준다
    const problems = body.fields.flatMap((f) => {
      const checked = parseFieldValue(f.key, f.value);
      return checked.ok ? [] : [{ path: `fields.${f.key}`, message: checked.message }];
    });
    if (problems.length > 0) throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: problems });

    await db.transaction(async (tx) => {
      const locked = await findExtraction(tx, row.id, true);
      if (locked === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);
      if (locked.status !== "ready" && locked.status !== "reviewed") throw HttpError.conflict("POSTER_NOT_READY", DETAIL.notReady);
      if (locked.revision !== body.revision) throw HttpError.conflict("POSTER_REVISION_CONFLICT", DETAIL.revision);

      for (const f of body.fields) {
        const checked = parseFieldValue(f.key, f.value);
        if (!checked.ok) throw new Error("검사를 통과한 값이 다시 실패했다");
        // 누가 채웠나: AI 가 읽은 값을 고치면 ai_edited, AI 가 못 읽은(빈) 칸을 채우면 user. 사람이 고친 칸은 확인필요가 아니다
        await tx.execute(
          tx.raw.sql`UPDATE poster_extraction_fields
                     SET value = ${JSON.stringify(checked.value)}::json,
                         value_source = CASE WHEN value_source = 'ai' AND value IS NOT NULL THEN 'ai_edited'
                                             WHEN value_source = 'ai' THEN 'user' ELSE value_source END,
                         needs_check = false, confirmed_at = NULL, updated_at = now()
                     WHERE extraction_id = ${row.id}::uuid AND field_key = ${f.key}`
            .affectedCount()
            .build(),
        );
      }
      // revision +1. 검토 끝(reviewed)이었으면 ready 로 돌리고 검토 칸을 비운다 — 고친 값은 다시 검토해야 한다(FR-074)
      await tx.execute(
        tx.raw.sql`UPDATE poster_extractions
                   SET revision = revision + 1, status = 'ready', reviewed_at = NULL, reviewed_by_staff_account_id = NULL, updated_at = now()
                   WHERE id = ${row.id}::uuid`
          .affectedCount()
          .build(),
      );
    });
    return Response.json(await respondWithExtraction(db, await reread(row.id)), { headers: NO_STORE });
  });

  // ---- ④ POST …/{extractionId}/review — 「검토 끝」 ------------------------------------------------

  const review = withRoute<ExtractionParams>(async (request, context) => {
    const staff = await readStaff(request);
    const row = await loadAccessible(context, staff);
    const body = await parseJsonBody(request, reviewBodySchema);

    // 이미 검토 끝(또는 제출까지 끝)이면 같은 본문
    if (row.status === "reviewed" || row.status === "submitted") {
      return Response.json(await respondWithExtraction(db, row), { headers: NO_STORE });
    }

    await db.transaction(async (tx) => {
      const locked = await findExtraction(tx, row.id, true);
      if (locked === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);
      if (locked.status === "reviewed") return;
      if (locked.status !== "ready") throw HttpError.conflict("POSTER_NOT_READY", DETAIL.notReady);
      if (locked.revision !== body.revision) throw HttpError.conflict("POSTER_REVISION_CONFLICT", DETAIL.revision);

      // 비어서 채워야 하는 기간 칸(SX-2.6, FR-073 하위 불릿) — 이 칸은 「맞다」(confirmedKeys)로 넘길 수 없다.
      // 사람이 PATCH 로 비운 칸(needs_check = false)도 여기서 잡힌다. 값을 넣어야만 풀린다
      const values: ReviewedFields = Object.fromEntries((await readFields(tx, row.id)).map((f) => [f.key, f.value]));
      const mustFill: PosterFieldKey[] = missingPeriodKeys(values);
      const confirmable = body.confirmedKeys.filter((k) => !mustFill.includes(k));

      // 「맞다」고 확인한 칸 — 확인필요를 내리고 확인 시각을 쓴다. 값은 그대로(AI 값이면 「AI 생성」 표시도 그대로)
      if (confirmable.length > 0) {
        await tx.execute(
          tx.raw.sql`UPDATE poster_extraction_fields SET needs_check = false, confirmed_at = now(), updated_at = now()
                     WHERE extraction_id = ${row.id}::uuid AND needs_check AND field_key IN (SELECT jsonb_array_elements_text(${JSON.stringify(confirmable)}::jsonb))`
            .affectedCount()
            .build(),
        );
      }
      // 아직 확인필요가 남았나(+ 채워야 하는 기간 칸) — 남으면 409 + 칸 이름(롤백되어 위 확인도 남지 않는다. 화면이 한 번에 다시 보낸다)
      const left = await tx.query(
        tx.raw.sql`SELECT field_key FROM poster_extraction_fields WHERE extraction_id = ${row.id}::uuid AND needs_check`
          .returnsRow({ field_key: "pg/text@1" })
          .build(),
      );
      const leftKeys = new Set<string>([...left.map((r) => r.field_key), ...mustFill]);
      if (leftKeys.size > 0) {
        const order = (k: string) => POSTER_FIELD_KEYS.indexOf(k as PosterFieldKey);
        const unresolved = [...leftKeys].sort((a, b) => order(a) - order(b));
        throw HttpError.conflict("POSTER_REVIEW_INCOMPLETE", DETAIL.incomplete, { unresolved });
      }
      await tx.execute(
        tx.raw.sql`UPDATE poster_extractions SET status = 'reviewed', reviewed_at = now(), reviewed_by_staff_account_id = ${staff.staffAccountId}::uuid,
                          updated_at = now()
                   WHERE id = ${row.id}::uuid AND status = 'ready'`
          .affectedCount()
          .build(),
      );
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, after)
                   VALUES (uuidv7(), 'staff', ${staff.staffAccountId}::uuid, ${roleOf(staff, row.academy_id)}, ${row.academy_id}::uuid,
                           'poster_extraction.reviewed', 'poster_extractions', ${row.id}::uuid,
                           ${JSON.stringify({ revision: locked.revision, confirmedKeys: body.confirmedKeys })}::json)`
          .affectedCount()
          .build(),
      );
    });
    return Response.json(await respondWithExtraction(db, await reread(row.id)), { headers: NO_STORE });
  });

  // ---- ⑤ POST …/{extractionId}/submit — 검토 끝난 초안 → S2-2 등록 -----------------------------------

  const submit = withRoute<ExtractionParams>(async (request, context) => {
    const staff = await readStaff(request);
    readIdempotencyKey(request, { required: true });
    const row = await loadAccessible(context, staff);
    await readEmptyBody(request);

    // 이미 제출됐으면 같은 본문(두 번 눌러도 수업이 둘 생기지 않는다)
    if (row.status === "submitted") return Response.json(await submittedBody(row), { headers: NO_STORE });
    // 검토 끝이 아니면 S2-2 로 넘기지 않는다 — ready(검토 전)에서 곧바로 부르는 경우 포함(SX-2.3 「검토 없이 게시 요청 거부」)
    if (row.status !== "reviewed") throw HttpError.conflict("REVIEW_REQUIRED", DETAIL.reviewRequired);

    // 검토된 값 → S2-2 임시 저장 본문. 홀·담당 강사는 이름을 그 학원의 id 로 바꾼다(못 찾으면 비워 두고 S2-2 가 알려 준다)
    const fields: ReviewedFields = Object.fromEntries((await readFields(db, row.id)).map((f) => [f.key, f.value]));
    // 기간이 비었으면 수업을 만들지 않고 409(SX-2.6). 검토가 이미 막지만, 기간 칸이 생기기 전에 검토를 끝낸 읽기도 여기서 걸린다
    const missingPeriod = missingPeriodKeys(fields);
    if (missingPeriod.length > 0) {
      throw HttpError.conflict("POSTER_PERIOD_REQUIRED", DETAIL.periodRequired, { missingFields: missingPeriod });
    }
    const draft = toClassDraft(fields, {
      academyId: row.academy_id,
      roomId: await findRoomId(row.academy_id, fields.room_name),
      instructorAccountId: staff.actor.ownedAcademyIds.includes(row.academy_id)
        ? await findInstructorId(row.academy_id, fields.instructor_name)
        : null,
    });

    // ① 임시 저장 — 이미 이 읽기로 만든 임시 저장이 있으면(앞 submit 이 승인 요청에서 막혔던 경우) 그것을 쓴다.
    //    그 사이 사람이 수업 편집(PUT /api/classes/{id})에서 빠진 칸(기간 등)을 채웠을 수 있으므로 다시 덮어쓰지 않는다
    const idempotencyKey = posterClassIdempotencyKey(row.id);
    let classId = await findPosterDraft(row.academy_id, idempotencyKey);
    if (classId === null) {
      const created = await classes.create(forward(request, "/api/classes", idempotencyKey, JSON.stringify(draft)), undefined);
      // S2-2 가 거부하면(권한·장르·칸 모양) 그 계약의 오류를 그대로 돌려준다. 읽기는 reviewed 로 남는다.
      // 422 면 빠진 칸(missingFields)만 더한다 — 아직 수업을 못 만들었으니 classId 는 없다(예: 대표가 올렸는데 담당 강사를 못 찾음)
      if (created.status === 422) return await withMissingFields(created, null);
      if (created.status !== 201 && created.status !== 200) return created;
      classId = classRegistrationSchema.parse(await created.json()).classId;
    }

    // ② 승인 요청 — S2-2 의 완성 검사·겹침 거부·환불 공지·게시 판정이 그대로 돈다
    const submitted = await classes.submit(forward(request, `/api/classes/${classId}/submit`, null, "{}"), {
      params: Promise.resolve({ classId }),
    });
    // S2-2 가 빠진 칸(일정 · 적정 연령 등)으로 422 를 내면, 만들어 둔 임시 저장 id 와 빠진 칸을 붙여 돌려준다(SX-2.6, FR-073 하위 불릿) —
    // 화면이 그 수업의 수정 폼으로 바로 보낼 수 있게. 다른 거절(409 겹침 등)은 S2-2 본문 그대로
    if (submitted.status === 422) return await withMissingFields(submitted, classId);
    if (submitted.status !== 200) return submitted;
    const registration = classRegistrationSchema.parse(await submitted.json());

    // ③ 읽기를 submitted 로 — 그 사이 값이 고쳐졌으면(PATCH → ready) 0행이라 409(만든 수업은 S2-2 에서 등록 취소할 수 있다)
    const moved = await db.transaction(async (tx) => {
      const done = await tx.execute(
        tx.raw.sql`UPDATE poster_extractions SET status = 'submitted', submitted_class_id = ${classId}::uuid, submitted_at = now(), updated_at = now()
                   WHERE id = ${row.id}::uuid AND status = 'reviewed' AND revision = ${row.revision}`
          .affectedCount()
          .build(),
      );
      if (done.affectedRows === 0) return false;
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, after)
                   VALUES (uuidv7(), 'staff', ${staff.staffAccountId}::uuid, ${roleOf(staff, row.academy_id)}, ${row.academy_id}::uuid,
                           'poster_extraction.submitted', 'poster_extractions', ${row.id}::uuid,
                           ${JSON.stringify({ classId, approvalStatus: registration.status })}::json)`
          .affectedCount()
          .build(),
      );
      return true;
    });
    if (!moved) {
      const now = await reread(row.id);
      if (now.status === "submitted") return Response.json(await submittedBody(now), { headers: NO_STORE });
      throw HttpError.conflict("REVIEW_REQUIRED", DETAIL.reviewRequired);
    }
    const body = posterSubmitSchema.parse({ extractionId: row.id, classId, approvalStatus: registration.status });
    return Response.json(body, { status: 201, headers: NO_STORE });
  });

  async function submittedBody(row: ExtractionRow) {
    const [cls] = await db.query(
      db.raw.sql`SELECT status FROM classes WHERE id = ${row.submitted_class_id}::uuid`.returnsRow({ status: "pg/text@1" }).build(),
    );
    return posterSubmitSchema.parse({ extractionId: row.id, classId: row.submitted_class_id, approvalStatus: cls?.status ?? "draft" });
  }

  /** 포스터의 장소 이름 → 그 학원의 active 홀(이름이 정확히 같은 것 하나). 없거나 둘 이상이면 null */
  async function findRoomId(academyId: string, name: unknown): Promise<string | null> {
    if (typeof name !== "string") return null;
    const rows = await db.query(
      db.raw.sql`SELECT r.id FROM rooms r JOIN academy_branches b ON b.id = r.branch_id
                 WHERE b.academy_id = ${academyId}::uuid AND r.status = 'active' AND r.name = ${name.trim()}`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    return rows.length === 1 ? (rows[0]?.id ?? null) : null;
  }

  /** 포스터의 강사 이름 → 그 학원 active 소속 강사(표시 이름이 정확히 같은 사람 하나). 대표가 올릴 때만 쓴다 */
  async function findInstructorId(academyId: string, name: unknown): Promise<string | null> {
    if (typeof name !== "string") return null;
    const rows = await db.query(
      db.raw.sql`SELECT s.id FROM instructor_affiliations a JOIN staff_accounts s ON s.id = a.instructor_account_id
                 WHERE a.academy_id = ${academyId}::uuid AND a.status = 'active' AND s.display_name = ${name.trim()}`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    return rows.length === 1 ? (rows[0]?.id ?? null) : null;
  }

  async function findPosterDraft(academyId: string, idempotencyKey: string): Promise<string | null> {
    const [found] = await db.query(
      db.raw.sql`SELECT id FROM classes WHERE academy_id = ${academyId}::uuid AND idempotency_key = ${idempotencyKey}`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    return found?.id ?? null;
  }

  return { start, read, patch, review, submit };
}

/**
 * S2-2 의 422 본문에 `missingFields`(빠진 칸 — S2-2 칸 이름의 첫 마디, 중복 없이)와, 임시 저장을 만들었으면 `classId` 를 더한다.
 * 예: fields 의 path 가 "schedule" · "targetAges" 면 missingFields = ["schedule", "targetAges"]. 나머지 칸(code · detail · fields)은 그대로 둔다.
 */
async function withMissingFields(rejected: Response, classId: string | null): Promise<Response> {
  const body = (await rejected.json()) as { fields?: { path?: unknown }[] } & Record<string, unknown>;
  const paths = (body.fields ?? []).map((f) => (typeof f.path === "string" ? (f.path.split(".")[0] ?? f.path) : "")).filter((p) => p !== "");
  const missingFields = [...new Set(paths)];
  return Response.json(classId === null ? { ...body, missingFields } : { ...body, classId, missingFields }, { status: 422, headers: NO_STORE });
}

/** 게시 요청 본문은 비어 있다(계약 「본문 없음」). `{}` 는 받고, 다른 칸이 있으면 422 */
async function readEmptyBody(request: Request): Promise<void> {
  const text = await request.text();
  if (text.trim() === "") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
  }
  if (!submitBodySchema.safeParse(parsed).success) throw new HttpError("VALIDATION_FAILED", DETAIL.validation);
}

/** 동시에 같은 파일로 두 번 시작했을 때 진 쪽 — 트랜잭션을 되돌리는 신호 */
class LostStartRace extends Error {}

/**
 * S2-2 처리기에 넘길 요청 — 부른 사람의 로그인(쿠키·Bearer)을 그대로 옮긴다.
 * 그래서 S2-2 는 「포스터 경로가 불렀다」가 아니라 「이 직원이 불렀다」로 판정한다(위임·2단계·소속이 똑같이 걸린다).
 */
function forward(request: Request, path: string, idempotencyKey: string | null, body: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["authorization", "cookie"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (idempotencyKey !== null) headers.set("Idempotency-Key", idempotencyKey);
  return new Request(new URL(path, request.url), { method: "POST", headers, body });
}
