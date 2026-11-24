// S1-1.26(사업자 상태 조회 포트와 가짜 구현) — 국세청 사업자 상태조회를 감싸는 포트.
//   입력 조사: _workspace/03_research.md §3-3(국세청 사업자 상태조회 API 실측) · 데이터 모델 §7-3b
//
// 누가 쓰나: 사업자 상태 점검 작업(S1-1.27 — 매일 1회 + 정산 직전)만 이 포트를 부른다.
// **결제 시작·정산 지급 같은 요청 경로에서는 부르지 않는다.** 그쪽은 academy_restrictions 에 열린 행이
// 있는지만 읽는다(데이터 모델 §7-3b 마지막 줄). 바깥 API 가 느리거나 죽어도 회원 결제가 멈추지 않게 하려는 것이다.
//
// 결과 상태는 business_status_checks.status 와 같은 다섯 값이다(BUSINESS_CHECK_STATUSES).
//   active(계속) · suspended(휴업) · closed(폐업) · not_found(미등록) · error(조회 실패)
// 특일 정보 포트(special-days.ts)와 달리 **실패를 예외로 던지지 않고 error 상태로 돌려준다.**
// 점검 작업은 번호마다 한 줄씩 기록을 남겨야 하고, error 는 「조치하지 않고 다음 점검에서 다시 본다」는
// 정해진 처리가 있기 때문이다 — 조회 실패를 폐업으로 오판하지 않으려는 장치다.
// 예외는 호출하는 쪽의 잘못(번호 모양이 틀림·한 번에 100개 초과)에만 던진다.
import type { BusinessCheckStatus } from "../../domain/constants";

/** 국세청 API 가 한 번에 받는 번호 수의 상한(03_research.md §3-3 「한 번에 최대 100개」) */
export const BUSINESS_STATUS_MAX_BATCH = 100;

/** 사업자등록번호 모양 — 하이픈 없는 숫자 10자리 */
export const BUSINESS_NO_PATTERN = /^\d{10}$/;

/**
 * 조회 실패 원인 코드. status 가 error 일 때만 붙는다.
 *   HTTP_ERROR      — 2xx 가 아닌 응답
 *   RESULT_CODE     — 응답은 왔는데 status_code 가 "OK" 가 아님(키 미등록 401 등)
 *   BAD_RESPONSE    — 모양이 예상과 다름(그 번호 항목이 없음·필드 형식 틀림)
 *   TIMEOUT         — 시간 안에 답이 없음
 *   NETWORK_ERROR   — 연결 자체가 안 됨
 *   NOT_CONFIGURED  — 인증키가 설정돼 있지 않음
 */
export const BUSINESS_STATUS_ERROR_CODES = [
  "HTTP_ERROR",
  "RESULT_CODE",
  "BAD_RESPONSE",
  "TIMEOUT",
  "NETWORK_ERROR",
  "NOT_CONFIGURED",
] as const;
export type BusinessStatusErrorCode = (typeof BUSINESS_STATUS_ERROR_CODES)[number];

/**
 * 번호 하나의 조회 결과. business_status_checks 한 행에 그대로 옮겨 담을 수 있는 칸만 둔다.
 *   closedOn    — 폐업일 `"YYYY-MM-DD"`. closed 일 때만 값이 있을 수 있다
 *   taxType     — 과세 유형 글(참고용). 미등록·실패면 null
 *   errorCode   — error 일 때만 값이 있다. 나머지 넷은 null
 *   rawResponse — 받은 원문(그 번호 항목 또는 실패 내용). raw_response 칸에 보관한다. 인증키는 넣지 않는다
 */
export interface BusinessStatusResult {
  readonly businessNo: string;
  readonly status: BusinessCheckStatus;
  readonly closedOn: string | null;
  readonly taxType: string | null;
  readonly errorCode: BusinessStatusErrorCode | null;
  readonly rawResponse: Readonly<Record<string, unknown>>;
}

/** 호출하는 쪽의 잘못(번호 모양·개수)일 때 던지는 오류. 바깥 API 실패에는 쓰지 않는다 */
export class BusinessStatusRequestError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "BusinessStatusRequestError";
  }
}

export interface BusinessStatusPort {
  /**
   * 번호들의 현재 상태를 조회한다. 결과는 **넘긴 번호와 같은 순서·같은 개수**다(중복 번호도 그대로).
   * 번호가 10자리 숫자가 아니거나 BUSINESS_STATUS_MAX_BATCH 를 넘으면 BusinessStatusRequestError 를 던진다.
   * 그 밖의 실패(네트워크·응답 이상)는 던지지 않고 그 번호의 status 를 error 로 돌려준다.
   */
  checkStatuses(businessNos: readonly string[]): Promise<readonly BusinessStatusResult[]>;
}

/** 실 어댑터와 가짜가 함께 쓰는 입력 검사. 위 두 규칙을 한 곳에서만 지킨다 */
export function assertBusinessStatusRequest(businessNos: readonly string[]): void {
  if (businessNos.length > BUSINESS_STATUS_MAX_BATCH) {
    throw new BusinessStatusRequestError(
      `사업자 상태 조회는 한 번에 ${BUSINESS_STATUS_MAX_BATCH}개까지다(받은 수 ${businessNos.length}).`,
    );
  }
  const badIndex = businessNos.findIndex((no) => !BUSINESS_NO_PATTERN.test(no));
  if (badIndex >= 0) {
    // 번호 값은 메시지에 넣지 않는다 — 몇 번째인지만 알려 준다
    throw new BusinessStatusRequestError(`${badIndex + 1}번째 사업자등록번호가 하이픈 없는 10자리 숫자가 아니다.`);
  }
}
