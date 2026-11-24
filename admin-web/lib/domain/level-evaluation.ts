// S6-3.2(레벨 계산: 끝까지 + 출석 70%) — 정규 과정 한 기간을 마친 회원의 세부 장르 레벨을 1칸 올릴지 정하는 순수 함수.
//   규칙 원본: spec FR-169a(출석률 반영 레벨) · FR-092e(결석 예정 미리 알리기의 「결석 표시」) · FR-161(레벨 등급 구간)
//   설계: _workspace/03_data-model.md §11-4 `course_completions` · 계약 14-membership-benefits.md §5-1(결정 D7)
//
// 이 파일이 하는 일 — DB 를 읽지 않는다. 내부 작업(S6-3.3 레벨 계산 작업)이 DB 에서 회차·결석 표시·예약·주문 상태를 모아
//   여기에 넘기면, 「끝까지 마쳤나」「출석이 70% 이상인가」「몇 레벨로 가나」만 계산해 돌려준다.
//   계산을 DB 코드와 떼어 두면 「8회 중 6회면 오른다」 같은 규칙을 DB 없이 빠르게 시험할 수 있다.
//
// 규칙 한 줄 요약: 끝까지 마쳤고(환불·취소 없음) 출석 × 10 ≥ 회차 × 7 이면 +1(10 이 상한). 못 미치면 그대로(내리지 않는다).

import {
  LEVEL_MAX,
  LEVEL_MIN,
  type AttendanceDisputeStatus,
  type AttendanceMarkedByKind,
  type ClassDiscipline,
  type ClassSessionStatus,
  type ClassSubGenre,
  type Genre,
  type LevelDetailGenre,
  type OrderStatus,
  type ReservationStatus,
} from "./constants";

/** 출석 비율 기준 — 분자/분모로 둬서 소수 계산 오차 없이 정수로만 비교한다(70% = 7/10) */
export const LEVEL_UP_ATTENDANCE_NUMERATOR = 7;
export const LEVEL_UP_ATTENDANCE_DENOMINATOR = 10;

/** 판정에 쓰는 회차 한 개 — 상태만 있으면 된다 */
export type EvaluationSession = {
  id: string;
  status: ClassSessionStatus;
};

/** 판정에 쓰는 결석 표시 한 줄(attendance_marks 의 필요한 칸만) */
export type EvaluationAbsenceMark = {
  sessionId: string;
  markedByKind: AttendanceMarkedByKind;
  /** 표시를 거둔 시각. 거뒀으면 결석이 아니다 */
  cancelledAt: string | null;
  disputeStatus: AttendanceDisputeStatus;
};

export type EvaluateCompletionInput = {
  /** 그 세부 장르의 지금 레벨(행이 없으면 0) */
  currentLevel: number;
  /** 기간이 끝났을 때 예약 상태 */
  reservationStatus: ReservationStatus;
  /** 기간이 끝났을 때 주문 상태 */
  orderStatus: OrderStatus;
  /** 그 판매 단위(기간)의 모든 회차 — 휴강·폐강 회차도 넣어도 된다(여기서 뺀다) */
  sessions: readonly EvaluationSession[];
  /** 그 회원·그 예약의 결석 표시 — 회원·강사·대표가 표시한 것 모두 */
  absenceMarks: readonly EvaluationAbsenceMark[];
};

export type EvaluateCompletionResult = {
  /** 끝까지 마쳤나(예약 확정 유지 + 주문 결제 완료, 부분 환불·취소 없음) */
  completed: boolean;
  /** 휴강·폐강을 뺀 회차 수 — 서버 안에서만 쓴다(응답에 내리지 않는다, 결정 D7) */
  totalSessions: number;
  /** 출석으로 본 회차 수 = totalSessions − 유효한 결석 표시가 있는 회차 수 */
  attendedSessions: number;
  /** 이번 판정으로 레벨이 1칸 오르나 */
  levelAwarded: boolean;
  fromLevel: number;
  /** 오르면 fromLevel + 1, 아니면 fromLevel 그대로 */
  toLevel: number;
};

/**
 * 「끝까지 마쳤다」의 뜻 — 기간이 끝날 때까지 그 예약이 확정 상태이고 주문이 결제 완료(paid)인 것.
 * 부분 환불(partially_refunded)·전액 환불·취소가 하나라도 있으면 중도에 그만둔 것으로 본다(data-model §11-4).
 */
export function isTermCompleted(reservationStatus: ReservationStatus, orderStatus: OrderStatus): boolean {
  return reservationStatus === "confirmed" && orderStatus === "paid";
}

/**
 * 결석 표시 한 줄이 지금도 결석으로 셀 표시인지.
 * - 거둔 표시(cancelled_at 있음)는 세지 않는다 — 본인·표시한 사람이 취소했거나 이의가 받아들여졌다
 * - 이의가 받아들여진(accepted) 표시도 세지 않는다(받아들이면 cancelled_at 도 채워지지만 한 번 더 막는다)
 * - 표시한 사람이 회원이든 강사든 대표든 똑같이 센다(FR-169a, 2026-11-19 사용자 결정)
 */
export function isEffectiveAbsence(mark: EvaluationAbsenceMark): boolean {
  if (mark.cancelledAt !== null) return false;
  if (mark.disputeStatus === "accepted") return false;
  return true;
}

/**
 * 정규 과정 한 기간의 레벨 판정.
 * 순서: ① 휴강·폐강 회차 빼고 전체 회차 수 ② 유효한 결석이 있는 회차 수(같은 회차에 표시가 둘이어도 1회)
 *       ③ 출석 = 전체 − 결석 ④ 끝까지 마쳤고 출석×10 ≥ 전체×7 이면 +1(10 이면 더 못 오른다)
 */
