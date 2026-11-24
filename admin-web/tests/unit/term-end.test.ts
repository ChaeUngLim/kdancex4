// 수업 「기간 종료」 판정(lib/domain/term-end.ts) — S6-3.3(레벨 계산 작업)·S5-1.3(정산 단계 전이 작업)이 같이 쓰는 규칙
import { describe, expect, it } from "vitest";

import { isTermEnded, termEndedBefore, termEndsAt } from "@/lib/domain/term-end";

const at = (iso: string) => Temporal.Instant.from(iso);
const END = at("2026-12-01T12:00:00Z");

describe("termEndsAt — 판매 단위의 마지막 회차 끝과 회차 끝 중 가장 늦은 것", () => {
  it("회차가 판매 단위 값보다 늦게 끝나면(시간 변경) 회차 쪽", () => {
    expect(termEndsAt({ lastSessionEndsAt: END, sessionEndsAts: [at("2026-11-24T12:00:00Z"), at("2026-12-02T12:00:00Z")] })).toEqual(
      at("2026-12-02T12:00:00Z"),
    );
  });
  it("회차가 모두 더 이르거나 없으면 판매 단위 값", () => {
    expect(termEndsAt({ lastSessionEndsAt: END, sessionEndsAts: [at("2026-11-24T12:00:00Z")] })).toEqual(END);
    expect(termEndsAt({ lastSessionEndsAt: END, sessionEndsAts: [] })).toEqual(END);
  });
});

describe("isTermEnded — 지금 > 끝 + 여유 시간", () => {
  it("여유 0: 같은 순간은 아직, 1초 뒤는 끝남", () => {
    expect(isTermEnded(END, END)).toBe(false);
    expect(isTermEnded(END, END.add({ seconds: 1 }))).toBe(true);
  });
  it("레벨 계산(여유 48시간): 47시간·48시간 정각은 아직, 49시간째 끝남", () => {
    expect(isTermEnded(END, END.add({ hours: 47 }), 48)).toBe(false);
    expect(isTermEnded(END, END.add({ hours: 48 }), 48)).toBe(false);
    expect(isTermEnded(END, END.add({ hours: 49 }), 48)).toBe(true);
  });
  it("여유 시간이 음수·소수면 거부", () => {
    expect(() => isTermEnded(END, END, -1)).toThrow(RangeError);
    expect(() => isTermEnded(END, END, 1.5)).toThrow(RangeError);
    expect(() => termEndedBefore(END, -1)).toThrow(RangeError);
  });
});

describe("termEndedBefore — SQL 기준 시각(끝 < 이 값)이 isTermEnded 와 같은 식", () => {
  it("지금 − 여유 시간", () => {
    const now = END.add({ hours: 49 });
    expect(termEndedBefore(now, 48)).toEqual(END.add({ hours: 1 }));
    // 끝 < 기준 ⇔ isTermEnded
    for (const h of [47, 48, 49]) {
      const n = END.add({ hours: h });
      expect(Temporal.Instant.compare(END, termEndedBefore(n, 48)) < 0).toBe(isTermEnded(END, n, 48));
    }
  });
});
