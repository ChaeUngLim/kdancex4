// SX-5.4(결과 없음 안내·조건 넓히기) — 말로 찾기 결과가 0건일 때 붙이는 안내와 「넓힌 조건」 버튼 값(순수 함수).
//   요구: FR-037a(강사 수업 말로 찾기 — 「조건에 맞는 수업이 없으면 「찾지 못했어요」와 함께 그 강사의 다른 수업이나
//         조건을 넓힌 검색으로 가는 버튼을 준다」) · FR-039(없는 항목 추천 금지) · FR-210(문장 속 값은 모델이 쓰지 않는다)
//   계약: 16-ai-agent.md §5-1(조건 모양) · §5-2 「결과 없음(no_offering_result)」
//
// 처음 보는 사람용 요약
//   - 회원이 「이준호 강사님의 라틴하우스 강남 주말 오전 수업」을 물었는데 DB 검색(SX-5.3 searchOfferingCards)이 0건이면,
//     빈 답 대신 「찾지 못했어요」 문장과 버튼 몇 개를 낸다. 버튼을 누르면 앱은 그 버튼에 담긴 조건으로 다시 찾는다.
//   - 버튼의 조건은 **원래 조건에서 칸을 빼기만** 해서 만든다. 새 강사·새 요일을 끼워 넣지 않는다 —
//     AI 가 짐작으로 조건을 지어내면 회원이 묻지 않은 수업이 나오기 때문이다(FR-039).
//   - 문장은 고정 문구다. 모델이 쓰지 않으므로 aiGenerated 는 false 다(FR-210).
//   - DB 를 보지 않는 순수 함수라 버튼마다 「수업 몇 개」는 세지 않는다(그 수는 누른 뒤의 검색이 보여 준다).
import type { ClassTargetLevel, Genre } from "./constants";
import type { Weekday } from "./recurring-schedule";

/** 이름과 id(SX-5.1 이름 후보 도구가 정한 id) */
export type NameRef = { readonly name?: string | null; readonly id?: string | null };

/** 계약 16 §5-1 조건 — 비운 칸은 null(빠져 있어도 null 로 본다) */
export type SearchConditions = {
  readonly instructor?: NameRef | null;
  readonly academy?: NameRef | null;
  readonly genre?: Genre | null;
  readonly weekdays?: readonly Weekday[] | null;
  readonly timeBand?: "morning" | "afternoon" | "evening" | { readonly from: string; readonly to: string } | null;
  readonly level?: ClassTargetLevel | null;
  readonly regionSido?: string | null;
  readonly regionGu?: string | null;
  readonly maxPriceAmount?: number | null;
  readonly dateFrom?: string | null;
  readonly dateTo?: string | null;
};

/** 버튼 값에 싣는 조건 — 열한 칸이 늘 다 있다(앱·도구가 그대로 search_offerings 입력으로 쓴다) */
export type NormalizedConditions = { readonly [K in keyof SearchConditions]-?: Exclude<SearchConditions[K], undefined> };

/** 넓히는 방법. 앞에 있을수록 먼저 보여 준다 */
export const WIDEN_KINDS = [
  "instructor_other_offerings", // 그 강사의 다른 수업(강사만 남긴다) — spec 이 먼저 든 버튼
  "drop_academy", // 모든 학원 수업 보기(M10F 조건 칩과 같은 말)
  "drop_time_band",
  "drop_weekdays",
  "drop_level",
  "drop_genre",
  "drop_date",
  "drop_price",
  "drop_region",
] as const;
export type WidenKind = (typeof WIDEN_KINDS)[number];

export type WidenAction = {
  readonly type: "widen_search";
  readonly widen: WidenKind;
  readonly label: string;
  readonly conditions: NormalizedConditions;
};

export type NoResultReply = {
  readonly kind: "no_offering_result";
  readonly sentence: string;
  readonly hint: string;
  readonly aiGenerated: false;
  readonly actions: readonly WidenAction[];
};

/** 안내 문장(FR-037a 「찾지 못했어요」) */
export const NO_RESULT_SENTENCE = "조건에 맞는 수업을 찾지 못했어요.";
/** 버튼은 최대 3개(M20E 완화 조건 칩 3개와 같은 수 — 많으면 무엇을 누를지 고르기 어렵다) */
export const MAX_WIDEN_ACTIONS = 3;

const HINT_WITH_ACTIONS = "아래 버튼으로 조건을 넓혀 다시 찾아볼 수 있어요.";
const HINT_INSTRUCTOR_ONLY = "이 강사님이 지금 모집 중인 수업이 없어요.";
const HINT_NOTHING_TO_WIDEN = "다른 장르나 강사 이름으로 다시 물어봐 주세요.";

