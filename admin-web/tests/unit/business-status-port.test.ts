// S1-1.26(사업자 상태 조회 포트와 가짜 구현) 단위 테스트 — 로드맵 verify 의 `tests/unit/s1-1-26.test.ts` 를 기능 이름으로 바꿨다.
//   포트: lib/server/ports/business-status.ts · 가짜: lib/server/fakes/fake-business-status.ts · 입력: 03_research.md §3-3
//
// 확인하는 것:
//   ① 다섯 상태(계속·휴업·폐업·미등록·오류)를 가짜로 골라 받을 수 있고, 상태마다 채워지는 칸이 정해져 있다
//   ② 골라 두지 않은 번호는 미등록이다(빈 코드를 계속사업자로 읽지 않는다)
//   ③ 결과는 넘긴 번호와 같은 순서·개수이고, 호출 전체 실패는 번호마다 error 로 돌아온다(예외가 아니다)
//   ④ 입력 규칙 — 10자리 숫자가 아니거나 100개를 넘으면 던진다(가짜도 실 어댑터와 같은 규칙)
//   ⑤ deps.ts 가 businessStatus 를 주고, 1회차 구현은 가짜다
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import { BUSINESS_CHECK_STATUSES } from "../../lib/domain/constants";
import { createDeps } from "../../lib/server/deps";
import { FakeBusinessStatusProvider } from "../../lib/server/fakes/fake-business-status";
import {
  BUSINESS_STATUS_ERROR_CODES,
  BUSINESS_STATUS_MAX_BATCH,
  BusinessStatusRequestError,
  type BusinessStatusPort,
} from "../../lib/server/ports/business-status";

const ACTIVE_NO = "1111111111";
const SUSPENDED_NO = "2222222222";
const CLOSED_NO = "3333333333";
const NOT_FOUND_NO = "4444444444";
const ERROR_NO = "5555555555";

/** 다섯 번호에 다섯 상태를 하나씩 골라 둔 가짜 */
function fiveStateFake(): FakeBusinessStatusProvider {
  return new FakeBusinessStatusProvider()
    .respond(ACTIVE_NO, "active")
    .respond(SUSPENDED_NO, "suspended")
    .respond(CLOSED_NO, { status: "closed", closedOn: "2026-10-31" })
    .respond(NOT_FOUND_NO, "not_found")
    .respond(ERROR_NO, { status: "error", errorCode: "TIMEOUT" });
}

