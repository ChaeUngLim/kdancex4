// SX-2.3(검토 API) — 포스터 읽기 한 건을 DB 에서 읽어 계약 응답 모양으로 만든다(경로들이 함께 쓴다).
//   계약: _workspace/03_contracts/16-ai-agent.md §4-6 `GET …/poster-extractions/{extractionId}` 응답
//   데이터: data-model §13-5(poster_extractions · poster_extraction_fields)
import { z } from "zod";

import {
  POSTER_EXTRACTION_STATUSES,
  POSTER_FAILURE_CODES,
  POSTER_FIELD_KEYS,
  POSTER_TARGET_KINDS,
  POSTER_VALUE_SOURCES,
  type PosterFieldKey,
} from "../../domain/constants";
import type { PosterFieldValue } from "../../domain/poster-extraction";
import type { Tx } from "./staff-signup";
import type { Db } from "../../../prisma/db";

// ---- 응답 계약(16 §4-6) ---------------------------------------------------------------------

export const posterFieldOutSchema = z.strictObject({
  key: z.enum(POSTER_FIELD_KEYS),
  value: z.unknown(),
  confidence: z.number().min(0).max(1).nullable(),
  needsCheck: z.boolean(),
  valueSource: z.enum(POSTER_VALUE_SOURCES),
  confirmedAt: z.string().nullable(),
});

export const posterExtractionSchema = z.strictObject({
  extractionId: z.uuid(),
  status: z.enum(POSTER_EXTRACTION_STATUSES),
  targetKind: z.enum(POSTER_TARGET_KINDS),
  revision: z.int().min(1),
  overallConfidence: z.number().min(0).max(1).nullable(),
  reviewedAt: z.string().nullable(),
  submittedClassId: z.uuid().nullable(),
  fields: z.array(posterFieldOutSchema),
  // S2-2 검증(강의실·강사 일정 겹침)을 읽기 전용으로 돌린 결과. 포스터 칸에는 기간이 없어 회차를 만들 수 없으므로
  // 지금은 늘 빈 목록이다(EVIDENCE.md 「알려진 한계」). 겹침은 submit 이 S2-2 로 넘길 때 409 로 막힌다
  conflicts: z.array(z.strictObject({ kind: z.string(), message: z.string(), relatedClassId: z.uuid().nullable() })),
  failureCode: z.enum(POSTER_FAILURE_CODES).nullable(),
});
export type PosterExtraction = z.infer<typeof posterExtractionSchema>;

/** 게시 요청 응답(16 §4-6 submit) */
export const posterSubmitSchema = z.strictObject({
  extractionId: z.uuid(),
  classId: z.uuid(),
  approvalStatus: z.string(),
});
export type PosterSubmitResult = z.infer<typeof posterSubmitSchema>;

/** 시작 응답(16 §4-6 POST) */
export const posterStartSchema = z.strictObject({
  extractionId: z.uuid(),
  status: z.enum(POSTER_EXTRACTION_STATUSES),
  revision: z.int().min(1),
});

// ---- 행 읽기 --------------------------------------------------------------------------------

// 시각은 「…Z」 글자로, 빈 칸은 빈 글자로 읽는다 — 다른 서비스(class-registration.ts)와 같은 방식
const ISO = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

const EXTRACTION_ROW = {
  id: "pg/uuid@1",
  academy_id: "pg/uuid@1",
  uploaded_by: "pg/uuid@1",
  source_file_id: "pg/uuid@1",
  target_kind: "pg/text@1",
  status: "pg/text@1",
  revision: "pg/int4@1",
  overall_confidence: "pg/text@1",
  failure_code: "pg/text@1",
  job_id: "pg/text@1",
  reviewed_at: "pg/text@1",
  submitted_class_id: "pg/text@1",
} as const;

export type ExtractionRow = {
  id: string;
  academy_id: string;
  uploaded_by: string;
  source_file_id: string;
  target_kind: string;
  status: string;
  revision: number;
  overall_confidence: string;
  failure_code: string;
  job_id: string;
  reviewed_at: string;
  submitted_class_id: string;
};

