// S1-3.9(관리자 웹 공지 화면 W4a) — 공지 화면이 「저장하고 적용」을 누를 때 부르는 API 하나.
//   계약: _workspace/03_contracts/09-owner-notices.md §1(POST /api/academies/{academyId}/refund-notices/{kind}/versions)
//   오류 모양(`{detail, code, fields}`)은 다른 콘솔 화면과 같은 send(ApiError)로 받는다.
import { send } from "./merchant-application-client";
import type { buildEventNoticeRequest } from "./event-notice-form";
import type { buildRegularNoticeRequest } from "./refund-notice-form";
import type { PublishRefundNoticeResponse } from "./server/services/refund-notice-publish";

/**
 * 정규 공지 새 판본 저장. 성공하면 201 `{kind, version, createdAt, body}`.
 * 실패 코드: 422 REFUND_BELOW_TEMPLATE·VALIDATION_FAILED(+fields) · 409 NOTICE_VERSION_CONFLICT(다른 화면이 먼저 저장)
 */
export function publishRegularNotice(
  academyId: string,
  body: ReturnType<typeof buildRegularNoticeRequest>,
): Promise<PublishRefundNoticeResponse> {
  return send(`/academies/${encodeURIComponent(academyId)}/refund-notices/regular/versions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * S1-3.10(이벤트형 공지 화면 W4b) — 이벤트형 공지 새 판본 저장. 성공하면 201 `{kind, version, createdAt, body}`.
 * 실패 코드: 422 CANCEL_FEE_ABOVE_MAX(구간별 최대보다 높음)·PROCESSING_DAYS_TOO_LONG(3영업일 넘음)·VALIDATION_FAILED(+fields)
 *   · 409 NOTICE_VERSION_CONFLICT(다른 화면이 먼저 저장)
 */
export function publishEventNotice(
  academyId: string,
  body: ReturnType<typeof buildEventNoticeRequest>,
): Promise<PublishRefundNoticeResponse> {
  return send(`/academies/${encodeURIComponent(academyId)}/refund-notices/event/versions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
