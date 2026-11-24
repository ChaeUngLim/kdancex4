// S6-3.8(앱 회원 레벨 카드 화면) — 등급 카드 그림을 고르는 열쇠(characterKey)를 만든다.
//   요구: spec FR-169c(레벨 성장 캐릭터) · FR-169f(카드 모음 화면) · 계약 14 §5(`GET /api/me/level-cards` 의 characterKey)
//
// 그림은 「세부 장르 묶음 × 성별 × 단계」마다 한 장이다(저장소 사본 docs/prototype/assets/level-characters/).
//   - 묶음: 댄스스포츠 라틴 5종은 samba 그림, 스탠다드 5종은 viennese 그림을 같이 쓴다. 아르헨티나 탱고는 tango,
//     스윙·살사·바차타는 각자 그림이 있다.
//   - 단계: 레벨 두 칸이 그림 한 장을 같이 쓴다(0~1 · 2~3 · 4~5 · 6~7 · 8~9), 10 은 따로 한 장.
//   - 성별: 남 회원은 m, 여 회원은 f.
// 열쇠 모양은 「묶음/성별_단계」다. 예: 살사 레벨 1 남 회원 → "salsa/m_l01".
// 앱은 이 열쇠로 자기 안에 넣어 둔 그림 파일을 고른다(mobile/lib/levels/level-card-art.ts).
import { LEVEL_MAX, LEVEL_MIN, type LevelDetailGenre } from "./constants";

/** 그림 묶음 — 그림 폴더 이름과 같다 */
export const LEVEL_ART_BUNDLES = ["samba", "viennese", "tango", "swing", "salsa", "bachata"] as const;
export type LevelArtBundle = (typeof LEVEL_ART_BUNDLES)[number];

/** 단계 그림 이름 — 레벨 두 칸씩(10 만 한 칸) */
export const LEVEL_ART_STEPS = ["l01", "l23", "l45", "l67", "l89", "l10"] as const;
export type LevelArtStep = (typeof LEVEL_ART_STEPS)[number];

/** 세부 장르 → 그림 묶음. 라틴·스탠다드 종목은 상위 묶음 그림을 같이 쓴다(로드맵 S6-3.8 메모) */
const BUNDLE_OF: Readonly<Record<LevelDetailGenre, LevelArtBundle>> = {
  cha_cha_cha: "samba",
  samba: "samba",
  rumba: "samba",
  paso_doble: "samba",
  jive: "samba",
  waltz: "viennese",
  tango: "viennese", // 스탠다드 탱고 — 아르헨티나 탱고(tango 그림)와 다르다
  viennese_waltz: "viennese",
  slow_foxtrot: "viennese",
  quickstep: "viennese",
  argentine_tango: "tango",
  swing: "swing",
  salsa: "salsa",
  bachata: "bachata",
};

export function levelArtBundle(detailGenre: LevelDetailGenre): LevelArtBundle {
  return BUNDLE_OF[detailGenre];
}

/** 레벨 → 단계 그림. 0~1 은 l01, 2~3 은 l23 … 10 은 l10. 범위 밖이면 계산 실수라 바로 던진다 */
export function levelArtStep(level: number): LevelArtStep {
  if (!Number.isInteger(level) || level < LEVEL_MIN || level > LEVEL_MAX) throw new RangeError(`레벨은 ${LEVEL_MIN}~${LEVEL_MAX} 정수다: ${level}`);
  if (level === LEVEL_MAX) return "l10";
  // 0·1 → 0번, 2·3 → 1번 … 8·9 → 4번
  return LEVEL_ART_STEPS[Math.floor(level / 2)]!;
}

/** 카드 그림 열쇠 「묶음/성별_단계」 — 예: "salsa/m_l01" */
export function levelCharacterKey(detailGenre: LevelDetailGenre, level: number, gender: "male" | "female"): string {
  return `${levelArtBundle(detailGenre)}/${gender === "male" ? "m" : "f"}_${levelArtStep(level)}`;
}
