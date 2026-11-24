// S7-4.9e(공휴일 화면(P9)) — 화면 글자·입력 검사 순수 함수
import { describe, expect, it } from "vitest";

import { addFormProblems, rowDateLabel, syncBannerText, yearOptions } from "../../lib/admin-holidays-form";

describe("공휴일 화면 글자", () => {
  it("표 날짜는 연도를 빼고 요일을 붙인다", () => {
    expect(rowDateLabel("2027-02-09", "화")).toBe("02-09 (화)");
  });

  it("수집 날이 오늘(KST)이면 「오늘 03:00」, 아니면 날짜로 적는다", () => {
    const lastSync = { ranAt: "2026-11-23T18:00:00Z", status: "success" as const, source: "공공데이터포털 특일 정보" };
    // 2026-11-24 03:00 KST 에 돈 수집을 같은 날 10:00 KST 에 본다
    expect(syncBannerText(lastSync, "2026-11-24T01:00:00Z")).toBe("마지막 자동 수집 오늘 03:00 · 성공 · 공공데이터포털 특일 정보");
    expect(syncBannerText({ ...lastSync, status: "failed" }, "2026-11-26T01:00:00Z")).toBe(
      "마지막 자동 수집 11-24 03:00 · 실패 · 공공데이터포털 특일 정보",
    );
  });

  it("수집 기록이 없으면 그렇다고 적는다", () => {
    expect(syncBannerText(null, "2026-11-24T01:00:00Z")).toContain("아직 자동 수집 기록이 없어요");
  });

  it("연도 고르기는 올해 앞 1년 ~ 뒤 2년, 주소로 연 연도도 넣는다", () => {
    expect(yearOptions(2026, 2027)).toEqual([2025, 2026, 2027, 2028]);
    expect(yearOptions(2026, 2031)).toEqual([2025, 2026, 2027, 2028, 2031]);
  });

  it("더하기 카드 빈칸·길이 검사", () => {
    expect(addFormProblems({ date: "2027-05-06", name: "임시 휴일", kind: "temporary_holiday" })).toEqual([]);
    expect(addFormProblems({ date: "", name: "  ", kind: "" })).toEqual(["날짜를 골라 주세요", "이름을 넣어 주세요", "종류를 골라 주세요"]);
    expect(addFormProblems({ date: "2027-05-06", name: "가".repeat(41), kind: "holiday" })).toEqual(["이름은 40자까지 넣을 수 있어요"]);
  });
});
