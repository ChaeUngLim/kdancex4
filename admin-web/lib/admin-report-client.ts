// S7-2.10b(관리자 웹 신고 처리 화면) — 신고 처리 칸이 버튼을 누를 때 부르는 API 둘.
//   계약: _workspace/03_contracts/15-ops.md §2-7(start-review · resolve)
//   오류 모양(`{detail, code}`)은 다른 운영자 화면과 같은 send(ApiError)로 받는다.
import type { ResolveBody } from "./admin-report-form";
import { send } from "./merchant-application-client";

const reportPath = (id: string, action: string) => `/admin/reports/${encodeURIComponent(id)}/${action}`;

/** `POST …/{reportId}/start-review` — 접수 → 확인 중. 신고자에게 「확인하고 있어요」 알림이 간다. 본문 없음 */
export function startReportReview(reportId: string): Promise<{ reportId: string; status: string }> {
  return send(reportPath(reportId, "start-review"), { method: "POST" });
}

/** `POST …/{reportId}/resolve` — 결과 기록 + 신고자 결과 알림. 인정이면서 조치를 골랐으면 이용 제한 절차도 같이 열린다 */
export function resolveReport(reportId: string, body: ResolveBody): Promise<{ reportId: string; status: "resolved"; restrictionCaseId: string | null }> {
  return send(reportPath(reportId, "resolve"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
