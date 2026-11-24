// S2-3.4(대타 요청 흐름) — 대타 후보 판정 순수 함수(lib/domain/substitute-request.ts).
//   계약 11 §8-1: 후보 = 같은 장르 · 요청자 본인 제외, 그 시간에 일정이 있으면 available=false · busy
import { describe, expect, test } from "vitest";

import type { InstructorScheduleItem } from "@/lib/domain/instructor-schedule-overlap";
import { instructorChangedMessage, judgeSubstituteCandidates, substituteAcceptedMessage } from "@/lib/domain/substitute-request";

const at = (iso: string) => Temporal.Instant.from(iso);
const SESSION = { startsAt: at("2026-12-01T11:30:00Z"), endsAt: at("2026-12-01T12:30:00Z") };
const item = (id: string, from: string, to: string, kind: InstructorScheduleItem["kind"] = "class_session"): InstructorScheduleItem => ({
  instructorAccountId: id,
  academyId: null,
  kind,
  startsAt: at(from),
  endsAt: at(to),
  label: "",
});

describe("judgeSubstituteCandidates", () => {
  const pool = [
    { accountId: "req", displayName: "준호", genre: "dance_sport" },
    { accountId: "a", displayName: "하나", genre: "dance_sport" },
    { accountId: "b", displayName: "가람", genre: "dance_sport" },
    { accountId: "c", displayName: "다솜", genre: "salsa_bachata" },
    { accountId: "d", displayName: "라온", genre: null },
  ];

  test("장르가 다르거나 프로필이 없거나 본인이면 목록에서 빠진다", () => {
    const out = judgeSubstituteCandidates({ session: SESSION, classGenre: "dance_sport", requesterAccountId: "req", pool, schedule: [] });
    expect(out.map((c) => c.accountId).sort()).toEqual(["a", "b"]);
  });

  test("겹치는 수업·개인 일정이 있으면 busy, 맞닿기만 하면 고를 수 있다", () => {
    const schedule = [
      item("a", "2026-12-01T12:00:00Z", "2026-12-01T13:00:00Z", "personal_event"), // 30분 겹침
      item("b", "2026-12-01T12:30:00Z", "2026-12-01T13:30:00Z"), // 끝과 맞닿음 — 겹침 아님
    ];
    const out = judgeSubstituteCandidates({ session: SESSION, classGenre: "dance_sport", requesterAccountId: "req", pool, schedule });
    expect(out).toEqual([
      { accountId: "b", displayName: "가람", genre: "dance_sport", available: true, unavailableReason: null },
      { accountId: "a", displayName: "하나", genre: "dance_sport", available: false, unavailableReason: "busy" },
    ]);
  });

  test("고를 수 있는 사람 먼저, 같으면 이름순", () => {
    const out = judgeSubstituteCandidates({ session: SESSION, classGenre: "dance_sport", requesterAccountId: null, pool, schedule: [] });
    expect(out.map((c) => c.displayName)).toEqual(["가람", "준호", "하나"]);
  });

  test("알림 문구", () => {
    expect(substituteAcceptedMessage("김하나", 10)).toBe("김하나 강사가 대타를 수락했어요 · 확인하면 수강생 10명에게 알림이 가요");
    expect(instructorChangedMessage("김하나")).toBe("이번 회차는 김하나 강사가 진행해요");
  });
});
