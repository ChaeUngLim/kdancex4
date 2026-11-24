// S3-2.2(시간대 필터·정렬) — 홈 목록 정렬 기준 순수 함수(lib/domain/home-offering-sort.ts).
//   DB 테스트(tests/db/home-offerings-sort.db.test.ts)가 실제 목록 순서를 보고, 여기서는 규칙 자체를 본다:
//   추천 점수의 빈 조건 처리, 정렬마다 주 값, 같은 값이면 첫 회차 → id.
import { describe, expect, test } from "vitest";

import {
  compareSortKeys,
  HOME_OFFERING_SORTS,
  RECOMMENDED_SCORE_SCALE,
  recommendedScore,
  sortHomeOfferings,
  sortKeyOf,
  type SortableOffering,
} from "@/lib/domain/home-offering-sort";

const offering = (id: string, firstAt: string, remainingSeats: number, score: number): SortableOffering => ({
  offeringId: id,
  firstAt,
  remainingSeats,
  recommendedScore: score,
});

describe("정렬 값(계약 02 §1) — 이번 회차는 3종, 거리 정렬은 없다", () => {
  test("recommended · deadline · seats 만 받는다", () => {
    expect(HOME_OFFERING_SORTS).toEqual(["recommended", "deadline", "seats"]);
    expect(HOME_OFFERING_SORTS).not.toContain("distance");
  });
});

describe("recommendedScore — 장르·지역·시간대 일치만, 인기는 0", () => {
  test("고른 조건이 모두 맞으면 인기 0 몫만 모자란다 — (25 + 15) / (25 + 15 + 15)", () => {
    expect(recommendedScore({ genreMatch: true, regionMatch: true, timeMatch: true, popularity: 0 })).toBe(
      Math.round((40 / 55) * RECOMMENDED_SCORE_SCALE),
    );
  });

  test("비워 둔 조건은 빼고 나머지 비중으로 늘린다 — 시간대를 비우면 25 / (25 + 15)", () => {
    expect(recommendedScore({ genreMatch: true, regionMatch: null, timeMatch: null, popularity: 0 })).toBe(
      Math.round((25 / 40) * RECOMMENDED_SCORE_SCALE),
    );
  });

  test("맞지 않는 조건은 점수를 깎는다 — 지역이 안 맞으면 취향 몫이 절반", () => {
    const all = recommendedScore({ genreMatch: true, regionMatch: true, timeMatch: true, popularity: 0 });
    const regionMiss = recommendedScore({ genreMatch: true, regionMatch: false, timeMatch: true, popularity: 0 });
    const timeMiss = recommendedScore({ genreMatch: true, regionMatch: true, timeMatch: false, popularity: 0 });
    expect(regionMiss).toBe(Math.round((27.5 / 55) * RECOMMENDED_SCORE_SCALE));
    expect(timeMiss).toBe(Math.round((25 / 55) * RECOMMENDED_SCORE_SCALE));
    expect(all).toBeGreaterThan(regionMiss);
    expect(regionMiss).toBeGreaterThan(timeMiss);
  });

  test("인기 자리는 남아 있다 — 값이 들어오면(S6-2) 점수가 오르고, 0~1 밖은 잘린다", () => {
    const base = { genreMatch: true, regionMatch: null, timeMatch: null } as const;
    expect(recommendedScore({ ...base, popularity: 1 })).toBe(RECOMMENDED_SCORE_SCALE);
    expect(recommendedScore({ ...base, popularity: 5 })).toBe(RECOMMENDED_SCORE_SCALE);
    expect(recommendedScore({ ...base, popularity: -1 })).toBe(recommendedScore({ ...base, popularity: 0 }));
  });
});

describe("sortHomeOfferings — 정렬마다 주 값, 같으면 첫 회차 → id", () => {
  const items = [
    offering("b", "2026-12-01T09:00:00.000000Z", 12, 5000),
    offering("a", "2026-12-01T09:00:00.000000Z", 12, 5000),
    offering("c", "2026-12-08T10:00:00.000000Z", 2, 9000),
    offering("d", "2026-12-03T01:00:00.000000Z", 0, 5000),
    offering("e", "2026-12-01T11:30:00.000000Z", 2, 5000),
  ];
  const ids = (sort: (typeof HOME_OFFERING_SORTS)[number]) => sortHomeOfferings(sort, items).map((i) => i.offeringId);

  test("deadline — 첫 회차 시작이 가까운 순(같은 시각은 id)", () => {
    expect(ids("deadline")).toEqual(["a", "b", "e", "d", "c"]);
  });

  test("seats — 남은 자리가 적은 순(0 이 맨 앞, 같으면 첫 회차 → id)", () => {
    expect(ids("seats")).toEqual(["d", "e", "c", "a", "b"]);
  });

  test("recommended — 점수가 높은 순(같으면 첫 회차 → id)", () => {
    expect(ids("recommended")).toEqual(["c", "a", "b", "e", "d"]);
  });

  test("받은 배열은 그대로 둔다", () => {
    const before = items.map((i) => i.offeringId);
    sortHomeOfferings("seats", items);
    expect(items.map((i) => i.offeringId)).toEqual(before);
  });

  test("compareSortKeys — 같은 열쇠는 0, 커서 뒤 자르기에 쓴다", () => {
    const [first] = items;
    if (first === undefined) throw new Error("항목이 없다");
    expect(compareSortKeys(sortKeyOf("seats", first), sortKeyOf("seats", first))).toBe(0);
  });
});
