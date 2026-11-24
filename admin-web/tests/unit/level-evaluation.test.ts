// S6-3.2(레벨 계산: 끝까지 + 출석 70%) — evaluateCompletion · levelStageLabel · levelGenreOf 단위 테스트.
//   규칙: spec FR-169a(출석률 반영 레벨) · 계약 14 §5-1 · data-model §11-4. verify 의 tests/unit/s6-3-2.test.ts 를 기능 이름으로 바꾼 파일이다.
import { describe, expect, it } from "vitest";
import {
  evaluateCompletion,
  isEffectiveAbsence,
  levelGenreOf,
  levelStageLabel,
  type EvaluationAbsenceMark,
  type EvaluationSession,
} from "@/lib/domain/level-evaluation";

// 8회 과정 회차 s1~s8 (모두 열린 회차)
function sessions(count: number, cancelled: readonly number[] = []): EvaluationSession[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i + 1}`,
    status: cancelled.includes(i + 1) ? ("cancelled" as const) : ("scheduled" as const),
  }));
}

// 회차 번호들에 결석 표시를 만든다(기본: 회원 본인 표시, 거두지 않음)
function absences(nums: readonly number[], by: EvaluationAbsenceMark["markedByKind"] = "member"): EvaluationAbsenceMark[] {
  return nums.map((n) => ({ sessionId: `s${n}`, markedByKind: by, cancelledAt: null, disputeStatus: "none" as const }));
}

const finished = { reservationStatus: "confirmed", orderStatus: "paid" } as const;

describe("evaluateCompletion — 끝까지 마치고 출석 70% 이상이면 +1", () => {
  it("8회 중 6회 출석하고 끝까지 마치면 레벨 +1", () => {
    const r = evaluateCompletion({ currentLevel: 3, ...finished, sessions: sessions(8), absenceMarks: absences([2, 5]) });
    expect(r).toEqual({ completed: true, totalSessions: 8, attendedSessions: 6, levelAwarded: true, fromLevel: 3, toLevel: 4 });
  });

  it("8회 중 5회 출석이면 그대로(0) — 내리지도 않는다", () => {
    const r = evaluateCompletion({ currentLevel: 3, ...finished, sessions: sessions(8), absenceMarks: absences([1, 2, 3]) });
    expect(r.attendedSessions).toBe(5);
    expect(r.levelAwarded).toBe(false);
    expect(r.toLevel).toBe(3);
  });

  it("강사가 표시한 결석도 센다 — 강사 표시 3회면 5회 출석 → 0", () => {
    const r = evaluateCompletion({ currentLevel: 0, ...finished, sessions: sessions(8), absenceMarks: absences([4, 6, 7], "instructor") });
    expect(r.attendedSessions).toBe(5);
    expect(r.levelAwarded).toBe(false);
  });

  it("회원·강사·대표 표시를 모두 센다(섞여 있어도)", () => {
    const marks = [...absences([1], "member"), ...absences([2], "instructor"), ...absences([3], "owner")];
    const r = evaluateCompletion({ currentLevel: 1, ...finished, sessions: sessions(8), absenceMarks: marks });
    expect(r.attendedSessions).toBe(5);
    expect(r.levelAwarded).toBe(false);
  });

  it("표시가 없으면 전부 참석으로 본다 → +1", () => {
    const r = evaluateCompletion({ currentLevel: 0, ...finished, sessions: sessions(8), absenceMarks: [] });
    expect(r.attendedSessions).toBe(8);
    expect(r.toLevel).toBe(1);
  });

  it("거둔 표시·이의가 받아들여진 표시는 세지 않는다", () => {
    const marks: EvaluationAbsenceMark[] = [
      ...absences([1, 2]),
      { sessionId: "s3", markedByKind: "member", cancelledAt: "2026-11-20T10:00:00Z", disputeStatus: "none" },
      { sessionId: "s4", markedByKind: "instructor", cancelledAt: "2026-11-21T10:00:00Z", disputeStatus: "accepted" },
      { sessionId: "s5", markedByKind: "owner", cancelledAt: null, disputeStatus: "accepted" },
    ];
    const r = evaluateCompletion({ currentLevel: 2, ...finished, sessions: sessions(8), absenceMarks: marks });
    expect(r.attendedSessions).toBe(6);
    expect(r.levelAwarded).toBe(true);
  });

  it("이의 신청 중(requested)·기각(rejected)인 강사 표시는 결석으로 센다", () => {
    expect(isEffectiveAbsence({ sessionId: "s1", markedByKind: "instructor", cancelledAt: null, disputeStatus: "requested" })).toBe(true);
    expect(isEffectiveAbsence({ sessionId: "s1", markedByKind: "instructor", cancelledAt: null, disputeStatus: "rejected" })).toBe(true);
  });

  it("같은 회차에 표시가 둘이어도 결석 1회로 센다", () => {
    const marks = [...absences([1], "member"), ...absences([1], "instructor"), ...absences([2])];
    const r = evaluateCompletion({ currentLevel: 0, ...finished, sessions: sessions(8), absenceMarks: marks });
    expect(r.attendedSessions).toBe(6);
    expect(r.levelAwarded).toBe(true);
  });

  it("휴강·폐강 회차는 분모에서 빼고, 그 회차 결석 표시도 무시한다", () => {
    // 10회 중 2회 휴강 → 8회 기준, 결석 2회(+휴강 회차 표시 1개는 무시) → 6/8 → +1
    const r = evaluateCompletion({ currentLevel: 5, ...finished, sessions: sessions(10, [9, 10]), absenceMarks: absences([1, 2, 9]) });
    expect(r.totalSessions).toBe(8);
    expect(r.attendedSessions).toBe(6);
    expect(r.toLevel).toBe(6);
  });

  it("70% 경계 — 10회 중 7회 +1, 6회 0", () => {
    expect(evaluateCompletion({ currentLevel: 0, ...finished, sessions: sessions(10), absenceMarks: absences([1, 2, 3]) }).levelAwarded).toBe(true);
    expect(evaluateCompletion({ currentLevel: 0, ...finished, sessions: sessions(10), absenceMarks: absences([1, 2, 3, 4]) }).levelAwarded).toBe(false);
  });

  it.each([
    ["부분 환불", "confirmed", "partially_refunded"],
    ["전액 환불", "confirmed", "refunded"],
    ["주문 취소", "confirmed", "cancelled"],
    ["예약 취소", "cancelled", "paid"],
  ] as const)("끝까지 마치지 않았으면(%s) 출석이 다 차도 0", (_label, reservationStatus, orderStatus) => {
    const r = evaluateCompletion({ currentLevel: 2, reservationStatus, orderStatus, sessions: sessions(8), absenceMarks: [] });
    expect(r.completed).toBe(false);
    expect(r.levelAwarded).toBe(false);
    expect(r.toLevel).toBe(2);
  });

  it("레벨 10(댄서)이면 더 오르지 않는다", () => {
    const r = evaluateCompletion({ currentLevel: 10, ...finished, sessions: sessions(8), absenceMarks: [] });
    expect(r.levelAwarded).toBe(false);
    expect(r.toLevel).toBe(10);
  });

  it("레벨 9 에서 조건을 채우면 10 으로 한 칸만", () => {
    expect(evaluateCompletion({ currentLevel: 9, ...finished, sessions: sessions(8), absenceMarks: [] }).toLevel).toBe(10);
  });

  it("회차가 전부 휴강이면 들은 수업이 없으니 0", () => {
    const r = evaluateCompletion({ currentLevel: 0, ...finished, sessions: sessions(4, [1, 2, 3, 4]), absenceMarks: [] });
    expect(r.totalSessions).toBe(0);
    expect(r.levelAwarded).toBe(false);
  });

  it("지금 레벨이 0~10 정수가 아니면 막는다", () => {
    expect(() => evaluateCompletion({ currentLevel: 11, ...finished, sessions: sessions(8), absenceMarks: [] })).toThrow(RangeError);
    expect(() => evaluateCompletion({ currentLevel: -1, ...finished, sessions: sessions(8), absenceMarks: [] })).toThrow(RangeError);
    expect(() => evaluateCompletion({ currentLevel: 2.5, ...finished, sessions: sessions(8), absenceMarks: [] })).toThrow(RangeError);
  });

  it("입력 배열을 바꾸지 않는다", () => {
    const s = sessions(8);
    const m = absences([1]);
    const before = JSON.stringify({ s, m });
    evaluateCompletion({ currentLevel: 0, ...finished, sessions: s, absenceMarks: m });
    expect(JSON.stringify({ s, m })).toBe(before);
  });
});

describe("evaluateCompletion — 폐강(closed) 회차도 분모에서 뺀다(S6-3.3 에서 바로잡음)", () => {
  it("8회 중 뒤 2회가 폐강(closed)이면 6회로 센다 — 폐강 회차에 걸린 결석 표시도 무시", () => {
    const list = sessions(8).map((s) => (s.id === "s7" || s.id === "s8" ? { ...s, status: "closed" as const } : s));
    const r = evaluateCompletion({ currentLevel: 2, ...finished, sessions: list, absenceMarks: absences([1, 7, 8]) });
    expect(r).toEqual({ completed: true, totalSessions: 6, attendedSessions: 5, levelAwarded: true, fromLevel: 2, toLevel: 3 });
  });
});

describe("levelStageLabel — FR-161 단계 이름", () => {
  it.each([
    [0, "입문"], [1, "입문"], [2, "초급"], [3, "초급"], [4, "초중급"], [5, "초중급"],
    [6, "중급"], [7, "중급"], [8, "고급"], [9, "고급"], [10, "댄서"],
  ] as const)("레벨 %i → %s", (level, label) => {
    expect(levelStageLabel(level)).toBe(label);
  });

  it("범위 밖은 막는다", () => {
    expect(() => levelStageLabel(11)).toThrow(RangeError);
    expect(() => levelStageLabel(-1)).toThrow(RangeError);
  });
});

describe("levelGenreOf — 수업이 들어가는 세부 장르 레벨", () => {
  it("종목이 있으면 종목(댄스스포츠)", () => {
    expect(levelGenreOf({ genre: "dance_sport", subGenre: "latin", discipline: "samba" })).toBe("samba");
    expect(levelGenreOf({ genre: "dance_sport", subGenre: "standard", discipline: "viennese_waltz" })).toBe("viennese_waltz");
  });
  it("종목이 없으면 살사·바차타 세부 장르", () => {
    expect(levelGenreOf({ genre: "salsa_bachata", subGenre: "salsa", discipline: null })).toBe("salsa");
    expect(levelGenreOf({ genre: "salsa_bachata", subGenre: "bachata", discipline: null })).toBe("bachata");
  });
  it("그것도 없으면 장르(아르헨티나 탱고·스윙)", () => {
    expect(levelGenreOf({ genre: "argentine_tango", subGenre: null, discipline: null })).toBe("argentine_tango");
    expect(levelGenreOf({ genre: "swing", subGenre: null, discipline: null })).toBe("swing");
  });
  it("종목 없이 라틴·스탠다드만 고른 댄스스포츠 수업은 레벨을 매길 수 없다(null)", () => {
    expect(levelGenreOf({ genre: "dance_sport", subGenre: "latin", discipline: null })).toBeNull();
    expect(levelGenreOf({ genre: "salsa_bachata", subGenre: null, discipline: null })).toBeNull();
  });
});
