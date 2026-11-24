// S7-2.7(문의·신고 첨부 파일) — 올린 첨부 파일을 문의 글·신고에 「붙이고」, 붙은 첨부를 다시 읽는 공용 처리.
//   계약: _workspace/03_contracts/15-ops.md §2-2(첨부는 POST /api/files 로 먼저 올린 fileId) · §2-4(답변 첨부) · §2-7(신고 첨부)
//   데이터: attachment_links(owner_kind · owner_id · file_id · position) · uploaded_files(attached_at)
//
// 흐름: 앱이 먼저 POST /api/files(purpose=inquiry_attachment|report_attachment)로 파일을 올려 fileId 를 받는다
//       → 문의·답변·신고를 만들 때 그 fileId 목록을 본문 attachmentFileIds 로 보낸다
//       → 처리기가 같은 트랜잭션에서 글·신고 행을 만든 뒤 linkAttachments 로 잇는다(실패하면 글·신고도 같이 없어진다)
//
// 붙이기 전에 보는 것(하나라도 틀리면 전체를 거부한다 — 일부만 붙으면 사용자가 무엇이 빠졌는지 모른다):
//   ① 같은 파일을 두 번 적지 않았나(422)  ② 파일이 있나(422 — 본문의 값이 틀린 것이라 404 가 아니다)
//   ③ 내가 올린 파일인가(403 — 남의 파일 id 를 알아내 내 글에 붙여 열람 권한을 얻는 길을 막는다)
//   ④ 목적이 맞나(문의엔 inquiry_attachment, 신고엔 report_attachment — 422)  ⑤ 이미 다른 곳에 붙지 않았나(422)
// 파일 행은 FOR UPDATE 로 잠근다 — 같은 파일을 두 요청이 동시에 붙여도 하나만 이긴다(uq_attachment_file 이 마지막 방어선).
import type { AttachmentOwnerKind, UploadedFilePurpose } from "../../domain/constants";
import type { AttachmentParty, AttachmentPlace, AttachmentUploader } from "../../domain/attachment";
import type { InquiryKind } from "../../domain/constants";
import { HttpError } from "../http";
import type { Runner } from "./cancellation-queries";

/** 응답에 싣는 첨부 한 장(계약 §2-2 messages[].attachments) */
export interface AttachmentSummary {
  fileId: string;
  displayName: string;
}

const DETAIL = {
  duplicate: "같은 파일을 두 번 붙일 수 없어요",
  notFound: "첨부 파일을 찾을 수 없어요. 다시 올려 주세요",
  notMine: "본인이 올린 파일만 붙일 수 있어요",
  wrongPurpose: "이 자리에 붙일 수 없는 파일이에요. 첨부용으로 다시 올려 주세요",
  alreadyAttached: "이미 다른 글에 붙은 파일이에요. 다시 올려 주세요",
} as const;

const attachmentError = (index: number, message: string) =>
  new HttpError("VALIDATION_FAILED", message, { fields: [{ path: `attachmentFileIds.${index}`, message }] });

/** 사람 하나 → SQL 에 넘길 두 칸(한쪽은 늘 빈 글자 — NULLIF 로 NULL 이 된다) */
const partyColumns = (who: AttachmentUploader) =>
  who.type === "member" ? { memberId: who.memberId, staffId: "" } : { memberId: "", staffId: who.staffAccountId };

/**
 * 파일들을 한 자리(문의 글 하나 · 신고 하나)에 붙인다. 주인 행은 이미 같은 트랜잭션에서 만들어져 있어야 한다.
 * 빈 목록이면 아무것도 하지 않는다.
 */
export async function linkAttachments(
  tx: Runner,
  input: {
    ownerKind: AttachmentOwnerKind;
    ownerId: string;
    purpose: UploadedFilePurpose;
    uploader: AttachmentUploader;
    fileIds: readonly string[];
    now: string;
  },
): Promise<void> {
  const { fileIds } = input;
  if (fileIds.length === 0) return;
  // ① 같은 파일 두 번
  const seen = new Set<string>();
  fileIds.forEach((fileId, index) => {
    if (seen.has(fileId)) throw attachmentError(index, DETAIL.duplicate);
    seen.add(fileId);
  });

  const cols = partyColumns(input.uploader);
  for (const [index, fileId] of fileIds.entries()) {
    // 파일 행을 잠그고 읽는다 — 동시에 같은 파일을 붙이려는 두 요청이 차례로 처리된다
    const [file] = await tx.query(
      tx.raw.sql`SELECT COALESCE(f.uploader_member_id::text, '') AS uploader_member_id,
                        COALESCE(f.uploader_account_id::text, '') AS uploader_account_id,
                        f.purpose,
                        EXISTS (SELECT 1 FROM attachment_links l WHERE l.file_id = f.id) AS linked
                 FROM uploaded_files f WHERE f.id = ${fileId}::uuid FOR UPDATE OF f`
        .returnsRow({ uploader_member_id: "pg/text@1", uploader_account_id: "pg/text@1", purpose: "pg/text@1", linked: "pg/bool@1" })
        .build(),
    );
    // ② 없음 ③ 남의 파일 ④ 목적 ⑤ 이미 붙음 — 순서는 「남의 파일인지」를 목적보다 먼저 알려 주도록 정했다
    if (file === undefined) throw attachmentError(index, DETAIL.notFound);
    const mine = cols.memberId !== "" ? file.uploader_member_id === cols.memberId : file.uploader_account_id === cols.staffId;
    if (!mine) throw new HttpError("FORBIDDEN", DETAIL.notMine);
    if (file.purpose !== input.purpose) throw attachmentError(index, DETAIL.wrongPurpose);
    if (file.linked) throw attachmentError(index, DETAIL.alreadyAttached);

    await tx.execute(
      tx.raw.sql`INSERT INTO attachment_links (id, owner_kind, owner_id, file_id, position, created_at)
                 VALUES (uuidv7(), ${input.ownerKind}, ${input.ownerId}::uuid, ${fileId}::uuid, ${index}::int, ${input.now}::timestamptz)`
        .affectedCount()
        .build(),
    );
    // 붙은 시각 — 24시간 지난 「주인 없는 파일」 정리(ix_files_unattached)에서 빠진다
    await tx.execute(
      tx.raw.sql`UPDATE uploaded_files SET attached_at = ${input.now}::timestamptz WHERE id = ${fileId}::uuid`.affectedCount().build(),
    );
  }
}

