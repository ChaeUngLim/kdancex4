// S3-3.4(주문 생성 API) — 주문에 고정하는 금액·예매 수수료·자리 종류 판정(lib/domain/checkout.ts).
//   근거: 계약 03 §3(가격 계산) · FR-282a(예매 수수료 2,000원) · FR-283(결제액 계산 순서) · FR-092·FR-092c(성별·단일 정원)
import { describe, expect, test } from "vitest";

import {
  BOOKING_FEE_PER_PERSON,
  CANCEL_FEE_PLATFORM_SHARE_BP,
  bookingFeeFor,
  computeOrderAmounts,
  seatKindFitsMode,
} from "@/lib/domain/checkout";
import { CLASS_KINDS, type ClassKind } from "@/lib/domain/constants";

const REGULAR_FAMILY: readonly ClassKind[] = ["regular", "private_lesson", "basic", "lady_style"];
const EVENT_FAMILY: readonly ClassKind[] = ["one_day", "event", "party", "performance", "competition"];

describe("bookingFeeFor — 예매 수수료는 유료 이벤트형에만", () => {
  test("수업 구분 9종이 두 묶음으로 빠짐없이 나뉜다", () => {
    expect([...REGULAR_FAMILY, ...EVENT_FAMILY].sort()).toEqual([...CLASS_KINDS].sort());
  });
  test.each(REGULAR_FAMILY)("%s(정규 계열)는 수수료 줄이 없다", (kind) => {
    expect(bookingFeeFor(kind, 120000)).toBeUndefined();
  });
  test.each(EVENT_FAMILY)("%s(이벤트형) 유료는 1명당 2,000원", (kind) => {
    expect(bookingFeeFor(kind, 30000)).toBe(2000);
  });
  test("이벤트형 0원은 수수료를 붙이지 않는다(0원 확정 경로는 S3-3.12)", () => {
    expect(bookingFeeFor("party", 0)).toBeUndefined();
  });
});

describe("computeOrderAmounts — 서버가 정하는 주문 금액", () => {
  test("정규 120,000원 → 정가·할인 0·쿠폰 0·최종 4줄, 합계 120,000", () => {
    const a = computeOrderAmounts("regular", 120000);
    expect(a).toMatchObject({ listPrice: 120000, benefitDiscount: 0, couponDiscount: 0, bookingFee: 0, total: 120000 });
    expect(a.breakdown.map((l) => [l.kind, l.amount])).toEqual([
      ["list_price", 120000],
      ["benefit_discount", 0],
      ["coupon_discount", 0],
      ["final", 120000],
    ]);
  });
  test("이벤트형 30,000원 → 예매 수수료 줄이 최종 앞에 들어가고 합계 32,000(data-model §6-1 손계산 표)", () => {
    const a = computeOrderAmounts("event", 30000);
    expect(a.bookingFee).toBe(BOOKING_FEE_PER_PERSON);
    expect(a.total).toBe(32000);
    expect(a.breakdown.map((l) => l.kind)).toEqual(["list_price", "benefit_discount", "coupon_discount", "booking_fee", "final"]);
  });
  test("합계는 DB ck_orders_total_formula 와 같은 식", () => {
    for (const [kind, price] of [["regular", 99000], ["one_day", 15000], ["competition", 1], ["basic", 0]] as const) {
      const a = computeOrderAmounts(kind, price);
      expect(a.total).toBe(Math.max(0, a.listPrice - a.benefitDiscount - a.couponDiscount) + a.bookingFee);
    }
  });
  test("취소 수수료 플랫폼 몫은 5:5(5000bp)", () => {
    expect(CANCEL_FEE_PLATFORM_SHARE_BP).toBe(5000);
  });
});

describe("seatKindFitsMode — 정원 방식과 자리 종류", () => {
  test.each([
    ["gender_split", "male", true],
    ["gender_split", "female", true],
    ["gender_split", "any", false],
    ["single", "any", true],
    ["single", "male", false],
    ["single", "female", false],
  ] as const)("%s + %s → %s", (mode, kind, expected) => {
    expect(seatKindFitsMode(mode, kind)).toBe(expected);
  });
});
