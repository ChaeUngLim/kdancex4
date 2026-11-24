// S1-4.8(관리자 웹 대시보드 화면 W29) — 대시보드 응답을 화면 글자로 바꾸는 순수 함수.
//   핵심: 준비 안 된 타일은 숫자(0 포함)를 만들지 않고 「준비 중」만 돌려준다(계약 10 §1 · 열린 점 ②).
import { describe, expect, test } from "vitest";

import { unavailableDashboardTiles } from "../../lib/domain/owner-dashboard";
import {
  dashboardDateLabel,
  dashboardTileView,
  dashboardTodoHref,
  dashboardTodoNote,
  type DashboardTileKey,
} from "../../lib/owner-dashboard-view";
import type { OwnerDashboard } from "../../lib/server/services/owner-dashboard";

const ACADEMY = "0193a1b2-0000-7000-8000-000000000001";
const KEYS: DashboardTileKey[] = ["todayOrders", "refundRequests", "pendingClassApprovals", "nearlyFull", "month", "nextPayout", "sessions"];

function m1Dashboard(): OwnerDashboard {
  return { academyId: ACADEMY, date: "2026-11-21", ...unavailableDashboardTiles(), todos: [] };
}

describe("dashboardTileView — 준비 안 된 타일", () => {
  test.each(KEYS)("%s 는 ready=false · 「준비 중」 안내만 있고 숫자가 없다", (key) => {
    const view = dashboardTileView(m1Dashboard(), key);
    expect(view.ready).toBe(false);
    expect(view).not.toHaveProperty("headline");
    if (!view.ready) expect(view.pendingNote).not.toMatch(/\d/);
  });
});

describe("dashboardTileView — 준비된 타일(각 슬라이스가 채운 뒤)", () => {
  test("숫자는 원·건 단위로, null 은 0 이 아니라 「—」", () => {
    const d = m1Dashboard();
    const filled: OwnerDashboard = {
      ...d,
      todayOrders: { available: true, availableFrom: null, applications: 6, paidCount: 4, paidAmount: 324000, awaitingDeposit: null },
    };
    expect(dashboardTileView(filled, "todayOrders")).toEqual({
      key: "todayOrders",
      title: "오늘 신청 · 결제",
      ready: true,
      headline: "6건 · 4건",
      detail: "결제 324,000원 · 입금 대기 —",
    });
  });
});

describe("날짜·할 일 글자", () => {
  test("요일을 붙인다(2026-11-21 은 토요일, 2026-11-11 은 수요일)", () => {
    expect(dashboardDateLabel("2026-11-21")).toBe("2026-11-21 (토)");
    expect(dashboardDateLabel("2026-11-11")).toBe("2026-11-11 (수)");
  });
  test("할 일 주소는 실제 학원별 화면으로", () => {
    const affiliation = { kind: "affiliation_requested" as const, title: "아이유 강사 소속 신청", dueAt: null, link: "/staff/instructors?status=pending" };
    const terms = { kind: "terms_change_notice" as const, title: "입점 약관 1.1 · 12월 10일 적용", dueAt: "2026-12-09T15:00:00Z", link: "/settings#terms" };
    expect(dashboardTodoHref(ACADEMY, affiliation)).toBe(`/academies/${ACADEMY}/instructors`);
    expect(dashboardTodoHref(ACADEMY, terms)).toBe(`/academies/${ACADEMY}/settings#terms`);
    expect(dashboardTodoNote(affiliation)).toBe("확인하고 승인하거나 거절해 주세요");
    // 기한은 KST 달력 날짜로 읽는다 — UTC 15:00 은 KST 다음 날 0시
    expect(dashboardTodoNote(terms)).toBe("12월 10일까지 확인해 주세요");
  });
});
