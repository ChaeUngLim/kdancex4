// S7-4.9e(공휴일 화면(P9)) — 「공휴일 관리」 서버 화면이 처음 그릴 때 필요한 목록을 미리 받아 온다.
//   계약: _workspace/03_contracts/13-settlement.md §10-1(GET /api/admin/console/holidays?year=)
//
// 왜 처리기를 그대로 부르나(admin-merchant-review-page.ts 와 같은 방식):
//   화면이 DB 를 따로 읽으면 「누가 볼 수 있나(운영자만)」·「조회 기록을 남기나(FR-302)」 기준이 API 와 갈라진다.
//   목록 처리기에 지금 요청의 쿠키만 실어 부르고, 응답을 계약 스키마로 다시 검사해 쓴다.
//   서버 안 함수 호출이라 네트워크 왕복이 없고, 화면이 뜬 뒤 다시 묻는 효과 훅(useEffect)도 필요 없다.
import { db } from "../../prisma/db";
import { getDeps } from "./deps";
import { createAdminHolidaysRoutes, holidayListResponseSchema, type HolidayListResponse } from "./services/admin-holidays";
import { readStaffSession } from "./staff-auth-instance";

/** 화면이 갈 길 — 읽었다 / 운영자가 아니다(403) / 틀린 연도(422 → 없는 쪽 404) */
export type HolidaysPage = { kind: "ok"; data: HolidayListResponse } | { kind: "forbidden" } | { kind: "notFound" };

let routes: ReturnType<typeof createAdminHolidaysRoutes> | null = null;

/** year 가 null 이면 서버가 KST 올해를 고른다 */
export async function loadHolidaysPage(headers: Headers, year: string | null): Promise<HolidaysPage> {
  routes ??= createAdminHolidaysRoutes({
    db,
    getSession: readStaffSession,
    // getter — deps 는 처음 쓰는 요청에서 만든다(route.ts 와 같다)
    get clock() {
      return getDeps().clock;
    },
  });
  const cookie = headers.get("cookie");
  const qs = year === null ? "" : `?year=${encodeURIComponent(year)}`;
  const res = await routes.list(
    new Request(`http://console.internal/api/admin/console/holidays${qs}`, { headers: cookie === null ? {} : { cookie } }),
    undefined,
  );
  if (res.status === 200) return { kind: "ok", data: holidayListResponseSchema.parse(await res.json()) };
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 422) return { kind: "notFound" };
  // 401(세션 끊김)·5xx 는 던져서 오류 화면으로 보낸다 — 콘솔 틀이 세션을 먼저 봤으니 보통 오지 않는다
  throw new Error(`GET /api/admin/console/holidays 가 예상 밖의 응답을 냈다: ${res.status}`);
}
