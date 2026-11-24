// S0-4.11(특일 정보 실 어댑터) 단위 테스트 — 로드맵 verify 의 `tests/unit/s0-4-11.test.ts` 를 기능 이름으로 바꿨다.
//   포트: lib/server/ports/special-days.ts · 실 어댑터: lib/server/adapters/kasi-special-days.ts · 입력: 03_research.md §3-2
//
// 확인하는 것:
//   ① 계약 시험 — 가짜와 실 어댑터(가짜 fetch)에 **같은** 시험을 돌린다. 성공이면 그해 날짜·중복 없는 목록,
//      실패면 SpecialDayProviderError(정해진 code) 를 던지고 빈 배열로 돌려주지 않는다
//   ② 실 어댑터만의 번역 규칙 — item 객체/배열/빈 값, isHoliday=N 거르기, 종류 가르기, 같은 날 합치기, 오류 코드 6종
//   ③ 실호출 1회 — 인증키가 있을 때만. 2026 한 해치를 실제로 받아 건수를 찍는다(키는 찍지 않는다)
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import { HOLIDAY_KINDS } from "../../lib/domain/constants";
import { createDeps } from "../../lib/server/deps";
import {
  KASI_REST_DE_INFO_URL,
  KasiSpecialDayProvider,
  classifyHolidayKind,
  parseRestDeInfoResponse,
} from "../../lib/server/adapters/kasi-special-days";
import { fakeHoliday, FakeSpecialDayProvider } from "../../lib/server/fakes/fake-special-days";
import {
  SPECIAL_DAY_ERROR_CODES,
  SpecialDayProviderError,
  type SpecialDayProviderPort,
} from "../../lib/server/ports/special-days";
import { findPublicDataHolidayKey } from "../setup/public-data-key";

const TEST_KEY = "test-key/with+special=chars";

// 2026 실응답(research §3-2)에서 뽑은 모양. item 이 배열인 경우
function apiBody(items: unknown, totalCount?: number, resultCode = "00") {
  const list = items === "" ? [] : Array.isArray(items) ? items : [items];
  return {
    response: {
      header: { resultCode, resultMsg: resultCode === "00" ? "NORMAL SERVICE." : "SERVICE ERROR" },
      body: { items: items === "" ? "" : { item: items }, numOfRows: 100, pageNo: 1, totalCount: totalCount ?? list.length },
    },
  };
}
const item = (locdate: number, dateName: string, isHoliday = "Y", dateKind = "01") => ({
  dateKind,
  dateName,
  isHoliday,
  locdate,
  seq: 1,
});

const SAMPLE_2026 = [
  item(20260101, "1월1일"),
  item(20260301, "삼일절"),
  item(20260302, "대체공휴일(삼일절)"),
  item(20260603, "전국동시지방선거"),
  item(20261225, "기독탄신일"),
];

interface FetchCall {
  readonly url: URL;
}

/** 가짜 fetch — 정해 둔 답을 내고, 불린 주소를 기록한다 */
function stubFetch(answer: (url: URL) => Response | Promise<Response>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url });
    return answer(url);
  }) as typeof fetch;
  return { fetch: fn, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 실패 코드를 확인하는 도우미 — 빈 배열이 아니라 정해진 오류를 던져야 한다 */
async function expectProviderError(promise: Promise<unknown>, code: string): Promise<SpecialDayProviderError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SpecialDayProviderError);
  expect((error as SpecialDayProviderError).code).toBe(code);
  return error as SpecialDayProviderError;
}

// ① 계약 시험 — 두 구현이 같은 시험을 통과해야 수집 작업이 어느 쪽을 받아도 똑같이 돈다
interface ContractSubject {
  readonly name: string;
  /** 2026 은 성공(SAMPLE_2026 과 같은 내용), 2099 는 실패(code RESULT_CODE) 하도록 만든 구현 */
  readonly make: () => SpecialDayProviderPort;
}

