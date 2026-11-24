// S1-1.30(국세청 상태조회 실 어댑터) — 국세청 「사업자등록 상태조회」(공공데이터포털 odcloud)를 부르는 실 구현.
//   포트: ../ports/business-status.ts(BusinessStatusPort) · 입력 조사: _workspace/03_research.md §3-3(실측)
//
// 이 파일의 일은 「바깥 응답 모양 → 포트 모양」 번역 하나다. 기록·제한 열기는 점검 작업(services/business-status-check.ts)이 한다.
// 가짜(fakes/fake-business-status.ts)와 같은 계약을 지킨다 — tests/unit/nts-business-status-adapter.test.ts 가
// 둘에게 같은 계약 시험을 돌린다.
//
// 실측으로 정한 것(research §3-3 + 2026-11-20 실호출):
//   - `POST …/v1/status?serviceKey=<키>` 에 JSON `{"b_no": [...]}`. 한 번에 100개까지
//   - 응답 `status_code: "OK"` + `data[]`. 항목의 `b_stt_cd` 는 01 계속 · 02 휴업 · 03 폐업, **빈 문자열이면 미등록**
//     (미등록도 200 으로 오고 tax_type 에 안내 문구가 들어 있다 — 빈 코드를 계속사업자로 읽지 않는다)
//   - 빈 목록을 보내면 411 REQUEST_DATA_MALFORMED → 빈 입력은 부르지 않고 바로 빈 결과를 낸다
//   - 키가 틀리면 401 `{"code":-4,"msg":"등록되지 않은 인증키 입니다."}`
//
// **실패를 예외로 던지지 않는다**(포트 규칙). 네트워크·응답 이상은 그 번호들의 결과를 status=error 로 돌려준다.
// 점검 작업은 error 를 「조치하지 않음」으로 처리하므로, 조회 실패가 폐업으로 오판되는 일이 없다.
// 원문(rawResponse)과 오류 내용에는 인증키와 요청 주소를 싣지 않는다 — 주소에 키가 들어 있기 때문이다.
import type { BusinessCheckStatus } from "../../domain/constants";
import {
  assertBusinessStatusRequest,
  type BusinessStatusErrorCode,
  type BusinessStatusPort,
  type BusinessStatusResult,
} from "../ports/business-status";

export const NTS_BUSINESS_STATUS_URL = "https://api.odcloud.kr/api/nts-businessman/v1/status";

