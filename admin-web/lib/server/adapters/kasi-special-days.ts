// S0-4.11(특일 정보 실 어댑터) — 공공데이터포털 「한국천문연구원 특일 정보」 getRestDeInfo 를 부르는 실 구현.
//   포트: ../ports/special-days.ts(SpecialDayProviderPort) · 입력 조사: _workspace/03_research.md §3-2(실측)
//
// 이 파일의 일은 「바깥 응답 모양 → 포트 모양」 번역 하나다. 표에 넣는 일은 수집 작업(services/holiday-sync.ts)이 한다.
// 가짜(fakes/fake-special-days.ts)와 같은 계약을 지킨다 — 테스트 tests/unit/special-days-adapter.test.ts 가
// 둘에게 같은 계약 시험을 돌린다.
//
// 실측으로 정한 것(research §3-2):
//   - `_type=json` 을 꼭 붙인다(빼면 XML). `numOfRows` 기본값이 10 이라 100 으로 올린다(한 해 22건 안팎)
//   - `response.body.items.item` 은 1건이면 **객체**, 여러 건이면 **배열**, 0건이면 items 가 빈 문자열이다
//   - 인증키는 포털의 「일반 인증키」를 URLSearchParams 로 한 번만 인코딩해 넣는다(두 번 인코딩하면 키 오류)
//   - 키가 틀리면 `_type=json` 이어도 200 + XML(`<returnReasonCode>`)로 답하는 일이 있다 → RESULT_CODE 로 본다
// 오류 메시지에는 인증키와 요청 주소를 싣지 않는다 — 주소에 키가 들어 있기 때문이다.
import type { HolidayKind } from "../../domain/constants";
import {
  SpecialDayProviderError,
  type SpecialDayHoliday,
  type SpecialDayProviderPort,
} from "../ports/special-days";

export const KASI_REST_DE_INFO_URL =
  "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo";

/** 한 해 공휴일은 22건 안팎이다. 100 이면 한 번에 다 받는다 */
const NUM_OF_ROWS = 100;
/** 답이 이 시간 안에 안 오면 TIMEOUT 으로 본다. 하루 1회 작업이라 넉넉히 둔다 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 법정 공휴일 이름(관공서의 공휴일에 관한 규정). 2026 실응답에서 확인한 이름이다.
 * 여기 없는 이름(선거일·임시공휴일 등)은 임시 공휴일로 본다 — 영업일 계산은 종류와 상관없이 다 빼므로
 * 잘못 갈라도 기한이 틀어지지는 않는다. 종류는 운영자 화면(P9)에서 구별해 보여 주는 데만 쓴다.
 */
const STATUTORY_HOLIDAY_NAMES: ReadonlySet<string> = new Set([
  "1월1일",
  "신정",
  "설날",
  "삼일절",
  "노동절",
  "어린이날",
  "부처님오신날",
  "석가탄신일",
  "현충일",
  "제헌절",
  "광복절",
  "추석",
  "개천절",
  "한글날",
  "기독탄신일",
  "성탄절",
]);

/** 이름으로 공휴일 종류를 가른다. 「대체공휴일(삼일절)」처럼 앞에 대체가 붙으면 대체 공휴일이다 */
export function classifyHolidayKind(name: string): HolidayKind {
  const trimmed = name.trim();
  if (trimmed.startsWith("대체")) return "substitute_holiday";
  if (STATUTORY_HOLIDAY_NAMES.has(trimmed)) return "holiday";
  return "temporary_holiday";
}

/** 같은 날 두 이름이 겹치면 어느 종류로 남길지 — 법정 > 대체 > 임시 */
const KIND_RANK: Readonly<Record<HolidayKind, number>> = {
  holiday: 0,
  substitute_holiday: 1,
  temporary_holiday: 2,
};

