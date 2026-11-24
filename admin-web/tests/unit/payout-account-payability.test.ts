// S1-1.22(예금주 확인 상태와 지급 금지 판정) — 확인 전 계좌로는 돈을 보내지 않는다(R15(무료 확인 수단 부재)).
//   로드맵 verify 의 파일 이름은 tests/unit/s1-1-22.test.ts 였는데, 기능 이름(payout-account-payability)으로 바꿨다.
//   판정 규칙(data-model §10-5): status = 'active' AND verification_status = 'verified' 일 때만 지급 대상.
import { describe, expect, test } from "vitest";

import { PAYOUT_ACCOUNT_STATUSES, PAYOUT_VERIFICATION_STATUSES } from "@/lib/domain/constants";
import { isPayableAccount, payoutAccountHoldReason } from "@/lib/domain/payout-account";

describe("예금주 확인 전 계좌는 지급 불가(isPayableAccount)", () => {
  test("쓰는 계좌 + 확인 끝남(verified) → 지급 가능, 보류 사유 없음", () => {
    const account = { status: "active", verificationStatus: "verified" } as const;
    expect(isPayableAccount(account)).toBe(true);
    expect(payoutAccountHoldReason(account)).toBeNull();
  });

  test.each(["awaiting_proof", "pending", "rejected"] as const)(
    "확인 전·반려(%s) 계좌 → 지급 불가, 보류 사유 account_unverified",
    (verificationStatus) => {
      const account = { status: "active", verificationStatus } as const;
      expect(isPayableAccount(account)).toBe(false);
      expect(payoutAccountHoldReason(account)).toBe("account_unverified");
    },
  );

  test("확인됐어도 바뀐 옛 계좌(replaced)로는 보내지 않는다", () => {
    const account = { status: "replaced", verificationStatus: "verified" } as const;
    expect(isPayableAccount(account)).toBe(false);
    expect(payoutAccountHoldReason(account)).toBe("account_unverified");
  });

  test("계좌가 없으면(null·undefined) 지급 불가 — 계약 13 §7 「계좌가 없거나 확인 전이면 held」", () => {
    expect(isPayableAccount(null)).toBe(false);
    expect(isPayableAccount(undefined)).toBe(false);
    expect(payoutAccountHoldReason(null)).toBe("account_unverified");
  });

  test("모든 상태 조합 중 지급 가능한 것은 active × verified 하나뿐이다", () => {
    const payable = PAYOUT_ACCOUNT_STATUSES.flatMap((status) =>
      PAYOUT_VERIFICATION_STATUSES.map((verificationStatus) => ({ status, verificationStatus })),
    ).filter((account) => isPayableAccount(account));
    expect(payable).toEqual([{ status: "active", verificationStatus: "verified" }]);
  });

  test("목록에 없는 상태 값이 섞여 들어와도 막는다(모르면 막는 쪽)", () => {
    const unknown = { status: "active", verificationStatus: "confirmed" } as unknown as Parameters<typeof isPayableAccount>[0];
    expect(isPayableAccount(unknown)).toBe(false);
  });
});