const subjects: ContractSubject[] = [
  {
    name: "FakeSpecialDayProvider",
    make: () =>
      new FakeSpecialDayProvider()
        .respond(2026, {
          holidays: [
            fakeHoliday("2026-01-01", "1월1일"),
            fakeHoliday("2026-03-01", "삼일절"),
            fakeHoliday("2026-03-02", "대체공휴일(삼일절)", "substitute_holiday"),
            fakeHoliday("2026-06-03", "전국동시지방선거", "temporary_holiday"),
            fakeHoliday("2026-12-25", "기독탄신일"),
          ],
        })
        .respond(2099, { error: "RESULT_CODE" }),
  },
  {
    name: "KasiSpecialDayProvider(가짜 fetch)",
    make: () =>
      new KasiSpecialDayProvider({
        serviceKey: TEST_KEY,
        fetch: stubFetch((url) =>
          url.searchParams.get("solYear") === "2099" ? json(apiBody("", 0, "30")) : json(apiBody(SAMPLE_2026)),
        ).fetch,
      }),
  },
];

describe.each(subjects)("① SpecialDayProviderPort 계약 — $name", ({ make }) => {
  test("성공: 그해 날짜만, YYYY-MM-DD, 이름 있음, 종류는 HOLIDAY_KINDS 안, 날짜 중복 없음", async () => {
    const list = await make().fetchPublicHolidays(2026);
    expect(list.length).toBe(5);
    for (const h of list) {
      expect(h.date).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(h.name.trim()).not.toBe("");
      expect(HOLIDAY_KINDS).toContain(h.kind);
    }
    expect(new Set(list.map((h) => h.date)).size).toBe(list.length);
  });

  test("성공: 대체·임시 공휴일 종류가 같은 값으로 나온다", async () => {
    const list = await make().fetchPublicHolidays(2026);
    const kindOf = (date: string) => list.find((h) => h.date === date)?.kind;
    expect(kindOf("2026-01-01")).toBe("holiday");
    expect(kindOf("2026-03-02")).toBe("substitute_holiday");
    expect(kindOf("2026-06-03")).toBe("temporary_holiday");
  });

  test("실패: 빈 배열이 아니라 SpecialDayProviderError(정해진 code) 를 던진다", async () => {
    const error = await expectProviderError(make().fetchPublicHolidays(2099), "RESULT_CODE");
    expect(SPECIAL_DAY_ERROR_CODES).toContain(error.code);
  });

  test("돌려받은 목록을 바꿔도 다음 호출에 영향이 없다", async () => {
    const provider = make();
    const first = (await provider.fetchPublicHolidays(2026)) as unknown as { name: string }[];
    first[0]!.name = "바뀜";
    const second = await provider.fetchPublicHolidays(2026);
    expect(second[0]!.name).toBe("1월1일");
  });
});

// ② 실 어댑터의 번역 규칙
describe("② KasiSpecialDayProvider — 요청 모양", () => {
  test("serviceKey·solYear·numOfRows=100·_type=json 을 싣고, 키는 한 번만 인코딩한다", async () => {
    const stub = stubFetch(() => json(apiBody(SAMPLE_2026)));
    await new KasiSpecialDayProvider({ serviceKey: TEST_KEY, fetch: stub.fetch }).fetchPublicHolidays(2026);
    expect(stub.calls).toHaveLength(1);
    const { url } = stub.calls[0]!;
    expect(`${url.origin}${url.pathname}`).toBe(KASI_REST_DE_INFO_URL);
    expect(url.searchParams.get("serviceKey")).toBe(TEST_KEY); // 한 번 풀면 원래 키
    expect(url.searchParams.get("solYear")).toBe("2026");
    expect(url.searchParams.get("numOfRows")).toBe("100");
    expect(url.searchParams.get("_type")).toBe("json");
    expect(url.searchParams.has("solMonth")).toBe(false); // 한 해 전체
  });

  test("키가 없으면 부르지 않고 NOT_CONFIGURED", async () => {
    const stub = stubFetch(() => json(apiBody(SAMPLE_2026)));
    await expectProviderError(
      new KasiSpecialDayProvider({ serviceKey: "  ", fetch: stub.fetch }).fetchPublicHolidays(2026),
      "NOT_CONFIGURED",
    );
    expect(stub.calls).toHaveLength(0);
  });
});

