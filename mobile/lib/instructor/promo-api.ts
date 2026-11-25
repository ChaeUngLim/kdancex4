/**
 * 홍보 이미지·소개 문구(보드 I32 · I32B · I32C · I32D · I41 · I42 · I43)의 서버 경로·응답 모양·순수 계산 — SX-6.9(앱 홍보 이미지·소개 문구 화면).
 *
 * 부르는 경로(계약 _workspace/03_contracts/16-ai-agent.md §4-7):
 *   GET  /api/ai/promo-image/options?classId=…   칩·예시·자동 조건·엔진 카드·남은 횟수·마지막 생성(화면을 열 때 한 번)
 *   POST /api/ai/promo-images                    만들기(Idempotency-Key). 막는 입력이면 422, 횟수 소진이면 409
 *   GET  /api/ai/promo-images/{generationId}     만드는 중이면 2초마다 읽는다(계약 추천값)
 *   GET  /api/ai/promo-images/history?limit=1    지난 입력 불러오기
 *   POST /api/ai/class-intro-drafts              소개 문구 초안(강조할 점 한 줄)
 *   GET·PUT /api/classes/{classId}/promo-assets  표지·소개 문구 저장(전체 교체) · 검토 확인
 *
 * 이 파일의 계산은 모두 순수 함수다(렌더 중에 바로 부른다). 서버 호출은 버튼 핸들러에서만 한다.
 */
import { apiFetch } from '../api';
import type { Genre } from '../onboarding/types';

// ---- 응답 모양 -----------------------------------------------------------------------------------

export type PromoChipKey = 'who' | 'mood' | 'place' | 'color';
export const PROMO_CHIP_KEYS: readonly PromoChipKey[] = ['who', 'mood', 'place', 'color'];
export type PromoChipValue = string | { custom: string };
export type PromoChips = Partial<Record<PromoChipKey, PromoChipValue>>;

export interface PromoEngineCard {
  id: string;
  label: string;
  speed: string;
  etaSeconds: number | null;
  available: boolean;
  blockedScope: 'monthly' | 'engine_daily' | null;
  resetsAt: string | null;
  lastPicked: boolean;
}

export interface PromoUsage {
  dailyLimit: number;
  used: number;
  remaining: number;
  resetsAt: string;
  betaPhase: boolean;
  freeQuotaExhausted: boolean;
  freeQuotaScope: 'monthly' | 'engine_daily' | null;
}

export type PromoGenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface PromoLastGeneration {
  generationId: string;
  status: PromoGenerationStatus;
  imageUrl: string | null;
  engine: string;
  sentence: string;
  chips: PromoChips;
  autoConditionIds: string[];
  createdOn: string;
}

export interface PromoOptions {
  genre: Genre;
  genreChip: { genre: Genre; label: string; locked: true };
  requiredChips: { key: PromoChipKey; label: string; options: string[] }[];
  examples: { id: string; genre: Genre; genreLabel: string; text: string; chips: Record<PromoChipKey, string> }[];
  autoConditions: { id: string; label: string; defaultOn: boolean; removable: boolean }[];
  engines: PromoEngineCard[];
  preselectedEngineId: string | null;
  usage: PromoUsage;
  lastGeneration: PromoLastGeneration | null;
  maxSentenceLength: number;
}

export interface PromoGeneration {
  generationId: string;
  status: PromoGenerationStatus;
  imageUrl: string | null;
  engine: string;
  refunded: boolean;
  remaining: number;
  failureCode: string | null;
}

export type PromoIntroSource = 'ai' | 'ai_edited' | 'user';

export interface PromoAssets {
  classId: string;
  coverSource: 'uploaded_photo' | 'ai_image' | null;
  coverUrl: string | null;
  introText: string | null;
  introSource: PromoIntroSource | null;
  aiImageGenerationId: string | null;
  introDraftId: string | null;
  reviewedAt: string | null;
}

export interface IntroDraft {
  draftId: string;
  body: string;
  facts: { schedule: string; sessionCount: number; price: string; level: string | null };
}

// ---- 경로 ----------------------------------------------------------------------------------------

export const promoOptionsPath = (classId: string): string => `/api/ai/promo-image/options?classId=${encodeURIComponent(classId)}`;
export const promoAssetsPath = (classId: string): string => `/api/classes/${encodeURIComponent(classId)}/promo-assets`;

export function createPromoImage(
  body: { classId: string; chips: PromoChips; sentence: string; autoConditionIds: string[]; engineId: string | null },
  idempotencyKey: string,
): Promise<{ generationId: string; status: PromoGenerationStatus; remaining: number }> {
  const { engineId, ...rest } = body;
  return apiFetch('/api/ai/promo-images', { method: 'POST', body: engineId === null ? rest : { ...rest, engineId }, idempotencyKey });
}

export function readPromoImage(generationId: string): Promise<PromoGeneration> {
  return apiFetch(`/api/ai/promo-images/${encodeURIComponent(generationId)}`);
}

export function readLatestPromoInput(): Promise<{ items: { sentence: string; chips: PromoChips; autoConditionIds: string[] }[] }> {
  return apiFetch('/api/ai/promo-images/history?limit=1');
}

export function createIntroDraft(classId: string, emphasis: string): Promise<IntroDraft> {
  const trimmed = emphasis.trim();
  return apiFetch('/api/ai/class-intro-drafts', { method: 'POST', body: trimmed === '' ? { classId } : { classId, emphasis: trimmed } });
}

