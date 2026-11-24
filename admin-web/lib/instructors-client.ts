// S1-2.14(관리자 웹 강사·소속 화면 W3a) — 강사 관리 화면이 버튼을 누를 때 부르는 API 셋.
//   계약: _workspace/03_contracts/08-owner-staff.md §1(초대 링크 만들기) · §3(승인) · §4(위임 권한 전체 교체)
//   오류 모양(`{detail, code, fields}`)은 다른 콘솔 화면과 같은 send(ApiError)로 받는다.
import type { AssignableDelegationPermission } from "./domain/permissions";
import { send } from "./merchant-application-client";
import type { ApprovedAffiliation } from "./server/services/academy-affiliation-decisions";
import type { UpdatedDelegations } from "./server/services/academy-affiliation-permissions";
import type { CreatedInvite } from "./server/services/academy-invites";

const academyPath = (academyId: string, rest: string) => `/academies/${encodeURIComponent(academyId)}/${rest}`;
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/** `POST …/affiliations/{id}/approve` — 프리랜서·사업자면 shareRateBp 를 꼭 싣는다(없으면 422 SHARE_RATE_REQUIRED) */
export function approveAffiliation(
  academyId: string,
  affiliationId: string,
  body: { isAcademyEmployee: boolean; shareRateBp?: number },
): Promise<ApprovedAffiliation> {
  return send(academyPath(academyId, `affiliations/${encodeURIComponent(affiliationId)}/approve`), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** `PUT …/affiliations/{id}/permissions` — 켜 둘 권한 전부(전체 교체). 응답의 permissions 로 토글을 다시 그린다 */
export function updatePermissions(
  academyId: string,
  affiliationId: string,
  permissions: AssignableDelegationPermission[],
): Promise<UpdatedDelegations> {
  return send(academyPath(academyId, `affiliations/${encodeURIComponent(affiliationId)}/permissions`), {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ permissions }),
  });
}

/** `POST …/invites` — 1회용 링크 하나. 링크 원문은 이 응답에서만 볼 수 있다(서버는 해시만 저장) */
export function createInvite(academyId: string): Promise<CreatedInvite> {
  return send(academyPath(academyId, "invites"), { method: "POST", headers: JSON_HEADERS, body: "{}" });
}
