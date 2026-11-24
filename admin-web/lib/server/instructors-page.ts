// S1-2.14(관리자 웹 강사·소속 화면 W3a) — 강사 관리 화면(서버 컴포넌트)이 처음 그릴 때 소속 목록을 미리 받아 온다.
//   계약: _workspace/03_contracts/08-owner-staff.md §3(GET /api/academies/{academyId}/affiliations)
//
// 왜 처리기를 그대로 부르나(academy-settings-page.ts 와 같은 방식):
//   화면이 DB 를 따로 읽으면 「누가 이 학원 강사 목록을 볼 수 있나」·「연락처를 어떻게 가리나」 기준이 API 와 갈라진다.
//   목록 처리기에 지금 요청의 쿠키만 실어 부르고, 응답을 계약 스키마로 다시 검사해 쓴다.
//   서버 안의 함수 호출이라 네트워크 왕복이 없고, 화면이 뜬 뒤 다시 묻는 효과 훅(useEffect)도 필요 없다.
import { db } from "../../prisma/db";
import {
  affiliationListSchema,
  createListAcademyAffiliationsRoute,
  type AffiliationListItem,
} from "./services/academy-affiliation-list";
import { readStaffSession } from "./staff-auth-instance";

/** 화면이 갈 길 — 읽었다 / 대표가 아니다(403) / 그런 학원이 없다(404) */
export type InstructorsPage = { kind: "ok"; items: AffiliationListItem[] } | { kind: "forbidden" } | { kind: "notFound" };

let listAffiliations: ReturnType<typeof createListAcademyAffiliationsRoute> | null = null;

/**
 * 콘솔 틀(layout)이 세션·2단계 판정을 마친 뒤에 부른다. 대기·소속 중을 한 번에 받는다(status 를 비움).
 * 403·404 는 화면에서 안내로 바꾸고, 예상 밖 응답(401·5xx)은 던져서 오류 화면으로 보낸다.
 */
export async function loadInstructorsPage(headers: Headers, academyId: string): Promise<InstructorsPage> {
  listAffiliations ??= createListAcademyAffiliationsRoute({ db, getSession: readStaffSession });
  const cookie = headers.get("cookie");
  const request = new Request(`http://console.internal/api/academies/${encodeURIComponent(academyId)}/affiliations`, {
    headers: cookie === null ? {} : { cookie },
  });
  const res = await listAffiliations(request, { params: Promise.resolve({ academyId }) });

  if (res.status === 200) return { kind: "ok", items: affiliationListSchema.parse(await res.json()).items };
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 404) return { kind: "notFound" };
  throw new Error(`GET /api/academies/{academyId}/affiliations 가 예상 밖의 응답을 냈다: ${res.status}`);
}
