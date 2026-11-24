// S1-4.7(관리자 웹 학원 공지 화면 W5) — 화면 규칙(보내기 전 검사 · 요청 본문 · 지난 공지 한 줄 · 받는 사람 줄)을 브라우저 없이 확인한다.
import { describe, expect, test } from "vitest";

import { buildNoticeBody, checkForm, hasProblems, noticeMetaLine, recipientsLine } from "../../lib/staff-notices-form";

describe("학원 공지 화면 규칙", () => {
  test("제목·내용이 비면 막고, 앞뒤 공백만 있어도 빈 것으로 본다", () => {
    const problems = checkForm({ category: "other", title: "   ", body: "" });
    expect(problems).toEqual({ title: "제목을 적어 주세요", body: "내용을 적어 주세요" });
    expect(hasProblems(problems)).toBe(true);
  });

  test("제목은 공백을 뺀 100자까지 — 101자는 막는다", () => {
    expect(checkForm({ category: "other", title: ` ${"가".repeat(100)} `, body: "본문" })).toEqual({});
    expect(checkForm({ category: "other", title: "가".repeat(101), body: "본문" }).title).toBe("제목은 100자까지 쓸 수 있어요");
  });

  test("요청 본문은 공백을 정리하고, 바로 올리기일 때만 publish:true 를 붙인다", () => {
    const form = { category: "class_cancelled" as const, title: " 휴강 ", body: " 내용 " };
    expect(buildNoticeBody(form, false)).toEqual({ category: "class_cancelled", title: "휴강", body: "내용" });
    expect(buildNoticeBody(form, true)).toEqual({ category: "class_cancelled", title: "휴강", body: "내용", publish: true });
  });

  test("지난 공지 한 줄 — KST 날짜 · 보낸 수, 읽은 사람이 있을 때만 읽음 수", () => {
    // 2026-11-08T16:00Z 는 KST 11월 9일 01시
    expect(noticeMetaLine({ publishedAt: "2026-11-08T16:00:00Z", recipientCount: 3, readCount: 0 })).toBe("11월 9일 · 강사 3명에게 보냄");
    expect(noticeMetaLine({ publishedAt: "2026-11-08T16:00:00Z", recipientCount: 3, readCount: 2 })).toBe(
      "11월 9일 · 강사 3명에게 보냄 · 2명 읽음",
    );
  });

  test("받는 사람 줄 — 3명까지 이름, 넘치면 「외 N명」, 0명이면 올릴 수 없다는 안내", () => {
    expect(recipientsLine("라틴하우스 강남", ["이준호", "김하나", "박서윤"])).toBe("라틴하우스 강남 소속 강사 3명 · 이준호 · 김하나 · 박서윤");
    expect(recipientsLine("라틴하우스 강남", ["가", "나", "다", "라", "마"])).toBe("라틴하우스 강남 소속 강사 5명 · 가 · 나 · 다 외 2명");
    expect(recipientsLine("라틴하우스 강남", [])).toContain("소속 강사가 있어야 올릴 수 있어요");
  });
});
