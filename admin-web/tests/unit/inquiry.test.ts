// S7-2.2(문의 생성과 조회 권한) — lib/domain/inquiry.ts 의 순수 규칙(종류 칩 짝 · 첫 답 기한 · 답변 대기 표시 · 미리보기)
import { describe, expect, test } from "vitest";

import { createHolidayCalendar } from "../../lib/domain/business-days";
import { INQUIRY_CATEGORIES } from "../../lib/domain/constants";
import {
  INQUIRY_CATEGORY_LABELS,
  allowedInquiryCategories,
  inquiryDueLabel,
  inquiryFirstResponseDueAt,
  inquiryPreview,
  inquiryWaitingNotice,
  isInquiryCategoryAllowed,
  isInquiryWaitingOverdue,
} from "../../lib/domain/inquiry";

const noHolidays = createHolidayCalendar([]);

describe("종류 칩 짝(계약 15 §2-1)", () => {
  test("회원→학원은 수업·환불·일정·기타, 「결석」은 강사 칩이라 안 된다", () => {
    expect(allowedInquiryCategories("member", "academy")).toEqual(["class", "refund", "schedule", "other"]);
    expect(isInquiryCategoryAllowed("member", "academy", "absence")).toBe(false);
  });
  test("강사→학원은 정산 근거·정원·결석(D10)·기타, 환불은 안 된다", () => {
    expect(isInquiryCategoryAllowed("instructor", "academy", "absence")).toBe(true);
    expect(isInquiryCategoryAllowed("instructor", "academy", "refund")).toBe(false);
  });
  test("멤버십은 회원의 시스템 문의에만, 대표→학원 짝은 없다", () => {
    expect(isInquiryCategoryAllowed("member", "system", "membership")).toBe(true);
    expect(isInquiryCategoryAllowed("owner", "system", "membership")).toBe(false);
    expect(isInquiryCategoryAllowed("instructor", "system", "payment_outage")).toBe(false);
    expect(allowedInquiryCategories("owner", "academy")).toEqual([]);
  });
});

describe("첫 답 기한 — 다음 영업일 23:59:59 KST", () => {
  test("금요일 15:00 접수 → 월요일 끝(계약 예시 14:59:59Z)", () => {
    const due = inquiryFirstResponseDueAt(Temporal.Instant.from("2026-11-20T06:00:00Z"), noHolidays);
    expect(due.toString()).toBe("2026-11-23T14:59:59Z");
  });
  test("토요일 밤 접수도 월요일 끝 · 월요일이 공휴일이면 화요일 끝", () => {
    const saturdayNight = Temporal.Instant.from("2026-11-21T14:00:00Z"); // 11-21(토) 23:00 KST
    expect(inquiryFirstResponseDueAt(saturdayNight, noHolidays).toString()).toBe("2026-11-23T14:59:59Z");
    const mondayHoliday = createHolidayCalendar([{ date: Temporal.PlainDate.from("2026-11-23") }]);
    expect(inquiryFirstResponseDueAt(saturdayNight, mondayHoliday).toString()).toBe("2026-11-24T14:59:59Z");
  });
  test("KST 자정 직후(UTC 로는 전날) 접수는 KST 날짜로 센다", () => {
    const justAfterMidnight = Temporal.Instant.from("2026-11-18T15:30:00Z"); // 11-19(목) 00:30 KST
    expect(inquiryFirstResponseDueAt(justAfterMidnight, noHolidays).toString()).toBe("2026-11-20T14:59:59Z");
  });
  test("안내 문구에 날짜와 요일을 적는다", () => {
    expect(inquiryWaitingNotice(Temporal.Instant.from("2026-11-23T14:59:59Z"))).toBe("1영업일 안에 답해요 · 11월 23일(월)까지");
  });
});

describe("답변 대기 중 표시 · 미리보기", () => {
  const due = Temporal.Instant.from("2026-11-23T14:59:59Z");
  test("답이 없고 기한을 넘겼을 때만 참", () => {
    expect(isInquiryWaitingOverdue({ status: "answer_waiting", firstResponseDueAt: due }, Temporal.Instant.from("2026-11-23T14:59:59Z"))).toBe(false);
    expect(isInquiryWaitingOverdue({ status: "answer_waiting", firstResponseDueAt: due }, Temporal.Instant.from("2026-11-23T15:00:00Z"))).toBe(true);
    expect(isInquiryWaitingOverdue({ status: "answered", firstResponseDueAt: due }, Temporal.Instant.from("2026-11-30T00:00:00Z"))).toBe(false);
  });
  test("미리보기는 줄바꿈을 접고 40자에서 자른다", () => {
    expect(inquiryPreview("첫 줄\n둘째 줄")).toBe("첫 줄 둘째 줄");
    const long = "가".repeat(45);
    expect(inquiryPreview(long)).toBe(`${"가".repeat(40)}…`);
  });
});

// S7-2.3(답변과 응답 기한 재알림) — 알림 제목·본문에 쓰는 글자
describe("알림 글자(S7-2.3)", () => {
  test("종류 칩마다 화면 글자가 있다(계약 15 §2-1)", () => {
    expect(Object.keys(INQUIRY_CATEGORY_LABELS).sort()).toEqual([...INQUIRY_CATEGORIES].sort());
    expect(INQUIRY_CATEGORY_LABELS.refund).toBe("환불 요청");
    expect(INQUIRY_CATEGORY_LABELS.absence).toBe("결석");
  });
  test("기한 글자는 KST 날짜와 요일 — 14:59:59Z 는 같은 날 23:59:59 KST", () => {
    expect(inquiryDueLabel(Temporal.Instant.from("2026-11-23T14:59:59Z"))).toBe("11월 23일(월)");
    expect(inquiryDueLabel(Temporal.Instant.from("2026-11-24T15:00:00Z"))).toBe("11월 25일(수)");
  });
});
