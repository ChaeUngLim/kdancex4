// S3-5.9b(앱 강사 결석 표시 화면) — 앱의 오늘 결석 글자 함수(mobile/lib/instructor/absence-api.ts)가 보드 I26 문구대로 나오는지 본다.
//   응답 모양은 계약 18 §8 예시(최하은 · 정우진)를 그대로 썼다.
import { describe, expect, test } from "vitest";

import * as view from "../../../mobile/lib/instructor/absence-api";
import type { HeadcountItem, SessionRoster } from "../../../mobile/lib/instructor/headcount-api";

// 화면이 그려지는 순간 = 2026-11-11 18:00 KST
const NOW = new Date("2026-11-11T09:00:00Z");

const base: view.SessionAbsenceList = {
  sessionId: "s1", classId: "c1", academyId: "a1", academyName: "라틴하우스 강남", title: "쌈바(입문)", roomName: "A홀",
  startsAt: "2026-11-11T11:30:00Z", endsAt: "2026-11-11T12:30:00Z", sessionStatus: "scheduled", lockedAt: "2026-11-13T12:30:00Z",
  window: "open", viewerRole: "instructor", seatCount: 19, absenceCount: { male: 1, female: 1, any: 0, total: 2 },
  items: [
    { markId: "m1", memberId: "u1", nickname: "최하은", gender: "female", monthsEnrolled: 3, markedByKind: "member", markedAt: "2026-11-10T12:05:00Z", disputeStatus: "none", disputeReason: null, canResolveDispute: false },
    { markId: "m2", memberId: "u2", nickname: "정우진", gender: "male", monthsEnrolled: 2, markedByKind: "instructor", markedAt: "2026-11-11T08:40:00Z", disputeStatus: "requested", disputeReason: "그날 수업에 갔어요", canResolveDispute: true },
  ],
  acceptedDisputes: [],
};

describe("오늘 결석(I26) 글자", () => {
  test("요약 상자 — 자리 · 오늘 결석 · 남녀", () => {
    expect(view.absenceSummaryLine(base)).toBe("자리 19명 · 오늘 결석 2명 (남 1 · 여 1)");
    expect(view.absenceSummaryLine({ ...base, absenceCount: { male: 0, female: 0, any: 2, total: 2 } })).toBe("자리 19명 · 오늘 결석 2명");
    expect(view.absenceSummaryLine({ ...base, absenceCount: { male: 0, female: 0, any: 0, total: 0 } })).toBe("자리 19명 · 오늘 결석 0명");
  });

  test("줄 둘째 줄 — 회원이 알림은 「어제 21:05 알림」, 강사 표시는 역할과 시각", () => {
    expect(view.absenceSubLine(base.items[0]!, NOW)).toBe("여 · 3개월째 · 어제 21:05 알림");
    expect(view.absenceSubLine(base.items[1]!, NOW)).toBe("남 · 2개월째 · 강사가 오늘 17:40 표시");
    expect(view.relativeWhen("2026-11-08T01:00:00Z", NOW)).toBe("11/8 (일) 10:00");
  });

  test("이의 상태 — 걸림은 사유, 유지는 결과, 없음은 null", () => {
    expect(view.disputeLine(base.items[1]!)).toEqual({ tone: "pending", text: "이의 신청이 들어왔어요 「그날 수업에 갔어요」" });
    expect(view.disputeLine({ ...base.items[1]!, disputeStatus: "rejected" })?.text).toBe("이의 결과 · 결석 유지(회원에게 알렸어요)");
    expect(view.disputeLine(base.items[0]!)).toBeNull();
    expect(view.acceptedLine({ markId: "m2", memberId: "u2", nickname: "정우진", gender: "male", disputeReason: null, resolvedAt: "2026-11-11T08:55:00Z" }, NOW))
      .toBe("남 · 오늘 17:55 이의를 받아들여 출석으로 돌렸어요");
  });

  test("표시 구간 — 열림만 스위치를 쓰고, 시작 전·잠김·휴강은 이유를 적는다", () => {
    expect(view.canEditMarks(base)).toBe(true);
    expect(view.windowNotice(base, NOW)).toBeNull();
    expect(view.canEditMarks({ ...base, window: "locked" })).toBe(false);
    expect(view.windowNotice({ ...base, window: "before_start" }, NOW)).toContain("수업이 시작하면");
    expect(view.windowNotice({ ...base, window: "locked" }, NOW)).toContain("48시간");
    expect(view.windowNotice({ ...base, sessionStatus: "cancelled" }, NOW)).toContain("휴강");
  });

  test("다른 수강생 시트 후보 — 이미 결석인 사람을 뺀다", () => {
    const member = (memberId: string, nickname: string) => ({ memberId, nickname, gender: "male" as const, ageBand: "20s" as const, phoneMasked: "010-****-0000", monthsEnrolled: 1, absence: null });
    const roster = { members: [member("u1", "최하은"), member("u3", "김서준"), member("u2", "정우진")] } as unknown as SessionRoster;
    expect(view.markableMembers(roster, base).map((m) => m.nickname)).toEqual(["김서준"]);
  });

  test("이전 · 다음 — 같은 날 단체 수업 중 앞뒤, 개인 레슨은 건너뛴다", () => {
    const cls = (sessionId: string) => ({ kind: "class", classId: `c-${sessionId}`, sessionId }) as unknown as HeadcountItem;
    const lesson = { kind: "private_lesson", bookingId: "b1" } as unknown as HeadcountItem;
    const items = [cls("a"), lesson, cls("b"), cls("c")];
    expect(view.neighborSessions(items, "b")).toEqual({ prev: { classId: "c-a", sessionId: "a" }, next: { classId: "c-c", sessionId: "c" } });
    expect(view.neighborSessions(items, "a").prev).toBeNull();
    expect(view.neighborSessions(items, "x")).toEqual({ prev: null, next: null });
    expect(view.sessionDateKey("2026-11-10T15:30:00Z")).toBe("2026-11-11");
    expect(view.absenceScreenHref("c 1", "s1")).toBe("/instructor/sessions/s1/absences?classId=c%201");
  });
});
