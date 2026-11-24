// S1-1.29(소명 기한 지남 → 운영자 게시 중단) — P11 사업자 점검 운영자 경로의 요청·응답 모양(zod).
//   계약: _workspace/03_contracts/13-settlement.md §10-3(P11 사업자 점검)
//
// 경계 검증과 모양만 맡는다. DB 를 읽지 않는다. 응답 스키마는 strict — 테스트가 응답 본문을 parse 해 키를 1대1로 본다.
import { z } from "zod";

/** 운영자 메모 최대 길이 — 이용 제한 사유 글과 같은 1,000자 */
export const BUSINESS_CHECK_NOTE_MAX = 1000;

/**
 * `POST …/{caseId}/suspend-listing` · `…/accept-explanation` 본문 — `{ "note": "소명 기한 지남" }`.
 * 메모는 감사 기록의 사유 칸에 남는다. 버튼 하나로 누르는 경로라 비워도 된다(추천안·사후 확인 2026-11-24).
 */
export const businessCheckActionSchema = z.strictObject({
  note: z.string().trim().max(BUSINESS_CHECK_NOTE_MAX, `${BUSINESS_CHECK_NOTE_MAX}자 이하로 적어 주세요`).optional().default(""),
});
export type BusinessCheckAction = z.output<typeof businessCheckActionSchema>;

/** `suspend-listing` 응답 — 처음이든 이미 중단이든 200 같은 본문 */
export const listingSuspendedSchema = z.strictObject({ state: z.literal("measure_applied") });

/** `accept-explanation` 응답 — 처음이든 이미 풀렸든 200 같은 본문 */
export const explanationAcceptedSchema = z.strictObject({ state: z.literal("lifted") });

// ---- S7-4.8c(사업자 점검 소명 처리 API(P11)) — 목록·상세 두 GET 의 응답 모양 ------------------------------------------------
//   계약 13 §10-3 의 예시 칸에 화면이 바로 쓰는 dueLabel·overdue·explanationCount 를 더했다(추천안·사후 확인 2026-11-24).
//   개인정보 없음(15-ops §4-1, FR-302): 수강생 정보는 아예 없고, 사업자등록번호는 가린 값만, 국세청 응답 원문은 내리지 않는다.

/** 점검 결과 다섯 가지 — 계속·휴업·폐업·미등록·조회 실패(data-model §7-3b) */
const checkStatusSchema = z.enum(["active", "suspended", "closed", "not_found", "error"]);
/** 열린 제한 종류 — 새 결제 막음·지급 보류·게시 중단 */
const restrictionKindSchema = z.enum(["new_sales_blocked", "payout_hold", "listing_suspended"]);
/** 이용 제한 절차 단계(15-ops §2-8) */
const caseStateSchema = z.enum(["notice_sent", "explained", "measure_applied", "lifted", "dismissed"]);

/** 소명 기한 표시 세 칸 — lib/domain/business-check-case.ts 의 explanationDue 결과 그대로 */
const dueShape = {
  explanationDueAt: z.string().nullable(),
  dueInDays: z.number().int().nullable(),
  dueLabel: z.string().nullable(),
  overdue: z.boolean(),
} as const;

/** 목록 한 줄. caseId 가 null 이면 「조회 실패」 줄이다(조치 없음 — 다음 점검에서 다시 본다) */
export const businessCheckListItemSchema = z.strictObject({
  caseId: z.uuid().nullable(),
  academyId: z.uuid(),
  academyName: z.string(),
  ownerName: z.string().nullable(),
  businessNoMasked: z.string(),
  status: checkStatusSchema,
  detectedAt: z.string(),
  actions: z.array(restrictionKindSchema),
  state: caseStateSchema.nullable(),
  explanationCount: z.number().int().nonnegative(),
  note: z.string().optional(),
  ...dueShape,
});

/** `GET /api/admin/console/business-checks` 응답 */
export const businessCheckListResponseSchema = z.strictObject({
  lastRunAt: z.string().nullable(),
  trigger: z.enum(["onboarding", "daily", "pre_payout", "manual"]).nullable(),
  summary: z.strictObject({
    total: z.number().int(),
    active: z.number().int(),
    suspended: z.number().int(),
    closed: z.number().int(),
    notFound: z.number().int(),
    error: z.number().int(),
  }),
  items: z.array(businessCheckListItemSchema),
});
export type BusinessCheckListResponse = z.output<typeof businessCheckListResponseSchema>;

/** `GET /api/admin/console/business-checks/{caseId}` 응답 */
export const businessCheckDetailResponseSchema = z.strictObject({
  caseId: z.uuid(),
  academyId: z.uuid(),
  academyName: z.string(),
  ownerName: z.string().nullable(),
  businessNoMasked: z.string(),
  latestCheck: z
    .strictObject({
      checkedAt: z.string(),
      status: checkStatusSchema,
      closedOn: z.string().nullable(),
      previousStatus: checkStatusSchema.nullable(),
    })
    .nullable(),
  explanations: z.array(
    z.strictObject({
      explanationId: z.uuid(),
      submittedAt: z.string(),
      body: z.string(),
      attachments: z.array(z.strictObject({ fileId: z.uuid(), displayName: z.string() })),
    }),
  ),
  actions: z.array(restrictionKindSchema),
  state: caseStateSchema,
  ...dueShape,
});
export type BusinessCheckDetailResponse = z.output<typeof businessCheckDetailResponseSchema>;