export function evaluateCompletion(input: EvaluateCompletionInput): EvaluateCompletionResult {
  if (!Number.isInteger(input.currentLevel) || input.currentLevel < LEVEL_MIN || input.currentLevel > LEVEL_MAX) {
    throw new RangeError(`currentLevel 은 ${LEVEL_MIN}~${LEVEL_MAX} 정수여야 한다: ${input.currentLevel}`);
  }

  // ① 휴강(cancelled)·폐강(closed) 회차는 수업이 없었으니 분모에서 뺀다(열린 점 ⑩). 예정(scheduled) 회차만 센다.
  //    「closed」는 「지나간 회차」가 아니라 폐강으로 닫힌 회차다(ck_sessions_cancelled — 닫은 시각이 있다, S2-3.2 폐강 경로).
  //    지나간 회차도 상태는 scheduled 로 남는다(S6-3.3 에서 바로잡음 — 증거 EVIDENCE.md 추천안·사후 확인)
  const heldSessionIds = new Set(input.sessions.filter((s) => s.status === "scheduled").map((s) => s.id));
  const totalSessions = heldSessionIds.size;

  // ② 결석 회차 — 열린 회차에 걸린 유효한 표시만, 회차 단위로 한 번씩
  const absentSessionIds = new Set(
    input.absenceMarks
      .filter((m) => isEffectiveAbsence(m) && heldSessionIds.has(m.sessionId))
      .map((m) => m.sessionId),
  );
  // ③ 표시가 없으면 참석으로 본다(FR-169a)
  const attendedSessions = totalSessions - absentSessionIds.size;

  const completed = isTermCompleted(input.reservationStatus, input.orderStatus);
  // 회차가 0 개(전부 휴강)면 들은 수업이 없으니 올리지 않는다 — 0×10 ≥ 0×7 이 참이 되는 것을 막는다
  const attendanceMet =
    totalSessions > 0 &&
    attendedSessions * LEVEL_UP_ATTENDANCE_DENOMINATOR >= totalSessions * LEVEL_UP_ATTENDANCE_NUMERATOR;

  // ④ 레벨 10(댄서)이면 조건을 채워도 더 오르지 않는다. 내리는 경우는 없다
  const levelAwarded = completed && attendanceMet && input.currentLevel < LEVEL_MAX;
  const fromLevel = input.currentLevel;
  const toLevel = levelAwarded ? fromLevel + 1 : fromLevel;

  return { completed, totalSessions, attendedSessions, levelAwarded, fromLevel, toLevel };
}

/** 레벨 단계 이름(FR-161) — 저장하지 않고 레벨에서 계산한다. 0~1 입문 · 2~3 초급 · 4~5 초중급 · 6~7 중급 · 8~9 고급 · 10 댄서 */
export function levelStageLabel(level: number): "입문" | "초급" | "초중급" | "중급" | "고급" | "댄서" {
  if (!Number.isInteger(level) || level < LEVEL_MIN || level > LEVEL_MAX) {
    throw new RangeError(`level 은 ${LEVEL_MIN}~${LEVEL_MAX} 정수여야 한다: ${level}`);
  }
  if (level >= 10) return "댄서";
  if (level >= 8) return "고급";
  if (level >= 6) return "중급";
  if (level >= 4) return "초중급";
  if (level >= 2) return "초급";
  return "입문";
}

/** levelGenreOf 가 읽는 수업 칸 — classes 의 세 칸 */
export type LevelGenreSource = {
  genre: Genre;
  subGenre: ClassSubGenre | null;
  discipline: ClassDiscipline | null;
};

/**
 * 수업이 어느 세부 장르 레벨에 들어가는지(data-model §11-9 · 2026-11-20 통합 결정).
 * 종목(discipline, 댄스스포츠 10종)이 있으면 그것 → 없으면 살사·바차타 세부 장르 → 없으면 장르(아르헨티나 탱고·스윙).
 * 어느 것도 레벨 세부 장르가 아니면(예: 종목 없이 「라틴」만 고른 댄스스포츠 수업) null — 레벨을 매길 수 없다.
 */
export function levelGenreOf(cls: LevelGenreSource): LevelDetailGenre | null {
  if (cls.discipline !== null) return cls.discipline;
  if (cls.subGenre === "salsa" || cls.subGenre === "bachata") return cls.subGenre;
  if (cls.genre === "argentine_tango" || cls.genre === "swing") return cls.genre;
  return null;
}

/**
 * 세부 장르의 한국어 이름 — 알림 본문처럼 카드 밖에서 쓴다(S6-3.3 레벨 계산 작업의 level_up 알림).
 * 카드·등급 연출 안에서는 영어 이름(Samba 등)을 쓴다(FR-169e) — 그 표기는 카드 화면 Task 가 둔다.
 * 「쌈바」는 프로젝트 공식 한글 표기다(「삼바」 아님).
 */
export const LEVEL_GENRE_LABEL_KO: Readonly<Record<LevelDetailGenre, string>> = {
  cha_cha_cha: "차차차",
  samba: "쌈바",
  rumba: "룸바",
  paso_doble: "파소도블레",
  jive: "자이브",
  waltz: "왈츠",
  tango: "탱고",
  viennese_waltz: "비엔나 왈츠",
  slow_foxtrot: "폭스트롯",
  quickstep: "퀵스텝",
  argentine_tango: "아르헨티나 탱고",
  swing: "스윙",
  salsa: "살사",
  bachata: "바차타",
};
