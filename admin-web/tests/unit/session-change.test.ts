// S2-3.2(시간·장소 변경과 휴강 알림) — 회차 변경 순수 함수(lib/domain/session-change.ts)
//   ① 10분 단위 ② 휴강 선택 기한(알린 날 + 7일의 KST 23:59, 자정 경계) ③ 알림 문구 세 갈래 ④ 휴강 1회 금액(올림)
import { describe, expect, test } from "vitest";

import {
  classClosedMessage,
  closureChoiceDeadline,
  isOnTimeStep,
  perSessionAmount,
  sessionCancelledMessage,
  timePlaceMessage,
} from "@/lib/domain/session-change";

const at = (s: string) => Temporal.Instant.from(s);

describe("회차 변경 순수 함수(S2-3.2)", () => {
  test("① 10분 단위만 통과한다", () => {
    expect(isOnTimeStep(at("2026-11-16T12:00:00Z"))).toBe(true);
    expect(isOnTimeStep(at("2026-11-16T12:50:00Z"))).toBe(true);
    expect(isOnTimeStep(at("2026-11-16T12:05:00Z"))).toBe(false);
    expect(isOnTimeStep(at("2026-11-16T12:00:30Z"))).toBe(false);
  });

  test("② 휴강 선택 기한 = 알린 날(KST) + 7일의 23:59 KST", () => {
    // KST 11/21 12:00 에 알림 → 11/28 23:59 KST = 11/28 14:59Z
    expect(closureChoiceDeadline(at("2026-11-21T03:00:00Z")).toString()).toBe("2026-11-28T14:59:00Z");
    // UTC 로는 11/21 이지만 KST 로는 11/22 00:30 — KST 날짜 기준이라 11/29 23:59 KST
    expect(closureChoiceDeadline(at("2026-11-21T15:30:00Z")).toString()).toBe("2026-11-29T14:59:00Z");
  });

  test("③ 알림 문구 — 시간과 장소 · 시간만 · 장소만 · 날짜가 바뀌면 뒤에도 날짜", () => {
    // 11/16(월) 20:30–21:30 KST = 11:30–12:30Z
    const before = { startsAt: at("2026-11-16T11:30:00Z"), endsAt: at("2026-11-16T12:30:00Z"), roomName: "A홀" };
    const both = timePlaceMessage("쌈바(입문)", before, { startsAt: at("2026-11-16T12:00:00Z"), endsAt: at("2026-11-16T13:00:00Z"), roomName: "B홀" });
    expect(both).toEqual({
      title: "수업 변경 · 쌈바(입문)",
      body: "11/16 (월) 시간과 장소가 바뀌었어요 · 20:30–21:30 A홀 → 21:00–22:00 B홀",
      refundHint: "이 시간에 못 오면 환불을 요청할 수 있어요",
    });
    expect(timePlaceMessage("쌈바(입문)", before, { ...before, roomName: "B홀" }).body).toBe(
      "11/16 (월) 장소가 바뀌었어요 · 20:30–21:30 A홀 → 20:30–21:30 B홀",
    );
    expect(
      timePlaceMessage("쌈바(입문)", before, { startsAt: at("2026-11-17T11:30:00Z"), endsAt: at("2026-11-17T12:30:00Z"), roomName: "A홀" }).body,
    ).toBe("11/16 (월) 시간이 바뀌었어요 · 20:30–21:30 A홀 → 11/17 (화) 20:30–21:30 A홀");
  });

  test("③ 휴강·폐강 문구에 사유와 기한·회차 수가 들어간다", () => {
    const slot = { startsAt: at("2026-12-01T11:30:00Z"), endsAt: at("2026-12-01T12:30:00Z"), roomName: "A홀" };
    const cancelled = sessionCancelledMessage("쌈바", slot, "대회 심사 일정", at("2026-11-28T14:59:00Z"));
    expect(cancelled.body).toBe("12/1 (화) 20:30 수업이 휴강해요 · 대회 심사 일정");
    expect(cancelled.refundHint).toContain("11/28 (토)까지");
    expect(classClosedMessage("쌈바", slot, 3, "강사 사정").body).toBe("12/1 (화)부터 남은 3회 수업이 폐강돼요 · 강사 사정");
  });

  test("④ 휴강 1회 금액은 원 미만 올림, 회차 0 이면 null", () => {
    expect(perSessionAmount(300000, 16)).toBe(18750);
    expect(perSessionAmount(100000, 3)).toBe(33334);
    expect(perSessionAmount(100000, 0)).toBeNull();
  });
});
