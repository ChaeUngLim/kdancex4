// SX-6.8(AI 생성 표시·무료량 소진) — 「이건 AI 가 만들었어요」 표시를 언제 붙이나를 DB 없이 정하는 순수 함수.
//   계약: _workspace/03_contracts/16-ai-agent.md §2 「AI 가 만든 모든 값에 aiGenerated: true」 · §4-7 홍보 이미지·소개 문구·promo-assets
//   요구: FR-258(AI 생성 표시 — 인공지능 기본법 투명성 의무 대응) · FR-061(소개 문구) · FR-061a(홍보 이미지) · FR-061b·FR-061c(프로필·학원 사진)
//
// 왜 따로 두나: 표시 판정을 화면마다 따로 쓰면 어느 화면은 붙이고 어느 화면은 빠뜨린다. 표시가 빠지는 것이
//   법 의무 위반이므로 「무엇이 AI 산출물인가」는 한 곳에서만 정한다. 화면은 여기서 돌려준 글자를 그대로 그린다.
//
// 규칙(추천안·사후 확인 2026-11-24 — spec 은 「표시해야 한다」까지만 정했다):
//   ① AI 이미지로 만든 표지 → 표시한다. 사람이 올린 사진 → 표시하지 않는다(사진이 먼저 쓰이면 표시도 사라진다).
//   ② 소개 문구가 AI 초안 그대로(ai) → 표시한다.
//   ③ AI 초안을 사람이 고친 글(ai_edited) → 그래도 표시한다. 바탕이 AI 문장이라서다. 다만 안내 글을 「고친 글」로 바꾼다.
//      (다른 후보: 고치면 표시를 뗀다 — 포스터 칸은 그렇게 한다. 포스터 칸은 날짜·가격 같은 짧은 사실이라 고치면 사람 값이지만,
//       소개 문구는 몇 문장을 손봐도 나머지가 AI 문장이라 떼면 표시 의무를 피하는 길이 된다.)
//   ④ 직접 쓴 글(user) → 표시하지 않는다.
import type { PromoCoverSource, PromoIntroSource } from "./constants";
import { POSTER_BADGE_LABELS } from "./poster-field-badges";

/** AI 가 만든 것의 종류 — 종류마다 안내 글이 다르다 */
export const AI_CONTENT_KINDS = ["promo_image", "class_intro", "class_intro_edited", "profile_image", "academy_photo"] as const;
export type AiContentKind = (typeof AI_CONTENT_KINDS)[number];

/** 모든 AI 산출물에 붙는 짧은 표(배지). 포스터 칸 배지와 같은 글자를 쓴다 — 화면마다 다르면 같은 뜻으로 읽히지 않는다 */
export const AI_GENERATED_BADGE = POSTER_BADGE_LABELS.aiGenerated;

/** 배지 옆·아래에 붙는 한 줄 안내(추천안). 「확인한 뒤 올린다」는 FR-061a·FR-061b·FR-061c 의 검토 규칙을 같이 알려 준다 */
export const AI_GENERATED_NOTES: Readonly<Record<AiContentKind, string>> = {
  promo_image: "AI 가 만든 이미지예요",
  class_intro: "AI 가 만든 소개 문구예요",
  class_intro_edited: "AI 초안을 고친 소개 문구예요",
  profile_image: "AI 가 만든 프로필 이미지예요",
  academy_photo: "AI 가 만든 학원 이미지예요",
};

/** 화면이 그릴 표시 한 개 */
export type AiGeneratedMark = {
  readonly aiGenerated: true;
  readonly kind: AiContentKind;
  readonly badge: string;
  readonly note: string;
};

/** 종류로 표시를 만든다 */
export function aiGeneratedMark(kind: AiContentKind): AiGeneratedMark {
  return { aiGenerated: true, kind, badge: AI_GENERATED_BADGE, note: AI_GENERATED_NOTES[kind] };
}

/** 표지에 표시를 붙이나 — AI 이미지일 때만(규칙 ①) */
export function coverAiMark(coverSource: PromoCoverSource | null): AiGeneratedMark | null {
  return coverSource === "ai_image" ? aiGeneratedMark("promo_image") : null;
}

/** 소개 문구에 표시를 붙이나 — AI 초안 그대로·고친 글이면 붙인다(규칙 ②③④) */
export function introAiMark(introSource: PromoIntroSource | null): AiGeneratedMark | null {
  if (introSource === "ai") return aiGeneratedMark("class_intro");
  if (introSource === "ai_edited") return aiGeneratedMark("class_intro_edited");
  return null;
}

/** 수업 홍보 자료(표지 + 소개 문구)의 표시 둘. 계약 16 §4-7 promo-assets 응답의 `aiMarks` 가 이 모양이다 */
export function promoAiMarks(input: {
  readonly coverSource: PromoCoverSource | null;
  readonly introSource: PromoIntroSource | null;
}): { readonly cover: AiGeneratedMark | null; readonly intro: AiGeneratedMark | null } {
  return { cover: coverAiMark(input.coverSource), intro: introAiMark(input.introSource) };
}