/** 답이 이 시간 안에 안 오면 TIMEOUT 으로 본다. 하루 1회 + 정산 직전 작업이라 넉넉히 둔다 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** 국세청 b_stt_cd → 포트 상태. 빈 문자열은 미등록이다. 여기 없는 코드는 BAD_RESPONSE 로 본다 */
const STATUS_BY_CODE: Readonly<Record<string, Exclude<BusinessCheckStatus, "error">>> = {
  "01": "active",
  "02": "suspended",
  "03": "closed",
  "": "not_found",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 결과를 얼려서 넘긴다 — 받는 쪽이 고쳐도 다음 호출에 영향이 없게(가짜와 같다) */
function freeze(result: BusinessStatusResult): BusinessStatusResult {
  return Object.freeze({ ...result, rawResponse: Object.freeze({ ...result.rawResponse }) });
}

/** 조회 실패 결과. 원문에는 실패 코드와 키가 없는 짧은 설명만 남긴다 */
function errorResult(
  businessNo: string,
  errorCode: BusinessStatusErrorCode,
  detail: Readonly<Record<string, unknown>> = {},
): BusinessStatusResult {
  return freeze({
    businessNo,
    status: "error",
    closedOn: null,
    taxType: null,
    errorCode,
    rawResponse: { error_code: errorCode, ...detail },
  });
}

/** 번호 전부를 같은 실패로 돌려준다(호출 자체가 실패한 경우) */
function allFailed(
  businessNos: readonly string[],
  errorCode: BusinessStatusErrorCode,
  detail: Readonly<Record<string, unknown>> = {},
): readonly BusinessStatusResult[] {
  return businessNos.map((no) => errorResult(no, errorCode, detail));
}

/** `end_dt` "20261031" → "2026-10-31". 빈 값이면 null, 달력에 없는 날이면 undefined(모양 틀림) */
function endDtToIsoDate(endDt: unknown): string | null | undefined {
  if (endDt === undefined || endDt === null || endDt === "") return null;
  if (typeof endDt !== "string") return undefined;
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(endDt.trim());
  if (match === null) return undefined;
  const [, y, m, d] = match;
  try {
    Temporal.PlainDate.from({ year: Number(y), month: Number(m), day: Number(d) }, { overflow: "reject" });
  } catch {
    return undefined;
  }
  return `${y}-${m}-${d}`;
}

/** 응답 항목 하나를 포트 결과로 바꾼다. 모양이 틀리면 그 번호만 BAD_RESPONSE 다 */
function translateItem(businessNo: string, item: Record<string, unknown>): BusinessStatusResult {
  const code = item["b_stt_cd"];
  const status = typeof code === "string" ? STATUS_BY_CODE[code.trim()] : undefined;
  if (status === undefined) {
    return errorResult(businessNo, "BAD_RESPONSE", { reason: "b_stt_cd", item });
  }

  // 미등록은 tax_type 에 「등록되지 않은 번호」 안내 문구가 오므로 과세 유형으로 쓰지 않는다
  const taxTypeText = typeof item["tax_type"] === "string" ? item["tax_type"].trim() : "";
  const taxType = status === "not_found" || taxTypeText === "" ? null : taxTypeText;

  // 폐업일은 폐업일 때만 쓴다. 다른 상태의 end_dt 는 원문에만 남긴다
  let closedOn: string | null = null;
  if (status === "closed") {
    const parsed = endDtToIsoDate(item["end_dt"]);
    if (parsed === undefined) return errorResult(businessNo, "BAD_RESPONSE", { reason: "end_dt", item });
    closedOn = parsed;
  }

  return freeze({ businessNo, status, closedOn, taxType, errorCode: null, rawResponse: item });
}

/**
 * 상태조회 응답 본문을 번호 순서대로 결과로 바꾼다. 테스트가 직접 부를 수 있게 내보낸다.
 *   - status_code 가 "OK" 가 아니면 번호 전부 RESULT_CODE
 *   - data 가 배열이 아니면 번호 전부 BAD_RESPONSE
 *   - 응답 순서를 믿지 않고 b_no 로 짝을 맞춘다. 짝이 없는 번호는 그 번호만 BAD_RESPONSE
 */
export function parseNtsStatusResponse(
  body: unknown,
  businessNos: readonly string[],
): readonly BusinessStatusResult[] {
  if (!isRecord(body)) return allFailed(businessNos, "BAD_RESPONSE", { reason: "본문이 객체가 아님" });
  const statusCode = body["status_code"];
  if (statusCode !== "OK") {
    return allFailed(businessNos, "RESULT_CODE", { status_code: typeof statusCode === "string" ? statusCode : null });
  }
  const data = body["data"];
  if (!Array.isArray(data)) return allFailed(businessNos, "BAD_RESPONSE", { reason: "data 가 배열이 아님" });

  // b_no → 항목. 같은 번호가 두 번 오면 첫 항목을 쓴다(같은 번호는 같은 상태다)
  const byNo = new Map<string, Record<string, unknown>>();
  for (const raw of data) {
    if (!isRecord(raw) || typeof raw["b_no"] !== "string") continue;
    const no = raw["b_no"].replaceAll("-", "").trim();
    if (!byNo.has(no)) byNo.set(no, raw);
  }

  return businessNos.map((no) => {
    const item = byNo.get(no);
    return item === undefined ? errorResult(no, "BAD_RESPONSE", { reason: "응답에 그 번호 항목이 없음" }) : translateItem(no, item);
  });
}

export interface NtsBusinessStatusProviderOptions {
  /** 포털 「일반 인증키」(PUBLIC_DATA_NTS_KEY). 비어 있으면 부르지 않고 번호 전부 NOT_CONFIGURED */
  readonly serviceKey: string | undefined;
  /** 테스트가 가짜 fetch 를 넣는 자리. 기본은 전역 fetch */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class NtsBusinessStatusProvider implements BusinessStatusPort {
  readonly #serviceKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: NtsBusinessStatusProviderOptions) {
    this.#serviceKey = options.serviceKey?.trim() || undefined;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async checkStatuses(businessNos: readonly string[]): Promise<readonly BusinessStatusResult[]> {
    // 호출하는 쪽 잘못(모양·개수)만 던진다 — 가짜와 같은 검사 함수
    assertBusinessStatusRequest(businessNos);
    // 빈 목록을 보내면 국세청이 411 을 낸다. 물을 것이 없으니 부르지 않는다
    if (businessNos.length === 0) return [];
    if (this.#serviceKey === undefined) return allFailed(businessNos, "NOT_CONFIGURED");

    // 키는 주소에 URLSearchParams 로 한 번만 인코딩해 넣는다(특일 정보 어댑터와 같은 방식)
    const url = new URL(NTS_BUSINESS_STATUS_URL);
    url.search = new URLSearchParams({ serviceKey: this.#serviceKey }).toString();
    // 같은 번호를 두 번 묻지 않는다. 결과는 parseNtsStatusResponse 가 원래 순서·개수로 되돌린다
    const unique = [...new Set(businessNos)];

    // ① 부르기 — 시간 초과와 연결 실패를 나눠 기록한다
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ b_no: unique }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") return allFailed(businessNos, "TIMEOUT");
      return allFailed(businessNos, "NETWORK_ERROR");
    }

    // ② 읽기 — 2xx 가 아니면 상태 번호와 국세청이 준 고정 문구(code·msg)만 남긴다
    const text = await res.text().catch(() => "");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const detail: Record<string, unknown> = { http_status: res.status };
      if (isRecord(body)) {
        if (body["code"] !== undefined) detail["code"] = body["code"];
        if (typeof body["msg"] === "string") detail["msg"] = body["msg"];
        if (typeof body["status_code"] === "string") detail["status_code"] = body["status_code"];
      }
      return allFailed(businessNos, "HTTP_ERROR", detail);
    }
    if (body === undefined) return allFailed(businessNos, "BAD_RESPONSE", { reason: "JSON 이 아님" });

    // ③ 번역
    return parseNtsStatusResponse(body, businessNos);
  }
}
