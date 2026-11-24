// S7-2.5(신고 접수·처리) — 신고 경로의 요청·응답 모양(zod).
//   계약: _workspace/03_contracts/15-ops.md §2-7(신고 — 보드 C11A · 운영자 처리)
//
// 이 파일은 경계 검증과 모양만 맡는다. DB 를 읽지 않는다.
// 응답 스키마는 테스트가 응답 본문을 parse 해 키 이름·타입을 1대1로 확인하는 데 쓴다(strict — 모르는 키가 있으면 실패).
import { z } from "zod";

import { REPORT_OUTCOMES, REPORT_REASON_CODES, REPORT_REPORTER_KINDS, REPORT_STATUSES, REPORT_TARGET_KINDS } from "../../domain/constants";
import { REPORT_DETAIL_MAX, REPORT_NOTE_MAX, REPORT_STEPS } from "../../domain/report";
import { RESTRICTION_MEASURES } from "../../domain/restriction";

/** 첨부는 한 신고에 5개까지(문의와 같은 값). S7-2.7 이 attachment_links 로 붙인다 */
export const REPORT_ATTACHMENT_MAX = 5;

/** 이용 제한 조치 종류(계약 §2-8 `plannedMeasure`) — 신고 처리에서 절차를 열 때 고른다. 값의 원본은 lib/domain/restriction.ts(S7-2.6) */
export { RESTRICTION_MEASURES };

const isoInstant = z.iso.datetime();

/**
 * `POST /api/reports` 본문(계약 §2-7). 신고자 역할이 그 대상을 고를 수 있는지는
 * 서버가 세션으로 역할을 알아낸 뒤 판정한다(lib/domain/report.ts) — 여기서는 값의 모양만 본다.
 */
export const createReportSchema = z.strictObject({
  targetKind: z.enum(REPORT_TARGET_KINDS),
  targetId: z.uuid(),
  reasonCode: z.enum(REPORT_REASON_CODES),
  // 상세 글은 비워도 된다(빈 글자는 null 로 맞춘다)
  detail: z
    .string()
    .trim()
    .max(REPORT_DETAIL_MAX, `${REPORT_DETAIL_MAX}자 이하로 적어 주세요`)
    .nullish()
    .transform((value) => (value === undefined || value === null || value === "" ? null : value)),
  attachmentFileIds: z.array(z.uuid()).max(REPORT_ATTACHMENT_MAX).optional().default([]),
});
export type CreateReport = z.output<typeof createReportSchema>;

/** `POST /api/reports` 응답(처음 201 · 재생·같은 신고 200 — 모양은 같다) */
export const reportCreatedSchema = z.strictObject({
  reportId: z.uuid(),
  status: z.enum(REPORT_STATUSES),
  steps: z.array(z.enum(REPORT_STEPS)),
  receivedAt: isoInstant,
});
export type ReportCreated = z.output<typeof reportCreatedSchema>;

/** `GET /api/reports` 한 줄 — 내 신고. 상대에게 한 조치 내용·운영자 메모는 싣지 않는다 */
export const myReportItemSchema = z.strictObject({
  reportId: z.uuid(),
  targetKind: z.enum(REPORT_TARGET_KINDS),
  targetLabel: z.string(),
  reasonCode: z.enum(REPORT_REASON_CODES),
  status: z.enum(REPORT_STATUSES),
  outcomeLabel: z.string().nullable(),
  receivedAt: isoInstant,
  resolvedAt: isoInstant.nullable(),
});
export const myReportListSchema = z.strictObject({ items: z.array(myReportItemSchema) });
export type MyReportList = z.output<typeof myReportListSchema>;

/** `GET /api/admin/reports?status=&cursor=&limit=` 쿼리 — 모르는 칸은 422 */
export const adminReportQuerySchema = z.strictObject({
  status: z.enum(REPORT_STATUSES).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** 운영자 신고함 한 줄 — 신고자는 역할 + 닉네임만(`reporterLabel`), 대상 정보는 포함 */
export const adminReportItemSchema = z.strictObject({
  reportId: z.uuid(),
  status: z.enum(REPORT_STATUSES),
  reporterKind: z.enum(REPORT_REPORTER_KINDS),
  reporterLabel: z.string(),
  target: z.strictObject({ kind: z.enum(REPORT_TARGET_KINDS), id: z.uuid(), label: z.string() }),
  reasonCode: z.enum(REPORT_REASON_CODES),
  reasonLabel: z.string(),
  detail: z.string().nullable(),
  outcome: z.enum(REPORT_OUTCOMES).nullable(),
  receivedAt: isoInstant,
  reviewedAt: isoInstant.nullable(),
  resolvedAt: isoInstant.nullable(),
  // 신고 첨부 — 운영자가 GET /api/files/{fileId} 로 연다(S7-2.7 — 추천안·사후 확인 2026-11-24)
  attachments: z.array(z.strictObject({ fileId: z.uuid(), displayName: z.string() })),
});
export const adminReportListSchema = z.strictObject({
  items: z.array(adminReportItemSchema),
  nextCursor: z.string().nullable(),
});
export type AdminReportList = z.output<typeof adminReportListSchema>;

/** `POST /api/admin/reports/{reportId}/start-review` 응답 */
export const reportReviewStartedSchema = z.strictObject({ reportId: z.uuid(), status: z.enum(REPORT_STATUSES) });
export type ReportReviewStarted = z.output<typeof reportReviewStartedSchema>;

/** `POST /api/admin/reports/{reportId}/resolve` 본문(계약 §2-7) */
export const resolveReportSchema = z.strictObject({
  outcome: z.enum(REPORT_OUTCOMES),
  note: z
    .string()
    .trim()
    .max(REPORT_NOTE_MAX, `${REPORT_NOTE_MAX}자 이하로 적어 주세요`)
    .nullish()
    .transform((value) => (value === undefined || value === null || value === "" ? null : value)),
  openRestriction: z
    .strictObject({ measure: z.enum(RESTRICTION_MEASURES), reasonText: z.string().trim().min(1).max(REPORT_NOTE_MAX) })
    .nullish()
    .transform((value) => value ?? null),
});
export type ResolveReport = z.output<typeof resolveReportSchema>;

/** `POST /api/admin/reports/{reportId}/resolve` 응답 */
export const reportResolvedSchema = z.strictObject({
  reportId: z.uuid(),
  status: z.literal("resolved"),
  restrictionCaseId: z.uuid().nullable(),
});
export type ReportResolved = z.output<typeof reportResolvedSchema>;
