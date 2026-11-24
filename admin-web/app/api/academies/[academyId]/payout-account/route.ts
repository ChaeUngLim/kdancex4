// S1-1.21(정산 계좌 변경 API) — `PUT /api/academies/{academyId}/payout-account`(계약 07 §4 · 열린 점 ⑯).
// 대표가 관리자 웹에서 인증 앱 6자리를 다시 넣고 정산 계좌를 바꾼다(FR-139). 새 계좌는 예금주 확인 대기로 시작한다.
// 처리 내용은 lib/server/services/academy-payout-account.ts 에 있고, 이 파일은 앱의 db·세션·암호화·코드 확인·요청 제한을 이어 줄 뿐이다.
import { getAppFieldCipher } from "@/lib/server/field-encryption";
import { createRateLimiter, loadRateLimitRules } from "@/lib/server/rate-limit";
import { createPayoutAccountChangeRoute } from "@/lib/server/services/academy-payout-account";
import { getStaffAuth, readStaffSession } from "@/lib/server/staff-auth-instance";
import { createStaffTotpChecker } from "@/lib/server/staff-totp";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const PUT = createPayoutAccountChangeRoute({
  db,
  getSession: readStaffSession,
  // getter·얇은 껍데기로 넘긴다 — 키·로그인 인스턴스는 처음 쓰는 요청에서 만든다(import 만으로 비밀값이 없다고 실패하지 않게)
  get fieldCipher() {
    return getAppFieldCipher();
  },
  totp: (authUserId, code) => createStaffTotpChecker(getStaffAuth())(authUserId, code),
  limiter: createRateLimiter(),
  get totpFailureRule() {
    return loadRateLimitRules().authFailure;
  },
});