describe("① 다섯 상태 가짜 응답", () => {
  test("다섯 번호가 계속·휴업·폐업·미등록·오류로 하나씩 돌아온다", async () => {
    const port: BusinessStatusPort = fiveStateFake();
    const results = await port.checkStatuses([ACTIVE_NO, SUSPENDED_NO, CLOSED_NO, NOT_FOUND_NO, ERROR_NO]);

    expect(results.map((r) => r.status)).toEqual(["active", "suspended", "closed", "not_found", "error"]);
    // 다섯 값이 business_status_checks.status 집합과 정확히 같다
    expect([...new Set(results.map((r) => r.status))].sort()).toEqual([...BUSINESS_CHECK_STATUSES].sort());
  });

  test("계속·휴업은 과세 유형만 있고 폐업일·오류 코드는 없다. 원문 b_stt_cd 는 01·02", async () => {
    const [active, suspended] = await fiveStateFake().checkStatuses([ACTIVE_NO, SUSPENDED_NO]);
    for (const r of [active, suspended]) {
      expect(r?.closedOn).toBeNull();
      expect(r?.errorCode).toBeNull();
      expect(typeof r?.taxType).toBe("string");
    }
    expect(active?.rawResponse["b_stt_cd"]).toBe("01");
    expect(suspended?.rawResponse["b_stt_cd"]).toBe("02");
  });

  test("폐업은 폐업일을 YYYY-MM-DD 로 주고, 원문 end_dt 는 YYYYMMDD 다", async () => {
    const [closed] = await fiveStateFake().checkStatuses([CLOSED_NO]);
    expect(closed).toMatchObject({ businessNo: CLOSED_NO, status: "closed", closedOn: "2026-10-31", errorCode: null });
    expect(closed?.rawResponse).toMatchObject({ b_stt_cd: "03", end_dt: "20261031" });
  });

  test("폐업일을 고르지 않아도 날짜 모양의 기본값이 들어간다", async () => {
    const [closed] = await new FakeBusinessStatusProvider().respond(CLOSED_NO, "closed").checkStatuses([CLOSED_NO]);
    expect(closed?.closedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("미등록은 폐업일·과세 유형·오류 코드가 모두 없고, 원문 b_stt_cd 는 빈 문자열이다", async () => {
    const [notFound] = await fiveStateFake().checkStatuses([NOT_FOUND_NO]);
    expect(notFound).toMatchObject({ status: "not_found", closedOn: null, taxType: null, errorCode: null });
    expect(notFound?.rawResponse["b_stt_cd"]).toBe("");
  });

  test("오류는 고른 실패 코드를 싣고, 고르지 않으면 정해진 코드 중 하나다", async () => {
    const [timeout] = await fiveStateFake().checkStatuses([ERROR_NO]);
    expect(timeout).toMatchObject({ status: "error", errorCode: "TIMEOUT", closedOn: null, taxType: null });

    const [plain] = await new FakeBusinessStatusProvider().respond(ERROR_NO, "error").checkStatuses([ERROR_NO]);
    expect(BUSINESS_STATUS_ERROR_CODES).toContain(plain?.errorCode);
  });
});

describe("② 골라 두지 않은 번호", () => {
  test("미등록(not_found)으로 돌아온다 — 계속사업자로 읽지 않는다", async () => {
    const [r] = await new FakeBusinessStatusProvider().checkStatuses(["9876543210"]);
    expect(r?.status).toBe("not_found");
  });

  test("같은 번호를 다시 고르면 덮어쓴다", async () => {
    const fake = new FakeBusinessStatusProvider().respond(ACTIVE_NO, "active").respond(ACTIVE_NO, "closed");
    const [r] = await fake.checkStatuses([ACTIVE_NO]);
    expect(r?.status).toBe("closed");
  });
});

describe("③ 순서·개수·전체 실패", () => {
  test("넘긴 순서와 개수 그대로 돌아온다(중복 번호 포함)", async () => {
    const input = [CLOSED_NO, ACTIVE_NO, CLOSED_NO];
    const results = await fiveStateFake().checkStatuses(input);
    expect(results.map((r) => r.businessNo)).toEqual(input);
  });

  test("빈 목록은 빈 결과다", async () => {
    expect(await fiveStateFake().checkStatuses([])).toEqual([]);
  });

  test("failAll 이면 고른 상태와 상관없이 번호마다 error 가 오고 예외는 없다. null 로 되돌린다", async () => {
    const fake = fiveStateFake().failAll("RESULT_CODE");
    const failed = await fake.checkStatuses([ACTIVE_NO, CLOSED_NO]);
    expect(failed.map((r) => [r.status, r.errorCode])).toEqual([
      ["error", "RESULT_CODE"],
      ["error", "RESULT_CODE"],
    ]);

    const [back] = await fake.failAll(null).checkStatuses([CLOSED_NO]);
    expect(back?.status).toBe("closed");
  });

  test("호출 기록이 남고, 결과를 고쳐도 다음 호출에 번지지 않는다", async () => {
    const fake = fiveStateFake();
    const [first] = await fake.checkStatuses([ACTIVE_NO]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.rawResponse)).toBe(true);
    await fake.checkStatuses([CLOSED_NO, ERROR_NO]);
    expect(fake.calls).toEqual([[ACTIVE_NO], [CLOSED_NO, ERROR_NO]]);
  });
});

describe("④ 입력 규칙", () => {
  test.each(["123-45-67890", "123456789", "12345678901", "abcdefghij", ""])("모양이 틀린 번호 %j 는 던진다", async (bad) => {
    await expect(new FakeBusinessStatusProvider().checkStatuses([ACTIVE_NO, bad])).rejects.toBeInstanceOf(
      BusinessStatusRequestError,
    );
  });

  test("오류 메시지에 번호 값을 싣지 않는다", async () => {
    await expect(new FakeBusinessStatusProvider().checkStatuses(["98765-4321"])).rejects.not.toThrow(/98765/);
  });

  test(`${BUSINESS_STATUS_MAX_BATCH}개까지는 받고, 그보다 많으면 던진다`, async () => {
    const nos = (n: number) => Array.from({ length: n }, (_, i) => String(1000000000 + i));
    const fake = new FakeBusinessStatusProvider();
    expect(await fake.checkStatuses(nos(BUSINESS_STATUS_MAX_BATCH))).toHaveLength(BUSINESS_STATUS_MAX_BATCH);
    await expect(fake.checkStatuses(nos(BUSINESS_STATUS_MAX_BATCH + 1))).rejects.toBeInstanceOf(BusinessStatusRequestError);
    // 거부된 호출은 기록에 남지 않는다
    expect(fake.calls).toHaveLength(1);
  });
});

describe("⑤ deps.ts 주입", () => {
  test("businessStatus 는 가짜이고 같은 deps 에서 같은 구현이다", async () => {
    const deps = createDeps({});
    expect(deps.businessStatus).toBeInstanceOf(FakeBusinessStatusProvider);
    expect(deps.businessStatus).toBe(deps.businessStatus);
    const [r] = await deps.businessStatus.checkStatuses([ACTIVE_NO]);
    expect(r?.status).toBe("not_found");
  });
});
