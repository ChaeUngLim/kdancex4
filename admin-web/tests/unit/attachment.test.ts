// S7-2.7(문의·신고 첨부 파일) — 첨부 열람 규칙 canOpenAttachment 를 표로 확인한다(DB 없음).
import { describe, expect, test } from "vitest";

import { canOpenAttachment, type AttachmentPlace, type AttachmentViewer } from "@/lib/domain/attachment";

const seoa: AttachmentViewer = { type: "member", memberId: "m-seoa" };
const other: AttachmentViewer = { type: "member", memberId: "m-other" };
const ownerA: AttachmentViewer = { type: "staff", staffAccountId: "s-ownerA", roles: ["owner"], ownedAcademyIds: ["academy-A"] };
const ownerB: AttachmentViewer = { type: "staff", staffAccountId: "s-ownerB", roles: ["owner"], ownedAcademyIds: ["academy-B"] };
const operator: AttachmentViewer = { type: "staff", staffAccountId: "s-admin", roles: ["admin"], ownedAcademyIds: [] };
const instructor: AttachmentViewer = { type: "staff", staffAccountId: "s-junho", roles: ["instructor"], ownedAcademyIds: [] };

const seoaUploads = { type: "member", memberId: "m-seoa" } as const;
const academyInquiry: AttachmentPlace = { ownerKind: "inquiry_message", asker: seoaUploads, inquiryKind: "academy", academyId: "academy-A" };
const systemInquiry: AttachmentPlace = { ownerKind: "inquiry_message", asker: seoaUploads, inquiryKind: "system", academyId: null };
const report: AttachmentPlace = { ownerKind: "report", reporter: seoaUploads };

const open = (viewer: AttachmentViewer, place: AttachmentPlace | null, uploader: Parameters<typeof canOpenAttachment>[0]["uploader"] = seoaUploads) =>
  canOpenAttachment({ viewer, uploader, place });

describe("canOpenAttachment — 당사자와 받는 쪽만(S7-2.7)", () => {
  test.each([
    ["문의자", seoa, true],
    ["그 학원 대표", ownerA, true],
    ["다른 학원 대표", ownerB, false],
    ["다른 회원", other, false],
    ["운영자(학원 문의는 받지 않는다 — FR-204)", operator, false],
    ["강사", instructor, false],
  ])("학원 문의 첨부 — %s → %s", (_label, viewer, expected) => {
    expect(open(viewer, academyInquiry)).toBe(expected);
  });

  test.each([
    ["문의자", seoa, true],
    ["운영자", operator, true],
    ["학원 대표", ownerA, false],
  ])("시스템 문의 첨부 — %s → %s", (_label, viewer, expected) => {
    expect(open(viewer, systemInquiry)).toBe(expected);
  });

  test.each([
    ["신고자", seoa, true],
    ["운영자", operator, true],
    ["신고받은 학원의 대표", ownerA, false],
    ["다른 회원", other, false],
  ])("신고 첨부 — %s → %s", (_label, viewer, expected) => {
    expect(open(viewer, report)).toBe(expected);
  });

  test("대표가 답변에 붙인 파일 — 올린 대표 본인과 문의자는 연다", () => {
    const ownerUploads = { type: "staff", staffAccountId: "s-ownerA" } as const;
    const ownerOnly: AttachmentViewer = { ...ownerA, ownedAcademyIds: [] }; // 대표에서 물러났어도 올린 사람은 연다
    expect(open(ownerOnly, academyInquiry, ownerUploads)).toBe(true);
    expect(open(seoa, academyInquiry, ownerUploads)).toBe(true);
    expect(open(ownerB, academyInquiry, ownerUploads)).toBe(false);
  });

  test("안 붙은 첨부 — 올린 사람만(운영자도 못 연다)", () => {
    expect(open(seoa, null)).toBe(true);
    expect(open(operator, null)).toBe(false);
    expect(open(ownerA, null)).toBe(false);
  });

  test("회원 번호와 직원 번호가 같은 글자여도 다른 사람이다", () => {
    const clash: AttachmentViewer = { type: "staff", staffAccountId: "m-seoa", roles: [], ownedAcademyIds: [] };
    expect(open(clash, report)).toBe(false);
  });
});
