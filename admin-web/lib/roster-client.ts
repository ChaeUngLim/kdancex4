// S3-5.7(관리자 웹 주문·명단 화면) — 예약·명단 화면(보드 W6)이 버튼을 누를 때 부르는 API 셋.
//   계약: 18-after-payment-views.md §5(연락처 전체 열람) · §6(현장 등록 인원) · 04-me-calendar-notifications.md §6-1(강사·대표 결석 표시)
//   오류 모양(`{detail, code}`)은 다른 콘솔 화면과 같은 send(ApiError)로 받는다.
import { send } from "./merchant-application-client";
import type { ContactRevealResponse } from "./server/services/member-contact-reveal";
import type { OnsiteHeadcountResponse } from "./server/services/session-onsite-headcount";
import type { StaffAbsenceMarkResponse } from "./server/services/staff-absence-marks";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;
const sessionPath = (classId: string, sessionId: string) =>
  `/classes/${encodeURIComponent(classId)}/sessions/${encodeURIComponent(sessionId)}`;

/** `PUT …/onsite-headcount` — 현장 인원을 통째로 바꾼다(남·여 또는 any). 정원을 넘기면 409 ONSITE_EXCEEDS_CAPACITY */
export function saveOnsiteHeadcount(
  classId: string,
  sessionId: string,
  body: Partial<Record<"male" | "female" | "any", number>>,
): Promise<OnsiteHeadcountResponse> {
  return send(`${sessionPath(classId, sessionId)}/onsite-headcount`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

/** `POST …/members/{memberId}/contact-reveal` — 사유를 적고 전체 번호를 본다. 부를 때마다 감사 기록 1건(SC-025) */
export function revealContact(academyId: string, memberId: string, reason: string, sessionId: string | null): Promise<ContactRevealResponse> {
  const body = sessionId === null ? { reason } : { reason, sessionId };
  return send(`/academies/${encodeURIComponent(academyId)}/members/${encodeURIComponent(memberId)}/contact-reveal`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    // 전체 번호가 브라우저 캐시에 남지 않게(서버도 no-store 를 준다)
    cache: "no-store",
  });
}

/** `POST …/absences` — 수업이 시작한 뒤 ~ 끝나고 48시간 안에 결석으로 표시한다. 회원에게 알림이 간다 */
export function markAbsence(classId: string, sessionId: string, memberId: string): Promise<StaffAbsenceMarkResponse> {
  return send(`${sessionPath(classId, sessionId)}/absences`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ memberId }) });
}
