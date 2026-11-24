// S1-4.7(관리자 웹 학원 공지 화면 W5) — 학원 공지 화면이 버튼을 누를 때 부르는 API 셋.
//   계약: _workspace/03_contracts/09-owner-notices.md §3(초안 만들기 · 초안 고치기 · 올리기, 구현 S1-4.3)
//   오류 모양(`{detail, code, fields}`)은 다른 콘솔 화면과 같은 send(ApiError)로 받는다.
import { send } from "./merchant-application-client";
import type { StaffNotice } from "./server/services/academy-staff-notices";
import type { buildNoticeBody } from "./staff-notices-form";

const noticesPath = (academyId: string) => `/academies/${encodeURIComponent(academyId)}/staff-notices`;
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/** `POST …/staff-notices` — 초안 만들기. 본문에 publish:true 가 있으면 한 요청으로 바로 올린다(O28) */
export function createNotice(academyId: string, body: ReturnType<typeof buildNoticeBody>): Promise<StaffNotice> {
  return send(noticesPath(academyId), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

/** `PATCH …/staff-notices/{noticeId}` — 초안만 고친다. 올린 공지는 409 NOTICE_ALREADY_PUBLISHED */
export function updateNotice(
  academyId: string,
  noticeId: string,
  body: ReturnType<typeof buildNoticeBody>,
): Promise<StaffNotice> {
  return send(`${noticesPath(academyId)}/${encodeURIComponent(noticeId)}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** `POST …/staff-notices/{noticeId}/publish` — 올리기. 두 번 눌러도 같은 본문 200(알림은 강사당 1건) */
export function publishNotice(academyId: string, noticeId: string): Promise<StaffNotice> {
  return send(`${noticesPath(academyId)}/${encodeURIComponent(noticeId)}/publish`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: "{}",
  });
}
