// SX-5.4(결과 없음 안내·조건 넓히기) — 순수 함수 lib/domain/offering-no-result.ts 의 규칙을 본다.
//   결과가 0건이면 「찾지 못했어요」 문장과 「넓힌 조건」 버튼 값이 붙고, 결과가 있으면 아무것도 붙지 않는다.
//   버튼 값의 조건은 원래 조건에서 칸을 **빼기만** 한다 — 새 조건을 지어내지 않는다(FR-039(없는 항목 추천 금지)).
import { describe, expect, test } from "vitest";

import {
  buildNoResultReply,
  MAX_WIDEN_ACTIONS,
  NO_RESULT_SENTENCE,
  type SearchConditions,
} from "@/lib/domain/offering-no-result";
import { searchOfferingsInputSchema } from "@/lib/server/services/offering-search";

const INSTRUCTOR = { name: "이준호", id: "11111111-1111-4111-8111-111111111111" };
const ACADEMY = { name: "라틴하우스 강남", id: "22222222-2222-4222-8222-222222222222" };

// 계약 16 §5-1 모양 — 비운 칸은 null
const EMPTY: SearchConditions = {
  instructor: null,
  academy: null,
  genre: null,
  weekdays: null,
  timeBand: null,
  level: null,
  regionSido: null,
  regionGu: null,
  maxPriceAmount: null,
  dateFrom: null,
  dateTo: null,
};
const conditions = (overrides: Partial<SearchConditions>): SearchConditions => ({ ...EMPTY, ...overrides });

const FAKE_CARD = { offeringId: "33333333-3333-4333-8333-333333333333" };

