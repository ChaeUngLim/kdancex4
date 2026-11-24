// S3-5.9c(대표 앱 현장 등록·주문 화면) — 대표 앱 글자 함수(mobile/lib/owner/headcount-view.ts · orders-view.ts)가
//   보드 O6 · O40 · O45 문구대로 나오는지, 현장 인원 칸이 0 아래·정원 위로 가지 않는지 본다.
//   응답 모양은 계약 18 §7(하루 인원표)·§2(주문 목록) 예시를 썼다.
import { describe, expect, test } from "vitest";

import * as hc from "../../../mobile/lib/owner/headcount-view";
import * as orders from "../../../mobile/lib/owner/orders-view";
import type { HeadcountClassItem } from "../../../mobile/lib/instructor/headcount-api";

const academy = { id: "a1", name: "라틴하우스 강남" };
const bachata: HeadcountClassItem = {
  kind: "class", classId: "c1", sessionId: "s1", startsAt: "2026-11-13T10:30:00Z", endsAt: "2026-11-13T11:30:00Z",
  title: "바차타 센슈얼 입문", academy, roomName: "A홀", instructor: { displayName: "이준호" }, seatMode: "gender_split",
  seats: [
    { seatKind: "male", capacity: 10, confirmed: 6, absencePlanned: 1, onsite: 0, present: 5, remaining: 4 },
    { seatKind: "female", capacity: 10, confirmed: 7, absencePlanned: 0, onsite: 1, present: 8, remaining: 2 },
  ],
  absence: { male: 1, female: 0 },
};
const single: HeadcountClassItem = {
  ...bachata, classId: "c2", sessionId: "s2", startsAt: "2026-11-13T12:30:00Z", endsAt: "2026-11-13T13:30:00Z", title: "라인댄스",
  roomName: null, instructor: null, seatMode: "single",
  seats: [{ seatKind: "any", capacity: 20, confirmed: 3, absencePlanned: 0, onsite: 0, present: 3, remaining: 17 }], absence: { any: 0 },
};
const ended: HeadcountClassItem = { ...bachata, sessionId: "s0", startsAt: "2026-11-13T01:00:00Z", endsAt: "2026-11-13T02:00:00Z", title: "아침 살사" };
const headcount: hc.OwnerHeadcount = {
  date: "2026-11-13",
  summary: { classCount: 3, privateLessonCount: 1, present: { male: 10, female: 17, total: 30 }, absencePlanned: 2 },
  items: [
    ended,
    { kind: "private_lesson", bookingId: "b1", startsAt: "2026-11-13T09:00:00Z", endsAt: "2026-11-13T09:50:00Z", title: "개인 레슨 · 1:1",
      academy, roomName: "연습실", student: { nickname: "김서연", gender: "female", awaitingPayment: false }, present: { male: 0, female: 1 }, absencePlanned: 0 },
    bachata,
    single,
  ],
};

describe("O6 오늘 우리 학원 수업 표", () => {
  test("줄 — 시간(KST) · 수업 · 강사·홀 · 남 · 여(오늘 인원) · 결석, 단일 정원은 남·여 「—」", () => {
    const rows = hc.todayRows(headcount);
    expect(rows[2]).toEqual({ key: "class-s1", time: "19:30", title: "바차타 센슈얼 입문", sub: "이준호 · A홀", male: "5", female: "8", absence: 1 });
    expect(rows[1]).toMatchObject({ time: "18:00", title: "개인 레슨 · 1:1", sub: "김서연 · 연습실", male: "0", female: "1" });
    expect(rows[3]).toMatchObject({ title: "라인댄스", sub: "", male: "—", female: "—", absence: 0 });
  });

  test("합계 줄과 날짜 글자", () => {
    expect(hc.todaySummaryLine(headcount)).toBe("수업 3 · 개인 레슨 1 · 참석 30 (남 10 · 여 17) · 결석 예정 2");
    expect(hc.shortDateLabel("2026-11-13")).toBe("11/13 (금)");
    expect(hc.ownerHeadcountPath("a 1")).toBe("/api/academies/a%201/headcount");
  });
});