function badResponse(detail: string): SpecialDayProviderError {
  return new SpecialDayProviderError("BAD_RESPONSE", `특일 정보 응답 모양이 다르다: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `locdate` 숫자 20260301(또는 문자열 "20260301") → "2026-03-01". 형식이 틀리면 null */
function locdateToIsoDate(locdate: unknown): string | null {
  const text = typeof locdate === "number" ? String(locdate) : typeof locdate === "string" ? locdate.trim() : "";
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match === null) return null;
  const [, y, m, d] = match;
  // 달력에 없는 날(2026-02-30 등)을 걸러 낸다
  try {
    Temporal.PlainDate.from({ year: Number(y), month: Number(m), day: Number(d) }, { overflow: "reject" });
  } catch {
    return null;
  }
  return `${y}-${m}-${d}`;
}

/**
 * getRestDeInfo 의 JSON 본문을 공휴일 목록으로 바꾼다. 테스트가 직접 부를 수 있게 내보낸다.
 *   - resultCode 가 "00" 이 아니면 RESULT_CODE
 *   - 모양이 틀리거나, 다른 해 날짜가 섞이거나, 받은 건수가 totalCount 보다 적으면 BAD_RESPONSE
 *   - isHoliday 가 Y 인 날만 남기고, 같은 날짜는 이름을 「·」로 이어 하나로 합친다
 */
export function parseRestDeInfoResponse(body: unknown, year: number): SpecialDayHoliday[] {
  if (!isRecord(body) || !isRecord(body["response"])) throw badResponse("response 없음");
  const response = body["response"];
  const header = response["header"];
  if (!isRecord(header)) throw badResponse("header 없음");
  const resultCode = header["resultCode"];
  if (resultCode !== "00") {
    // resultMsg 는 「SERVICE_KEY_IS_NOT_REGISTERED_ERROR」 같은 고정 문구라 그대로 실어도 키가 새지 않는다
    const msg = typeof header["resultMsg"] === "string" ? header["resultMsg"] : "";
    throw new SpecialDayProviderError("RESULT_CODE", `특일 정보 resultCode=${String(resultCode)} ${msg}`.trim());
  }

  const resBody = response["body"];
  if (!isRecord(resBody)) throw badResponse("body 없음");
  const totalCount = Number(resBody["totalCount"] ?? 0);
  if (!Number.isInteger(totalCount) || totalCount < 0) throw badResponse("totalCount");

  // 0건이면 items 가 빈 문자열("")로 온다. 1건이면 item 이 객체, 여러 건이면 배열
  const items = resBody["items"];
  const rawItem = isRecord(items) ? items["item"] : undefined;
  const rawList: unknown[] = rawItem === undefined ? [] : Array.isArray(rawItem) ? rawItem : [rawItem];
  if (rawList.length < totalCount) throw badResponse(`받은 ${rawList.length}건 < totalCount ${totalCount}`);

  // 날짜 → 공휴일. 같은 날이 두 번 오면(예: 어린이날·부처님오신날이 겹치는 해) 하나로 합친다
  const byDate = new Map<string, SpecialDayHoliday>();
  for (const raw of rawList) {
    if (!isRecord(raw)) throw badResponse("item 이 객체가 아님");
    if (raw["isHoliday"] !== "Y") continue; // 기념일·절기는 영업일과 상관없다
    const date = locdateToIsoDate(raw["locdate"]);
    if (date === null) throw badResponse("locdate 형식");
    if (!date.startsWith(`${year}-`)) throw badResponse("요청한 해가 아닌 날짜");
    const name = typeof raw["dateName"] === "string" ? raw["dateName"].trim() : "";
    if (name === "") throw badResponse("dateName 없음");

    const kind = classifyHolidayKind(name);
    const prev = byDate.get(date);
    const merged: SpecialDayHoliday =
      prev === undefined
        ? { date, name, kind }
        : {
            date,
            name: prev.name.split("·").includes(name) ? prev.name : `${prev.name}·${name}`,
            kind: KIND_RANK[kind] < KIND_RANK[prev.kind] ? kind : prev.kind,
          };
    byDate.set(date, merged);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface KasiSpecialDayProviderOptions {
  /** 포털 「일반 인증키」. 비어 있으면 부를 때 NOT_CONFIGURED 를 던진다 */
  readonly serviceKey: string | undefined;
  /** 테스트가 가짜 fetch 를 넣는 자리. 기본은 전역 fetch */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class KasiSpecialDayProvider implements SpecialDayProviderPort {
  readonly #serviceKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: KasiSpecialDayProviderOptions) {
    this.#serviceKey = options.serviceKey?.trim() || undefined;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async fetchPublicHolidays(year: number): Promise<readonly SpecialDayHoliday[]> {
    if (this.#serviceKey === undefined) {
      throw new SpecialDayProviderError("NOT_CONFIGURED", "PUBLIC_DATA_HOLIDAY_KEY 가 설정돼 있지 않다");
    }
    if (!Number.isInteger(year) || year < 1000 || year > 9999) {
      throw new RangeError(`solYear 는 4자리 해여야 한다: ${year}`);
    }

    // solMonth 를 빼면 한 해 전체가 온다
    const url = new URL(KASI_REST_DE_INFO_URL);
    url.search = new URLSearchParams({
      serviceKey: this.#serviceKey,
      solYear: String(year),
      numOfRows: String(NUM_OF_ROWS),
      pageNo: "1",
      _type: "json",
    }).toString();

    // ① 부르기 — 시간 초과와 연결 실패를 나눠 기록한다
    let res: Response;
    try {
      res = await this.#fetch(url, { signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new SpecialDayProviderError("TIMEOUT", `특일 정보가 ${this.#timeoutMs}ms 안에 답하지 않았다`);
      }
      throw new SpecialDayProviderError("NETWORK_ERROR", "특일 정보 서버에 연결하지 못했다");
    }
    if (!res.ok) {
      throw new SpecialDayProviderError("HTTP_ERROR", `특일 정보 HTTP ${res.status}`);
    }

    // ② 읽기 — JSON 이 아니면 키 오류 XML 인지 본다
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      const reason = /<returnReasonCode>(\d+)<\/returnReasonCode>/.exec(text);
      if (reason !== null) {
        throw new SpecialDayProviderError("RESULT_CODE", `특일 정보 returnReasonCode=${reason[1]}`);
      }
      throw badResponse("JSON 이 아님");
    }

    // ③ 번역
    return parseRestDeInfoResponse(body, year);
  }
}
