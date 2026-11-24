// S3-3.1(결제수단 판정 함수) — FR-280(결제수단 결정) 표를 순수 함수로 옮긴 것(lib/domain/payment-methods.ts)을 본다.
//   수업 구분 9종 × 결제수단 4종 표가 spec 과 같은지, 기본 수단이 무엇인지,
//   이벤트형에서 카드·간편결제가 막히는지(FR-111a(카드 허용 범위) 강제 방법 ②의 판정 근거)를 확인한다.
import { describe, expect, test } from "vitest";

import { CLASS_KINDS, PAYMENT_METHODS, type ClassKind, type PaymentMethod } from "@/lib/domain/constants";
import { isPaymentMethodAllowed, paymentMethodsFor } from "@/lib/domain/payment-methods";

// spec FR-280 표를 손으로 옮긴 기대값. ○ = 고를 수 있음, × = 받지 않음
//   정규·단기(베이직·레이디 스타일)·개인 레슨: 카드(기본) · 간편결제 · 간편 계좌이체 · 가상계좌
//   이벤트형(원데이·이벤트·파티·공연·대회): 간편 계좌이체(기본) · 가상계좌만
const CARD_FIRST: Record<PaymentMethod, boolean> = { card: true, easy_pay: true, easy_transfer: true, virtual_account: true };
const TRANSFER_ONLY: Record<PaymentMethod, boolean> = {
  card: false,
  easy_pay: false,
  easy_transfer: true,
  virtual_account: true,
};

const EXPECTED: Record<ClassKind, { readonly table: Record<PaymentMethod, boolean>; readonly defaultMethod: PaymentMethod }> = {
  regular: { table: CARD_FIRST, defaultMethod: "card" },
  basic: { table: CARD_FIRST, defaultMethod: "card" },
  lady_style: { table: CARD_FIRST, defaultMethod: "card" },
  private_lesson: { table: CARD_FIRST, defaultMethod: "card" },
  one_day: { table: TRANSFER_ONLY, defaultMethod: "easy_transfer" },
  event: { table: TRANSFER_ONLY, defaultMethod: "easy_transfer" },
  party: { table: TRANSFER_ONLY, defaultMethod: "easy_transfer" },
  performance: { table: TRANSFER_ONLY, defaultMethod: "easy_transfer" },
  competition: { table: TRANSFER_ONLY, defaultMethod: "easy_transfer" },
};

describe("상품 종류 × 수단 4종 표(FR-280)", () => {
  test("기대 표가 수업 구분 9종을 빠짐없이 덮는다", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...CLASS_KINDS].sort());
  });

  for (const kind of CLASS_KINDS) {
    for (const method of PAYMENT_METHODS) {
      const allowed = EXPECTED[kind].table[method];
      test(`${kind} × ${method} → ${allowed ? "허용" : "거부"}`, () => {
        expect(isPaymentMethodAllowed(kind, method)).toBe(allowed);
        expect(paymentMethodsFor(kind).allowed.includes(method)).toBe(allowed);
      });
    }
  }
});

describe("기본 수단", () => {
  for (const kind of CLASS_KINDS) {
    test(`${kind} 의 기본은 ${EXPECTED[kind].defaultMethod}`, () => {
      const result = paymentMethodsFor(kind);
      expect(result.defaultMethod).toBe(EXPECTED[kind].defaultMethod);
      // 기본 수단은 허용 목록 맨 앞에 있어야 결제 화면이 첫 줄을 기본 선택으로 그릴 수 있다(보드 M9·M9E)
      expect(result.allowed[0]).toBe(result.defaultMethod);
    });
  }
});

describe("허용 목록 순서 — spec 표의 적힌 순서", () => {
  test("정규 계열은 카드 → 간편결제 → 간편 계좌이체 → 가상계좌", () => {
    expect(paymentMethodsFor("regular").allowed).toEqual(["card", "easy_pay", "easy_transfer", "virtual_account"]);
  });
  test("이벤트형은 간편 계좌이체 → 가상계좌, 둘뿐", () => {
    expect(paymentMethodsFor("party").allowed).toEqual(["easy_transfer", "virtual_account"]);
  });
});

describe("돌려준 값은 바꿀 수 없다", () => {
  test("허용 목록을 고치려 하면 TypeError", () => {
    const { allowed } = paymentMethodsFor("event");
    expect(Object.isFrozen(allowed)).toBe(true);
    expect(() => (allowed as PaymentMethod[]).push("card")).toThrow(TypeError);
    expect(isPaymentMethodAllowed("event", "card")).toBe(false);
  });
});
