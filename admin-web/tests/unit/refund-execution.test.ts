// S4-1.5(수단별 환불 실행) — 실행 방식·멱등 키·기록용 비율 순수 규칙(lib/domain/refund-execution.ts)
import { describe, expect, test } from "vitest";

import { PAYMENT_METHODS } from "../../lib/domain/constants";
import { refundExecutionKindFor, refundIdempotencyKey, refundRateBpFor } from "../../lib/domain/refund-execution";

describe("refundExecutionKindFor — 결제수단 → 환불 실행 방식(FR-295)", () => {
  test("카드·간편결제는 PG 부분 취소, 가상계좌·간편 계좌이체는 대표 송금", () => {
    expect(Object.fromEntries(PAYMENT_METHODS.map((m) => [m, refundExecutionKindFor(m)]))).toEqual({
      card: "pg_cancel",
      easy_pay: "pg_cancel",
      easy_transfer: "owner_bank_transfer",
      virtual_account: "owner_bank_transfer",
    });
  });
});

describe("refundIdempotencyKey — refund:{원인}:{id}:{시도} (계약 §1-3)", () => {
  test("같은 원인·같은 시도는 같은 키, 시도가 오르면 새 키", () => {
    const id = "0190f5b6-0000-7000-8000-000000000001";
    expect(refundIdempotencyKey("request", id, 1)).toBe(`refund:request:${id}:1`);
    expect(refundIdempotencyKey("request", id, 1)).toBe(refundIdempotencyKey("request", id, 1));
    expect(refundIdempotencyKey("request", id, 2)).not.toBe(refundIdempotencyKey("request", id, 1));
    expect(refundIdempotencyKey("closure_choice", id, 1)).toBe(`refund:closure_choice:${id}:1`);
  });

  test("시도 번호가 1 미만·소수이거나 id 가 비면 RangeError", () => {
    expect(() => refundIdempotencyKey("request", "x", 0)).toThrow(RangeError);
    expect(() => refundIdempotencyKey("request", "x", 1.5)).toThrow(RangeError);
    expect(() => refundIdempotencyKey("request", " ", 1)).toThrow(RangeError);
  });
});

describe("refundRateBpFor — 기록용 비율(bp, 원 미만 올림)", () => {
  test("계약 예시 숫자", () => {
    expect(refundRateBpFor(107200, 180000)).toBe(5956);
    expect(refundRateBpFor(120600, 180000)).toBe(6700);
    expect(refundRateBpFor(180000, 180000)).toBe(10000);
    expect(refundRateBpFor(0, 180000)).toBe(0);
  });

  test("0원 결제는 0, 100% 를 넘지 않는다, 음수·소수는 RangeError", () => {
    expect(refundRateBpFor(0, 0)).toBe(0);
    expect(refundRateBpFor(200000, 180000)).toBe(10000);
    expect(() => refundRateBpFor(-1, 100)).toThrow(RangeError);
    expect(() => refundRateBpFor(1.5, 100)).toThrow(RangeError);
  });
});
