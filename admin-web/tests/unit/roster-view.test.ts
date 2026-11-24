// S3-5.7(관리자 웹 주문·명단 화면) — 예약·명단 화면(보드 W6)의 글자·숫자를 만드는 순수 함수(lib/roster-view.ts).
//   화면 없이 고정한다: 회차 고르기(‹ › · 오늘 · 이번 주) · 좌석 칸 · − n + 상한 · 결석 표시 창 · 명단 글자.
import { describe, expect, test } from "vitest";

import {
  absenceWindow,
  formatPhone,
  capacityLine,
  genresText,
  inquiryText,
  onsiteNote,
  pickRosterSession,
  seatCells,
  seatSummary,
  sessionHeading,
  sessionSubline,
  sessionTabLabel,
  stepOnsite,
  termsText,
  weekOf,
  type RosterSessionOption,
} from "@/lib/roster-view";

const option = (id: string, startsAt: string, endsAt: string, seq = 1): RosterSessionOption => ({
  sessionId: id,
  classId: "c",
  title: "살사 온원 입문",
  startsAt,
  endsAt,
  roomName: "A실",
  instructorName: "이준호",
  kindName: "정규",
  seq,
  sessionCount: 4,
});

// 2026-11-24(화) 10:00 KST = 01:00Z. 이번 주 = 11/23(월) ~ 11/29(일)
const NOW = Temporal.Instant.from("2026-11-24T01:00:00Z");
const PAST = option("past", "2026-11-17T10:00:00Z", "2026-11-17T11:00:00Z"); // 11/17(화) 19:00 — 지난주
const TODAY_DONE = option("todayDone", "2026-11-23T23:00:00Z", "2026-11-24T00:00:00Z"); // 11/24 08:00 — 오늘, 이미 끝남
const TODAY_NEXT = option("todayNext", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z", 2); // 11/24 19:00 — 오늘, 아직
const THU = option("thu", "2026-11-26T10:00:00Z", "2026-11-26T11:00:00Z", 3); // 11/26(목)
const NEXT_WEEK = option("nextWeek", "2026-12-01T10:00:00Z", "2026-12-01T11:00:00Z", 4);
const ALL = [PAST, TODAY_DONE, TODAY_NEXT, THU, NEXT_WEEK];

describe("회차 고르기(보드 W6 위쪽 줄)", () => {
  test("주소에 회차가 없으면 아직 끝나지 않은 첫 회차 · 칩은 「오늘」", () => {
    const pick = pickRosterSession(ALL, { requestedId: null, now: NOW });
    expect(pick.current?.sessionId).toBe("todayNext");
    expect(pick.prev?.sessionId).toBe("todayDone");
    expect(pick.next?.sessionId).toBe("thu");
    expect(pick.todayTarget?.sessionId).toBe("todayNext");
    expect(pick.weekTarget?.sessionId).toBe("todayNext");
    expect(pick.activeChip).toBe("today");
  });

  test("주소의 회차를 그대로 — 이번 주 목요일이면 「이번 주」, 다음 주면 칩 없음 · 끝이면 › 없음", () => {
    expect(pickRosterSession(ALL, { requestedId: "thu", now: NOW }).activeChip).toBe("week");
    const last = pickRosterSession(ALL, { requestedId: "nextWeek", now: NOW });
    expect(last.activeChip).toBeNull();
    expect(last.next).toBeNull();
    expect(last.prev?.sessionId).toBe("thu");
  });

  test("모르는 회차 id 는 무시하고 다가오는 회차 · 모두 지났으면 마지막 회차 · 비었으면 null", () => {
    expect(pickRosterSession(ALL, { requestedId: "nope", now: NOW }).current?.sessionId).toBe("todayNext");
    expect(pickRosterSession([PAST], { requestedId: null, now: NOW }).current?.sessionId).toBe("past");
    const empty = pickRosterSession([], { requestedId: null, now: NOW });
    expect(empty.current).toBeNull();
    expect(empty.todayTarget).toBeNull();
    expect(empty.weekTarget).toBeNull();
  });

  test("오늘 회차가 없으면 「오늘」 칩은 갈 곳이 없다", () => {
    expect(pickRosterSession([PAST, THU], { requestedId: null, now: NOW }).todayTarget).toBeNull();
  });

  test("이번 주는 KST 월~일 — 일요일에도 그 주 월요일부터", () => {
    expect(weekOf(Temporal.PlainDate.from("2026-11-29")).monday.toString()).toBe("2026-11-23");
    expect(weekOf(Temporal.PlainDate.from("2026-11-23")).sunday.toString()).toBe("2026-11-29");
  });

  test("제목 줄 · 작은 줄(보드 글자 모양)", () => {
    expect(sessionHeading(option("x", "2026-11-12T10:00:00Z", "2026-11-12T11:00:00Z"))).toBe("11/12 (목) 19:00 살사 온원 입문");
    expect(sessionSubline(option("x", "2026-11-12T10:00:00Z", "2026-11-12T11:00:00Z", 2))).toBe("A실 · 이준호 강사 · 정규 4회 중 2회차");
    expect(sessionSubline({ ...option("x", "2026-11-12T10:00:00Z", "2026-11-12T11:00:00Z"), roomName: null, instructorName: null })).toBe(
      "정규 4회 중 1회차",
    );
  });
});

describe("좌석 칸(보드 W6 가운데)", () => {
  test("남 정원 6 · 앱 4 · 현장 1 · 남은 1 → 칠함 4 · 빗금 1 · 빈 칸 1(보드 그대로)", () => {
    const seat = { capacity: 6, appConfirmed: 4, onsite: 1, remaining: 1 };
    expect(seatCells(seat)).toEqual(["app", "app", "app", "app", "onsite", "empty"]);
    expect(seatSummary(seat)).toBe("앱 4 · 현장 1 · 남은 1");
  });

  test("결제 대기로 잡힌 자리는 옅은 칸 — 정원 8 · 앱 2 · 현장 1 · 남은 4 → 대기 1", () => {
    expect(seatCells({ capacity: 8, appConfirmed: 2, onsite: 1, remaining: 4 }).filter((c) => c === "awaiting")).toHaveLength(1);
  });

  test("이상한 값이 와도 칸 수는 정원을 넘지 않는다", () => {
    expect(seatCells({ capacity: 4, appConfirmed: 6, onsite: 2, remaining: 3 })).toHaveLength(4);
  });

  test("정원 줄 · 탭 글자 · 현장 안내", () => {
    const seats = [
      { seatKind: "male" as const, capacity: 6, appConfirmed: 4, onsite: 1 },
      { seatKind: "female" as const, capacity: 6, appConfirmed: 5, onsite: 0 },
    ];
    expect(capacityLine(seats)).toBe("정원 · 남 6 · 여 6");
    expect(capacityLine([{ seatKind: "any", capacity: 12 }])).toBe("정원 · 12");
    expect(sessionTabLabel(seats)).toBe("이 회차 앱 9 · 현장 1");
    expect(onsiteNote(seats)).toBe("+ 현장 등록 남 1명 · 이름 없이 인원만 기록돼요");
    expect(onsiteNote([{ seatKind: "male", onsite: 0 }])).toBeNull();
  });

  test("− n + — 0 아래로 안 내려가고 상한(maxOnsite)을 넘지 않는다", () => {
    expect(stepOnsite(0, -1, 2)).toBe(0);
    expect(stepOnsite(1, 1, 2)).toBe(2);
    expect(stepOnsite(2, 1, 2)).toBe(2);
    // 이미 상한을 넘은 값(그 사이 앱 결제가 들어옴)은 줄일 수만 있다
    expect(stepOnsite(3, 1, 2)).toBe(3);
    expect(stepOnsite(3, -1, 2)).toBe(2);
  });
});

describe("명단 글자 · 결석 표시 창", () => {
  test("관심 장르 · 수강 이력 · 문의", () => {
    expect(genresText(["salsa_bachata", "argentine_tango"])).toBe("살사 · 바차타 · 탱고");
    expect(genresText([])).toBe("—");
    expect(termsText(3)).toBe("3과정 수강");
    expect(termsText(1)).toBe("첫 과정");
    expect(inquiryText(0)).toBe("없음");
    expect(inquiryText(1)).toBe("답변 대기 1");
    // 위임 강사 응답에는 칸이 없다(undefined) · 문의 표가 없으면 null
    expect(inquiryText(undefined)).toBe("—");
    expect(inquiryText(null)).toBe("—");
  });

  test("시작 전 · 시작 뒤 ~ 끝 + 48시간 · 그 뒤", () => {
    const session = { startsAt: "2026-11-24T10:00:00Z", endsAt: "2026-11-24T11:00:00Z" };
    expect(absenceWindow(session, Temporal.Instant.from("2026-11-24T09:59:59Z"))).toBe("before");
    expect(absenceWindow(session, Temporal.Instant.from("2026-11-24T10:00:00Z"))).toBe("open");
    expect(absenceWindow(session, Temporal.Instant.from("2026-11-26T11:00:00Z"))).toBe("open");
    expect(absenceWindow(session, Temporal.Instant.from("2026-11-26T11:00:01Z"))).toBe("closed");
  });
});

describe("전체 번호 모양", () => {
  test("숫자만 온 번호에 하이픈을 넣는다 · 이미 있으면 그대로 · 모르는 길이는 그대로", () => {
    expect(formatPhone("01022225678")).toBe("010-2222-5678");
    expect(formatPhone("010-2222-5678")).toBe("010-2222-5678");
    expect(formatPhone("0212345678")).toBe("02-1234-5678");
    expect(formatPhone("0111234567")).toBe("011-123-4567");
    expect(formatPhone("+82 10")).toBe("+82 10");
  });
});