/** 포스터 읽기 한 건. lock = true 면 그 행을 잠근다(트랜잭션 안에서만) */
export async function findExtraction(db: Db | Tx, extractionId: string, lock = false): Promise<ExtractionRow | null> {
  const query = lock
    ? db.raw.sql`SELECT id, academy_id, uploaded_by_staff_account_id AS uploaded_by, source_file_id, target_kind, status, revision,
                        COALESCE(overall_confidence::text, '') AS overall_confidence, COALESCE(failure_code, '') AS failure_code,
                        COALESCE(job_id::text, '') AS job_id,
                        COALESCE(to_char(reviewed_at AT TIME ZONE 'UTC', ${ISO}), '') AS reviewed_at,
                        COALESCE(submitted_class_id::text, '') AS submitted_class_id
                 FROM poster_extractions WHERE id = ${extractionId}::uuid FOR UPDATE`
    : db.raw.sql`SELECT id, academy_id, uploaded_by_staff_account_id AS uploaded_by, source_file_id, target_kind, status, revision,
                        COALESCE(overall_confidence::text, '') AS overall_confidence, COALESCE(failure_code, '') AS failure_code,
                        COALESCE(job_id::text, '') AS job_id,
                        COALESCE(to_char(reviewed_at AT TIME ZONE 'UTC', ${ISO}), '') AS reviewed_at,
                        COALESCE(submitted_class_id::text, '') AS submitted_class_id
                 FROM poster_extractions WHERE id = ${extractionId}::uuid`;
  const [row] = await db.query(query.returnsRow(EXTRACTION_ROW).build());
  return row ?? null;
}

const FIELD_ROW = {
  field_key: "pg/text@1",
  value: "pg/text@1",
  confidence: "pg/text@1",
  needs_check: "pg/bool@1",
  value_source: "pg/text@1",
  confirmed_at: "pg/text@1",
} as const;

export type FieldRow = {
  key: PosterFieldKey;
  value: PosterFieldValue;
  confidence: number | null;
  needsCheck: boolean;
  valueSource: (typeof POSTER_VALUE_SOURCES)[number];
  confirmedAt: string | null;
};

const textOrNull = (text: string): string | null => (text === "" ? null : text);
const instantOrNull = (text: string): string | null => (text === "" ? null : Temporal.Instant.from(text).toString());

/** 칸 행들 — 계약의 칸 순서(POSTER_FIELD_KEYS) 대로 돌려준다 */
export async function readFields(db: Db | Tx, extractionId: string): Promise<FieldRow[]> {
  const rows = await db.query(
    db.raw.sql`SELECT field_key, COALESCE(value::text, '') AS value, COALESCE(confidence::text, '') AS confidence, needs_check,
                      value_source, COALESCE(to_char(confirmed_at AT TIME ZONE 'UTC', ${ISO}), '') AS confirmed_at
               FROM poster_extraction_fields WHERE extraction_id = ${extractionId}::uuid`
      .returnsRow(FIELD_ROW)
      .build(),
  );
  const order = (key: string) => POSTER_FIELD_KEYS.indexOf(key as PosterFieldKey);
  return [...rows]
    .sort((a, b) => order(a.field_key) - order(b.field_key))
    .map((r) => ({
      key: r.field_key as PosterFieldKey,
      // 칸 값은 json 칸이다 — 글자로 읽어 되살린다(빈 글자 = SQL NULL = 값 없음)
      value: r.value === "" ? null : (JSON.parse(r.value) as PosterFieldValue),
      confidence: r.confidence === "" ? null : Number(r.confidence),
      needsCheck: r.needs_check,
      valueSource: r.value_source as FieldRow["valueSource"],
      confirmedAt: instantOrNull(r.confirmed_at),
    }));
}

/** 행 + 칸 → 계약 응답. 마지막에 응답 스키마로 한 번 거른다 */
export async function respondWithExtraction(db: Db | Tx, row: ExtractionRow): Promise<PosterExtraction> {
  const fields = await readFields(db, row.id);
  return posterExtractionSchema.parse({
    extractionId: row.id,
    status: row.status,
    targetKind: row.target_kind,
    revision: row.revision,
    overallConfidence: row.overall_confidence === "" ? null : Number(row.overall_confidence),
    reviewedAt: instantOrNull(row.reviewed_at),
    submittedClassId: textOrNull(row.submitted_class_id),
    fields,
    conflicts: [],
    failureCode: textOrNull(row.failure_code),
  });
}
