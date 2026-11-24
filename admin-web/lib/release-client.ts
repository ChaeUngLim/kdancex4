// S2-3.10(관리자 웹·대표 앱 해제 확인 화면) — 소속 해제 화면(W3b · W3b2)이 버튼을 누를 때 부르는 API 셋.
//   계약: _workspace/03_contracts/11-instructor.md §8-1(대체 강사 후보) · §9-1(release-preview) · §9-2(release, Idempotency-Key 필수)
//   오류 모양(`{detail, code, fields}`)은 다른 콘솔 화면과 같은 send(ApiError)로 받는다.
import { send } from "./merchant-application-client";
import type { ReleaseSessionAction } from "./release-form";
import type { ReleasedAffiliation } from "./server/services/academy-affiliation-release";
import type { ReleasePreview } from "./server/services/affiliation-release-sessions";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

const affiliationPath = (academyId: string, affiliationId: string, verb: "release-preview" | "release") =>
  `/academies/${encodeURIComponent(academyId)}/affiliations/${encodeURIComponent(affiliationId)}/${verb}`;

export type SessionDecision = { sessionId: string; action: ReleaseSessionAction; substituteAccountId?: string };

/** 대체 강사 후보 한 명(§8-1). 바쁜 이유는 「그 시간에 일정이 있어요」 하나뿐 — 무슨 일정인지는 오지 않는다 */
export type SubstituteCandidate = {
  accountId: string;
  displayName: string;
  genre: string | null;
  available: boolean;
  unavailableReason: "busy" | null;
};

/** `GET /api/sessions/{sessionId}/substitute-candidates` — 같은 학원·같은 장르 강사와 그 시간에 비었는지 */
export async function fetchCandidates(sessionId: string): Promise<SubstituteCandidate[]> {
  const res = await send<{ sessionId: string; items: SubstituteCandidate[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/substitute-candidates`,
    { method: "GET" },
  );
  return res.items;
}

/** `POST …/release-preview` — 고른 처리로 묶음·받는 회원을 미리 계산(DB 에 쓰지 않는다) */
export function previewRelease(academyId: string, affiliationId: string, sessionDecisions: SessionDecision[]): Promise<ReleasePreview> {
  return send(affiliationPath(academyId, affiliationId, "release-preview"), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionDecisions, privateLessonDecisions: [] }),
  });
}

/**
 * `POST …/release` — 해제 실행. 같은 확인 창에서 다시 누르면 같은 키가 나가 한 번만 처리된다.
 * 대표가 덧붙이는 한 줄(ownerNote)은 비어 있으면 싣지 않는다(서버는 빈 글자를 받지 않는다).
 */
export function releaseAffiliation(
  academyId: string,
  affiliationId: string,
  sessionDecisions: SessionDecision[],
  ownerNote: string,
  idempotencyKey: string,
): Promise<ReleasedAffiliation> {
  const note = ownerNote.trim();
  return send(affiliationPath(academyId, affiliationId, "release"), {
    method: "POST",
    headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ sessionDecisions, privateLessonDecisions: [], ...(note === "" ? {} : { ownerNote: note }) }),
  });
}
