// S7-2.10(대표 앱 문의함 화면 O22) — 대표 앱 문의함 글자 함수(mobile/lib/owner/inquiries-view.ts)가 보드 O22 문구대로 나오고,
//   칩 값·종류 글자·대표→운영자 칩이 서버 표(계약 15 §2-1·§2-4, admin-web 도메인 상수)와 어긋나지 않는지 본다.
import { describe, expect, test } from "vitest";

import { INQUIRY_BODY_MAX, INQUIRY_CATEGORY_LABELS, isInquiryCategoryAllowed } from "@/lib/domain/inquiry";
import { OWNER_INQUIRY_FILTERS } from "@/lib/server/schemas/inquiries";
import * as v from "../../../mobile/lib/owner/inquiries-view";

const base: v.OwnerInquiryItem = {
  inquiryId: "i1", category: "refund", origin: "member", askerLabel: "살사러버", context: "바차타 센슈얼 입문",
  preview: "개인 사정으로 2회차부터 못 나가요. 환불 가능할까요?", status: "answer_waiting",
  createdAt: "2026-11-24T00:31:00Z", firstResponseDueAt: "2026-11-25T14:59:59Z", overdue: false, refundRequestId: null, route: "human",
};

describe("대표 앱 문의함 글자(보드 O22)", () => {
  test("칩 — 보드 순서 그대로이고 값은 서버 filter 와 같다", () => {
    expect(v.OWNER_INQUIRY_CHIPS.map((c) => c.label)).toEqual(["전체", "답변 대기", "환불 요청", "사람 요청", "답변 완료"]);
    expect(v.OWNER_INQUIRY_CHIPS.map((c) => c.key)).toEqual([...OWNER_INQUIRY_FILTERS]);
  });

  test("주소 — 전체는 filter 를 붙이지 않고, 커서·id 는 주소용으로 감싼다", () => {
    expect(v.ownerInquiriesPath("a1", "all")).toBe("/api/academies/a1/inquiries");
    expect(v.ownerInquiriesPath("a1", "waiting", "x+y/z")).toBe("/api/academies/a1/inquiries?filter=waiting&cursor=x%2By%2Fz");
    expect(v.ownerInquiryReplyPath("a1", "i1")).toBe("/api/academies/a1/inquiries/i1/replies");
  });

  test("태그 — 사람 이관이 종류보다 먼저, 환불은 빨간 계열, 종류 글자는 서버 표와 같다", () => {
    expect(v.inquiryTag(base)).toEqual({ text: "환불 요청", tone: "refund" });
    expect(v.inquiryTag({ category: "class", route: "ai_handoff" })).toEqual({ text: "사람 요청", tone: "human" });
    for (const [category, label] of Object.entries(INQUIRY_CATEGORY_LABELS)) {
      expect(v.categoryLabel(category as v.OwnerInquiryCategory)).toBe(label);
    }
  });

  test("제목 — 「닉네임 · 수업」, 수업이 없는 강사 문의는 「· 소속 강사」", () => {
    expect(v.inquiryTitle(base)).toBe("살사러버 · 바차타 센슈얼 입문");
    expect(v.inquiryTitle({ askerLabel: "오세린", context: null, origin: "instructor" })).toBe("오세린 · 소속 강사");
  });

  test("상태 — 답변 대기 · 기한 지남 · AI 답변 완료 · 답변 완료, 닫힌 문의는 답하기 없음", () => {
    expect(v.inquiryStatusBadge(base)).toEqual({ text: "답변 대기", tone: "waiting" });
    expect(v.inquiryStatusBadge({ status: "answer_waiting", overdue: true })).toEqual({ text: "답변 대기 · 기한 지남", tone: "overdue" });
    expect(v.inquiryStatusBadge({ status: "ai_answered", overdue: false }).text).toBe("AI 답변 완료");
    expect(v.inquiryStatusBadge({ status: "answered", overdue: false }).text).toBe("답변 완료");
    expect(v.canReply({ status: "closed" })).toBe(false);
    expect(v.canReply({ status: "answered" })).toBe(true);
  });

  test("접수 시각 — KST 기준 오늘 09:31 · 어제 · 그 앞은 월/일", () => {
    const now = new Date("2026-11-24T05:00:00Z"); // 11-24 14:00 KST
    expect(v.receivedLabel("2026-11-24T00:31:00Z", now)).toBe("오늘 09:31");
    expect(v.receivedLabel("2026-11-23T14:59:00Z", now)).toBe("어제"); // 11-23 23:59 KST
    expect(v.receivedLabel("2026-11-23T15:00:00Z", now)).toBe("오늘 00:00");
    expect(v.receivedLabel("2026-11-20T06:00:00Z", now)).toBe("11/20");
  });

  test("대화 말머리 · 글 상한 · 운영자 문의 칩이 서버 규칙과 같다", () => {
    expect(v.senderLabel("academy_owner", "살사러버")).toBe("내 답변");
    expect(v.senderLabel("asker", "살사러버")).toBe("살사러버");
    expect(v.senderLabel("operator", "")).toBe("운영팀");
    expect(v.REPLY_MAX_LENGTH).toBe(INQUIRY_BODY_MAX);
    for (const category of v.OWNER_SYSTEM_CATEGORIES) {
      expect(isInquiryCategoryAllowed("owner", "system", category as never)).toBe(true);
    }
  });
});
