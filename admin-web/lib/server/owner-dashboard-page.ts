// S1-4.8(관리자 웹 대시보드 화면 W29) — 대시보드 화면(서버 컴포넌트)이 처음 그릴 때 대시보드 응답을 미리 받아 온다.
//   계약: _workspace/03_contracts/10-owner-dashboard.md §1(GET /api/academies/{academyId}/dashboard)
//
// 왜 처리기를 그대로 부르나(instructors-page.ts 와 같은 방식):
//   화면이 DB 를 따로 읽으면 「준비 안 된 타일은 null」 같은 규칙과 권한 판정이 API 와 갈라진다.
//   대시보드 처리기에 지금 요청의 쿠키만 실어 부르고, 응답을 계약 스키마(ownerDashboardSchema)로 다시 검사해 쓴다.
//   서버 안의 함수 호출이라 네트워크 왕복이 없고, 화면이 뜬 뒤 다시 묻는 효과 훅(useEffect)도 필요 없다.
import { cancellationRouteDeps } from "./cancellation-route-deps";
import { createOwnerDashboardRoute, ownerDashboardSchema, type OwnerDashboard } from "./services/owner-dashboard";

/** 화면이 갈 길 — 읽었다 / 대표가 아니다(403) / 그런 학원이 없다(404) */
export type OwnerDashboardPage = { kind: "ok"; dashboard: OwnerDashboard } | { kind: "forbidden" } | { kind: "notFound" };

let readDashboard: ReturnType<typeof createOwnerDashboardRoute> | null = null;

/**
 * 콘솔 틀(layout)이 세션·2단계 판정을 마친 뒤에 부른다. date 는 비워 두어 서버 시계의 KST 오늘을 쓴다.
 * 403·404 는 화면에서 안내로 바꾸고, 예상 밖 응답(401·5xx)은 던져서 오류 화면으로 보낸다.
 */
export async function loadOwnerDashboardPage(headers: Headers, academyId: string): Promise<OwnerDashboardPage> {
  // API 경로와 같은 재료(db·세션·시계·PG 포트) — 읽기 전 정리에서 같은 가짜 PG 원장을 봐야 한다
  readDashboard ??= createOwnerDashboardRoute(cancellationRouteDeps);
  const cookie = headers.get("cookie");
  const request = new Request(`http://console.internal/api/academies/${encodeURIComponent(academyId)}/dashboard`, {
    headers: cookie === null ? {} : { cookie },
  });
  const res = await readDashboard(request, { params: Promise.resolve({ academyId }) });

  if (res.status === 200) return { kind: "ok", dashboard: ownerDashboardSchema.parse(await res.json()) };
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 404) return { kind: "notFound" };
  throw new Error(`GET /api/academies/{academyId}/dashboard 가 예상 밖의 응답을 냈다: ${res.status}`);
}
