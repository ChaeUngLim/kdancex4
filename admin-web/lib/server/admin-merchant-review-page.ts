// S1-1.33(운영자 심사 최소 화면) — 운영자 심사 화면(서버 컴포넌트)이 처음 그릴 때 필요한 것을 미리 받아 온다.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §3(GET /api/admin/merchant-applications · …/{id}) · 열린 점 ⑨
//
// 왜 처리기를 그대로 부르나(academy-settings-page.ts · console-staff.ts 와 같은 방식):
//   화면이 DB 를 따로 읽으면 「누가 볼 수 있나(운영자만)」·「계좌를 어떻게 가리나」 기준이 API 와 갈라질 수 있다.
//   목록·상세 처리기에 지금 요청의 쿠키만 실어 부르고, 응답을 계약 스키마로 다시 검사해 쓴다.
//   서버 안의 함수 호출이라 네트워크 왕복이 없고, 화면이 뜬 뒤 다시 묻는 효과 훅(useEffect)도 필요 없다.
import { merchantApplicationAppDeps } from "./merchant-application-app";
import {
  adminApplicationListSchema,
  adminApplicationSchema,
  createGetMerchantApplicationRoute,
  createListMerchantApplicationsRoute,
  type AdminApplication,
} from "./services/admin-merchant-applications";

/** 화면이 갈 길 — 읽었다 / 운영자가 아니다(403) / 그런 신청이 없다(404) */
export type AdminPage<T> = { kind: "ok"; data: T } | { kind: "forbidden" } | { kind: "notFound" };
export type AdminApplicationList = { items: AdminApplication[]; nextCursor: string | null };

let listRoute: ReturnType<typeof createListMerchantApplicationsRoute> | null = null;
let detailRoute: ReturnType<typeof createGetMerchantApplicationRoute> | null = null;

/** 쿠키만 실은 내부 요청. 세션은 쿠키로 읽고, 다른 헤더는 이 판정에 필요 없다 */
function internalRequest(headers: Headers, path: string): Request {
  const cookie = headers.get("cookie");
  return new Request(`http://console.internal${path}`, { headers: cookie === null ? {} : { cookie } });
}

/**
 * 예상한 응답(200·403·404 와 목록의 422)만 화면 갈 길로 바꾸고, 그 밖(401·5xx)은 던져서 오류 화면으로 보낸다.
 * 422 는 손으로 고친 커서 같은 틀린 쿼리다 — 목록 화면에서는 없는 쪽(404)으로 보인다.
 */
async function toPage<T>(res: Response, parse: (body: unknown) => T, label: string): Promise<AdminPage<T>> {
  if (res.status === 200) return { kind: "ok", data: parse(await res.json()) };
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 404 || res.status === 422) return { kind: "notFound" };
  throw new Error(`${label} 가 예상 밖의 응답을 냈다: ${res.status}`);
}

/** 목록 한 쪽. status 가 null 이면 운영자에게 보이는 상태 전부 */
export async function loadAdminApplicationList(
  headers: Headers,
  query: { status: string | null; cursor: string | null },
): Promise<AdminPage<AdminApplicationList>> {
  listRoute ??= createListMerchantApplicationsRoute(merchantApplicationAppDeps());
  const params = new URLSearchParams();
  if (query.status !== null) params.set("status", query.status);
  if (query.cursor !== null) params.set("cursor", query.cursor);
  const qs = params.toString();
  const res = await listRoute(internalRequest(headers, `/api/admin/merchant-applications${qs === "" ? "" : `?${qs}`}`), undefined);
  return toPage(res, (body) => adminApplicationListSchema.parse(body), "GET /api/admin/merchant-applications");
}

/** 신청 하나(증빙 파일 id 포함, 계좌는 가린 값) */
export async function loadAdminApplication(headers: Headers, id: string): Promise<AdminPage<AdminApplication>> {
  detailRoute ??= createGetMerchantApplicationRoute(merchantApplicationAppDeps());
  const res = await detailRoute(internalRequest(headers, `/api/admin/merchant-applications/${encodeURIComponent(id)}`), {
    params: Promise.resolve({ id }),
  });
  return toPage(res, (body) => adminApplicationSchema.parse(body), "GET /api/admin/merchant-applications/{id}");
}
