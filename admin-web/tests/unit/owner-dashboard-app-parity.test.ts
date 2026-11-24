// S1-4.9(대표 앱 홈 화면 O6) — 「앱 대시보드가 웹과 같은 숫자를 보인다」를 확인하는 비교 테스트.
//   같은 대시보드 응답(계약 10 §1)을 웹 글자 함수(lib/owner-dashboard-view.ts)와
//   앱 글자 함수(mobile/lib/owner/dashboard-view.ts)에 넣고, 타일 7개·날짜·할 일 안내 글자가 하나도 다르지 않은지 본다.
//   앱 파일은 휴대폰 엔진 때문에 Temporal·Intl 없이 따로 적었다. 두 파일이 나중에 어긋나면 이 테스트가 먼저 깨진다.
import { describe, expect, test } from "vitest";

import * as app from "../../../mobile/lib/owner/dashboard-view";
import { unavailableDashboardTiles } from "../../lib/domain/owner-dashboard";
import * as web from "../../lib/owner-dashboard-view";
import type { OwnerDashboard } from "../../lib/server/services/owner-dashboard";

const KEYS: web.DashboardTileKey[] = ["todayOrders", "refundRequests", "pendingClassApprovals", "nearlyFull", "month", "nextPayout", "sessions"];

/** M1 지금 모습 — 타일 7개 전부 준비 전 */
const m1: OwnerDashboard = {
  academyId: "0193a1b2-0000-7000-8000-000000000001",
  date: "2026-11-21",
  ...unavailableDashboardTiles(),
  todos: [
    { kind: "terms_change_notice", title: "입점 약관 1.1 · 12월 10일 적용", dueAt: "2026-12-09T15:30:00Z", link: "/settings#terms" },
    { kind: "affiliation_requested", title: "아이유 강사 소속 신청", dueAt: null, link: "/staff/instructors?status=pending" },
  ],
};

/** S3-5.6 이 채운 항목 모양 — 화면 글자 함수는 줄 수만 센다 */
const NEARLY_FULL_ITEM = {
  offeringId: "0193a1b2-0000-7000-8000-0000000000a1",
  classId: "0193a1b2-0000-7000-8000-0000000000b1",
  classTitle: "쌈바(입문)",
  offeringLabel: "12/01~12/29 · 5회",
  seatKind: "male" as const,
  capacity: 10,
  remaining: 2,
  firstSessionStartsAt: "2026-12-01T11:30:00Z",
};
const SESSION_ITEM = {
  sessionId: "0193a1b2-0000-7000-8000-0000000000c1",
  classId: "0193a1b2-0000-7000-8000-0000000000b1",
  title: "쌈바(입문)",
  startsAt: "2026-11-21T11:30:00Z",
  endsAt: "2026-11-21T12:30:00Z",
  instructor: { displayName: "이준호" },
  roomName: "A홀",
  seats: [{ seatKind: "any" as const, capacity: 20, confirmed: 13, absencePlanned: 1, onsite: 1, present: 13 }],
  absencePlanned: 1,
};

/** 뒤 슬라이스가 채운 뒤의 모습 — 큰 금액(쉼표), null 칸(「—」), 0(진짜 0건)을 섞었다 */
const filled: OwnerDashboard = {
  ...m1,
  todayOrders: { available: true, availableFrom: null, applications: 12, paidCount: 0, paidAmount: 1234567, awaitingDeposit: null },
  refundRequests: { available: true, availableFrom: null, regular: 2, event: null, overdue: 0 },
  pendingClassApprovals: { available: true, availableFrom: null, count: 1, top: null },
  nearlyFull: { available: true, availableFrom: null, items: [NEARLY_FULL_ITEM, { ...NEARLY_FULL_ITEM, seatKind: "female", remaining: 1 }] },
  month: { available: true, availableFrom: null, revenue: 4820000, paymentsCount: 37, settlement: { completed: null, scheduled: null, hold: null } },
  nextPayout: { available: true, availableFrom: null, date: "2026-12-05", expectedNet: null, instructorPayoutPending: null },
  sessions: { available: true, availableFrom: null, today: [SESSION_ITEM, { ...SESSION_ITEM, title: "바차타(초급)" }], tomorrow: [] },
  newMembers: { available: true, availableFrom: null, count: 3 },
};

describe("웹·앱 대시보드 글자가 같다", () => {
  test.each(KEYS)("준비 전 %s — 「준비 중」 안내가 같고 숫자가 없다", (key) => {
    const a = app.dashboardTileView(m1, key);
    expect(a).toEqual(web.dashboardTileView(m1, key));
    expect(a.ready).toBe(false);
  });

  test.each(KEYS)("채워진 %s — 숫자 글자가 같다(쉼표·단위·「—」·0)", (key) => {
    expect(app.dashboardTileView(filled, key)).toEqual(web.dashboardTileView(filled, key));
  });

  test("채워진 타일의 실제 글자 예 — 앱 화면이 이 글자를 그린다", () => {
    expect(app.dashboardTileView(filled, "month")).toMatchObject({ headline: "4,820,000원", detail: "결제 37건" });
    expect(app.dashboardTileView(filled, "refundRequests")).toMatchObject({ headline: "—", detail: "정규 2 · 이벤트형 — · 기한 지남 0" });
    expect(app.dashboardTileView(filled, "todayOrders")).toMatchObject({ headline: "12건 · 0건", detail: "결제 1,234,567원 · 입금 대기 —" });
  });

  test("날짜 줄과 할 일 안내가 같다(KST 자정 넘김 포함)", () => {
    for (const date of ["2026-11-21", "2026-01-01", "2028-02-29"]) {
      expect(app.dashboardDateLabel(date)).toBe(web.dashboardDateLabel(date));
    }
    for (const todo of m1.todos) {
      expect(app.dashboardTodoNote(todo)).toBe(web.dashboardTodoNote(todo));
    }
    // 2026-12-09T15:30Z 는 KST 로 12월 10일 00:30 — 웹과 앱 모두 「12월 10일」
    expect(app.dashboardTodoNote(m1.todos[0]!)).toBe("12월 10일까지 확인해 주세요");
  });

  test("타일 제목·준비 중 안내 표가 글자 그대로 같다", () => {
    expect(app.DASHBOARD_TILE_TITLES).toEqual(web.DASHBOARD_TILE_TITLES);
    expect(app.DASHBOARD_PENDING_NOTES).toEqual(web.DASHBOARD_PENDING_NOTES);
  });
});
