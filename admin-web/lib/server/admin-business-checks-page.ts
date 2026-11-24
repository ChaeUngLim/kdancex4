// S7-4.9g(사업자 점검 화면(P11)) — 「사업자 상태 점검」 서버 화면이 처음 그릴 때 필요한 목록·상세를 미리 받아 온다.
//   계약: _workspace/03_contracts/13-settlement.md §10-3(GET /api/admin/console/business-checks · …/{caseId})
//
// 왜 처리기를 그대로 부르나(admin-holidays-page.ts 와 같은 방식):
//   화면이 DB 를 따로 읽으면 「누가 볼 수 있나(운영자만)」·「조회 기록을 남기나(FR-302)」 기준이 API 와 갈라진다.
//   목록·상세 처리기에 지금 요청의 쿠키만 실어 부르고, 응답을 계약 스키마로 다시 검사해 쓴다.
//   서버 안 함수 호출이라 네트워크 왕복이 없고, 화면이 뜬 뒤 다시 묻는 효과 훅(useEffect)도 필요 없다.
import { db } from "../../prisma/db";
import { getDeps } from "./deps";
import {
  businessCheckDetailResponseSchema,
  businessCheckListResponseSchema,
  type BusinessCheckDetailResponse,
  type BusinessCheckListResponse,
} from "./schemas/admin-business-checks";
import { createAdminBusinessCheckRoutes } from "./services/admin-business-checks";
import { readStaffSession } from "./staff-auth-instance";

/** 화면이 갈 길 — 읽었다 / 운영자가 아니다(403) / 주소의 건이 없다(404) */
export type BusinessChecksPage =
  | { kind: "ok"; list: BusinessCheckListResponse; detail: BusinessCheckDetailResponse | null }
  | { kind: "forbidden" }
  | { kind: "notFound" };

let routes: ReturnType<typeof createAdminBusinessCheckRoutes> | null = null;

function getRoutes() {
  routes ??= createAdminBusinessCheckRoutes({
    db,
    getSession: readStaffSession,
    // getter — deps 는 처음 쓰는 요청에서 만든다(route.ts 와 같다)
    get clock() {
      return getDeps().clock;
    },
  });
  return routes;
}

/**
 * caseId 가 null 이면 목록의 첫 건(조회 실패 줄은 건이 없어 건너뛴다)을 오른쪽에 펼친다 — 보드 P11 이 첫 건을 연 모양이라서.
 * 건이 하나도 없으면 detail 은 null 이다(빈 화면).
 */
export async function loadBusinessChecksPage(headers: Headers, caseId: string | null): Promise<BusinessChecksPage> {
  const r = getRoutes();
  const cookie = headers.get("cookie");
  const init: RequestInit = { headers: cookie === null ? {} : { cookie } };

  const listRes = await r.list(new Request("http://console.internal/api/admin/console/business-checks", init), undefined);
  if (listRes.status === 403) return { kind: "forbidden" };
  // 401(세션 끊김)·5xx 는 던져서 오류 화면으로 보낸다 — 콘솔 틀이 세션을 먼저 봤으니 보통 오지 않는다
  if (listRes.status !== 200) throw new Error(`GET /api/admin/console/business-checks 가 예상 밖의 응답을 냈다: ${listRes.status}`);
  const list = businessCheckListResponseSchema.parse(await listRes.json());

  const selected = caseId ?? list.items.find((item) => item.caseId !== null)?.caseId ?? null;
  if (selected === null) return { kind: "ok", list, detail: null };

  const detailRes = await r.detail(new Request(`http://console.internal/api/admin/console/business-checks/${encodeURIComponent(selected)}`, init), {
    params: Promise.resolve({ caseId: selected }),
  });
  // 주소로 없는 건(또는 다른 출처 절차)을 열었으면 404 화면
  if (detailRes.status === 404) return { kind: "notFound" };
  if (detailRes.status !== 200) throw new Error(`GET /api/admin/console/business-checks/{caseId} 가 예상 밖의 응답을 냈다: ${detailRes.status}`);
  return { kind: "ok", list, detail: businessCheckDetailResponseSchema.parse(await detailRes.json()) };
}
