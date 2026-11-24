/**
 * 강사 「레벨 정하기」(보드 I23 회원 관리 탭의 체크 상자 + 시트) — 경로 · 응답 모양 · 화면 글자 계산. S6-3.6(앱 강사 레벨·후보 화면).
 *
 * 부르는 경로(계약 14 §6-1, 서버는 S6-3.4 가 만들었다)
 *   GET  /api/instructor/offerings/{offeringId}/member-levels   결제 완료 수강생의 지금 레벨과 「내 평가 레벨」
 *   POST /api/instructor/level-evaluations                      「최종 적용」 — 평가 레벨 저장, 회원 레벨보다 높으면 승급 안내
 *
 * 규칙(spec FR-169d(강사 레벨 등급 조절), 2026-11-24 개정)
 *  - 레벨 올리기는 **멤버십 강사**의 기능이다. 멤버십이 아니면 서버가 403 INSTRUCTOR_MEMBERSHIP_REQUIRED 를 준다 →
 *    화면은 「선택한 n명 레벨 올리기」를 잠그고 「멤버십 강사만 쓸 수 있어요」를 보인다.
 *  - 받는 **회원**은 멤버십과 상관없다 — 체크 상자는 멤버십으로 잠그지 않는다.
 *  - 회원 레벨보다 높게 정하면 회원에게 「○○ 강사님이 … 올려 줬어요」 안내가 가고, 낮거나 같으면 내 평가 레벨에만 남는다.
 *  - 회원 레벨은 이 화면에서 바뀌지 않는다. 회원이 승급을 골라야 오른다.
 *
 * 이 파일의 계산 함수는 입력을 바꾸지 않는 순수 함수다 — 렌더 중에 바로 불러 쓴다.
 */
import { apiFetch } from '../api';
import type { LevelDetailGenre } from '../levels/level-cards-view';

// ---- 응답 모양(admin-web instructor-level-evaluations.ts 의 zod 스키마와 같다) -------------------------

export interface MemberLevelItem {
  memberId: string;
  displayName: string;
  gender: 'male' | 'female';
  monthsEnrolled: number;
  absenceScheduled: boolean;
  /** 회원의 그 세부 장르 지금 레벨(기록이 없으면 0) */
  level: number;
  stageLabel: string;
  /** 이 강사가 매긴 평가 레벨(없으면 null). 다른 강사의 평가는 오지 않는다 */
  myEvaluation: number | null;
}

export interface MemberLevels {
  offeringId: string;
  detailGenre: LevelDetailGenre;
  items: MemberLevelItem[];
}

export type LevelApplyResult =
  | { memberId: string; evaluationSaved: true; offerSent: true; toLevel: number }
  | { memberId: string; evaluationSaved: true; offerSent: false; reason: 'not_higher_than_member_level' };

export interface LevelApplyResponse {
  results: LevelApplyResult[];
}

export const LEVEL_MIN = 0;
export const LEVEL_MAX = 10;

/** 멤버십이 아닌 강사에게 서버가 주는 오류 코드(계약 14 §6-3) */
export const INSTRUCTOR_MEMBERSHIP_REQUIRED = 'INSTRUCTOR_MEMBERSHIP_REQUIRED';
/** 잠긴 버튼 옆 안내(로드맵 S6-3.6 메모의 문구 그대로) */
export const MEMBERSHIP_LOCK_TEXT = '멤버십 강사만 쓸 수 있어요';

export function memberLevelsPath(offeringId: string): string {
  return `/api/instructor/offerings/${encodeURIComponent(offeringId)}/member-levels`;
}

/** 「최종 적용」 — 버튼 핸들러에서만 부른다(화면을 열 때 자동으로 부르지 않는다) */
export function applyLevelEvaluation(body: { offeringId: string; detailGenre: LevelDetailGenre; memberIds: string[]; level: number }): Promise<LevelApplyResponse> {
  return apiFetch<LevelApplyResponse>('/api/instructor/level-evaluations', { method: 'POST', body });
}

// ---- 화면 글자 ----------------------------------------------------------------------------------

