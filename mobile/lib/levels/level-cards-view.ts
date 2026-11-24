/**
 * 카드 모음(보드 M26) 화면이 쓰는 모양과 계산 — S6-3.8(앱 회원 레벨 카드 화면).
 *   요구: spec FR-169f(카드 모음 화면) · FR-169e(카드 안 세부 장르 이름은 영어) · FR-161(단계 이름)
 *
 * 서버 응답(`GET /api/me/level-cards`, 계약 14 §5)을 받아 세부 장르별 묶음으로 나눈다.
 * 화면 글자 규칙:
 *   - 카드·카드 모음 안 세부 장르 이름은 모든 장르에서 영어(Samba · Argentine Tango …). 나머지 문장은 한국어
 *   - 레벨은 「Lv.3 (초급)」처럼 레벨 번호 뒤 괄호에 단계 이름
 *   - 카드에는 세부 장르 · 레벨 · 단계 이름까지만 적는다. 그 밖의 레벨 설명 글은 넣지 않는다(FR-169c)
 */

/** 서버의 세부 장르 이름 14종(admin-web LEVEL_DETAIL_GENRES 와 같다) */
export type LevelDetailGenre =
  | 'cha_cha_cha'
  | 'samba'
  | 'rumba'
  | 'paso_doble'
  | 'jive'
  | 'waltz'
  | 'tango'
  | 'viennese_waltz'
  | 'slow_foxtrot'
  | 'quickstep'
  | 'argentine_tango'
  | 'swing'
  | 'salsa'
  | 'bachata';

/** 카드 한 장(계약 14 §5 `GET /api/me/level-cards` 항목) */
export interface LevelCard {
  cardId: string;
  detailGenre: LevelDetailGenre;
  level: number;
  stageLabel: string;
  issuedAt: string;
  isFeatured: boolean;
  /** 그 세부 장르의 지금 레벨 카드 — 「지금」 표시 */
  isCurrent: boolean;
  characterKey: string;
}

export interface LevelCardsPage {
  items: readonly LevelCard[];
  nextCursor: string | null;
}

/** 카드 안 영어 이름(spec FR-169e 목록). 스윙은 Lindy Hop, 슬로 폭스트롯은 Foxtrot 으로 적는다 */
const GENRE_EN: Readonly<Record<LevelDetailGenre, string>> = {
  cha_cha_cha: 'Cha Cha Cha',
  samba: 'Samba',
  rumba: 'Rumba',
  paso_doble: 'Paso Doble',
  jive: 'Jive',
  waltz: 'Waltz',
  tango: 'Tango',
  viennese_waltz: 'Viennese Waltz',
  slow_foxtrot: 'Foxtrot',
  quickstep: 'Quickstep',
  argentine_tango: 'Argentine Tango',
  swing: 'Lindy Hop',
  salsa: 'Salsa',
  bachata: 'Bachata',
};

/** 묶음 이름(보드 M26 「Samba · 댄스스포츠 라틴」). 댄스스포츠 종목만 붙이고 나머지는 이름만 */
const LATIN: readonly LevelDetailGenre[] = ['cha_cha_cha', 'samba', 'rumba', 'paso_doble', 'jive'];
const STANDARD: readonly LevelDetailGenre[] = ['waltz', 'tango', 'viennese_waltz', 'slow_foxtrot', 'quickstep'];

export function genreNameEn(genre: LevelDetailGenre): string {
  return GENRE_EN[genre];
}

export function genreGroupLabel(genre: LevelDetailGenre): string | null {
  if (LATIN.includes(genre)) return '댄스스포츠 라틴';
  if (STANDARD.includes(genre)) return '댄스스포츠 스탠다드';
  return null;
}

/** 「Lv.3 (초급)」 */
export function levelText(level: number, stageLabel: string): string {
  return `Lv.${level} (${stageLabel})`;
}

/** 세부 장르 한 묶음 — 섹션 머리 + 3열 카드 */
export interface LevelCardSection {
  genre: LevelDetailGenre;
  title: string;
  /** 그 세부 장르의 지금 레벨 카드(없으면 null — 보통은 있다) */
  current: LevelCard | null;
  cards: readonly LevelCard[];
}

/**
 * 카드를 세부 장르별로 묶는다. 묶음은 지금 레벨이 높은 장르부터(보드: Samba Lv.10 → Argentine Tango Lv.3),
 * 같으면 영어 이름 순. 묶음 안 카드는 레벨 오름차순. 원본 배열은 바꾸지 않는다.
 */
export function groupLevelCards(cards: readonly LevelCard[]): readonly LevelCardSection[] {
  const byGenre = new Map<LevelDetailGenre, LevelCard[]>();
  for (const card of cards) {
    byGenre.set(card.detailGenre, [...(byGenre.get(card.detailGenre) ?? []), card]);
  }
  const sections = [...byGenre.entries()].map(([genre, list]): LevelCardSection => {
    const sorted = [...list].sort((a, b) => a.level - b.level);
    const group = genreGroupLabel(genre);
    return {
      genre,
      title: group === null ? genreNameEn(genre) : `${genreNameEn(genre)} · ${group}`,
      current: sorted.find((c) => c.isCurrent) ?? null,
      cards: sorted,
    };
  });
  // 지금 레벨(없으면 가장 높은 카드) 내림차순 → 영어 이름 순
  const topLevel = (s: LevelCardSection) => s.current?.level ?? s.cards.at(-1)?.level ?? 0;
  return sections.sort((a, b) => topLevel(b) - topLevel(a) || genreNameEn(a.genre).localeCompare(genreNameEn(b.genre)));
}
