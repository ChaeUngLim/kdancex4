// S6-3.5(개강 후보) — 강사가 「새 반 열기 추천」(보드 I15·I15B)에 조건을 넣었을 때 후보를 묶고 세는 순수 함수들.
//   규칙 원본: spec FR-164(개강 후보 추천) · FR-165(후보 연락처 동의) · FR-169d ①(강사 평가 레벨 — 모집용)
//   계약: _workspace/03_contracts/14-membership-benefits.md §6-2
//
// 이 파일은 DB 를 읽지 않는다. 서비스(lib/server/services/new-class-candidates.ts)가 회원마다
// 「어느 근거에 걸리는가(세 가지 참·거짓)」와 「연락처 제공에 동의했나」를 읽어 넘기면, 여기서
//   ① 한 사람에게 대표 근거 하나를 고르고(여러 근거에 걸려도 total 은 한 번만 센다)
//   ② 남·여 · 근거별 · 동의/비동의 인원을 센다.
// 근거 셋을 한 사람에게 하나씩만 붙이므로 근거별 인원의 합이 total 과 같다(계약 예시 11 + 8 + 4 = 23).
import type { Gender, Genre, LevelDetailGenre } from "./constants";
import { LEVEL_GENRE_LABEL_KO } from "./level-evaluation";
import { detailGenresOfGenre } from "./level-offer";

/** 선정 근거 세 가지 — 앞에 있을수록 먼저 고른다(같은 세부 장르를 끝까지 마친 것이 가장 강한 근거) */
export const CANDIDATE_BASIS_KINDS = ["completed_same_detail_genre", "attending_same_genre", "preferred_time"] as const;
export type CandidateBasisKind = (typeof CANDIDATE_BASIS_KINDS)[number];

/** 요일 칸 값 — 받기는 하지만 판정에는 쓰지 않는다(회원 데이터에 요일 선호가 없다 — 계약 14 열린 점 ⑫) */
export const CANDIDATE_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type CandidateWeekday = (typeof CANDIDATE_WEEKDAYS)[number];

/** 화면 맨 아래 문구(보드 I15 · FR-164) — AI 추천이고 신청을 약속하지 않는다 */
export const CANDIDATE_DISCLAIMER = "AI 추천 · 실제 신청으로 이어진다는 뜻은 아니에요";
/** 명단 위 문구(보드 I15B) — 연락처 쓰임을 못 박는다 */
export const CANDIDATE_LIST_NOTICE = "연락처는 새 반 안내 말고 다른 용도로 쓸 수 없어요";

/** 회원 한 명에 대해 서비스가 읽어 오는 것 */
export type CandidateFlags = {
  readonly memberId: string;
  readonly gender: Gender;
  /** 같은 세부 장르 정규 과정을 끝까지 마쳤다(course_completions.completed) */
  readonly completedSameDetailGenre: boolean;
  /** 같은 대분류 장르의 수업을 지금 듣고 있다(확정 예약 + 결제 완료, 아직 회차가 남음) */
  readonly attendingSameGenre: boolean;
  /** 선호 시간대(members.available_from~to)가 요청 시간대와 겹친다 */
  readonly preferredTime: boolean;
  /** 연락처 제공에 동의했다(candidate_contact_consents.consented — 행이 없으면 동의 안 함) */
  readonly consented: boolean;
};

/** 대표 근거 — 어느 근거에도 안 걸리면 null(후보가 아니다) */
export function primaryBasis(flags: Pick<CandidateFlags, "completedSameDetailGenre" | "attendingSameGenre" | "preferredTime">): CandidateBasisKind | null {
  if (flags.completedSameDetailGenre) return "completed_same_detail_genre";
  if (flags.attendingSameGenre) return "attending_same_genre";
  if (flags.preferredTime) return "preferred_time";
  return null;
}

/** 후보 한 명 = 회원 + 대표 근거 */
export type Candidate = CandidateFlags & { readonly basis: CandidateBasisKind };

/** 근거가 하나라도 있는 사람만 남긴다 */
export function pickCandidates(rows: readonly CandidateFlags[]): Candidate[] {
  return rows.flatMap((row) => {
    const basis = primaryBasis(row);
    return basis === null ? [] : [{ ...row, basis }];
  });
}

/** 세부 장르 → 그 세부 장르가 속한 대분류 장르(근거 ② 「같은 대분류 장르」 판정에 쓴다) */
export function genreOfDetailGenre(detailGenre: LevelDetailGenre): Genre {
  const genres: readonly Genre[] = ["dance_sport", "salsa_bachata", "argentine_tango", "swing"];
  const found = genres.find((genre) => detailGenresOfGenre(genre).includes(detailGenre));
  if (found === undefined) throw new RangeError(`대분류 장르를 모르는 세부 장르: ${detailGenre}`);
  return found;
}

const GENRE_KO: Readonly<Record<Genre, string>> = {
  dance_sport: "댄스스포츠",
  argentine_tango: "아르헨티나 탱고",
  swing: "스윙",
  salsa_bachata: "살사·바차타",
};

/**
 * 근거 문장 — 화면 묶음 줄에 그대로 쓴다. 개인을 가리키는 말은 넣지 않는다.
 *   요일은 판정에 쓰지 않으므로 ③ 문장에도 넣지 않는다(쓰지 않은 조건을 근거처럼 보이지 않게).
 */
export function basisLabel(kind: CandidateBasisKind, detailGenre: LevelDetailGenre, time: { from: string; to: string } | null): string {
  if (kind === "completed_same_detail_genre") return `${LEVEL_GENRE_LABEL_KO[detailGenre]} 정규 과정을 끝까지 마쳤어요`;
  if (kind === "attending_same_genre") return `${GENRE_KO[genreOfDetailGenre(detailGenre)]} 수업을 듣고 있어요`;
  return time === null ? "선호 시간을 골랐어요" : `${time.from}~${time.to} 시간대를 선호 시간으로 골랐어요`;
}

export type CandidateSummary = {
  total: number;
  male: number;
  female: number;
  basis: { kind: CandidateBasisKind; count: number }[];
  contactConsent: { consenting: number; notConsenting: number };
};

/** 후보를 센다 — 근거는 세 줄을 늘 같은 순서로 낸다(0명이어도 줄은 있다 — 화면이 줄 수를 바꾸지 않게) */
export function summarizeCandidates(candidates: readonly Candidate[]): CandidateSummary {
  const consenting = candidates.filter((c) => c.consented).length;
  return {
    total: candidates.length,
    male: candidates.filter((c) => c.gender === "male").length,
    female: candidates.filter((c) => c.gender === "female").length,
    basis: CANDIDATE_BASIS_KINDS.map((kind) => ({ kind, count: candidates.filter((c) => c.basis === kind).length })),
    contactConsent: { consenting, notConsenting: candidates.length - consenting },
  };
}
