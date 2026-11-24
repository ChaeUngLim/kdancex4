// S3-2.2(시간대 필터·정렬) — 홈 목록 `GET /api/home/offerings?sort=` 의 정렬 기준(계약 02 §1 「정렬」 줄).
//   요구: FR-036a(검색 결과 정렬 5종) 중 이번 회차 몫 3종 · FR-033(시간대 필터)
//
// 왜 순수 함수인가: 정렬은 「무엇이 먼저 오나」라는 규칙 하나다. DB·시계·세션 없이 값만 받아 순서를 내면
// 같은 규칙을 단위 테스트로 바로 확인할 수 있고, 다음 쪽(cursor)을 자를 때도 같은 비교 함수를 그대로 쓴다.
//
// 이번 회차에 만드는 정렬 3종(2026-11-23 사용자 결정):
//   - recommended(추천순, 기본) — 장르·지역·시간대 일치만 점수로 본다. 인기 점수는 0 이다
//                                 (조회 수 표·세는 규칙은 S6-2 에서 검색순·인기순과 함께 만든다)
//   - deadline(마감 임박순)    — 첫 회차 시작이 가까운 순
//   - seats(잔여석 임박순)     — 남은 자리(모든 자리 묶음 합)가 적은 순
//   같은 값이면 첫 회차 시작 시각 오름차순 → 판매 단위 id 순으로 한 줄로 세운다(쪽을 넘길 때 겹치거나 빠지지 않게).
//
// 만들지 않는 것: 거리 정렬. 지도 API 의 무료 구간 확인이 먼저라 로드맵 S3-2 「먼저 정할 것」에 남겨 두었다.
// 검색순·인기순(FR-036a 의 나머지 둘)은 S6-2 몫이다.

/** 이번 회차에 받는 정렬 값. 이 밖의 값은 422 VALIDATION_FAILED 다 */
export const HOME_OFFERING_SORTS = ["recommended", "deadline", "seats"] as const;
export type HomeOfferingSort = (typeof HOME_OFFERING_SORTS)[number];
export const DEFAULT_HOME_OFFERING_SORT: HomeOfferingSort = "recommended";

/**
 * 추천순 비중(FR-036a 「추천순 비중」 표에서 이번 회차에 셀 수 있는 요소만).
 *   - preference(취향·검색 조건 25): 장르·관심 지역 일치
 *   - time(시간 적합성 15): 가능 시간대 안인가
 *   - popularity(인기 15): 이번 회차에는 늘 0 — 그래도 자리를 남겨 두어 S6-2 가 값만 채우면 되게 한다
 * 나이·대상(15)과 수강생 만족도(30)는 이번 회차 계약에 없어 셈에 넣지 않는다.
 */
export const RECOMMENDED_WEIGHTS = { preference: 25, time: 15, popularity: 15 } as const;

/** 점수를 정수로 두려고 0~10000(만분율)으로 쓴다 — 커서에 실수를 넣으면 반올림 차이로 쪽이 어긋날 수 있다 */
export const RECOMMENDED_SCORE_SCALE = 10000;

/**
 * 추천순 재료. `null` 은 「회원이 그 조건을 비워 두었다」는 뜻이다 —
 * spec 「추천순의 빈 조건」대로 그 요소는 빼고 나머지 비중을 합이 100% 가 되게 늘린다.
 */
export interface RecommendedSignals {
  readonly genreMatch: boolean;
  readonly regionMatch: boolean | null;
  readonly timeMatch: boolean | null;
  /** 0~1. 이번 회차에는 늘 0 */
  readonly popularity: number;
}

/** 추천 점수(0~10000, 클수록 앞). 빈 조건은 빼고 나머지 비중으로 나눈다 */
export function recommendedScore(signals: RecommendedSignals): number {
  // 취향·검색 조건 = 장르 일치 + (지역을 골랐다면) 지역 일치의 평균
  const preferenceParts = signals.regionMatch === null ? [signals.genreMatch] : [signals.genreMatch, signals.regionMatch];
  const preference = preferenceParts.filter(Boolean).length / preferenceParts.length;

  // [비중, 값] 목록. 시간대를 비워 둔 회원은 시간 요소가 아예 빠진다
  const parts: Array<readonly [number, number]> = [
    [RECOMMENDED_WEIGHTS.preference, preference],
    [RECOMMENDED_WEIGHTS.popularity, Math.min(1, Math.max(0, signals.popularity))],
  ];
  if (signals.timeMatch !== null) parts.push([RECOMMENDED_WEIGHTS.time, signals.timeMatch ? 1 : 0]);

  const totalWeight = parts.reduce((sum, [w]) => sum + w, 0);
  const weighted = parts.reduce((sum, [w, v]) => sum + w * v, 0);
  return Math.round((weighted / totalWeight) * RECOMMENDED_SCORE_SCALE);
}

/** 정렬에 쓰는 한 판매 단위의 값. firstAt 은 DB 가 내준 고정 폭 ISO 글자(마이크로초까지)라 글자 비교 = 시각 비교다 */
export interface SortableOffering {
  readonly offeringId: string;
  readonly firstAt: string;
  /** 모든 자리 묶음의 남은 자리 합(정원 − 잡힌 자리 − 확정) */
  readonly remainingSeats: number;
  readonly recommendedScore: number;
}

/**
 * 정렬마다의 「주 값」. 작을수록 앞이 되게 맞춘다(추천 점수는 클수록 앞이라 부호를 뒤집는다).
 * 마감 임박순은 주 값이 따로 없고(0) 첫 회차 시각이 곧 기준이다.
 */
export function primarySortKey(sort: HomeOfferingSort, item: SortableOffering): number {
  switch (sort) {
    case "recommended":
      return -item.recommendedScore;
    case "seats":
      return item.remainingSeats;
    case "deadline":
      return 0;
  }
}

/** 커서·비교에 쓰는 정렬 열쇠 — (주 값, 첫 회차 시각, id) */
export interface HomeSortKey {
  readonly primary: number;
  readonly firstAt: string;
  readonly offeringId: string;
}

export function sortKeyOf(sort: HomeOfferingSort, item: SortableOffering): HomeSortKey {
  return { primary: primarySortKey(sort, item), firstAt: item.firstAt, offeringId: item.offeringId };
}

/** 열쇠 둘의 앞뒤. 음수면 a 가 앞이다. 주 값 → 첫 회차 시각 → id 순으로 본다 */
export function compareSortKeys(a: HomeSortKey, b: HomeSortKey): number {
  if (a.primary !== b.primary) return a.primary - b.primary;
  if (a.firstAt !== b.firstAt) return a.firstAt < b.firstAt ? -1 : 1;
  if (a.offeringId !== b.offeringId) return a.offeringId < b.offeringId ? -1 : 1;
  return 0;
}

/** 정렬한 새 배열을 돌려준다(받은 배열은 건드리지 않는다) */
export function sortHomeOfferings<T extends SortableOffering>(sort: HomeOfferingSort, items: readonly T[]): T[] {
  return [...items].sort((a, b) => compareSortKeys(sortKeyOf(sort, a), sortKeyOf(sort, b)));
}
