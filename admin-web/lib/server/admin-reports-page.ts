// S7-2.10b(관리자 웹 신고 처리 화면) — 「신고 처리」 서버 화면이 처음 그릴 때 필요한 신고 목록을 미리 받아 온다.
//   계약: _workspace/03_contracts/15-ops.md §2-7(GET /api/admin/reports?status=&cursor=)
//
// 왜 처리기를 그대로 부르나(admin-holidays-page.ts · admin-merchant-review-page.ts 와 같은 방식):
//   화면이 DB 를 따로 읽으면 「누가 볼 수 있나(운영자만, 2단계 필수)」·「신고자를 어떻게 가리나(역할 · 닉네임만)」 기준이
//   API 와 갈라진다. 목록 처리기에 지금 요청의 쿠키만 실어 부르고, 응답을 계약 스키마로 다시 검사해 쓴다.
//   서버 안 함수 호출이라 네트워크 왕복이 없고, 화면이 뜬 뒤 다시 묻는 효과 훅(useEffect)도 필요 없다.
import type { ReportStatus } from "../domain/constants";
import { memberProfileAppDeps } from "./member-profile-app";
import { adminReportListSchema, type AdminReportList } from "./schemas/reports";
import { createReportRoutes } from "./services/reports";

/** 화면이 갈 길 — 읽었다 / 운영자가 아니다(403) / 틀린 커서(422 → 없는 쪽 404) */
export type AdminReportsPage = { kind: "ok"; data: AdminReportList } | { kind: "forbidden" } | { kind: "notFound" };

let routes: ReturnType<typeof createReportRoutes> | null = null;

export async function loadAdminReportsPage(
  headers: Headers,
  query: { status: ReportStatus | null; cursor: string | null },
): Promise<AdminReportsPage> {
  // 처리기는 처음 쓰는 요청에서 한 번만 만든다(deps 의 시계는 getter 라 그때 읽힌다)
  routes ??= createReportRoutes(memberProfileAppDeps);
  const params = new URLSearchParams();
  if (query.status !== null) params.set("status", query.status);
  if (query.cursor !== null) params.set("cursor", query.cursor);
  const qs = params.size === 0 ? "" : `?${params.toString()}`;
  const cookie = headers.get("cookie");
  const res = await routes.adminList(
    new Request(`http://console.internal/api/admin/reports${qs}`, { headers: cookie === null ? {} : { cookie } }),
    undefined,
  );
  if (res.status === 200) return { kind: "ok", data: adminReportListSchema.parse(await res.json()) };
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 422) return { kind: "notFound" };
  // 401(세션 끊김)·5xx 는 던져서 오류 화면으로 보낸다 — 콘솔 틀이 세션을 먼저 봤으니 보통 오지 않는다
  throw new Error(`GET /api/admin/reports 가 예상 밖의 응답을 냈다: ${res.status}`);
}