describe("② parseRestDeInfoResponse — 응답 번역", () => {
  test("item 이 객체 하나여도 받는다", () => {
    expect(parseRestDeInfoResponse(apiBody(item(20261225, "기독탄신일")), 2026)).toEqual([
      { date: "2026-12-25", name: "기독탄신일", kind: "holiday" },
    ]);
  });

  test("0건이면 items 가 빈 문자열 — 빈 목록", () => {
    expect(parseRestDeInfoResponse(apiBody("", 0), 2026)).toEqual([]);
  });

  test("isHoliday=N(기념일·절기)은 거른다", () => {
    const list = parseRestDeInfoResponse(apiBody([item(20260101, "1월1일"), item(20260405, "식목일", "N", "02")]), 2026);
    expect(list.map((h) => h.name)).toEqual(["1월1일"]);
  });

  test("locdate 문자열도 받고 날짜 순으로 낸다", () => {
    const list = parseRestDeInfoResponse(
      apiBody([{ ...item(0, "기독탄신일"), locdate: "20261225" }, item(20260101, "1월1일")]),
      2026,
    );
    expect(list.map((h) => h.date)).toEqual(["2026-01-01", "2026-12-25"]);
  });

  test("같은 날 두 이름이면 하나로 합치고 법정 공휴일 종류를 남긴다", () => {
    const list = parseRestDeInfoResponse(apiBody([item(20250505, "어린이날"), item(20250505, "부처님오신날")]), 2025);
    expect(list).toEqual([{ date: "2025-05-05", name: "어린이날·부처님오신날", kind: "holiday" }]);
  });

  test("resultCode 가 00 이 아니면 RESULT_CODE", () => {
    expect(() => parseRestDeInfoResponse(apiBody("", 0, "30"), 2026)).toThrow(SpecialDayProviderError);
    try {
      parseRestDeInfoResponse(apiBody("", 0, "30"), 2026);
    } catch (e) {
      expect((e as SpecialDayProviderError).code).toBe("RESULT_CODE");
    }
  });

  test.each([
    ["response 없음", { foo: 1 }],
    ["다른 해 날짜", apiBody([item(20270101, "1월1일")])],
    ["날짜 형식 틀림", apiBody([item(2026011, "1월1일")])],
    ["달력에 없는 날", apiBody([item(20260230, "가짜")])],
    ["이름 없음", apiBody([item(20260101, " ")])],
    ["totalCount 보다 적게 옴(잘림)", apiBody([item(20260101, "1월1일")], 30)],
  ])("모양이 틀리면 BAD_RESPONSE — %s", (_label, body) => {
    try {
      parseRestDeInfoResponse(body, 2026);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SpecialDayProviderError);
      expect((e as SpecialDayProviderError).code).toBe("BAD_RESPONSE");
    }
  });
});

describe("② classifyHolidayKind — 이름으로 종류 가르기", () => {
  test.each([
    ["설날", "holiday"],
    ["제헌절", "holiday"],
    ["노동절", "holiday"],
    ["대체공휴일(광복절)", "substitute_holiday"],
    ["전국동시지방선거", "temporary_holiday"],
    ["임시공휴일", "temporary_holiday"],
  ])("%s → %s", (name, kind) => {
    expect(classifyHolidayKind(name)).toBe(kind);
  });
});

