// S1-1.30(국세청 상태조회 실 어댑터) 단위 테스트 — 로드맵 verify 의 `tests/unit/s1-1-30.test.ts` 를 기능 이름으로 바꿨다.
//   포트: lib/server/ports/business-status.ts · 실 어댑터: lib/server/adapters/nts-business-status.ts
//   가짜: lib/server/fakes/fake-business-status.ts · 입력: 03_research.md §3-3
//
// 확인하는 것:
//   ① 계약 시험 — 가짜와 실 어댑터(가짜 fetch)에 **같은** 시험을 돌린다. 다섯 상태의 칸 규칙, 순서·개수·중복 유지,
//      입력 규칙(10자리·100개), 실패는 예외가 아니라 번호마다 error, 결과 동결
//   ② 실 어댑터만의 요청·번역 규칙 — POST 본문·키 한 번 인코딩·중복 번호 한 번만 묻기·빈 입력은 부르지 않기,
//      b_no 로 짝 맞추기, 오류 코드 6종, 메시지·원문에 키 없음
//   ③ 실호출 1건 — 인증키가 있을 때만. 공개된 법인 번호 1건을 실제로 조회한다(키는 찍지 않는다)
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import { BUSINESS_CHECK_STATUSES } from "../../lib/domain/constants";
import { createDeps } from "../../lib/server/deps";
import {
  NTS_BUSINESS_STATUS_URL,
  NtsBusinessStatusProvider,
  parseNtsStatusResponse,
} from "../../lib/server/adapters/nts-business-status";
import { FakeBusinessStatusProvider } from "../../lib/server/fakes/fake-business-status";
import {
  BUSINESS_STATUS_ERROR_CODES,
  BUSINESS_STATUS_MAX_BATCH,
  BusinessStatusRequestError,
  type BusinessStatusPort,
  type BusinessStatusResult,
} from "../../lib/server/ports/business-status";
import { findPublicDataKey } from "../setup/public-data-key";

const TEST_KEY = "test-key/with+special=chars==";

const ACTIVE_NO = "1111111111";
const SUSPENDED_NO = "2222222222";
const CLOSED_NO = "3333333333";
const NOT_FOUND_NO = "4444444444";

// 2026-11-20 실호출에서 본 응답 항목 모양(research §3-3)
function ntsItem(b_no: string, b_stt_cd: string, end_dt = "", tax_type = "부가가치세 일반과세자") {
  const text: Record<string, string> = { "01": "계속사업자", "02": "휴업자", "03": "폐업자", "": "" };
  return {
    b_no,
    b_stt: text[b_stt_cd] ?? "",
    b_stt_cd,
    tax_type: b_stt_cd === "" ? "국세청에 등록되지 않은 사업자등록번호입니다." : tax_type,
    tax_type_cd: b_stt_cd === "" ? "" : "01",
    end_dt,
    utcc_yn: "N",
    tax_type_change_dt: "",
    invoice_apply_dt: "",
    rbf_tax_type: "해당없음",
    rbf_tax_type_cd: "99",
  };
}
const okBody = (data: unknown[]) => ({ request_cnt: data.length, match_cnt: data.length, status_code: "OK", data });

/** 네 번호의 정답 표 — 가짜에는 respond 로, 실 어댑터에는 가짜 fetch 응답으로 같은 내용을 넣는다 */
const ANSWERS: Readonly<Record<string, ReturnType<typeof ntsItem>>> = {
  [ACTIVE_NO]: ntsItem(ACTIVE_NO, "01"),
  [SUSPENDED_NO]: ntsItem(SUSPENDED_NO, "02"),
  [CLOSED_NO]: ntsItem(CLOSED_NO, "03", "20261031"),
  [NOT_FOUND_NO]: ntsItem(NOT_FOUND_NO, ""),
};

interface FetchCall {
  readonly url: URL;
  readonly init: RequestInit | undefined;
}

