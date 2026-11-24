// S2-3.10(관리자 웹·대표 앱 해제 확인 화면) — 소속 해제 화면(보드 W3b, 서버 컴포넌트)이 처음 그릴 때 남은 회차를 미리 받아 온다.
//   계약: _workspace/03_contracts/11-instructor.md §9-1(POST …/affiliations/{id}/release-preview, 빈 본문 = 남은 것 목록만)
//
// instructors-page.ts 와 같은 방식이다 — 화면이 DB 를 따로 읽지 않고 같은 처리기를 지금 요청의 쿠키로 부른다.
// 그래야 「누가 볼 수 있나」·「남은 회차가 무엇인가」 기준이 API 와 하나로 남는다. 화면이 뜬 뒤 다시 묻는 효과 훅도 필요 없다.
import { db } from "../../prisma/db";
import { getDeps } from "./deps";
import { createOwnerReleasePreviewRoute } from "./services/affiliation-release-preview";
import { releasePreviewSchema, type ReleasePreview } from "./services/affiliation-release-sessions";
import { readStaffSession } from "./staff-auth-instance";

/** 화면이 갈 길 — 읽었다 / 대표가 아니다(403) / 그런 소속이 없다(404) / 이미 소속 중이 아니다(409) */
export type ReleasePage =
  | { kind: "ok"; preview: ReleasePreview }
  | { kind: "forbidden" }
  | { kind: "notFound" }
  | { kind: "notActive" };

let previewRoute: ReturnType<typeof createOwnerReleasePreviewRoute> | null = null;

export async function loadReleasePage(headers: Headers, academyId: string, affiliationId: string): Promise<ReleasePage> {
  previewRoute ??= createOwnerReleasePreviewRoute({
    db,
    getSession: readStaffSession,
    get clock() {
      return getDeps().clock;
    },
  });
  const cookie = headers.get("cookie");
  const path = `/api/academies/${encodeURIComponent(academyId)}/affiliations/${encodeURIComponent(affiliationId)}/release-preview`;
  const request = new Request(`http://console.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie === null ? {} : { cookie }) },
    body: "{}",
  });
  const res = await previewRoute(request, { params: Promise.resolve({ academyId, id: affiliationId }) });

  if (res.status === 200) return { kind: "ok", preview: releasePreviewSchema.parse(await res.json()) };
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 404) return { kind: "notFound" };
  if (res.status === 409) return { kind: "notActive" };
  throw new Error(`release-preview 가 예상 밖의 응답을 냈다: ${res.status}`);
}
