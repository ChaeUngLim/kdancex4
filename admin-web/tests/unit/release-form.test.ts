// S2-3.10(관리자 웹·대표 앱 해제 확인 화면) — 소속 해제 화면(W3b · W3b2)의 글자·계산 규칙(lib/release-form.ts).
import { describe, expect, test } from "vitest";

import {
  choiceHint,
  classHeading,
  groupByClass,
  remainingCount,
  remainingLabel,
  sessionDateLabel,
  sessionDecisionsOf,
  totalsLine,
  type Choices,
  type RemainingSession,
} from "@/lib/release-form";

const session = (id: string, classId: string, startsAt: string, endsAt: string): RemainingSession => ({
  sessionId: id,
  classId,
  classTitle: classId === "c1" ? "차차차 입문" : "룸바 중급",
  startsAt,
  endsAt,
  roomName: "A실",
  memberCount: 9,
  decision: null,
});

// 2026-11-26(목) 20:00–21:30 KST = 11:00–12:30Z
const S1 = session("s1", "c1", "2026-11-26T11:00:00Z", "2026-11-26T12:30:00Z");
const S2 = session("s2", "c2", "2026-11-27T10:00:00Z", "2026-11-27T11:00:00Z");
const S3 = session("s3", "c1", "2026-12-03T11:00:00Z", "2026-12-03T12:30:00Z");

describe("소속 해제 화면 규칙(W3b · W3b2)", () => {
  test("날짜와 수업 머리는 KST 로 읽는다", () => {
    expect(sessionDateLabel(S1.startsAt)).toBe("11월 26일 (목)");
    expect(classHeading(S1)).toBe("차차차 입문 · A실 · 목 20:00–21:30");
  });

  test("수업별로 묶되 서버가 준 순서를 지킨다", () => {
    const groups = groupByClass([S1, S2, S3]);
    expect(groups.map((g) => [g.classId, g.sessions.map((s) => s.sessionId)])).toEqual([
      ["c1", ["s1", "s3"]],
      ["c2", ["s2"]],
    ]);
  });

  test("대체 강사는 사람까지 골라야 정한 것이다 — 남은 수와 보낼 결정 목록", () => {
    const half: Choices = { s1: { action: "substitute", substituteAccountId: null, substituteName: null }, s2: { action: "cancel_session", substituteAccountId: null, substituteName: null } };
    expect(remainingCount([S1, S2, S3], half)).toBe(2);
    expect(remainingLabel(2)).toBe("2개 남았어요");
    expect(choiceHint(half["s1"])).toBe("대체 강사를 골라 주세요");
    expect(choiceHint(undefined)).toBe("아직 고르지 않았어요");

    const all: Choices = { ...half, s1: { action: "substitute", substituteAccountId: "lee", substituteName: "이준호" }, s3: { action: "close", substituteAccountId: null, substituteName: null } };
    expect(remainingCount([S1, S2, S3], all)).toBe(0);
    expect(remainingLabel(0)).toBe("모두 정했어요");
    expect(sessionDecisionsOf([S1, S2, S3], all)).toEqual([
      { sessionId: "s1", action: "substitute", substituteAccountId: "lee" },
      { sessionId: "s2", action: "cancel_session" },
      { sessionId: "s3", action: "close" },
    ]);
  });

  test("합계 문구는 열린 점 ⑯ 추천안 — 받는 회원 M명 · 알림은 회원마다 1건", () => {
    expect(totalsLine({ memberCount: 12, notificationCount: 12 })).toBe("받는 회원 12명 · 알림은 회원마다 1건");
  });
});
