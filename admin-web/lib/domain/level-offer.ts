// S6-3.4(강사 레벨 조절과 평가 레벨 숨김) — 강사가 「최종 적용」을 눌렀을 때 회원마다 무엇을 할지 정하는 순수 함수들.
//   규칙 원본: spec FR-169d(강사 레벨 등급 조절) ①·② · FR-161(레벨 등급 구간) · FR-162(레벨 부여 제한)
//   계약: _workspace/03_contracts/14-membership-benefits.md §6-1(레벨 정하기)
//
// 강사가 정한 값은 두 군데로 간다.
//   ① 강사 평가 레벨(모집용) — 올리든 내리든 저장한다. 회원에게는 보이지 않는다(S6-3 수용 ③).
//   ② 회원에게 승급 안내 — 회원의 지금 레벨보다 **높을 때만** 보낸다. 회원은 받거나(승급) 지금 레벨에서 키운다.
// 이 파일은 DB 를 읽지 않는다. 서비스(lib/server/services/instructor-level-evaluations.ts)가 지금 상태를 읽어 넘기면
// 「평가를 고쳐 쓸까 · 안내를 새로 보낼까 · 열린 안내를 닫을까」만 계산한다.
import { LEVEL_MAX, LEVEL_MIN, type Genre, type LevelDetailGenre } from "./constants";
import { LEVEL_GENRE_LABEL_KO, levelStageLabel } from "./level-evaluation";

/** 레벨 단계 코드 — 회원 응답의 `stage`(계약 14 §5 「"stage": "advanced"」). 값 집합은 경험 수준(FR-029) 6구간과 같다 */
export type LevelStage = "entry" | "beginner" | "novice_intermediate" | "intermediate" | "advanced" | "dancer";

/** 레벨 → 단계 코드. 0~1 entry · 2~3 beginner · 4~5 novice_intermediate · 6~7 intermediate · 8~9 advanced · 10 dancer */
export function levelStageCode(level: number): LevelStage {
  // 범위 검사는 levelStageLabel 과 같게 — 단계 이름과 코드가 같은 칸에서 갈라지지 않도록 그 함수를 먼저 부른다
  const label = levelStageLabel(level);
  const byLabel = { 입문: "entry", 초급: "beginner", 초중급: "novice_intermediate", 중급: "intermediate", 고급: "advanced", 댄서: "dancer" } as const;
  return byLabel[label];
}

/**
 * 수업 장르(classes.genre) 아래에 있는 레벨 세부 장르들 — 강사는 그 수업 장르 안에서만 세부 장르를 골라 정한다(FR-169d).
 * 댄스스포츠 = 종목 10종, 살사·바차타 = 살사·바차타, 아르헨티나 탱고·스윙 = 그 하나.
 */
const DETAIL_GENRES_BY_GENRE: Readonly<Record<Genre, readonly LevelDetailGenre[]>> = {
  dance_sport: ["cha_cha_cha", "samba", "rumba", "paso_doble", "jive", "waltz", "tango", "viennese_waltz", "slow_foxtrot", "quickstep"],
  salsa_bachata: ["salsa", "bachata"],
  argentine_tango: ["argentine_tango"],
  swing: ["swing"],
};

export function detailGenresOfGenre(genre: Genre): readonly LevelDetailGenre[] {
  return DETAIL_GENRES_BY_GENRE[genre];
}

/**
 * 숫자 뒤 조사 「로/으로」 — 「4(초중급)로」처럼 괄호 앞 숫자의 읽는 소리로 고른다.
 * 받침이 있고 ㄹ 이 아닌 소리(삼·육·십·영)만 「으로」다. 일·칠·팔은 ㄹ 받침이라 「로」.
 */
function toParticle(level: number): "로" | "으로" {
  return level === 0 || level === 3 || level === 6 || level === 10 ? "으로" : "로";
}

