// S1-2.14(관리자 웹 강사·소속 화면 W3a) — 강사 관리 화면의 순수 함수(승인 본문 · 위임 토글 · 비율 글자).
import { describe, expect, test } from "vitest";

import { buildApproveBody, percentLabel, togglePermission } from "../../lib/instructors-form";

describe("togglePermission — 누른 하나만 뒤집고 나머지는 그대로", () => {
  test("꺼진 예약·명단을 켜면 더해진다", () => {
    expect(togglePermission([], "roster_manage")).toEqual(["roster_manage"]);
  });
  test("앱 수업 등록 권한(class_submit)은 웹 토글을 눌러도 남는다", () => {
    expect(togglePermission(["roster_manage", "class_submit"], "roster_manage")).toEqual(["class_submit"]);
    expect(togglePermission(["class_submit"], "class_manage")).toEqual(["class_manage", "class_submit"]);
  });
  test("순서는 계약 enum 순서(roster_manage → class_manage → class_submit)", () => {
    expect(togglePermission(["class_manage"], "roster_manage")).toEqual(["roster_manage", "class_manage"]);
  });
});

describe("buildApproveBody — 승인 본문(08 §3)", () => {
  test("프리랜서 60 → shareRateBp 6000", () => {
    expect(buildApproveBody({ employment: "freelancer", ratePercent: " 60 " })).toEqual({
      ok: true,
      body: { isAcademyEmployee: false, shareRateBp: 6000 },
    });
  });
  test("경계 0·100 은 받는다", () => {
    expect(buildApproveBody({ employment: "freelancer", ratePercent: "0" })).toMatchObject({ ok: true, body: { shareRateBp: 0 } });
    expect(buildApproveBody({ employment: "freelancer", ratePercent: "100" })).toMatchObject({ ok: true, body: { shareRateBp: 10000 } });
  });
  test("비우면 못 보낸다 — 기본값 없음(결정 11)", () => {
    expect(buildApproveBody({ employment: "freelancer", ratePercent: "" })).toEqual({ ok: false, reason: "강사 몫 비율을 넣어 주세요" });
  });
  test("101 · 소수 · 글자는 못 보낸다", () => {
    for (const ratePercent of ["101", "55.5", "육십", "-1"]) {
      expect(buildApproveBody({ employment: "freelancer", ratePercent }).ok).toBe(false);
    }
  });
  test("학원 직원은 비율 칸을 아예 보내지 않는다(보내면 422)", () => {
    expect(buildApproveBody({ employment: "employee", ratePercent: "60" })).toEqual({ ok: true, body: { isAcademyEmployee: true } });
  });
});

test("percentLabel — bp 를 % 글자로", () => {
  expect(percentLabel(6000)).toBe("60%");
  expect(percentLabel(5550)).toBe("55.5%");
});