/** 가짜 fetch — 정해 둔 답을 내고, 불린 주소·옵션을 기록한다 */
function stubFetch(answer: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof fetch;
  return { fetch: fn, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 국세청처럼 요청 본문의 b_no 를 보고 정답 표에서 골라 답하는 fetch */
function ntsLikeFetch() {
  return stubFetch((_url, init) => {
    const { b_no } = JSON.parse(String(init?.body)) as { b_no: string[] };
    return json(okBody(b_no.map((no) => ANSWERS[no] ?? ntsItem(no, ""))));
  });
}

interface Subject {
  readonly name: string;
  /** 정상 응답을 내는 구현 */
  readonly make: () => BusinessStatusPort;
  /** 호출 전체가 실패하는 구현 */
  readonly makeFailing: () => BusinessStatusPort;
}

const subjects: readonly Subject[] = [
  {
    name: "FakeBusinessStatusProvider",
    make: () =>
      new FakeBusinessStatusProvider()
        .respond(ACTIVE_NO, "active")
        .respond(SUSPENDED_NO, "suspended")
        .respond(CLOSED_NO, { status: "closed", closedOn: "2026-10-31" })
        .respond(NOT_FOUND_NO, "not_found"),
    makeFailing: () => new FakeBusinessStatusProvider().failAll("HTTP_ERROR"),
  },
  {
    name: "NtsBusinessStatusProvider(가짜 fetch)",
    make: () => new NtsBusinessStatusProvider({ serviceKey: TEST_KEY, fetch: ntsLikeFetch().fetch }),
    makeFailing: () =>
      new NtsBusinessStatusProvider({ serviceKey: TEST_KEY, fetch: stubFetch(() => json({ msg: "x" }, 500)).fetch }),
  },
];

/** 상태마다 채워지는 칸의 규칙 — 포트 주석(business-status.ts)의 BusinessStatusResult 설명 그대로 */
function expectFieldRules(r: BusinessStatusResult): void {
  expect(BUSINESS_CHECK_STATUSES).toContain(r.status);
  expect(r.businessNo).toMatch(/^\d{10}$/);
  if (r.status !== "closed") expect(r.closedOn).toBeNull();
  else if (r.closedOn !== null) expect(r.closedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  if (r.status === "error") {
    expect(BUSINESS_STATUS_ERROR_CODES).toContain(r.errorCode);
    expect(r.taxType).toBeNull();
  } else {
    expect(r.errorCode).toBeNull();
  }
  if (r.status === "not_found") expect(r.taxType).toBeNull();
  expect(typeof r.rawResponse).toBe("object");
}

describe.each(subjects)("① BusinessStatusPort 계약 — $name", ({ make, makeFailing }) => {
  test("네 상태(계속·휴업·폐업·미등록)를 정해진 칸 규칙으로 돌려준다", async () => {
    const results = await make().checkStatuses([ACTIVE_NO, SUSPENDED_NO, CLOSED_NO, NOT_FOUND_NO]);
    expect(results.map((r) => r.status)).toEqual(["active", "suspended", "closed", "not_found"]);
    results.forEach(expectFieldRules);
    expect(results[2]!.closedOn).toBe("2026-10-31");
    expect(results[0]!.taxType).toBe("부가가치세 일반과세자");
    // 원문은 국세청 항목 모양 — 미등록은 빈 코드다
    expect(results[0]!.rawResponse["b_stt_cd"]).toBe("01");
    expect(results[3]!.rawResponse["b_stt_cd"]).toBe("");
  });

  test("결과는 넘긴 번호와 같은 순서·개수다(중복 번호도 그대로)", async () => {
    const input = [CLOSED_NO, ACTIVE_NO, CLOSED_NO, NOT_FOUND_NO];
    const results = await make().checkStatuses(input);
    expect(results.map((r) => r.businessNo)).toEqual(input);
    expect(results.map((r) => r.status)).toEqual(["closed", "active", "closed", "not_found"]);
  });

  test("빈 목록이면 빈 결과", async () => {
    expect(await make().checkStatuses([])).toEqual([]);
  });

  test("입력 규칙: 10자리 숫자가 아니거나 100개를 넘으면 BusinessStatusRequestError, 100개는 통과", async () => {
    const port = make();
    for (const bad of ["123456789", "12345678901", "123-45-67890", "abcdefghij", ""]) {
      await expect(port.checkStatuses([bad])).rejects.toBeInstanceOf(BusinessStatusRequestError);
    }
    const hundred = Array.from({ length: BUSINESS_STATUS_MAX_BATCH }, (_, i) => String(1_000_000_000 + i));
    await expect(port.checkStatuses(hundred)).resolves.toHaveLength(BUSINESS_STATUS_MAX_BATCH);
    await expect(port.checkStatuses([...hundred, "9999999999"])).rejects.toBeInstanceOf(BusinessStatusRequestError);
  });

  test("호출 전체가 실패해도 던지지 않고 번호마다 error 를 돌려준다", async () => {
    const results = await makeFailing().checkStatuses([ACTIVE_NO, CLOSED_NO]);
    expect(results.map((r) => [r.businessNo, r.status, r.errorCode])).toEqual([
      [ACTIVE_NO, "error", "HTTP_ERROR"],
      [CLOSED_NO, "error", "HTTP_ERROR"],
    ]);
    results.forEach(expectFieldRules);
  });

  test("결과는 얼려서 넘긴다", async () => {
    const [r] = await make().checkStatuses([ACTIVE_NO]);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r!.rawResponse)).toBe(true);
  });
});

describe("② NtsBusinessStatusProvider — 요청 모양", () => {
  test("POST JSON {b_no}, serviceKey 는 주소에 한 번만 인코딩, 같은 번호는 한 번만 묻는다", async () => {
    const stub = ntsLikeFetch();
    await new NtsBusinessStatusProvider({ serviceKey: TEST_KEY, fetch: stub.fetch }).checkStatuses([
      ACTIVE_NO,
      ACTIVE_NO,
      CLOSED_NO,
    ]);
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(`${call.url.origin}${call.url.pathname}`).toBe(NTS_BUSINESS_STATUS_URL);
    expect(call.url.searchParams.get("serviceKey")).toBe(TEST_KEY); // 한 번 풀면 원래 키 = 한 번만 인코딩
    expect(call.init?.method).toBe("POST");
    expect(new Headers(call.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(call.init?.body))).toEqual({ b_no: [ACTIVE_NO, CLOSED_NO] });
  });

  test("빈 목록은 부르지 않는다(국세청은 빈 목록에 411)", async () => {
    const stub = ntsLikeFetch();
    await new NtsBusinessStatusProvider({ serviceKey: TEST_KEY, fetch: stub.fetch }).checkStatuses([]);
    expect(stub.calls).toHaveLength(0);
  });

  test("키가 없으면 부르지 않고 번호마다 NOT_CONFIGURED", async () => {
    const stub = ntsLikeFetch();
    for (const serviceKey of [undefined, "", "  "]) {
      const results = await new NtsBusinessStatusProvider({ serviceKey, fetch: stub.fetch }).checkStatuses([ACTIVE_NO]);
      expect(results.map((r) => [r.status, r.errorCode])).toEqual([["error", "NOT_CONFIGURED"]]);
    }
    expect(stub.calls).toHaveLength(0);
  });
});

describe("② parseNtsStatusResponse — 응답 번역", () => {
  test("응답 순서를 믿지 않고 b_no 로 짝을 맞춘다", () => {
    const body = okBody([ANSWERS[CLOSED_NO], ANSWERS[ACTIVE_NO]]);
    expect(parseNtsStatusResponse(body, [ACTIVE_NO, CLOSED_NO]).map((r) => r.status)).toEqual(["active", "closed"]);
  });

  test("응답에 없는 번호는 그 번호만 BAD_RESPONSE", () => {
    const results = parseNtsStatusResponse(okBody([ANSWERS[ACTIVE_NO]]), [ACTIVE_NO, CLOSED_NO]);
    expect(results.map((r) => [r.status, r.errorCode])).toEqual([
      ["active", null],
      ["error", "BAD_RESPONSE"],
    ]);
  });

  test("빈 b_stt_cd 는 계속사업자가 아니라 미등록, 안내 문구는 과세 유형으로 쓰지 않는다", () => {
    const [r] = parseNtsStatusResponse(okBody([ANSWERS[NOT_FOUND_NO]]), [NOT_FOUND_NO]);
    expect(r!.status).toBe("not_found");
    expect(r!.taxType).toBeNull();
  });

  test("모르는 b_stt_cd·틀린 폐업일은 그 번호만 BAD_RESPONSE", () => {
    const results = parseNtsStatusResponse(
      okBody([ntsItem(ACTIVE_NO, "09"), ntsItem(CLOSED_NO, "03", "20260230"), ntsItem(SUSPENDED_NO, "02")]),
      [ACTIVE_NO, CLOSED_NO, SUSPENDED_NO],
    );
    expect(results.map((r) => [r.status, r.errorCode])).toEqual([
      ["error", "BAD_RESPONSE"],
      ["error", "BAD_RESPONSE"],
      ["suspended", null],
    ]);
  });

  test("폐업일이 빈 폐업 항목은 closedOn null", () => {
    const [r] = parseNtsStatusResponse(okBody([ntsItem(CLOSED_NO, "03", "")]), [CLOSED_NO]);
    expect([r!.status, r!.closedOn]).toEqual(["closed", null]);
  });

  test("status_code 가 OK 가 아니면 RESULT_CODE, data 가 배열이 아니면 BAD_RESPONSE", () => {
    expect(parseNtsStatusResponse({ status_code: "BAD_JSON_REQUEST" }, [ACTIVE_NO])[0]!.errorCode).toBe("RESULT_CODE");
    expect(parseNtsStatusResponse({ status_code: "OK", data: {} }, [ACTIVE_NO])[0]!.errorCode).toBe("BAD_RESPONSE");
    expect(parseNtsStatusResponse("text", [ACTIVE_NO])[0]!.errorCode).toBe("BAD_RESPONSE");
  });
});

describe("② 실패 코드 — 던지지 않고 정해진 errorCode, 원문에 키가 없다", () => {
  async function errorOf(fetchImpl: typeof fetch, timeoutMs?: number): Promise<BusinessStatusResult> {
    const [r] = await new NtsBusinessStatusProvider({ serviceKey: TEST_KEY, fetch: fetchImpl, timeoutMs }).checkStatuses([
      ACTIVE_NO,
    ]);
    expect(r!.status).toBe("error");
    expect(JSON.stringify(r!.rawResponse)).not.toContain(TEST_KEY);
    expect(JSON.stringify(r!.rawResponse)).not.toContain("serviceKey");
    return r!;
  }

  test("키 미등록 401 → HTTP_ERROR, 국세청 고정 문구만 남긴다", async () => {
    const r = await errorOf(stubFetch(() => json({ code: -4, msg: "등록되지 않은 인증키 입니다." }, 401)).fetch);
    expect(r.errorCode).toBe("HTTP_ERROR");
    expect(r.rawResponse).toMatchObject({ http_status: 401, code: -4 });
  });

  test("200 인데 JSON 이 아니면 BAD_RESPONSE", async () => {
    const r = await errorOf(stubFetch(() => new Response("<html>점검 중</html>", { status: 200 })).fetch);
    expect(r.errorCode).toBe("BAD_RESPONSE");
  });

  test("200 인데 status_code 가 OK 가 아니면 RESULT_CODE", async () => {
    const r = await errorOf(stubFetch(() => json({ status_code: "TOO_LARGE_REQUEST" })).fetch);
    expect(r.errorCode).toBe("RESULT_CODE");
  });

  test("연결 실패 → NETWORK_ERROR", async () => {
    const r = await errorOf(
      stubFetch(() => {
        throw new TypeError("fetch failed");
      }).fetch,
    );
    expect(r.errorCode).toBe("NETWORK_ERROR");
  });

  test("시간 초과 → TIMEOUT", async () => {
    const hang = stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const r = await errorOf(hang.fetch, 20);
    expect(r.errorCode).toBe("TIMEOUT");
  });
});

describe("② deps.ts — 키가 있을 때만 실 어댑터", () => {
  test("PUBLIC_DATA_NTS_KEY 가 있으면 NtsBusinessStatusProvider, 없거나 빈 값이면 가짜", () => {
    expect(createDeps({ PUBLIC_DATA_NTS_KEY: TEST_KEY }).businessStatus).toBeInstanceOf(NtsBusinessStatusProvider);
    expect(createDeps({}).businessStatus).toBeInstanceOf(FakeBusinessStatusProvider);
    expect(createDeps({ PUBLIC_DATA_NTS_KEY: " " }).businessStatus).toBeInstanceOf(FakeBusinessStatusProvider);
  });
});

// ③ 실호출 1건 — 키가 없는 PC 에서는 건너뛴다.
// 번호는 공개된 법인 사업자등록번호(삼성전자 124-81-00998)다. 계속사업자로 나와야 한다.
const liveKey = findPublicDataKey("PUBLIC_DATA_NTS_KEY");
const LIVE_BUSINESS_NO = "1248100998";

describe.skipIf(liveKey === undefined)("③ 실호출 — 국세청 사업자 상태조회 1건", () => {
  test("실제 API 로 등록번호 1건을 조회한다(계약 칸 규칙 · 계속사업자)", { timeout: 20_000 }, async () => {
    const results = await new NtsBusinessStatusProvider({ serviceKey: liveKey }).checkStatuses([LIVE_BUSINESS_NO]);
    const r = results[0]!;
    // 크리틱이 로그에서 결과를 볼 수 있게 남긴다(키는 싣지 않는다)
    console.info(
      `[S1-1.30 실호출] ${r.businessNo} → status=${r.status} b_stt_cd=${String(r.rawResponse["b_stt_cd"])} ` +
        `taxType=${String(r.taxType)} errorCode=${String(r.errorCode)}`,
    );
    expect(results).toHaveLength(1);
    expectFieldRules(r);
    expect(r.status).toBe("active");
    expect(r.rawResponse["b_no"]).toBe(LIVE_BUSINESS_NO);
    expect(JSON.stringify(r.rawResponse)).not.toContain(liveKey!);
  });
});
