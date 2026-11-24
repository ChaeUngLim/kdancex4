// S0-4.10(특일 정보 수집 작업) — 공휴일을 알려 주는 바깥 출처의 포트.
//   입력 조사: _workspace/03_research.md §3-2(공공데이터포털 「한국천문연구원 특일 정보」 실측)
//
// 수집 작업(lib/server/services/holiday-sync.ts)은 이 인터페이스만 안다. 실제 API 를 부르는 어댑터는
// S0-4.11(특일 정보 실 어댑터)이 만들고, 그 전까지는 가짜(fakes/fake-special-days.ts)를 쓴다.
// 어댑터의 일은 「바깥 응답 모양 → 아래 SpecialDayHoliday 모양」 번역까지다:
//   - `locdate`(숫자 20260301) → `"2026-03-01"`
//   - `isHoliday=Y` 인 날만 넘긴다(기념일·절기는 영업일과 상관없다)
//   - 이름으로 종류를 가른다(대체공휴일 → substitute_holiday 등)
// 응답이 이상하거나 호출이 실패하면 **예외**(SpecialDayProviderError)를 던진다. 빈 배열은 「그해 공휴일이 0개」라는
// 뜻이 되어 버리므로, 실패를 빈 배열로 돌려주지 않는다.
import type { HolidayKind } from "../../domain/constants";

/** 공휴일 하루. 날짜는 KST 달력 날짜 `"YYYY-MM-DD"` */
export interface SpecialDayHoliday {
  readonly date: string;
  readonly name: string;
  readonly kind: HolidayKind;
}

/**
 * 실패 원인 코드. holiday_sync_runs.error_code 에 그대로 들어간다.
 *   HTTP_ERROR      — 2xx 가 아닌 응답
 *   RESULT_CODE     — 응답은 왔는데 resultCode 가 "00"(성공)이 아님(키 오류·한도 초과 등)
 *   BAD_RESPONSE    — 모양이 예상과 다름(필드 없음·날짜 형식 틀림)
 *   TIMEOUT         — 시간 안에 답이 없음
 *   NETWORK_ERROR   — 연결 자체가 안 됨
 *   NOT_CONFIGURED  — 인증키가 설정돼 있지 않음
 */
export const SPECIAL_DAY_ERROR_CODES = [
  "HTTP_ERROR",
  "RESULT_CODE",
  "BAD_RESPONSE",
  "TIMEOUT",
  "NETWORK_ERROR",
  "NOT_CONFIGURED",
] as const;
export type SpecialDayErrorCode = (typeof SPECIAL_DAY_ERROR_CODES)[number];

/** 특일 정보 출처가 실패했을 때 던지는 오류. 메시지에 인증키 값을 싣지 않는다 */
export class SpecialDayProviderError extends Error {
  readonly code: SpecialDayErrorCode;

  constructor(code: SpecialDayErrorCode, message: string = code) {
    super(message);
    this.name = "SpecialDayProviderError";
    this.code = code;
  }
}

export interface SpecialDayProviderPort {
  /** 한 해의 공휴일 전부. 실패하면 SpecialDayProviderError 를 던진다 */
  fetchPublicHolidays(year: number): Promise<readonly SpecialDayHoliday[]>;
}
