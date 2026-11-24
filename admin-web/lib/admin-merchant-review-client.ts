// S1-1.33(운영자 심사 최소 화면) — 심사 상세 화면이 버튼을 누를 때 부르는 API 셋.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §3(start-review · approve · reject)
//   오류 모양(`{detail, code}`)은 다른 화면과 같은 send(ApiError)로 받는다.
import type { MerchantRejectReason } from "./domain/constants";
import { send } from "./merchant-application-client";

const reviewPath = (id: string, action: string) => `/admin/merchant-applications/${encodeURIComponent(id)}/${action}`;

/** `POST …/{id}/start-review` — 심사 대기 → 심사 중. 본문 없음 */
export function startReview(id: string): Promise<{ status: string }> {
  return send(reviewPath(id, "start-review"), { method: "POST" });
}

/**
 * `POST …/{id}/approve` — 승인. 학원·첫 지점·정산 계좌·대표 연결이 한 번에 생긴다.
 * 응답을 못 받고 다시 누를 때 같은 키를 넘겨야 서버가 한 번으로 친다(학원이 둘 생기지 않는다).
 */
export function approveApplication(id: string, idempotencyKey: string): Promise<{ academyId: string }> {
  return send(reviewPath(id, "approve"), { method: "POST", headers: { "Idempotency-Key": idempotencyKey } });
}

/** `POST …/{id}/reject` — 반려. 사유 코드 4종 중 하나 + 신청자에게 보낼 설명 */
export function rejectApplication(id: string, body: { reasonCode: MerchantRejectReason; reasonText: string }): Promise<{ status: string }> {
  return send(reviewPath(id, "reject"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
