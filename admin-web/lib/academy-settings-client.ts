// S1-1.32(학원 설정 화면 W2b·W22) — 학원 설정 화면이 버튼을 누를 때 부르는 API 넷.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §1(파일) · §4(profile · app-page · payout-account)
//   오류 모양(`{detail, code, fields}`)은 입점 신청 화면과 같은 send(ApiError)로 받는다.
import type { AcademyAppPageResponse } from "./server/services/academy-app-page";
import type { PayoutAccountChangeResponse } from "./server/services/academy-payout-account";
import type { AcademySettingsResponse } from "./server/services/academy-settings";
import type { PayoutForm, ProfilePatch } from "./academy-settings-form";
import { send } from "./merchant-application-client";

const academyPath = (academyId: string, rest: string) => `/academies/${encodeURIComponent(academyId)}/${rest}`;

/** `PATCH …/profile` — 바뀐 칸만. 응답은 설정 조회와 같은 본문이라 화면을 그대로 다시 그린다 */
export function patchProfile(academyId: string, patch: ProfilePatch): Promise<AcademySettingsResponse> {
  return send(academyPath(academyId, "profile"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

/**
 * `PUT …/payout-account` — 인증 앱 6자리를 이 요청에 한 번 더 싣는다(FR-139 재확인).
 * 같은 변경을 다시 보낼 때(응답을 못 받고 다시 누름)는 같은 키를 넘겨야 서버가 한 번으로 친다.
 */
export function changePayoutAccount(
  academyId: string,
  idempotencyKey: string,
  form: PayoutForm,
  totpCode: string,
): Promise<PayoutAccountChangeResponse> {
  return send(academyPath(academyId, "payout-account"), {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ ...form, totpCode: totpCode.trim() }),
  });
}

/** `PUT …/app-page` — 한 줄 소개·소개 글·사진 목록 전체 교체(배열 순서 = 보이는 순서) */
export function saveAppPage(
  academyId: string,
  body: { tagline: string; intro: string; photoFileIds: string[] },
): Promise<AcademyAppPageResponse> {
  return send(academyPath(academyId, "app-page"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** `POST /api/files` — 학원 사진 한 장(purpose academy_photo). 받은 fileId 를 사진 목록에 붙인다 */
export function uploadAcademyPhoto(file: File): Promise<{ fileId: string; displayName: string; sizeBytes: number }> {
  const form = new FormData();
  form.append("purpose", "academy_photo");
  form.append("file", file);
  return send("/files", { method: "POST", body: form });
}

/** 사진 미리보기 주소 — 권한 판정을 거치는 내려받기 경로(올린 사람·그 학원 대표만 열린다) */
export const photoUrl = (fileId: string) => `/api/files/${encodeURIComponent(fileId)}`;
