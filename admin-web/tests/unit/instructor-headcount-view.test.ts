// S3-5.9(앱 강사 명단 화면) — 앱의 인원표·명단 글자 함수(mobile/lib/instructor/headcount-api.ts)가 보드 I1 · I7 · I23 문구대로 나오는지 본다.
//   서버 응답 모양은 계약 18 §4 · §7 예시를 그대로 썼다. 앱 파일은 휴대폰 엔진 때문에 Temporal 없이 적혀 있어 여기서 따로 시험한다.
import { describe, expect, test } from "vitest";

import * as view from "../../../mobile/lib/instructor/headcount-api";

const academy = { id: "0193a1b2-0000-7000-8000-000000000001", name: "라틴하우스 강남" };

const samba: view.HeadcountClassItem = {
  kind: "class", classId: "c1", sessionId: "s1", startsAt: "2026-11-11T11:30:00Z", endsAt: "2026-11-11T12:30:00Z",
  title: "쌈바(입문)", academy, roomName: "A홀", instructor: { displayName: "이준호" }, seatMode: "gender_split",
  seats: [
    { seatKind: "male", capacity: 10, confirmed: 6, absencePlanned: 0, onsite: 0, present: 6, remaining: 4 },
    { seatKind: "female", capacity: 10, confirmed: 5, absencePlanned: 1, onsite: 1, present: 5, remaining: 4 },
  ],
  absence: { male: 0, female: 1 },
};
const lesson: view.HeadcountLessonItem = {
  kind: "private_lesson", bookingId: "b1", startsAt: "2026-11-11T09:00:00Z", endsAt: "2026-11-11T09:50:00Z", title: "개인 레슨 · 1:1",
  academy, roomName: "연습실", student: { nickname: "김서연", gender: "female", awaitingPayment: false }, present: { male: 0, female: 1 }, absencePlanned: 0,
};

describe("I1 · I7 하루 인원표 글자", () => {
  test("주소 — 전체면 academyId 를 뺀다", () => {
    expect(view.headcountPath("2026-11-24")).toBe("/api/instructor/headcount?date=2026-11-24");
    expect(view.headcountPath("2026-11-24", academy.id)).toBe(`/api/instructor/headcount?date=2026-11-24&academyId=${academy.id}`);
  });
  test("결석 칸 — 「결석 1 (여)」 · 없으면 「없음」 · 남녀 둘 다 · 개인 레슨 확정/결제 대기", () => {
    expect(view.absenceLabel(samba)).toBe("결석 1 (여)");
    expect(view.absenceLabel({ ...samba, absence: { male: 0, female: 0 } })).toBe("없음");
    expect(view.absenceLabel({ ...samba, absence: { male: 1, female: 1 } })).toBe("결석 2 (남 1 · 여 1)");
    expect(view.absenceLabel({ ...samba, seatMode: "single", absence: { any: 2 } })).toBe("결석 2");
    expect(view.absenceLabel(lesson)).toBe("확정");
    expect(view.absenceLabel({ ...lesson, student: { ...lesson.student, awaitingPayment: true } })).toBe("결제 대기");
  });
  test("참석 칸 — 남녀는 오늘 인원(present), 단일은 n명, 개인 레슨은 수강생 성별 1", () => {
    expect(view.presentCounts(samba)).toEqual({ male: 6, female: 5 });
    expect(view.presentCounts(lesson)).toEqual({ male: 0, female: 1 });
    const single: view.HeadcountClassItem = { ...samba, seatMode: "single", absence: { any: 0 },
      seats: [{ seatKind: "any", capacity: 20, confirmed: 4, absencePlanned: 0, onsite: 0, present: 4, remaining: 16 }] };
    expect(view.presentCounts(single)).toEqual({ any: 4 });
  });
  test("둘째 줄 · 요약줄(보드 I7 문구)", () => {
    expect(view.itemPlace(samba)).toBe("라틴하우스 강남 A홀");
    expect(view.itemPlace(lesson)).toBe("김서연 · 라틴하우스 강남 연습실");
    expect(view.headcountSummaryLine({ classCount: 2, privateLessonCount: 1, present: { male: 9, female: 12, total: 21 }, absencePlanned: 1 }))
      .toBe("수업 2 · 개인 레슨 1 · 참석 21 (남 9 · 여 12) · 결석 예정 1");
    // 단일 정원 인원이 섞여 남+여 ≠ 합계면 성별 괄호를 빼고 합계만
    expect(view.headcountSummaryLine({ classCount: 1, privateLessonCount: 0, present: { male: 0, female: 0, total: 3 }, absencePlanned: 0 }))
      .toBe("수업 1 · 개인 레슨 0 · 참석 3 · 결석 예정 0");
  });
  test("좌석 점 막대 — 정원 칸만큼(10칸 상한), 정원 넘침·0 처리", () => {
    expect(view.gaugeDots(5, 6)).toEqual({ filled: 5, total: 6 });
    expect(view.gaugeDots(10, 20)).toEqual({ filled: 5, total: 10 });
    expect(view.gaugeDots(9, 4)).toEqual({ filled: 4, total: 4 });
    expect(view.gaugeDots(1, 0)).toBeNull();
  });
});

describe("I23 회원 관리 탭 글자", () => {
  const seats: view.RosterSeat[] = [
    { seatKind: "male", capacity: 10, appConfirmed: 8, absencePlanned: 1, onsite: 1, present: 8, remaining: 1, maxOnsite: 2 },
    { seatKind: "female", capacity: 10, appConfirmed: 9, absencePlanned: 1, onsite: 1, present: 9, remaining: 0, maxOnsite: 0 },
  ];
  test("요약줄 — 「수업 전 인원 · 참석 17 (남 8 · 여 9) · 결석 예정 2」(보드 I23)", () => {
    expect(view.rosterSummaryLine(seats)).toBe("수업 전 인원 · 참석 17 (남 8 · 여 9) · 결석 예정 2");
  });
  test("결제 대기 — 숫자만, 없으면 null", () => {
    expect(view.awaitingLine({ male: 1, female: 0 })).toBe("결제 대기 남 1 · 여 0 · 이름은 결제가 끝나면 보여요");
    expect(view.awaitingLine({ any: 2 })).toBe("결제 대기 2명 · 이름은 결제가 끝나면 보여요");
    expect(view.awaitingLine({ male: 0, female: 0 })).toBeNull();
  });
  test("수강생 둘째 줄 — 「여 · 20대 · 3개월째 · 결석 예정」, 출석률 없음", () => {
    const m: view.RosterMember = { memberId: "m1", nickname: "최하은", gender: "female", ageBand: "20s", phoneMasked: "010-****-1234", monthsEnrolled: 3,
      absence: { markedByKind: "member", markedAt: "2026-11-10T12:05:00Z" } };
    expect(view.memberSubLine(m)).toBe("여 · 20대 · 3개월째 · 결석 예정");
    expect(view.memberSubLine({ ...m, gender: "male", ageBand: "60s_plus", monthsEnrolled: 1, absence: null })).toBe("남 · 60대 이상 · 1개월째");
  });
  test("명단 주소", () => {
    expect(view.rosterPath("c 1", "s1")).toBe("/api/classes/c%201/sessions/s1/roster");
  });
});
