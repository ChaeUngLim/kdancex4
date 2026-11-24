// S1-1.26(사업자 상태 조회 포트와 가짜 구현) — BusinessStatusPort 의 가짜 구현.
//
// 국세청 API 를 부르지 않고, 번호마다 미리 골라 둔 상태를 돌려준다. 점검 작업 테스트(S1-1.27)가
// 「폐업이면 확인 기록 1행」·「오류는 조치 0」을 DB 와 함께 확인할 때 쓴다.
// 실 어댑터가 붙기 전에는 deps.ts 도 이것을 준다 — 골라 두지 않은 번호는 미등록(not_found)이다.
// 진짜 API 도 모르는 번호에 「등록되지 않은 번호」로 답하므로(03_research.md §3-3) 같은 기본값을 쓴다.
//
// 원문(rawResponse)은 국세청 응답 항목 모양(b_no·b_stt_cd·end_dt·tax_type)을 흉내 낸다.
// 그래야 raw_response 칸에 쌓이는 모양이 실 어댑터와 크게 다르지 않다.
import type { BusinessCheckStatus } from "../../domain/constants";
import {
  assertBusinessStatusRequest,
  type BusinessStatusErrorCode,
  type BusinessStatusPort,
  type BusinessStatusResult,
} from "../ports/business-status";

/** 번호 하나에 골라 두는 응답. 상태만 주면 나머지는 상태에 맞는 기본값으로 채운다 */
export type FakeBusinessStatusChoice =
  | { readonly status: "active" | "suspended"; readonly taxType?: string }
  | { readonly status: "closed"; readonly closedOn?: string; readonly taxType?: string }
  | { readonly status: "not_found" }
  | { readonly status: "error"; readonly errorCode?: BusinessStatusErrorCode };

/** 국세청 b_stt_cd 값. 미등록은 빈 문자열로 온다(03_research.md §3-3) */
const NTS_STATUS_CODE: Readonly<Record<"active" | "suspended" | "closed" | "not_found", string>> = {
  active: "01",
  suspended: "02",
  closed: "03",
  not_found: "",
};
const NTS_STATUS_TEXT: Readonly<Record<"active" | "suspended" | "closed", string>> = {
  active: "계속사업자",
  suspended: "휴업자",
  closed: "폐업자",
};
const DEFAULT_TAX_TYPE = "부가가치세 일반과세자";
const NOT_FOUND_TAX_TYPE = "국세청에 등록되지 않은 사업자등록번호입니다.";
const DEFAULT_CLOSED_ON = "2026-11-01";
const DEFAULT_ERROR_CODE: BusinessStatusErrorCode = "NETWORK_ERROR";

export class FakeBusinessStatusProvider implements BusinessStatusPort {
  #choices = new Map<string, FakeBusinessStatusChoice>();
  #failAll: BusinessStatusErrorCode | null = null;
  #calls: (readonly string[])[] = [];

  /** 그 번호에 돌려줄 상태를 고른다. 같은 번호를 다시 고르면 덮어쓴다 */
  respond(businessNo: string, choice: FakeBusinessStatusChoice | BusinessCheckStatus): this {
    const normalized: FakeBusinessStatusChoice = typeof choice === "string" ? { status: choice } : choice;
    this.#choices = new Map(this.#choices).set(businessNo, normalized);
    return this;
  }

  /** 호출 전체가 실패한 것처럼 만든다(키 미등록·장애). null 을 주면 되돌린다 */
  failAll(errorCode: BusinessStatusErrorCode | null): this {
    this.#failAll = errorCode;
    return this;
  }

  /** checkStatuses 가 받은 번호 묶음(순서대로) */
  get calls(): readonly (readonly string[])[] {
    return this.#calls.map((batch) => [...batch]);
  }

  async checkStatuses(businessNos: readonly string[]): Promise<readonly BusinessStatusResult[]> {
    // 실 어댑터와 같은 입력 규칙 — 가짜라고 101개를 받아 주면 점검 작업의 묶음 나누기 버그를 못 잡는다
    assertBusinessStatusRequest(businessNos);
    this.#calls = [...this.#calls, [...businessNos]];

    const failAll = this.#failAll;
    if (failAll !== null) {
      return businessNos.map((no) => errorResult(no, failAll));
    }
    return businessNos.map((no) => toResult(no, this.#choices.get(no) ?? { status: "not_found" }));
  }
}

/** 고른 응답 하나를 포트 결과 모양으로 바꾼다. 상태마다 채우는 칸이 다르다 */
function toResult(businessNo: string, choice: FakeBusinessStatusChoice): BusinessStatusResult {
  switch (choice.status) {
    case "active":
    case "suspended": {
      const taxType = choice.taxType ?? DEFAULT_TAX_TYPE;
      return freeze({
        businessNo,
        status: choice.status,
        closedOn: null,
        taxType,
        errorCode: null,
        rawResponse: ntsItem(businessNo, choice.status, "", taxType),
      });
    }
    case "closed": {
      const closedOn = choice.closedOn ?? DEFAULT_CLOSED_ON;
      const taxType = choice.taxType ?? DEFAULT_TAX_TYPE;
      return freeze({
        businessNo,
        status: "closed",
        closedOn,
        taxType,
        errorCode: null,
        rawResponse: ntsItem(businessNo, "closed", closedOn.replaceAll("-", ""), taxType),
      });
    }
    case "not_found":
      return freeze({
        businessNo,
        status: "not_found",
        closedOn: null,
        taxType: null,
        errorCode: null,
        rawResponse: { b_no: businessNo, b_stt: "", b_stt_cd: NTS_STATUS_CODE.not_found, end_dt: "", tax_type: NOT_FOUND_TAX_TYPE },
      });
    case "error":
      return errorResult(businessNo, choice.errorCode ?? DEFAULT_ERROR_CODE);
  }
}

/** 조회 실패 결과. 원문에는 실패 코드만 남긴다(진짜 실패 응답에도 번호 항목이 없다) */
function errorResult(businessNo: string, errorCode: BusinessStatusErrorCode): BusinessStatusResult {
  return freeze({
    businessNo,
    status: "error",
    closedOn: null,
    taxType: null,
    errorCode,
    rawResponse: { fake: true, error_code: errorCode },
  });
}

/** 국세청 응답 항목 모양을 흉내 낸 원문 */
function ntsItem(
  businessNo: string,
  status: "active" | "suspended" | "closed",
  endDt: string,
  taxType: string,
): Readonly<Record<string, unknown>> {
  return { b_no: businessNo, b_stt: NTS_STATUS_TEXT[status], b_stt_cd: NTS_STATUS_CODE[status], end_dt: endDt, tax_type: taxType };
}

/** 결과를 얼려서 넘긴다 — 받는 쪽이 고쳐도 다음 호출에 영향이 없게 */
function freeze(result: BusinessStatusResult): BusinessStatusResult {
  return Object.freeze({ ...result, rawResponse: Object.freeze({ ...result.rawResponse }) });
}
