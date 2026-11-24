// SX-2.5(포스터 검토 화면 O2) — 검토 화면(서버 컴포넌트)이 처음 그릴 때 필요한 것을 미리 받아 온다.
//   ① 포스터 읽기 한 건 — 계약 16 §4-6 GET /api/academies/{academyId}/poster-extractions/{extractionId}(SX-2.3)
//   ② 포스터 원본 파일 id — 왼쪽에 포스터를 띄우는 데 쓴다(바이트는 GET /api/files/{fileId} 가 권한을 보고 내린다)
//
// 왜 처리기를 그대로 부르나(staff-notices-page.ts 와 같은 방식):
//   화면이 DB 를 따로 읽으면 「누가 이 포스터 읽기를 볼 수 있나」(올린 사람 · 그 학원 대표) 기준이 API 와 갈라진다.
//   처리기에 지금 요청의 쿠키만 실어 부르고, 응답을 계약 스키마로 다시 검사해 쓴다. 효과 훅(useEffect)도 필요 없다.
//   파일 id 는 계약 응답에 없는 칸이라, 처리기가 권한을 통과시킨 **뒤에만** 같은 행에서 읽는다.
import { db } from "../../prisma/db";
import { agentJobDispatcherFromEnv } from "./ai/agent-jobs-client";
import { findExtraction, posterExtractionSchema, type PosterExtraction } from "./services/poster-extraction-reads";
import { createPosterExtractionRoutes } from "./services/poster-extractions";
import { readStaffSession } from "./staff-auth-instance";

/** 화면이 갈 길 — 읽었다 / 권한 없음(403) / 없음(404) */
export type PosterReviewPage =
  | { kind: "ok"; extraction: PosterExtraction; posterFileId: string }
  | { kind: "forbidden" }
  | { kind: "notFound" };

let routes: ReturnType<typeof createPosterExtractionRoutes> | null = null;

/** 콘솔 틀(layout)이 세션·2단계 판정을 마친 뒤에 부른다. 예상 밖 응답(401·5xx)은 던져서 오류 화면으로 보낸다 */
export async function loadPosterReviewPage(headers: Headers, academyId: string, extractionId: string): Promise<PosterReviewPage> {
  routes ??= createPosterExtractionRoutes({ db, getSession: readStaffSession, dispatchJob: agentJobDispatcherFromEnv() });
  const cookie = headers.get("cookie");
  const path = `/api/academies/${encodeURIComponent(academyId)}/poster-extractions/${encodeURIComponent(extractionId)}`;
  const request = new Request(`http://console.internal${path}`, { headers: cookie === null ? {} : { cookie } });

  const res = await routes.read(request, { params: Promise.resolve({ academyId, extractionId }) });
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 404) return { kind: "notFound" };
  if (res.status !== 200) throw new Error(`GET …/poster-extractions/{extractionId} 가 예상 밖의 응답을 냈다: ${res.status}`);
  const extraction = posterExtractionSchema.parse(await res.json());

  // 권한은 위 처리기가 확인했다 — 같은 행의 원본 파일 id 만 더 읽는다
  const row = await findExtraction(db, extraction.extractionId);
  if (row === null) return { kind: "notFound" };
  return { kind: "ok", extraction, posterFileId: row.source_file_id };
}