describe("② 실패 코드 — 호출이 잘못되면 정해진 code 를 던지고 키를 메시지에 싣지 않는다", () => {
  const run = (answer: Parameters<typeof stubFetch>[0], timeoutMs?: number) =>
    new KasiSpecialDayProvider({ serviceKey: TEST_KEY, fetch: stubFetch(answer).fetch, timeoutMs }).fetchPublicHolidays(
      2026,
    );

  test("HTTP 500 → HTTP_ERROR", async () => {
    const e = await expectProviderError(run(() => new Response("oops", { status: 500 })), "HTTP_ERROR");
    expect(e.message).not.toContain(TEST_KEY);
  });

  test("키 오류 XML(200) → RESULT_CODE", async () => {
    const xml =
      "<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg>" +
      "<returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode>" +
      "</cmmMsgHeader></OpenAPI_ServiceResponse>";
    await expectProviderError(run(() => new Response(xml, { status: 200 })), "RESULT_CODE");
  });

  test("JSON 도 키 오류 XML 도 아니면 BAD_RESPONSE", async () => {
    await expectProviderError(run(() => new Response("<html>점검 중</html>")), "BAD_RESPONSE");
  });

  test("연결 실패 → NETWORK_ERROR", async () => {
    const e = await expectProviderError(
      run(() => {
        throw new TypeError(`fetch failed ${KASI_REST_DE_INFO_URL}?serviceKey=${TEST_KEY}`);
      }),
      "NETWORK_ERROR",
    );
    expect(e.message).not.toContain(TEST_KEY);
  });

  test("시간 초과 → TIMEOUT", async () => {
    const stub = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    await expectProviderError(
      new KasiSpecialDayProvider({ serviceKey: TEST_KEY, fetch: stub, timeoutMs: 20 }).fetchPublicHolidays(2026),
      "TIMEOUT",
    );
  });
});

describe("② deps.ts — 키가 있을 때만 실 어댑터", () => {
  test("PUBLIC_DATA_HOLIDAY_KEY 가 있으면 KasiSpecialDayProvider, 없으면 가짜", () => {
    expect(createDeps({ PUBLIC_DATA_HOLIDAY_KEY: TEST_KEY }).specialDays).toBeInstanceOf(KasiSpecialDayProvider);
    expect(createDeps({}).specialDays).toBeInstanceOf(FakeSpecialDayProvider);
    expect(createDeps({ PUBLIC_DATA_HOLIDAY_KEY: " " }).specialDays).toBeInstanceOf(FakeSpecialDayProvider);
  });
});

// ③ 실호출 1회 — 키가 없는 PC 에서는 건너뛴다
const liveKey = findPublicDataHolidayKey();

describe.skipIf(liveKey === undefined)("③ 실호출 — 공공데이터포털 특일 정보 2026 한 해치", () => {
  test("실제 API 로 2026 공휴일을 받는다(계약 모양 · 1월1일·기독탄신일 포함)", { timeout: 20_000 }, async () => {
    const list = await new KasiSpecialDayProvider({ serviceKey: liveKey }).fetchPublicHolidays(2026);
    // 크리틱이 로그에서 건수를 볼 수 있게 남긴다(키는 싣지 않는다). research §3-2 실측은 22건
    console.info(
      `[S0-4.11 실호출] 2026 공휴일 ${list.length}건 — ` +
        `법정 ${list.filter((h) => h.kind === "holiday").length} · ` +
        `대체 ${list.filter((h) => h.kind === "substitute_holiday").length} · ` +
        `임시 ${list.filter((h) => h.kind === "temporary_holiday").length}`,
    );
    expect(list.length).toBeGreaterThanOrEqual(15);
    expect(list.map((h) => h.date)).toEqual(expect.arrayContaining(["2026-01-01", "2026-12-25"]));
    for (const h of list) {
      expect(h.date).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(HOLIDAY_KINDS).toContain(h.kind);
    }
    expect(new Set(list.map((h) => h.date)).size).toBe(list.length);
  });
});