/**
 * 승급 안내 문구 — spec FR-169d ② 「○○ 강사님이 쌈바 레벨을 4(초중급)로 올려 줬어요」.
 * 회원 알림 본문과 회원 레벨 화면(GET /api/me/levels 의 pendingOffers)이 같은 문장을 쓴다. 평가 레벨이라는 말은 넣지 않는다.
 */
export function levelOfferMessage(instructorName: string, detailGenre: LevelDetailGenre, toLevel: number): string {
  return `${instructorName} 강사님이 ${LEVEL_GENRE_LABEL_KO[detailGenre]} 레벨을 ${toLevel}(${levelStageLabel(toLevel)})${toParticle(toLevel)} 올려 줬어요`;
}

/** 한 회원에 대해 지금 DB 에 있는 것 — 서비스가 읽어 넘긴다 */
export type LevelApplyState = {
  /** 회원의 그 세부 장르 지금 레벨(기록이 없으면 0) */
  readonly memberLevel: number;
  /** 이 강사가 전에 매긴 평가 레벨(없으면 null) */
  readonly myEvaluation: number | null;
  /** 이 회원·세부 장르에 열린 안내가 있으면 그 안내 — 누가 보냈는지와 올린 레벨 */
  readonly openOffer: { readonly mine: boolean; readonly toLevel: number } | null;
};

/** 계산 결과 — 서비스가 이대로 쓴다 */
export type LevelApplyPlan = {
  /** 평가 레벨을 새로 쓰거나 고친다(같은 값이면 false) */
  readonly writeEvaluation: boolean;
  /** 열린 안내를 superseded 로 닫는다 */
  readonly supersedeOpenOffer: boolean;
  /** 새 안내를 만들고 알림을 보낸다 */
  readonly sendOffer: boolean;
  /** 응답 — 호출이 끝난 뒤 이 강사의 열린 안내가 이 레벨로 있나 */
  readonly offerSent: boolean;
  /** offerSent 가 false 인 까닭(회원 레벨보다 높지 않음) */
  readonly reason: "not_higher_than_member_level" | null;
};

/**
 * 「최종 적용」 한 번에 회원 한 명을 어떻게 다룰지(계약 14 §6-1).
 *   - 평가 레벨은 언제나 이 값이 된다(올리든 내리든). 같은 값이면 다시 쓰지 않는다.
 *   - 회원 레벨보다 높으면: 이 강사가 같은 레벨로 연 안내가 이미 있으면 그대로(알림 중복 없음).
 *     아니면 열린 안내(누가 보냈든)를 닫고 새로 보낸다 — 회원은 늘 최신 안내 하나만 본다.
 *   - 높지 않으면: 안내를 보내지 않는다(내린 레벨은 평가 레벨에만 남는다 — I23). 이 강사가 전에 연 안내가 있으면 닫는다
 *     (강사의 마지막 판단이 회원 레벨 이하로 바뀌었으니 예전 안내는 더 이상 맞지 않는다 — 추천안). 다른 강사의 안내는 건드리지 않는다.
 */
export function planLevelApply(state: LevelApplyState, level: number): LevelApplyPlan {
  if (!Number.isInteger(level) || level < LEVEL_MIN || level > LEVEL_MAX) {
    throw new RangeError(`level 은 ${LEVEL_MIN}~${LEVEL_MAX} 정수여야 한다: ${level}`);
  }
  const writeEvaluation = state.myEvaluation !== level;

  if (level > state.memberLevel) {
    const alreadyOpen = state.openOffer !== null && state.openOffer.mine && state.openOffer.toLevel === level;
    return {
      writeEvaluation,
      supersedeOpenOffer: !alreadyOpen && state.openOffer !== null,
      sendOffer: !alreadyOpen,
      offerSent: true,
      reason: null,
    };
  }
  return {
    writeEvaluation,
    supersedeOpenOffer: state.openOffer !== null && state.openOffer.mine,
    sendOffer: false,
    offerSent: false,
    reason: "not_higher_than_member_level",
  };
}
