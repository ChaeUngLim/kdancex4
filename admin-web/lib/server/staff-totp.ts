// S1-1.21(정산 계좌 변경 API) — 「이 요청에서」 인증 앱 6자리를 다시 확인하는 도구.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §4 「정산 계좌 변경」 — `totpCode` 를 이 요청에서 다시 확인한다
//         (세션의 2단계 인증과 별개). 관련: FR-139(계좌 변경 재확인) · FR-303(관리자 웹 2단계 인증)
//
// 왜 세션의 2단계 표시만으로 부족한가:
//   세션은 30일 기억 쿠키로도 이어진다. 그 사이 누가 켜 둔 브라우저를 쓰면 정산 계좌(돈이 들어가는 곳)를 바꿀 수 있다.
//   그래서 계좌를 바꾸는 순간에는 인증 앱이 지금 보여 주는 6자리를 한 번 더 받는다.
//
// 어떻게 확인하나:
//   Better Auth 2단계 플러그인(verify-totp)과 똑같은 방법을 쓴다 — 저장된 비밀값(auth."twoFactor".secret, 서버 비밀값으로 암호화됨)을
//   풀어 같은 자리수(6)·같은 주기(30초)·같은 허용 폭(앞뒤 한 칸)으로 견준다. 플러그인 엔드포인트를 부르지 않는 이유:
//   그 경로는 로그인 흐름용이라 세션·쿠키를 새로 만들어 버린다. 여기서는 「맞나 틀리나」만 알면 된다.
import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt } from "better-auth/crypto";

import type { StaffAuth } from "./staff-auth";

/** 인증 앱 코드를 견주는 함수. 맞으면 true. 인증 앱을 등록하지 않은 계정이면 false */
export type TotpChecker = (authUserId: string, code: string) => Promise<boolean>;

// 플러그인 기본값과 같아야 한다(staff-auth.ts 의 twoFactor 설정이 digits·period 를 바꾸지 않는다)
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;

/** 직원 로그인(Better Auth) 인스턴스로 코드 확인 함수를 만든다. 앱과 테스트가 같은 함수를 쓴다 */
export function createStaffTotpChecker(auth: StaffAuth): TotpChecker {
  return async (authUserId, code) => {
    // 숫자 6자리가 아니면 견줄 것도 없이 틀린 코드다
    if (!/^[0-9]{6}$/.test(code)) return false;
    const ctx = await auth.$context;
    const row = await ctx.adapter.findOne<{ secret: string; verified?: boolean | null }>({
      model: "twoFactor",
      where: [{ field: "userId", value: authUserId }],
    });
    // 등록을 끝내지 않은(verified=false) 비밀값으로는 통과시키지 않는다 — 로그인 플러그인과 같은 규칙
    if (row === null || row.verified === false) return false;
    const secret = await symmetricDecrypt({ key: ctx.secretConfig, data: row.secret });
    return createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS }).verify(code);
  };
}
