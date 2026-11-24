// S2-3.3(정원·가격 변경 규칙) — 판정 순수 함수(lib/domain/class-capacity-price.ts) 단위 테스트.
//   계약 11 §13 단위 목록의 「정원 하한 판정(held + confirmed)」
import { describe, expect, test } from "vitest";

import { judgeCapacityChange, judgePriceChange, reservedMinimum } from "@/lib/domain/class-capacity-price";

const SPLIT = [
  { seatKind: "male", capacity: 10, held: 0, confirmed: 9 },
  { seatKind: "female", capacity: 10, held: 0, confirmed: 10 },
] as const;

describe("정원 하한 판정", () => {
  test("하한은 held + confirmed, 판매 단위가 여럿이면 가장 많이 찬 쪽", () => {
    expect(reservedMinimum(SPLIT)).toEqual({ male: 9, female: 10 });
    expect(
      reservedMinimum([
        { seatKind: "any", capacity: 10, held: 2, confirmed: 3 },
        { seatKind: "any", capacity: 10, held: 0, confirmed: 7 },
      ]),
    ).toEqual({ any: 7 });
  });

  test("확정 9명 묶음을 8로 줄이면 below_reserved + 묶음 전체의 minimum", () => {
    expect(judgeCapacityChange(SPLIT, { male: 8 })).toEqual({ ok: false, reason: "below_reserved", minimum: { male: 9, female: 10 } });
  });

  test("하한과 같거나 크면 통과, 보낸 종류만 next 에", () => {
    expect(judgeCapacityChange(SPLIT, { male: 9 })).toEqual({ ok: true, next: { male: 9 } });
    expect(judgeCapacityChange(SPLIT, { male: 20, female: 10 })).toEqual({ ok: true, next: { male: 20, female: 10 } });
  });

  test("모양 오류(없는 묶음 · 0 · 소수 · 너무 큼 · 빈 값)는 invalid — 하한보다 먼저", () => {
    const paths = (r: ReturnType<typeof judgeCapacityChange>) => (r.ok || r.reason !== "invalid" ? [] : r.issues.map((i) => i.path));
    expect(paths(judgeCapacityChange(SPLIT, { any: 30 }))).toEqual(["capacity.any"]);
    expect(paths(judgeCapacityChange(SPLIT, { female: 0 }))).toEqual(["capacity.female"]);
    expect(paths(judgeCapacityChange(SPLIT, { male: 9.5 }))).toEqual(["capacity.male"]);
    expect(paths(judgeCapacityChange(SPLIT, { male: 1000 }))).toEqual(["capacity.male"]);
    expect(paths(judgeCapacityChange(SPLIT, {}))).toEqual(["capacity"]);
    // 모양 오류와 하한 미달이 함께 있으면 모양 오류만 알린다
    expect(paths(judgeCapacityChange(SPLIT, { male: 1, any: 3 }))).toEqual(["capacity.any"]);
  });
});

describe("금액 변경 판정", () => {
  test("유료 금액끼리는 올리고 내리기 모두 통과", () => {
    expect(judgePriceChange(300000, 320000)).toEqual({ ok: true, next: 320000 });
    expect(judgePriceChange(300000, 1)).toEqual({ ok: true, next: 1 });
    expect(judgePriceChange(0, 0)).toEqual({ ok: true, next: 0 });
  });

  test("음수 · 소수 · 최대 초과 · 무료↔유료 전환은 거부", () => {
    for (const [current, next] of [
      [300000, -1],
      [300000, 1.5],
      [300000, 10_000_001],
      [300000, 0],
      [0, 10000],
    ] as const) {
      expect(judgePriceChange(current, next).ok).toBe(false);
    }
  });
});
