// 홍보 이미지 화면이 열릴 때 미리 받을 표지 사진 고르기 — 2026-11-25 홍보 이미지 버그 수정.
// react-native 를 가져오지 않는 순수 함수만 둔다(admin-web 단위 테스트가 그대로 불러 시험한다). 타입은 promo-api 에서 이름만 가져온다.
import type { PromoAssets, PromoOptions } from './promo-api';

/**
 * 화면을 열 때 먼저 받아 둘 표지 사진 주소(/api/files/…). 없으면 null.
 * PromoFlow 의 처음 값과 같은 순서로 고른다 — 올린 사진 → 마지막 생성 → 저장해 둔 AI 표지.
 * 사진은 <Image> 가 직접 받지 않고 화면이 data URI 로 받아 넘긴다(api.ts apiFetchImageDataUri — 안드로이드 이미지 요청에 토큰 헤더가 안 실리는 문제).
 */
export function initialCoverPath(options: PromoOptions, assets: PromoAssets): string | null {
  if (assets.coverSource === 'uploaded_photo') return assets.coverUrl;
  const last = options.lastGeneration;
  if (last !== null) return last.status === 'succeeded' ? last.imageUrl : null;
  return assets.aiImageGenerationId !== null ? assets.coverUrl : null;
}
