// S7-2.7(문의·신고 첨부 파일) — 「이 첨부를 누가 열 수 있나」를 정하는 순수 규칙.
//   계약: _workspace/03_contracts/15-ops.md §2-2(첨부는 당사자와 받는 쪽만) · 07 §1(GET /api/files/{fileId})
//   데이터: attachment_links(owner_kind · owner_id · file_id) · data-model §12 「attachment_links」
//   플랜: 6-8 파일 저장 경계 표 「문의·신고 첨부 | 회원·강사 | 당사자와 받는 쪽만」
//
// DB 를 읽지 않는다. 서비스(lib/server/services/file-download.ts)가 사실(누가 물었나 · 그 첨부가 어디에 붙었나)을 모아
// 이 함수에 넘기고, 이 함수는 참/거짓만 돌려준다 — 그래서 표 하나로 단위 테스트할 수 있다.
//
// 규칙(owner_kind 별):
//   inquiry_message — 문의자 본인 · 받는 쪽. 받는 쪽은 학원 문의면 그 학원의 지금 대표, 시스템 문의면 운영자.
//                     운영자라도 학원 문의 첨부는 못 연다 — 운영자는 학원 문의를 받지 않는다(FR-204).
//   report          — 신고자 본인 · 운영자. 신고받은 상대(학원·강사·회원)는 못 연다 — 누가 신고했는지 알리지 않는다(C11A).
//   restriction_explanation — 소명을 낸 본인 · 운영자(소명 경로를 만드는 Task 가 이 자리에 붙인다).
//   어디에도 아직 안 붙은 첨부 — 올린 사람만. 붙기 전에는 받는 쪽이 정해지지 않았다.
// 올린 사람은 언제나 연다(문의자·신고자가 아니어도 — 예: 대표가 답변에 붙인 파일은 그 대표가 다시 연다).
import type { AttachmentOwnerKind, InquiryKind } from "./constants";

/** 요청한 사람. 회원과 직원은 다른 계정이다(FR-011a) */
export type AttachmentViewer =
  | { readonly type: "member"; readonly memberId: string }
  | {
      readonly type: "staff";
      readonly staffAccountId: string;
      /** active 역할(role_grants) — 운영자 판정에 쓴다 */
      readonly roles: readonly string[];
      /** 지금 대표인 학원(academy_owners active) */
      readonly ownedAcademyIds: readonly string[];
    };

/** 파일을 올린 사람 — 직원 계정이나 회원 둘 중 하나(uploaded_files 의 ck_files_uploader) */
export type AttachmentUploader = { readonly type: "member"; readonly memberId: string } | { readonly type: "staff"; readonly staffAccountId: string };

/** 「당사자」 한 명 — 문의자 · 신고자 · 소명자. 회원이거나 직원이다 */
export type AttachmentParty = AttachmentUploader;

/** 그 첨부가 붙은 자리. 붙지 않았으면 null */
export type AttachmentPlace =
  | { readonly ownerKind: Extract<AttachmentOwnerKind, "inquiry_message">; readonly asker: AttachmentParty; readonly inquiryKind: InquiryKind; readonly academyId: string | null }
  | { readonly ownerKind: Extract<AttachmentOwnerKind, "report">; readonly reporter: AttachmentParty }
  | { readonly ownerKind: Extract<AttachmentOwnerKind, "restriction_explanation">; readonly explainer: AttachmentParty };

/** 두 사람이 같은 사람인가 — 회원은 회원 번호로, 직원은 직원 계정 번호로만 견준다 */
function samePerson(viewer: AttachmentViewer, party: AttachmentParty): boolean {
  if (viewer.type === "member") return party.type === "member" && party.memberId === viewer.memberId;
  return party.type === "staff" && party.staffAccountId === viewer.staffAccountId;
}

const isOperator = (viewer: AttachmentViewer): boolean => viewer.type === "staff" && viewer.roles.includes("admin");

/**
 * 이 사람이 이 첨부를 열어도 되나. 하나라도 맞으면 연다:
 *   ① 올린 사람 ② 그 자리의 당사자(문의자·신고자·소명자) ③ 그 자리의 받는 쪽
 */
export function canOpenAttachment(input: {
  readonly viewer: AttachmentViewer;
  readonly uploader: AttachmentUploader;
  readonly place: AttachmentPlace | null;
}): boolean {
  const { viewer, uploader, place } = input;
  // ① 올린 사람
  if (samePerson(viewer, uploader)) return true;
  // 아직 붙지 않은 첨부는 올린 사람만 — 받는 쪽이 아직 없다
  if (place === null) return false;

  switch (place.ownerKind) {
    case "inquiry_message": {
      // ② 문의자 본인
      if (samePerson(viewer, place.asker)) return true;
      // ③ 받는 쪽 — 학원 문의는 그 학원의 지금 대표, 시스템 문의는 운영자(학원 문의 첨부는 운영자도 못 연다, FR-204)
      if (viewer.type !== "staff") return false;
      if (place.inquiryKind === "academy") return place.academyId !== null && viewer.ownedAcademyIds.includes(place.academyId);
      return isOperator(viewer);
    }
    case "report":
      // 신고자 본인 · 운영자. 신고받은 상대에게는 열지 않는다
      return samePerson(viewer, place.reporter) || isOperator(viewer);
    case "restriction_explanation":
      return samePerson(viewer, place.explainer) || isOperator(viewer);
  }
}
