// SX-6.7(검토 후 게시 경로) — 수업 홍보 표지·소개 문구의 규칙 두 가지를 DB 없이 계산하는 순수 함수.
//   계약: _workspace/03_contracts/16-ai-agent.md §4-7 `PUT /api/classes/{classId}/promo-assets`
//   데이터: data-model §13-6 class_promo_assets(ck_promo_assets_cover · 「검토가 필요한가」 판정식)
//   요구: FR-061(소개 문구) · FR-061a(홍보 이미지 — 검토·교체 뒤에만 게시, 이미지 위 글자는 수업 데이터로 앱이 얹는다)
//
// 왜 따로 두나: 「표지를 무엇으로 쓰나」와 「검토 확인이 있어야 하나」는 저장(PUT)과 게시 관문(승인 요청·대표 승인)
// 두 곳이 같이 쓴다. 규칙이 두 벌이면 언젠가 어긋나서, 한쪽은 통과시키고 한쪽은 막는 일이 생긴다.
import type { PromoCoverSource, PromoIntroSource } from "./constants";

/** 표지 후보 — 올린 사진 파일 id 와 AI 이미지 생성 id. 없으면 null */
export type CoverCandidates = {
  readonly uploadedPhotoFileId: string | null;
  readonly aiImageGenerationId: string | null;
};

/**
 * 표지를 정한다 — **사진이 먼저**다(계약 16 §4-7, DB ck_promo_assets_cover 와 같은 규칙).
 *   ① 올린 사진이 있으면 사진(AI 이미지를 같이 보내도 사진을 쓴다)
 *   ② 사진이 없고 AI 이미지가 있으면 AI 이미지
 *   ③ 둘 다 없으면 표지 없음
 */
export function decideCoverSource(candidates: CoverCandidates): PromoCoverSource | null {
  if (candidates.uploadedPhotoFileId !== null) return "uploaded_photo";
  if (candidates.aiImageGenerationId !== null) return "ai_image";
  return null;
}

/**
 * AI 가 만든 것이 들어 있나 — AI 표지이거나, 문구가 AI 초안(그대로·고친 것)이면 그렇다.
 * 사진만·직접 쓴 글만이면 사람이 만든 것이라 검토 확인이 필요 없다.
 */
export function containsAiContent(coverSource: PromoCoverSource | null, introSource: PromoIntroSource | null): boolean {
  return coverSource === "ai_image" || introSource === "ai" || introSource === "ai_edited";
}

/**
 * 게시 경로로 들어가도 되나(data-model §13-6 「검토가 필요한가」 판정식).
 * AI 가 만든 것이 있는데 검토 확인(reviewed_at)이 없으면 false — 승인 요청·대표 승인이 PROMO_REVIEW_REQUIRED 로 막는다.
 */
export function promoAssetsPublishable(input: {
  readonly coverSource: PromoCoverSource | null;
  readonly introSource: PromoIntroSource | null;
  readonly reviewed: boolean;
}): boolean {
  return !containsAiContent(input.coverSource, input.introSource) || input.reviewed;
}
