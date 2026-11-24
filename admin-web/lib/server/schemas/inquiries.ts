// S7-2.2(문의 생성과 조회 권한) — 문의 경로의 요청·응답 모양(zod).
//   계약: _workspace/03_contracts/15-ops.md §2-2(`POST·GET /api/inquiries` · `GET /api/inquiries/{inquiryId}`)
//         · §2-4(`GET /api/academies/{academyId}/inquiries`) · §2-5(`GET /api/admin/inquiries`)
//
// 이 파일은 경계 검증과 모양만 맡는다. DB 를 읽지 않는다.
// 응답 스키마는 테스트가 응답 본문을 parse 해 키 이름·타입을 1대1로 확인하는 데 쓴다(strict — 모르는 키가 있으면 실패).
import { z } from "zod";

import {
  INQUIRY_ASKER_KINDS,
  INQUIRY_CATEGORIES,
  INQUIRY_KINDS,
  INQUIRY_MESSAGE_SENDER_KINDS,
  INQUIRY_ROUTES,
  INQUIRY_STATUSES,
} from "../../domain/constants";
import { INQUIRY_BODY_MAX } from "../../domain/inquiry";

/** 첨부는 한 글에 5개까지(추천안 — S7-2.7 이 실제로 붙인다. 지금은 빈 목록만 받는다) */
export const INQUIRY_ATTACHMENT_MAX = 5;

/** 비어 있으면 null 로 맞춘다 — 「안 보냄」과 「null」을 같게 본다 */
const optionalUuid = z.uuid().nullish().transform((value) => value ?? null);

/**
 * `POST /api/inquiries` 본문(계약 §2-2). 받는 곳(`kind`)과 종류(`category`)가 묻는 사람의 역할에 맞는지는
 * 서버가 세션으로 역할을 알아낸 뒤 판정한다(lib/domain/inquiry.ts) — 여기서는 값의 모양만 본다.
 */
export const createInquirySchema = z.strictObject({
  kind: z.enum(INQUIRY_KINDS),
  academyId: optionalUuid,
  category: z.enum(INQUIRY_CATEGORIES),
  reservationId: optionalUuid,
  offeringId: optionalUuid,
  body: z
    .string()
    .trim()
    .min(1, "문의 내용을 적어 주세요")
    .max(INQUIRY_BODY_MAX, `${INQUIRY_BODY_MAX}자 이하로 적어 주세요`),
  relatedSettlementRef: optionalUuid,
  attachmentFileIds: z.array(z.uuid()).max(INQUIRY_ATTACHMENT_MAX).optional().default([]),
});
export type CreateInquiry = z.output<typeof createInquirySchema>;

const isoInstant = z.iso.datetime();

/** `POST /api/inquiries` 응답(처음 201 · 같은 열쇠 재생 200 — 모양은 같다) */
export const inquiryCreatedSchema = z.strictObject({
  inquiryId: z.uuid(),
  kind: z.enum(INQUIRY_KINDS),
  category: z.enum(INQUIRY_CATEGORIES),
  status: z.enum(INQUIRY_STATUSES),
  firstResponseDueAt: isoInstant,
  refundRequestId: z.uuid().nullable(),
  waitingNotice: z.string(),
  createdAt: isoInstant,
});
export type InquiryCreated = z.output<typeof inquiryCreatedSchema>;

const academyRefSchema = z.strictObject({ academyId: z.uuid(), name: z.string() });

/** `GET /api/inquiries` 한 줄 */
export const myInquiryItemSchema = z.strictObject({
  inquiryId: z.uuid(),
  kind: z.enum(INQUIRY_KINDS),
  academy: academyRefSchema.nullable(),
  category: z.enum(INQUIRY_CATEGORIES),
  status: z.enum(INQUIRY_STATUSES),
  lastMessagePreview: z.string(),
  lastMessageAt: isoInstant,
  // 첫 답 기한을 넘겼는데 아직 답이 없다 → 화면이 「답변 대기 중」을 띄운다(수용 ②)
  waiting: z.boolean(),
});
export const myInquiryListSchema = z.strictObject({
  items: z.array(myInquiryItemSchema),
  nextCursor: z.string().nullable(),
});
export type MyInquiryList = z.output<typeof myInquiryListSchema>;