/** 홍보 자료 저장 — 전체 교체라 늘 모든 칸을 보낸다. 사진(포스터)이 붙어 있으면 서버가 사진을 먼저 쓴다 */
export function savePromoAssets(
  classId: string,
  body: {
    aiImageGenerationId: string | null;
    introText: string | null;
    introSource: PromoIntroSource | null;
    introDraftId: string | null;
    reviewConfirmed: boolean;
  },
): Promise<PromoAssets> {
  return apiFetch(promoAssetsPath(classId), { method: 'PUT', body });
}

// ---- 순수 계산 -----------------------------------------------------------------------------------

/** 칩 값 → 글자. 고르지 않았으면 null */
export function chipText(value: PromoChipValue | undefined): string | null {
  if (value === undefined) return null;
  const text = typeof value === 'string' ? value : value.custom;
  return text.trim() === '' ? null : text.trim();
}

/** 빠진 필수 항목 이름(누가·분위기·장소·색감) — 하나라도 있으면 만들기가 잠긴다(서버 PROMO_REQUIRED_MISSING 과 같은 판정) */
export function missingChipLabels(chips: PromoChips, requiredChips: PromoOptions['requiredChips']): string[] {
  return requiredChips.filter((chip) => chipText(chips[chip.key]) === null).map((chip) => chip.label);
}

/**
 * 고른 칩으로 문장을 채운다 — 「{누가}이/가 {장소}에서 {색감} 아래 {분위기 부사} {춤}을/를 추는 모습」.
 * 서버 원본은 admin-web/lib/domain/promo-image-chips.ts 의 fillPromoSentence 다(이 앱은 admin-web 코드를 가져올 수 없어 같은 규칙을 옮겼다).
 * 판정은 서버가 다시 하므로, 문장이 조금 달라도 만들기 결과는 틀리지 않는다.
 */
export function fillSentence(chips: PromoChips, danceWord: string): string {
  const who = chipText(chips.who);
  const place = chipText(chips.place);
  const color = chipText(chips.color);
  const mood = chipText(chips.mood);
  if (who === null && place === null && color === null && mood === null) return '';
  const parts = [
    who && `${who}${josa(who, '이', '가')}`,
    place && `${place}에서`,
    color && `${color} 아래`,
    mood && moodAdverb(mood),
    `${danceWord}${josa(danceWord, '을', '를')} 추는 모습`,
  ];
  return parts.filter((p): p is string => Boolean(p)).join(' ');
}

/** 「열정적인」→「열정적으로」, 「우아한」→「우아하게」, 그 밖은 「~ 분위기로」 */
function moodAdverb(mood: string): string {
  if (mood.endsWith('적인')) return `${mood.slice(0, -1)}으로`;
  if (mood.endsWith('한')) return `${mood.slice(0, -1)}하게`;
  return `${mood} 분위기로`;
}

/** 받침이 있으면 앞 조사, 없으면 뒤 조사(한글 음절 (코드-0xAC00)%28 ≠ 0 이면 받침) */
function josa(word: string, withFinal: string, withoutFinal: string): string {
  const code = word.charCodeAt(word.length - 1);
  const isHangul = code >= 0xac00 && code <= 0xd7a3;
  return isHangul && (code - 0xac00) % 28 !== 0 ? withFinal : withoutFinal;
}

/**
 * 칩을 바꿨을 때 새 문장 — 사람이 채워진 문장 뒤에 덧붙인 글은 남긴다.
 * 지금 문장이 옛 칩 문장으로 시작하지 않으면(사람이 앞부분을 고쳐 썼으면) 덧붙인 글을 알 수 없으니 새 칩 문장만 쓴다.
 */
export function refillSentence(current: string, oldChips: PromoChips, newChips: PromoChips, danceWord: string): string {
  const oldBase = fillSentence(oldChips, danceWord);
  const tail = oldBase !== '' && current.startsWith(oldBase) ? current.slice(oldBase.length) : oldBase === '' ? current : '';
  return `${fillSentence(newChips, danceWord)}${tail}`;
}

/** 점 N개 — 남은 만큼 ●, 쓴 만큼 ○(「남은 횟수 2/3 ●●○」) */
export function usageDots(remaining: number, limit: number): string {
  const left = Math.max(0, Math.min(remaining, limit));
  return `${'●'.repeat(left)}${'○'.repeat(limit - left)}`;
}

/** 「남은 횟수 2/3 ●●○」 — 분자는 늘 남은 횟수(spec FR-061a 표기 통일) */
export function usageLabel(remaining: number, limit: number): string {
  return `남은 횟수 ${remaining}/${limit} ${usageDots(remaining, limit)}`;
}

/** 막힌 까닭 한 줄(서버 reason 이 없을 때만 쓰는 기본 문장) */
export const BLOCKED_KIND_LINES: Readonly<Record<string, string>> = {
  explicit: '선정적인 내용은 만들지 않아요.',
  violence: '폭력적인 내용은 만들지 않아요.',
  real_person: '실제 사람의 얼굴을 흉내 낸 그림은 만들지 않아요.',
  trademark: '다른 회사의 상표·로고는 넣지 않아요.',
};

/** 생성이 끝났나(성공·실패) — 끝나지 않았으면 계속 읽는다 */
export const isFinished = (status: PromoGenerationStatus): boolean => status === 'succeeded' || status === 'failed';
