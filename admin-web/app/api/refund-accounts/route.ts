// S4-1.2a(환불 계좌 저장 API(본인 명의 확인)) — `POST /api/refund-accounts`(계약 12 §2-1).
// 회원이 계좌로 결제한 주문의 환불받을 계좌를 넣는다. 예금주가 본인확인 이름과 다르면 저장하지 않는다(FR-295).
// 처리 내용은 lib/server/services/refund-accounts.ts 에 있다. 본문은 그 파일이 쓰는 saveRefundAccountSchema(zod)로 검사한다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { getAppFieldCipher } from "@/lib/server/field-encryption";
import { createSaveRefundAccountRoute } from "@/lib/server/services/refund-accounts";

// 회원마다 다른 응답이고 매번 DB 에 쓴다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createSaveRefundAccountRoute({
  db: cancellationRouteDeps.db,
  getSession: cancellationRouteDeps.getSession,
  // getter 로 넘긴다 — 시계·암호화 키는 처음 쓰는 요청에서 꺼낸다(import 만으로 비밀값이 없다고 실패하지 않게)
  get clock() {
    return cancellationRouteDeps.clock;
  },
  get fieldCipher() {
    return getAppFieldCipher();
  },
});