/** `GET /api/inquiries?status=&cursor=&limit=` 쿼리 — 모르는 칸은 422 */
export const myInquiryQuerySchema = z.strictObject({
  status: z.enum(INQUIRY_STATUSES).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const attachmentSchema = z.strictObject({ fileId: z.uuid(), displayName: z.string() });

/** `GET /api/inquiries/{inquiryId}` — 문의 하나와 대화(시간 순) */
export const inquiryDetailSchema = z.strictObject({
  inquiryId: z.uuid(),
  kind: z.enum(INQUIRY_KINDS),
  category: z.enum(INQUIRY_CATEGORIES),
  status: z.enum(INQUIRY_STATUSES),
  academy: academyRefSchema.nullable(),
  refundRequestId: z.uuid().nullable(),
  firstResponseDueAt: isoInstant,
  waiting: z.boolean(),
  messages: z.array(
    z.strictObject({
      messageId: z.uuid(),
      sender: z.enum(INQUIRY_MESSAGE_SENDER_KINDS),
      body: z.string(),
      createdAt: isoInstant,
      attachments: z.array(attachmentSchema),
    }),
  ),
});
export type InquiryDetail = z.output<typeof inquiryDetailSchema>;

/** 대표 문의함 칩(보드 O22): 전체 · 답변 대기 · 환불 요청 · 사람 요청 · 답변 완료 */
export const OWNER_INQUIRY_FILTERS = ["all", "waiting", "refund", "human_request", "answered"] as const;
export type OwnerInquiryFilter = (typeof OWNER_INQUIRY_FILTERS)[number];

/** 운영자 시스템 문의함 칩 — 계약 §2-5 의 둘에 「전체」(기본)를 더했다 */
export const ADMIN_INQUIRY_FILTERS = ["all", "waiting", "answered"] as const;
export type AdminInquiryFilter = (typeof ADMIN_INQUIRY_FILTERS)[number];

export const ownerInquiryQuerySchema = z.strictObject({
  filter: z.enum(OWNER_INQUIRY_FILTERS).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const adminInquiryQuerySchema = z.strictObject({
  filter: z.enum(ADMIN_INQUIRY_FILTERS).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** 받는 쪽 문의함 한 줄 — 문의자는 닉네임(회원)·표시 이름(직원)만 내린다(FR-187·FR-299) */
export const inboxItemSchema = z.strictObject({
  inquiryId: z.uuid(),
  category: z.enum(INQUIRY_CATEGORIES),
  origin: z.enum(INQUIRY_ASKER_KINDS),
  askerLabel: z.string(),
  // 수업 이름(예약·수업을 골라 물은 문의만). 없으면 null
  context: z.string().nullable(),
  preview: z.string(),
  status: z.enum(INQUIRY_STATUSES),
  createdAt: isoInstant,
  // 첫 답 기한과 「넘겼나」 — spec 「대표 문의함: 기한이 가까운 순서 · 넘긴 건에 표시」(추천안·사후 확인 2026-11-24)
  firstResponseDueAt: isoInstant,
  overdue: z.boolean(),
  refundRequestId: z.uuid().nullable(),
  route: z.enum(INQUIRY_ROUTES),
});
export const inboxListSchema = z.strictObject({
  waitingCount: z.number().int().min(0),
  items: z.array(inboxItemSchema),
  nextCursor: z.string().nullable(),
});
export type InboxList = z.output<typeof inboxListSchema>;

// ---- S7-2.3(답변과 응답 기한 재알림) ------------------------------------------------------------

/**
 * `POST /api/academies/{academyId}/inquiries/{inquiryId}/replies` · `POST /api/admin/inquiries/{inquiryId}/replies` 본문(계약 §2-4·§2-5).
 * 첨부는 S7-2.7 이 붙인다 — 지금은 빈 목록만 받는다(하나라도 오면 처리기가 422 로 알린다).
 */
export const replyInquirySchema = z.strictObject({
  body: z
    .string()
    .trim()
    .min(1, "답변 내용을 적어 주세요")
    .max(INQUIRY_BODY_MAX, `${INQUIRY_BODY_MAX}자 이하로 적어 주세요`),
  attachmentFileIds: z.array(z.uuid()).max(INQUIRY_ATTACHMENT_MAX).optional().default([]),
});
export type ReplyInquiry = z.output<typeof replyInquirySchema>;

/** 답변 응답 — 처음 201 · 같은 열쇠 재생 200(모양은 같다) */
export const inquiryReplySchema = z.strictObject({
  messageId: z.uuid(),
  status: z.enum(INQUIRY_STATUSES),
});
export type InquiryReply = z.output<typeof inquiryReplySchema>;

/** `POST /api/internal/jobs/inquiries/remind-overdue` 본문 — `asOf` 는 dev 경로가 켜진 환경에서만 쓴다(시험용 시계) */
export const remindOverdueBodySchema = z.strictObject({ asOf: z.iso.datetime().optional() });

/** 재알림 작업 응답 — 이번에 처음 재알림한 문의 수(두 번째 호출이면 0) */
export const remindOverdueResultSchema = z.strictObject({ reminded: z.number().int().min(0) });
export type RemindOverdueResult = z.output<typeof remindOverdueResultSchema>;