/** 세부 장르 한국어 이름(admin-web LEVEL_GENRE_LABEL_KO 와 같다). 강사 화면 문장은 한국어로 쓴다 */
export const DETAIL_GENRE_KO: Readonly<Record<LevelDetailGenre, string>> = {
  cha_cha_cha: '차차차',
  samba: '쌈바',
  rumba: '룸바',
  paso_doble: '파소도블레',
  jive: '자이브',
  waltz: '왈츠',
  tango: '탱고',
  viennese_waltz: '비엔나 왈츠',
  slow_foxtrot: '폭스트롯',
  quickstep: '퀵스텝',
  argentine_tango: '아르헨티나 탱고',
  swing: '스윙',
  salsa: '살사',
  bachata: '바차타',
};

/** 레벨 단계 이름(spec FR-161) — 0~1 입문 · 2~3 초급 · 4~5 초중급 · 6~7 중급 · 8~9 고급 · 10 댄서 */
export function stageLabelOf(level: number): string {
  if (level >= 10) return '댄서';
  if (level >= 8) return '고급';
  if (level >= 6) return '중급';
  if (level >= 4) return '초중급';
  if (level >= 2) return '초급';
  return '입문';
}

/** 시트 아래 눈금 한 줄(보드 I23) */
export const STAGE_SCALE_LINE = '0~1 입문 · 2~3 초급 · 4~5 초중급 · 6~7 중급 · 8~9 고급 · 10 댄서';

/** 명단 오른쪽 레벨 칩 「Lv.5 초중급」 */
export function levelChipText(item: Pick<MemberLevelItem, 'level' | 'stageLabel'>): string {
  return `Lv.${item.level} ${item.stageLabel}`;
}

/**
 * 시트를 열 때의 처음 값 — 고른 회원 가운데 가장 높은 값(내 평가가 있으면 그 값, 없으면 회원 레벨)보다 한 칸 위.
 * 보드 I23: 둘 다 Lv.3 → 4. 10 을 넘지 않는다. 아무도 안 골랐으면 0.
 */
export function initialSheetLevel(selected: readonly MemberLevelItem[]): number {
  if (selected.length === 0) return LEVEL_MIN;
  const top = Math.max(...selected.map((m) => m.myEvaluation ?? m.level));
  return Math.min(LEVEL_MAX, top + 1);
}

/** 시트 머리 아래 줄 「지금 · 김서연 Lv.3 · 이도현 Lv.3」 — 셋을 넘으면 「외 n명」 */
export function sheetCurrentLine(selected: readonly MemberLevelItem[]): string {
  const shown = selected.slice(0, 3).map((m) => `${m.displayName} Lv.${m.level}`);
  const rest = selected.length - shown.length;
  return `지금 · ${shown.join(' · ')}${rest > 0 ? ` 외 ${rest}명` : ''}`;
}

/** 숫자 뒤 조사 — 서버 안내 문장과 같게(3·6·10 은 「으로」, 나머지는 「로」) */
function toParticle(level: number): string {
  return level === 3 || level === 6 || level === 10 ? '으로' : '로';
}

/**
 * 시트의 보라 상자 설명. 고른 값이 회원 레벨보다 높은 사람에게만 안내가 간다(서버와 같은 규칙).
 *   안내 문장의 강사 이름은 서버가 붙이므로 여기서는 이름 없이 「강사님이 …」 모양만 보여 준다.
 */
export function sheetExplain(selected: readonly MemberLevelItem[], detailGenre: LevelDetailGenre, level: number): { sendTo: number; keepOnly: number; message: string } {
  const sendTo = selected.filter((m) => level > m.level).length;
  const message = `「강사님이 ${DETAIL_GENRE_KO[detailGenre]} 레벨을 ${level}(${stageLabelOf(level)})${toParticle(level)} 올려 줬어요」`;
  return { sendTo, keepOnly: selected.length - sendTo, message };
}

/** 적용한 뒤 한 줄 결과 「2명에게 승급 안내를 보냈어요 · 1명은 내 평가 레벨에만 남겼어요」 */
export function applyResultLine(response: LevelApplyResponse): string {
  const sent = response.results.filter((r) => r.offerSent).length;
  const kept = response.results.length - sent;
  const parts: string[] = [];
  if (sent > 0) parts.push(`${sent}명에게 승급 안내를 보냈어요`);
  if (kept > 0) parts.push(`${kept}명은 내 평가 레벨에만 남겼어요`);
  return parts.join(' · ');
}