describe("buildNoResultReply — 결과 0건이면 안내와 넓힌 조건 버튼", () => {
  test("결과가 있으면 null(안내를 붙이지 않는다)", () => {
    expect(buildNoResultReply(conditions({ instructor: INSTRUCTOR }), [FAKE_CARD])).toBeNull();
  });

  test("강사 + 학원 + 주말 오전이 0건이면 「찾지 못했어요」와 그 강사의 다른 수업 · 조건 빼기 버튼", () => {
    const input = conditions({ instructor: INSTRUCTOR, academy: ACADEMY, weekdays: ["sat", "sun"], timeBand: "morning" });
    const reply = buildNoResultReply(input, []);

    expect(reply).not.toBeNull();
    expect(reply?.kind).toBe("no_offering_result");
    expect(reply?.sentence).toBe(NO_RESULT_SENTENCE);
    expect(reply?.sentence).toContain("찾지 못했어요");
    expect(reply?.aiGenerated).toBe(false);

    // 첫 버튼은 그 강사의 다른 수업(강사만 남긴다)
    expect(reply?.actions[0]).toEqual({
      type: "widen_search",
      widen: "instructor_other_offerings",
      label: "이준호 강사님의 다른 수업 보기",
      conditions: conditions({ instructor: INSTRUCTOR }),
    });
    // 다음은 학원 빼기 → 시간대 빼기 순(좁히는 칸이 큰 것부터 하나씩 뺀다)
    expect(reply?.actions[1]).toEqual({
      type: "widen_search",
      widen: "drop_academy",
      label: "모든 학원 수업 보기",
      conditions: conditions({ instructor: INSTRUCTOR, weekdays: ["sat", "sun"], timeBand: "morning" }),
    });
    expect(reply?.actions[2]).toEqual({
      type: "widen_search",
      widen: "drop_time_band",
      label: "시간대 상관없이 보기",
      conditions: conditions({ instructor: INSTRUCTOR, academy: ACADEMY, weekdays: ["sat", "sun"] }),
    });
    expect(reply?.actions).toHaveLength(MAX_WIDEN_ACTIONS);
  });

  test("버튼 조건은 원래 조건의 부분집합이다 — 칸을 빼기만 하고 값을 바꾸거나 더하지 않는다", () => {
    const input = conditions({
      instructor: INSTRUCTOR,
      genre: "salsa_bachata",
      weekdays: ["mon"],
      timeBand: { from: "18:00", to: "21:00" },
      level: "beginner",
      maxPriceAmount: 150000,
    });
    const reply = buildNoResultReply(input, []);
    expect(reply?.actions.length).toBeGreaterThan(0);
    for (const action of reply?.actions ?? []) {
      for (const [key, value] of Object.entries(action.conditions)) {
        if (value === null) continue;
        expect(value).toEqual(input[key as keyof SearchConditions]);
      }
      // 버튼마다 원래보다 칸이 적다
      const filled = (c: SearchConditions) => Object.values(c).filter((v) => v !== null).length;
      expect(filled(action.conditions)).toBeLessThan(filled(input));
    }
  });

  test("강사 + 학원뿐이면 「다른 수업」과 「모든 학원」이 같은 조건이라 버튼은 하나만", () => {
    const reply = buildNoResultReply(conditions({ instructor: INSTRUCTOR, academy: ACADEMY }), []);
    expect(reply?.actions).toHaveLength(1);
    expect(reply?.actions[0]?.widen).toBe("instructor_other_offerings");
    expect(reply?.actions[0]?.conditions).toEqual(conditions({ instructor: INSTRUCTOR }));
  });

  test("강사 없이 장르 + 요일 + 레벨이면 조건을 하나씩 뺀 버튼(강사 버튼 없음)", () => {
    const reply = buildNoResultReply(conditions({ genre: "swing", weekdays: ["sat"], level: "intermediate" }), []);
    expect(reply?.actions.map((a) => a.widen)).toEqual(["drop_weekdays", "drop_level", "drop_genre"]);
    expect(reply?.actions.map((a) => a.label)).toEqual(["요일 상관없이 보기", "레벨 상관없이 보기", "장르 상관없이 보기"]);
  });

  test("지역은 시·도와 구를 함께 뺀다", () => {
    const reply = buildNoResultReply(conditions({ genre: "swing", regionSido: "서울", regionGu: "강남구" }), []);
    const region = reply?.actions.find((a) => a.widen === "drop_region");
    expect(region?.label).toBe("지역 상관없이 보기");
    expect(region?.conditions).toEqual(conditions({ genre: "swing" }));
  });

  test("날짜는 시작·끝을 함께 뺀다", () => {
    const reply = buildNoResultReply(conditions({ instructor: INSTRUCTOR, dateFrom: "2026-12-01", dateTo: "2026-12-31" }), []);
    expect(reply?.actions.map((a) => a.widen)).toEqual(["instructor_other_offerings"]);
    expect(reply?.actions[0]?.conditions).toEqual(conditions({ instructor: INSTRUCTOR }));
  });

  test("빼면 조건이 하나도 안 남는 버튼은 만들지 않는다(조건 없음 검색 금지 — 계약 16 §5-1)", () => {
    const reply = buildNoResultReply(conditions({ genre: "argentine_tango" }), []);
    expect(reply?.sentence).toBe(NO_RESULT_SENTENCE);
    expect(reply?.actions).toEqual([]);
    expect(reply?.hint).toBe("다른 장르나 강사 이름으로 다시 물어봐 주세요.");
  });

  test("강사만으로도 0건이면 넓힐 칸이 없어 버튼 없이 그 강사의 게시 수업이 없다고 안내한다", () => {
    const reply = buildNoResultReply(conditions({ instructor: INSTRUCTOR }), []);
    expect(reply?.actions).toEqual([]);
    expect(reply?.hint).toBe("이 강사님이 지금 모집 중인 수업이 없어요.");
  });

  test("버튼이 있으면 넓혀 다시 찾을 수 있다는 안내", () => {
    const reply = buildNoResultReply(conditions({ instructor: INSTRUCTOR, level: "advanced" }), []);
    expect(reply?.hint).toBe("아래 버튼으로 조건을 넓혀 다시 찾아볼 수 있어요.");
  });

  test("빈 요일 배열은 조건 없음으로 본다(버튼을 만들지 않는다)", () => {
    const reply = buildNoResultReply(conditions({ instructor: INSTRUCTOR, weekdays: [] }), []);
    expect(reply?.actions).toEqual([]);
  });

  test("강사 이름이 없고 id 만 있으면 라벨은 「이 강사님의 다른 수업 보기」", () => {
    const reply = buildNoResultReply(conditions({ instructor: { name: null, id: INSTRUCTOR.id }, level: "entry" }), []);
    expect(reply?.actions[0]?.label).toBe("이 강사님의 다른 수업 보기");
  });

  test("버튼 조건은 그대로 search_offerings 입력(SX-5.3 스키마)으로 통과한다", () => {
    const input = conditions({
      instructor: INSTRUCTOR,
      academy: ACADEMY,
      genre: "dance_sport",
      weekdays: ["sat", "sun"],
      timeBand: "morning",
      level: "beginner",
    });
    const reply = buildNoResultReply(input, []);
    expect(reply?.actions).toHaveLength(MAX_WIDEN_ACTIONS);
    for (const action of reply?.actions ?? []) {
      expect(searchOfferingsInputSchema.safeParse({ ...action.conditions, limit: 20 }).success).toBe(true);
    }
  });

  test("원래 조건 객체를 바꾸지 않는다", () => {
    const input = conditions({ instructor: INSTRUCTOR, academy: ACADEMY, weekdays: ["sat"] });
    const snapshot = structuredClone(input);
    buildNoResultReply(input, []);
    expect(input).toEqual(snapshot);
  });
});
