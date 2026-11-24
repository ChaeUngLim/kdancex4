/**
 * 등급 알림 → 카드 받기 선택 → 카드 공개 연출(보드 M25 · M25B · M25C)이 쓰는 모양·순서·글자 — S6-3.10.
 *   요구: spec FR-169e(등급 카드 발급 애니메이션) · FR-169d ②(강사 승급은 회원이 고른다) · FR-161(단계 이름)
 *   기준 연출: 아티팩트 「레벨 카드 발급 연출 · 미리보기」
 *
 * 서버 응답 `GET /api/me/levels`(계약 14 §5) 의 두 목록을 「보여 줄 차례」 한 줄로 세운다.
 *   pendingReveal — 이미 발급됐지만 연출을 아직 안 본 카드. 본인 레벨업(출석 70%)은 묻지 않으므로 M25 → M25C 로 바로 간다
 *   pendingOffers — 강사가 올려 준 레벨 안내. M25 → M25B(받을지 고르기) → 예면 M25C, 아니오면 「그대로예요」 안내
 * 카드부터 보여 주고 안내는 그다음이다 — 이미 받은 것을 먼저 축하하고, 고를 일은 뒤에 둔다(추천안 — 증거 EVIDENCE.md).
 *
 * 글자 규칙(크리틱 반려 조건 포함):
 *   - 연출·카드 안 세부 장르는 영어(Samba · Salsa …, FR-169e). 나머지 문장은 한국어
 *   - 레벨 근거는 「정규 수업 한 기간을 끝까지 마치고 출석 70% 이상」 한 문구. 출석 횟수·% 숫자는 쓰지 않는다(2026-11-20 결정)
 *   - 「강사 쪽에 평가 레벨이 남는다」는 말은 어디에도 쓰지 않는다(2026-10-15 결정)
 *   - 레벨 그림을 만들 때 쓰는 나이 표현은 글자로 쓰지 않는다. 단계 이름(입문~댄서)까지만
 */
import { genreGroupLabel, genreNameEn, type LevelDetailGenre } from './level-cards-view';

/** `GET /api/me/levels` 응답 중 연출이 읽는 칸(계약 14 §5, S6-3.10 이 pendingReveal·pendingOffers 칸을 더했다) */
export interface MeLevels {
  items: readonly { detailGenre: LevelDetailGenre; level: number; stageLabel: string }[];
  pendingReveal: readonly PendingReveal[];
  pendingOffers: readonly PendingOffer[];
}

export interface PendingReveal {
  cardId: string;
  detailGenre: LevelDetailGenre;
  level: number;
  stageLabel: string;
  reason: 'course_completion' | 'instructor_offer';
  fromLevel: number;
  issuedAt: string;
  characterKey: string;
}

export interface PendingOffer {
  offerId: string;
  detailGenre: LevelDetailGenre;
  toLevel: number;
  toStageLabel: string;
  message: string;
  instructorName: string;
}

/** 보여 줄 차례 하나 — 이미 받은 카드(reveal) 또는 받을지 고를 안내(offer) */
export type LevelUpStep =
  | { kind: 'reveal'; card: PendingReveal }
  | { kind: 'offer'; offer: PendingOffer; fromLevel: number };

/**
 * 연출 차례를 세운다. 카드 먼저(발급 순서), 그다음 안내.
 * 안내의 「지금 레벨」은 items 에서 그 세부 장르 레벨을 찾고, 없으면 0(아직 기록 없음)이다.
 */
export function buildLevelUpQueue(view: MeLevels): readonly LevelUpStep[] {
  const levelOf = (genre: LevelDetailGenre) => view.items.find((i) => i.detailGenre === genre)?.level ?? 0;
  return [
    ...view.pendingReveal.map((card): LevelUpStep => ({ kind: 'reveal', card })),
    ...view.pendingOffers.map((offer): LevelUpStep => ({ kind: 'offer', offer, fromLevel: levelOf(offer.detailGenre) })),
  ];
}

/** 숫자 뒤 조사 — 영·삼·육·십처럼 받침으로 끝나는 읽기는 「으로」(서버 levelOfferMessage 와 같은 규칙) */
function toParticle(level: number): '로' | '으로' {
  return level === 0 || level === 3 || level === 6 || level === 10 ? '으로' : '로';
}

/** 레벨 근거 한 문구(2026-11-20 결정 — 숫자 없이 하나로) */
const COMPLETION_BASIS = '정규 수업 한 기간을 끝까지 마치고 출석 70% 이상';
const OFFER_BASIS = '강사님이 올려 준 레벨로 승급';

