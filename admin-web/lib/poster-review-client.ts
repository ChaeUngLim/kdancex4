// SX-2.5(포스터 검토 화면) — 검토 화면이 버튼을 누를 때 부르는 API 셋.
//   계약: _workspace/03_contracts/16-ai-agent.md §4-6 — PATCH …/{extractionId}(값 고치기) · POST …/review(검토 끝) · POST …/submit(승인 요청, SX-2.6)
//   오류 모양(`{detail, code, fields, unresolved}`)은 다른 콘솔 화면과 같은 send(ApiError)로 받는다.
import type { PosterFieldKey } from "./domain/constants";
import type { PosterFieldValue } from "./domain/poster-extraction";
import { send } from "./merchant-application-client";
import type { PosterExtraction, PosterSubmitResult } from "./server/services/poster-extraction-reads";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;
const extractionPath = (academyId: string, extractionId: string) =>
  `/academies/${encodeURIComponent(academyId)}/poster-extractions/${encodeURIComponent(extractionId)}`;

/** 칸 하나 고치기. revision 이 다르면 409 POSTER_REVISION_CONFLICT(다른 창에서 먼저 고쳤다) */
export function patchPosterField(
  academyId: string,
  extractionId: string,
  revision: number,
  key: PosterFieldKey,
  value: PosterFieldValue,
): Promise<PosterExtraction> {
  return send(extractionPath(academyId, extractionId), {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ revision, fields: [{ key, value }] }),
  });
}

/** 검토 끝. 확인필요 칸은 고쳤거나 confirmedKeys 에 넣어야 한다 — 남으면 409 POSTER_REVIEW_INCOMPLETE + unresolved */
export function reviewPoster(academyId: string, extractionId: string, revision: number, confirmedKeys: PosterFieldKey[]): Promise<PosterExtraction> {
  return send(`${extractionPath(academyId, extractionId)}/review`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ revision, confirmedKeys }),
  });
}

/**
 * 승인 요청(SX-2.6) — 검토 끝난 초안을 S2-2 수업 등록으로 넘긴다. 두 번 눌러도 수업이 둘 생기지 않게 누를 때마다 새 멱등키를 쓴다
 * (서버가 「포스터 읽기 하나에 수업 하나」로 묶는다). 거절은 ApiError 로 온다:
 *   409 POSTER_PERIOD_REQUIRED + missingFields(빈 기간 칸) · 422 VALIDATION_FAILED + classId · missingFields(S2-2 가 빠졌다고 한 칸)
 */
export function submitPoster(academyId: string, extractionId: string): Promise<PosterSubmitResult> {
  return send(`${extractionPath(academyId, extractionId)}/submit`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "Idempotency-Key": crypto.randomUUID() },
    body: "{}",
  });
}