describe("O40 현장 등록", () => {
  const now = new Date("2026-11-13T05:00:00Z"); // 14:00 KST

  test("목록 — 끝난 회차·개인 레슨은 빼고 남은 단체 회차만", () => {
    expect(hc.onsiteSessions(headcount, now).map((i) => i.title)).toEqual(["바차타 센슈얼 입문", "라인댄스"]);
  });

  test("줄 글자 — 보드 「정원 남 10 · 여 10 · 앱 예약 남 6 · 여 7」 「남은 자리 남 4 · 여 2 (현장 남 0 · 여 1 포함)」", () => {
    expect(hc.capacityLine(bachata)).toBe("정원 남 10 · 여 10 · 앱 예약 남 6 · 여 7");
    expect(hc.remainingLine(bachata, {})).toBe("남은 자리 남 4 · 여 2 (현장 남 0 · 여 1 포함)");
    // 여자 현장을 3 으로 고치면 남은 자리가 바로 줄어든다(저장 전)
    expect(hc.remainingLine(bachata, { s1: { female: "3" } })).toBe("남은 자리 남 4 · 여 0 (현장 남 0 · 여 3 포함)");
  });

  test("칸 값 — 빈 칸은 0, 숫자 아닌 글자는 버림, 상한 = 현장 + 남은 자리, 0 아래·상한 위로 자른다", () => {
    expect(hc.initialOnsiteText(0)).toBe("");
    expect(hc.initialOnsiteText(2)).toBe("2");
    expect(hc.onsiteValue("")).toBe(0);
    expect(hc.onsiteValue("-3a")).toBe(3);
    expect(hc.maxOnsite(bachata, "female")).toBe(3);
    expect(hc.maxOnsite(bachata, "male")).toBe(4);
    expect(hc.clampOnsite(-1, 3)).toBe(0);
    expect(hc.clampOnsite(9, 3)).toBe(3);
  });

  test("저장할 것 — 바뀐 회차만, 정원 방식에 맞는 칸을 통째로, 입력 상태는 바꾸지 않는다", () => {
    const draft: hc.OnsiteDraft = { s1: { male: "2" } };
    const next = hc.withDraft(draft, "s2", "any", "4");
    expect(draft).toEqual({ s1: { male: "2" } });
    expect(hc.onsiteChanges([bachata, single], next)).toEqual([
      { classId: "c1", sessionId: "s1", title: "바차타 센슈얼 입문", body: { male: 2, female: 1 } },
      { classId: "c2", sessionId: "s2", title: "라인댄스", body: { any: 4 } },
    ]);
    // 같은 값이면 보내지 않는다
    expect(hc.onsiteChanges([bachata], { s1: { female: "1" } })).toEqual([]);
    expect(hc.onsitePath("c 1", "s1")).toBe("/api/classes/c%201/sessions/s1/onsite-headcount");
  });
});

describe("O45 주문·결제 찾기", () => {
  const base: orders.OwnerOrder = {
    orderId: "o1", createdAt: "2026-11-10T01:20:00Z", member: { memberId: "m1", nickname: "김서연" },
    class: { classId: "c1", offeringId: "f1", title: "바차타 센슈얼 입문", kindLabel: "정규 4주", classKind: "regular" },
    amount: 160000, method: "card", status: "paid", paidAt: "2026-11-10T01:21:30Z", dueAt: null, refundRequest: null,
  };

  test("칩 → 서버 status 값, 기간은 오늘 포함 366일, 검색어는 잘라서 인코딩", () => {
    const now = new Date("2026-11-24T02:00:00Z");
    expect(orders.ownerOrdersPath("a1", "all", "", now)).toBe("/api/academies/a1/orders?from=2025-11-24&to=2026-11-24");
    expect(orders.ownerOrdersPath("a1", "refund", " 바차타 ", now, "cur")).toBe(
      "/api/academies/a1/orders?from=2025-11-24&to=2026-11-24&status=partially_refunded,refunded&q=%EB%B0%94%EC%B0%A8%ED%83%80&cursor=cur",
    );
    expect(orders.ownerOrdersPath("a1", "pending", "", now)).toContain("status=pending");
  });

  test("줄 글자 — 보드 O45 문구", () => {
    expect(orders.won(160000)).toBe("160,000원");
    expect(orders.orderClassLine(base)).toBe("바차타 센슈얼 입문 · 정규 4주");
    expect(orders.orderStatusLine(base)).toEqual({ text: "신용카드 · 결제 완료", tone: "accent" });
    expect(orders.orderStatusLine({ ...base, method: "easy_transfer" })).toEqual({ text: "간편 계좌이체 · 결제 완료", tone: "accent" });
    expect(orders.orderStatusLine({ ...base, method: "virtual_account", status: "pending", dueAt: "2026-11-14T14:59:00Z" })).toEqual({
      text: "가상계좌 · 입금 대기 (11/14까지)", tone: "danger" });
    expect(orders.orderStatusLine({ ...base, status: "refunded" }).text).toBe("신용카드 · 환불 완료");
    expect(orders.orderStatusLine({ ...base, status: "expired" }).tone).toBe("muted");
    expect(orders.orderStatusLine({ ...base, refundRequest: { requestId: "r1", status: "received", kind: "regular" } }).text).toBe("신용카드 · 환불 요청");
  });

  test("이력 한 줄 — 「11/12 (목)」 · 글자 · 금액 또는 상태 또는 「—」", () => {
    expect(orders.timelineRow({ at: "2026-11-12T03:00:00Z", kind: "refund_requested", label: "환불 요청 접수", detail: "검토 중", amount: null }))
      .toEqual({ date: "11/12 (목)", label: "환불 요청 접수", right: "검토 중" });
    expect(orders.timelineRow({ at: "2026-11-10T01:21:30Z", kind: "paid", label: "결제 완료 · 신용카드", detail: null, amount: 160000 }).right).toBe("160,000원");
    expect(orders.timelineRow({ at: "2026-11-10T01:20:00Z", kind: "order_created", label: "수업 신청 · 결제 시작", detail: null, amount: null }).right).toBe("—");
  });
});