/** 빠진 칸·빈 요일 배열을 null 로 맞추고, 칸 순서를 고정한다(같은 조건인지 견줄 때 순서가 같아야 한다) */
function normalize(c: SearchConditions): NormalizedConditions {
  return {
    instructor: c.instructor ?? null,
    academy: c.academy ?? null,
    genre: c.genre ?? null,
    weekdays: c.weekdays != null && c.weekdays.length > 0 ? c.weekdays : null,
    timeBand: c.timeBand ?? null,
    level: c.level ?? null,
    regionSido: c.regionSido ?? null,
    regionGu: c.regionGu ?? null,
    maxPriceAmount: c.maxPriceAmount ?? null,
    dateFrom: c.dateFrom ?? null,
    dateTo: c.dateTo ?? null,
  };
}

const hasAnyCondition = (c: NormalizedConditions): boolean => Object.values(c).some((value) => value !== null);
const sameConditions = (a: NormalizedConditions, b: NormalizedConditions): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 넓히는 방법 하나 → 넓힌 조건과 버튼 글자. 원래 조건에 그 칸이 없으면 null(넓힐 것이 없다) */
function widenOnce(kind: WidenKind, c: NormalizedConditions): { conditions: NormalizedConditions; label: string } | null {
  switch (kind) {
    case "instructor_other_offerings": {
      if (c.instructor === null) return null;
      // 강사 한 칸만 남긴 새 객체를 만든다(나머지는 전부 null)
      const name = c.instructor.name?.trim();
      const who = name ? `${name} 강사님` : "이 강사님";
      return { conditions: normalize({ instructor: c.instructor }), label: `${who}의 다른 수업 보기` };
    }
    case "drop_academy":
      return c.academy === null ? null : { conditions: { ...c, academy: null }, label: "모든 학원 수업 보기" };
    case "drop_time_band":
      return c.timeBand === null ? null : { conditions: { ...c, timeBand: null }, label: "시간대 상관없이 보기" };
    case "drop_weekdays":
      return c.weekdays === null ? null : { conditions: { ...c, weekdays: null }, label: "요일 상관없이 보기" };
    case "drop_level":
      return c.level === null ? null : { conditions: { ...c, level: null }, label: "레벨 상관없이 보기" };
    case "drop_genre":
      return c.genre === null ? null : { conditions: { ...c, genre: null }, label: "장르 상관없이 보기" };
    case "drop_date":
      return c.dateFrom === null && c.dateTo === null
        ? null
        : { conditions: { ...c, dateFrom: null, dateTo: null }, label: "날짜 상관없이 보기" };
    case "drop_price":
      return c.maxPriceAmount === null ? null : { conditions: { ...c, maxPriceAmount: null }, label: "가격 상관없이 보기" };
    case "drop_region":
      // 시·도와 구는 한 덩어리로 뺀다(구만 남으면 어느 시의 구인지 모른다)
      return c.regionSido === null && c.regionGu === null
        ? null
        : { conditions: { ...c, regionSido: null, regionGu: null }, label: "지역 상관없이 보기" };
  }
}

/**
 * 검색 결과가 0건이면 안내 문장과 넓힌 조건 버튼을, 1건 이상이면 null 을 돌려준다.
 * 버튼 규칙: WIDEN_KINDS 순서로 한 칸씩 빼 본다 → 조건이 하나도 안 남거나(조건 없음 검색 금지, 계약 16 §5-1)
 * 원래 조건·앞 버튼과 같은 조건이면 건너뛴다 → 앞에서부터 최대 MAX_WIDEN_ACTIONS 개.
 */
export function buildNoResultReply(conditions: SearchConditions, cards: readonly unknown[]): NoResultReply | null {
  if (cards.length > 0) return null;

  const original = normalize(conditions);
  const actions: WidenAction[] = [];
  for (const kind of WIDEN_KINDS) {
    if (actions.length >= MAX_WIDEN_ACTIONS) break;
    const widened = widenOnce(kind, original);
    if (widened === null) continue;
    if (!hasAnyCondition(widened.conditions)) continue;
    if (sameConditions(widened.conditions, original)) continue;
    if (actions.some((a) => sameConditions(a.conditions, widened.conditions))) continue;
    actions.push({ type: "widen_search", widen: kind, label: widened.label, conditions: widened.conditions });
  }

  // 안내 둘째 줄: 넓힐 버튼이 있으면 버튼 안내, 강사만으로 0건이면 그 강사에게 모집 중 수업이 없다는 사실, 그 밖에는 다시 묻기
  const instructorOnly = original.instructor !== null && sameConditions(original, normalize({ instructor: original.instructor }));
  const hint = actions.length > 0 ? HINT_WITH_ACTIONS : instructorOnly ? HINT_INSTRUCTOR_ONLY : HINT_NOTHING_TO_WIDEN;

  return { kind: "no_offering_result", sentence: NO_RESULT_SENTENCE, hint, aiGenerated: false, actions };
}
