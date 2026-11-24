// S2-3.6(소속 해제의 남은 회차 처리와 받는 회원 수) — lib/domain/affiliation-release.ts 의 순수 함수.
//   핵심: 「받는 회원 M명」은 회차별 회원 수의 합이 아니라 중복을 뺀 수다(수용 ⑤). 알림은 회원마다 1건으로 묶는다.
import { describe, expect, test } from "vitest";

import {
  bundleByAction,
  countDistinctMembers,
  findUndecided,
  groupByMember,
  releaseBundlePreview,
  releaseItemSentence,
  releaseMemberMessage,
  substituteAssignedMessage,
  type DecidedSession,
} from "@/lib/domain/affiliation-release";

// 세 회차 — hana 는 셋 다, minsu 는 s1·s3, yuna 는 s2 만 예약
const SESSIONS: DecidedSession[] = [
  { sessionId: "s1", action: "substitute", memberIds: ["hana", "minsu"] },
  { sessionId: "s2", action: "close", memberIds: ["hana", "yuna"] },
  { sessionId: "s3", action: "cancel_session", memberIds: ["hana", "minsu"] },
];

describe("받는 회원 수 — 중복 제거", () => {
  test("회차별 합 6 이 아니라 서로 다른 회원 3명", () => {
    expect(SESSIONS.reduce((n, s) => n + s.memberIds.length, 0)).toBe(6);
    expect(countDistinctMembers(SESSIONS)).toBe(3);
  });

  test("회차가 없거나 회원이 없으면 0, 한 회차 안의 같은 id 도 한 번만", () => {
    expect(countDistinctMembers([])).toBe(0);
    expect(countDistinctMembers([{ sessionId: "s1", memberIds: [] }])).toBe(0);
    expect(countDistinctMembers([{ sessionId: "s1", memberIds: ["a", "a"] }])).toBe(1);
  });
});

describe("정하지 않은 회차", () => {
  test("남은 회차 순서대로, 정한 것은 뺀다", () => {
    expect(findUndecided(["s1", "s2", "s3"], ["s2"])).toEqual(["s1", "s3"]);
    expect(findUndecided(["s1"], ["s1", "x"])).toEqual([]);
    expect(findUndecided([], [])).toEqual([]);
  });
});

describe("묶음과 회원별 묶기", () => {
  test("처리별 묶음은 대체 → 휴강 → 폐강 순서, 묶음 안 회원도 중복 제거", () => {
    expect(bundleByAction(SESSIONS)).toEqual([
      { action: "substitute", sessionCount: 1, memberIds: ["hana", "minsu"] },
      { action: "cancel_session", sessionCount: 1, memberIds: ["hana", "minsu"] },
      { action: "close", sessionCount: 1, memberIds: ["hana", "yuna"] },
    ]);
    expect(bundleByAction([SESSIONS[0]!, { ...SESSIONS[2]!, action: "substitute" }])).toEqual([
      { action: "substitute", sessionCount: 2, memberIds: ["hana", "minsu"] },
    ]);
  });

  test("회원마다 한 줄 — 세 회차 예약 회원도 한 항목(알림 1건)", () => {
    expect(groupByMember(SESSIONS)).toEqual([
      { memberId: "hana", sessionIds: ["s1", "s2", "s3"] },
      { memberId: "minsu", sessionIds: ["s1", "s3"] },
      { memberId: "yuna", sessionIds: ["s2"] },
    ]);
  });
});

describe("회원 알림 문구", () => {
  const at = Temporal.Instant.from("2026-11-18T11:00:00Z"); // KST 11/18(수) 20:00

  test("대체 문구는 계약 §9-1 예시와 같은 모양, 받침에 맞춰 은/는", () => {
    const item = { classTitle: "차차차 입문", startsAt: at, action: "substitute" as const, substituteName: "이준호" };
    expect(releaseBundlePreview(item, "박서윤")).toBe("「11/18 (수) 차차차 입문은 박서윤 강사 대신 이준호 강사가 진행해요. 원하면 환불을 요청할 수 있어요.」");
    expect(releaseItemSentence({ ...item, classTitle: "살사", action: "cancel_session" }, "박서윤")).toBe("11/18 (수) 살사는 휴강해요");
    expect(releaseItemSentence({ ...item, classTitle: "쌈바(입문)", action: "close" }, "박서윤")).toBe("11/18 (수) 쌈바(입문)은 폐강돼요");
  });

  test("회원 한 명의 한 건에 회차가 줄마다 들어가고, 대표 한마디는 끝에", () => {
    const items = [
      { classTitle: "차차차 입문", startsAt: at, action: "substitute" as const, substituteName: "이준호" },
      { classTitle: "룸바", startsAt: at.add({ hours: 48 }), action: "close" as const, substituteName: null },
    ];
    const withNote = releaseMemberMessage(items, { instructorName: "박서윤", academyName: "라온댄스", ownerNote: "감사했어요" });
    expect(withNote.title).toBe("수업 강사 변경 안내 · 라온댄스");
    expect(withNote.body.split("\n")).toEqual([
      "11/18 (수) 차차차 입문은 박서윤 강사 대신 이준호 강사가 진행해요",
      "11/20 (금) 룸바는 폐강돼요",
      "학원 한마디: 감사했어요",
    ]);
    expect(releaseMemberMessage(items, { instructorName: "박서윤", academyName: "라온댄스", ownerNote: null }).body.split("\n")).toHaveLength(2);
  });

  // S2-3.7(대체 강사 배정 알림) — 대체 강사에게 가는 한 건은 회원 쪽과 같은 회차 문장 + 「내 일정에 들어갔어요」
  test("대체 강사 배정 알림 문구는 회원 문구와 같은 회차 문장을 쓴다", () => {
    const item = { classTitle: "차차차 입문", startsAt: at, action: "substitute" as const, substituteName: "이준호" };
    expect(substituteAssignedMessage(item, { instructorName: "박서윤", academyName: "라온댄스" })).toEqual({
      title: "대체 강사 배정 · 라온댄스",
      body: `${releaseItemSentence(item, "박서윤")}. 내 일정에 들어갔어요.`,
    });
    expect(substituteAssignedMessage(item, { instructorName: "박서윤", academyName: "라온댄스" }).body).toBe(
      "11/18 (수) 차차차 입문은 박서윤 강사 대신 이준호 강사가 진행해요. 내 일정에 들어갔어요.",
    );
  });
});