/** M25 등급 알림 글자 */
export interface AlertText {
  genre: string;
  fromLevel: number;
  toLevel: number;
  stageLabel: string;
  main: string;
  sub: string;
  hint: string;
}

export function alertText(step: LevelUpStep): AlertText {
  if (step.kind === 'offer') {
    const { offer } = step;
    const genre = genreNameEn(offer.detailGenre);
    return {
      genre,
      fromLevel: step.fromLevel,
      toLevel: offer.toLevel,
      stageLabel: offer.toStageLabel,
      main: `${offer.instructorName} 강사님이 ${genre} 레벨을 ${offer.toLevel}(${offer.toStageLabel})${toParticle(offer.toLevel)} 올려 줬어요`,
      sub: `강사님 승급 안내 · 레벨 ${step.fromLevel} → ${offer.toLevel}`,
      hint: '화면을 누르면 카드를 받을지 골라요',
    };
  }
  const { card } = step;
  const genre = genreNameEn(card.detailGenre);
  const basis = card.reason === 'course_completion' ? COMPLETION_BASIS : OFFER_BASIS;
  return {
    genre,
    fromLevel: card.fromLevel,
    toLevel: card.level,
    stageLabel: card.stageLabel,
    main: `${genre} Level.${card.level}(${card.stageLabel})${toParticle(card.level)} 등급했습니다`,
    sub: `${basis} · 레벨 ${card.fromLevel} → ${card.level}`,
    hint: '화면을 누르면 카드를 받아요',
  };
}

/** M25B 카드 받기 선택 글자 — 강사 승급일 때만 나온다 */
export interface ChooseText {
  miniLabel: string;
  offerLine: string;
  cardLine: string;
  keepLine: string;
}

export function chooseText(offer: PendingOffer, fromLevel: number): ChooseText {
  const genre = genreNameEn(offer.detailGenre);
  return {
    miniLabel: `${genre} · Lv.${offer.toLevel}`,
    offerLine: `${offer.instructorName} 강사님이 ${genre} 레벨을 ${offer.toLevel}(${offer.toStageLabel})${toParticle(offer.toLevel)} 올려 줬어요.`,
    cardLine: `${genre} Level.${offer.toLevel}(${offer.toStageLabel}) 카드가 카드 모음에 들어가요.`,
    keepLine: `받지 않으면 지금 레벨(${fromLevel}) 그대로예요.`,
  };
}

/** M25C 등급 카드 앞면 글자·색 */
export interface CardFace {
  cardId: string;
  characterKey: string;
  level: number;
  heading: string;
  genreColor: string;
  levelLine: string;
  gaugeColor: string;
  stageLabel: string;
  foot: string;
  toastLine: string;
}

/** 장르 묶음 글자 색 — 라틴은 보드의 #00462A, 그 밖은 앱 강조색(딥 플럼). 보드에 라틴 값만 있어 나머지는 추천안 */
const LATIN_INK = '#00462A';
const OTHER_INK = '#5B3A63';
/** 게이지 색(FR-169c) — 남 파랑 · 여 빨강 */
const GAUGE_MALE = '#2D2A78';
const GAUGE_FEMALE = '#9A2626';

/** 발급일 「2026-11-25」 — 한국 시간 날짜(UTC+9). 서버 issuedAt 은 UTC ISO 다 */
export function kstDate(iso: string): string {
  const kst = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

export function cardFace(card: PendingReveal): CardFace {
  const genre = genreNameEn(card.detailGenre);
  const group = genreGroupLabel(card.detailGenre);
  const basis = card.reason === 'course_completion' ? COMPLETION_BASIS : OFFER_BASIS;
  // 열쇠 「묶음/성별_단계」에서 성별(m·f)만 읽는다 — 그림과 게이지 색이 같은 회원 성별을 따른다
  const female = card.characterKey.includes('/f_');
  return {
    cardId: card.cardId,
    characterKey: card.characterKey,
    level: card.level,
    heading: group === null ? genre : `${genre} · ${group}`,
    genreColor: group === '댄스스포츠 라틴' ? LATIN_INK : OTHER_INK,
    levelLine: `Level ${card.level} · ${genre}`,
    gaugeColor: female ? GAUGE_FEMALE : GAUGE_MALE,
    stageLabel: card.stageLabel,
    foot: `${kstDate(card.issuedAt)} 발급 · ${basis} · 레벨 ${card.fromLevel} → ${card.level}`,
    toastLine: `레벨 카드 모음 · ${genre} Lv.${card.level} 추가됨`,
  };
}

/** 아니오를 골랐을 때 안내(아티팩트 장면 5) */
export function keptToast(level: number): string {
  return `지금 레벨 ${level} 그대로예요`;
}
