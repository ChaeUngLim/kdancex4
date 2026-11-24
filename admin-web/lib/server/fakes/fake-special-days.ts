// S0-4.10(특일 정보 수집 작업) — SpecialDayProviderPort 의 가짜 구현.
//
// 바깥 API 를 부르지 않고, 미리 넣어 둔 응답을 연도별로 돌려준다. 수집 작업 테스트가
// 「새 공휴일이 들어온다」·「실패하면 표가 그대로다」를 DB 와 함께 확인할 때 쓴다.
// 실 어댑터(S0-4.11)가 붙기 전에는 deps.ts 도 이것을 준다 — 응답을 넣지 않은 해는 빈 목록이다.
import type { HolidayKind } from "../../domain/constants";
import {
  SpecialDayProviderError,
  type SpecialDayErrorCode,
  type SpecialDayHoliday,
  type SpecialDayProviderPort,
} from "../ports/special-days";

/** 한 해치 응답 — 공휴일 목록이거나, 실패 코드 */
export type FakeSpecialDayResponse =
  | { readonly holidays: readonly SpecialDayHoliday[] }
  | { readonly error: SpecialDayErrorCode };

export class FakeSpecialDayProvider implements SpecialDayProviderPort {
  #responses = new Map<number, FakeSpecialDayResponse>();
  #calls: number[] = [];

  /** 그해에 돌려줄 응답을 정한다. 같은 해를 다시 정하면 덮어쓴다 */
  respond(year: number, response: FakeSpecialDayResponse): this {
    this.#responses = new Map(this.#responses).set(year, response);
    return this;
  }

  /** fetchPublicHolidays 가 불린 연도(순서대로) */
  get calls(): readonly number[] {
    return [...this.#calls];
  }

  async fetchPublicHolidays(year: number): Promise<readonly SpecialDayHoliday[]> {
    this.#calls = [...this.#calls, year];
    const response = this.#responses.get(year);
    if (response === undefined) return [];
    if ("error" in response) {
      throw new SpecialDayProviderError(response.error, `가짜 특일 정보 실패(${response.error})`);
    }
    // 복사해서 넘긴다 — 받는 쪽이 배열을 바꿔도 다음 호출에 영향이 없게
    return response.holidays.map((h) => ({ ...h }));
  }
}

/** 테스트에서 공휴일 하루를 짧게 쓰는 도우미 */
export function fakeHoliday(date: string, name: string, kind: HolidayKind = "holiday"): SpecialDayHoliday {
  return { date, name, kind };
}