/** 여러 자리(문의 글 여럿 등)의 첨부를 한 번에 읽는다. 자리 id → 순서대로 놓인 첨부 목록 */
export async function readAttachmentsByOwner(
  runner: Runner,
  ownerKind: AttachmentOwnerKind,
  ownerIds: readonly string[],
): Promise<Map<string, AttachmentSummary[]>> {
  const result = new Map<string, AttachmentSummary[]>();
  if (ownerIds.length === 0) return result;
  const rows = await runner.query(
    runner.raw.sql`SELECT l.owner_id, l.file_id, f.display_name
                   FROM attachment_links l JOIN uploaded_files f ON f.id = l.file_id
                   WHERE l.owner_kind = ${ownerKind} AND l.owner_id = ANY(${`{${ownerIds.join(",")}}`}::uuid[])
                   ORDER BY l.owner_id, l.position`
      .returnsRow({ owner_id: "pg/uuid@1", file_id: "pg/uuid@1", display_name: "pg/text@1" })
      .build(),
  );
  for (const row of rows) {
    const list = result.get(row.owner_id) ?? [];
    result.set(row.owner_id, [...list, { fileId: row.file_id, displayName: row.display_name }]);
  }
  return result;
}

/** 회원·직원 번호 두 칸(글자) → 당사자. 둘 다 비면 null(그럴 수 없는 행이다 — 각 표의 CHECK 가 막는다) */
function partyOf(memberId: string, staffId: string): AttachmentParty | null {
  if (memberId !== "") return { type: "member", memberId };
  if (staffId !== "") return { type: "staff", staffAccountId: staffId };
  return null;
}

/**
 * 이 파일이 어디에 붙었나 — 내려받기 판정(GET /api/files/{fileId})이 쓴다. 안 붙었으면 null.
 * 문의 글이면 그 문의의 문의자·종류·학원, 신고면 신고자를 함께 읽는다.
 */
export async function readAttachmentPlace(runner: Runner, fileId: string): Promise<AttachmentPlace | null> {
  const [link] = await runner.query(
    runner.raw.sql`SELECT l.owner_kind,
                          COALESCE(i.kind, '') AS inquiry_kind, COALESCE(i.academy_id::text, '') AS academy_id,
                          COALESCE(i.asker_member_id::text, r.reporter_member_id::text, '') AS party_member_id,
                          COALESCE(i.asker_staff_account_id::text, r.reporter_staff_account_id::text, '') AS party_staff_id
                   FROM attachment_links l
                   LEFT JOIN inquiry_messages m ON l.owner_kind = 'inquiry_message' AND m.id = l.owner_id
                   LEFT JOIN inquiries i ON i.id = m.inquiry_id
                   LEFT JOIN reports r ON l.owner_kind = 'report' AND r.id = l.owner_id
                   WHERE l.file_id = ${fileId}::uuid`
      .returnsRow({
        owner_kind: "pg/text@1",
        inquiry_kind: "pg/text@1",
        academy_id: "pg/text@1",
        party_member_id: "pg/text@1",
        party_staff_id: "pg/text@1",
      })
      .build(),
  );
  if (link === undefined) return null;
  const party = partyOf(link.party_member_id, link.party_staff_id);
  // 자리 행을 못 찾으면(소명 표는 아직 없다) 당사자가 없는 것으로 본다 — 판정은 올린 사람·운영자만 남는다
  const nobody: AttachmentParty = { type: "staff", staffAccountId: "" };
  switch (link.owner_kind as AttachmentOwnerKind) {
    case "inquiry_message":
      return {
        ownerKind: "inquiry_message",
        asker: party ?? nobody,
        // 문의를 못 찾으면 받는 쪽이 없는 학원 문의로 본다 — 운영자에게 열리지 않게 닫는 쪽으로
        inquiryKind: (link.inquiry_kind === "" ? "academy" : link.inquiry_kind) as InquiryKind,
        academyId: link.academy_id === "" ? null : link.academy_id,
      };
    case "report":
      return { ownerKind: "report", reporter: party ?? nobody };
    case "restriction_explanation":
      return { ownerKind: "restriction_explanation", explainer: party ?? nobody };
  }
}
