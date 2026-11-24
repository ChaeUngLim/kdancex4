// S7-2.6(이용 제한 절차) — 이용 제한 경로의 요청·응답 모양(zod).
//   계약: _workspace/03_contracts/15-ops.md §2-8(이용 제한 절차 — 사유 통지 → 소명 → 조치)
//
// 이 파일은 경계 검증과 모양만 맡는다. DB 를 읽지 않는다.
// 응답 스키마는 테스트가 응답 본문을 parse 해 키 이름·타입을 1대1로 확인하는 데 쓴다(strict — 모르는 키가 있으면 실패).
import { z } from "zod";

import {
  RESTRICTION_EXPLANATION_DAYS_DEFAULT,
  RESTRICTION_EXPLANATION_DAYS_MAX,
  RESTRICTION_MEASURES,
  RESTRICTION_REASON_CODES,
  RESTRICTION_REASON_TEXT_MAX,
  RESTRICTION_STATES,
  RESTRICTION_SUBJECT_KINDS,
} from "../../domain/restriction";

/**
 * `POST /api/admin/restrictions` 본문(계약 §2-8).
 * 사유(reasonCode + reasonText)는 둘 다 필수다 — 「사유와 함께 기록된다」(FR-254)가 이 경로의 약속이다.
 */
export const openRestrictionSchema = z.strictObject({
  subjectKind: z.enum(RESTRICTION_SUBJECT_KINDS),
  subjectId: z.uuid(),
  reasonCode: z.enum(RESTRICTION_REASON_CODES),
  reasonText: z
    .string()
    .trim()
    .min(1, "사유를 적어 주세요")
    .max(RESTRICTION_REASON_TEXT_MAX, `${RESTRICTION_REASON_TEXT_MAX}자 이하로 적어 주세요`),
  plannedMeasure: z.enum(RESTRICTION_MEASURES),
  urgent: z.boolean().optional().default(false),
  explanationDays: z.int().min(1).max(RESTRICTION_EXPLANATION_DAYS_MAX).optional().default(RESTRICTION_EXPLANATION_DAYS_DEFAULT),
});
export type OpenRestriction = z.output<typeof openRestrictionSchema>;

/** `POST /api/admin/restrictions` 응답(처음 201 · 같은 열쇠 재생 200 — 모양은 같다) */
export const restrictionOpenedSchema = z.strictObject({
  caseId: z.uuid(),
  state: z.enum(RESTRICTION_STATES),
  explanationDueAt: z.iso.datetime().nullable(),
});
export type RestrictionOpened = z.output<typeof restrictionOpenedSchema>;
