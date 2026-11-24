// SX-2.4(낮은 신뢰도·AI 생성 표시) — 포스터 읽기 칸마다 화면에 붙일 표시를 정하는 순수 함수(DB·화면 없이 돈다).
//   계약: _workspace/03_contracts/16-ai-agent.md §4-6(needsCheck · valueSource) — 「화면 표시 문구는 앱이 붙인다」
//   요구: FR-075(확인필요 표시) · FR-258(AI 생성 표시)
//
// 처음 보는 사람용 요약
//   검토 화면(SX-2.5)은 칸마다 작은 딱지를 붙인다. 딱지는 두 가지뿐이다.
//   ① 「확인필요」 — AI 가 채웠는데 자신이 없거나(신뢰도 < 기준) 못 읽은 칸. 사람이 아직 「맞다」고 확인하지 않았을 때만 붙는다
//   ② 「AI 생성」 — 지금 칸에 든 값이 AI 가 만든 값일 때. 사람이 확인만 하고 고치지 않았다면 값은 여전히 AI 것이라 남는다
//   사람이 고치거나(ai_edited) 직접 채운(user) 칸은 사람 값이므로 딱지가 없다.
//   판정 기준을 화면마다 따로 쓰면 어긋나므로, 화면은 이 함수 결과만 그린다.
//
//   SX-2.6(포스터 초안 기간 칸) — 기간(개강일·종료일·회차 수)이 비어 「채워야 하는」 칸은 누가 비웠든(AI 가 못 읽음 · 사람이 비움)
//   언제나 「확인필요」다. 이런 칸은 「맞아요」로 넘길 수 없고 값을 넣어야 풀린다(FR-073 하위 불릿 「채울 때까지 제출을 막는다」).
//   어느 칸이 그런지는 poster-extraction.ts 의 missingPeriodKeys 하나로 정한다(서버 검토 경로도 같은 함수를 쓴다).
import type { PosterFieldKey, PosterValueSource } from "./constants";
import { missingPeriodKeys, needsCheckFor, POSTER_CONFIDENCE_MIN, type PosterFieldValue } from "./poster-extraction";

/** 화면에 그대로 찍는 딱지 글자(O2 보드) */
export const POSTER_BADGE_LABELS = { needsCheck: "확인필요", aiGenerated: "AI 생성" } as const;

export type PosterBadgeLabel = (typeof POSTER_BADGE_LABELS)[keyof typeof POSTER_BADGE_LABELS];

/** 판정에 쓰는 칸 정보 — GET …/poster-extractions/{id} 응답의 fields 한 줄과 같은 이름 */
export interface PosterFieldDisplayInput {
  key: PosterFieldKey;
  value: PosterFieldValue;
  confidence: number | null;
  valueSource: PosterValueSource;
  confirmedAt: string | null;
}

export interface PosterFieldBadges {
  needsCheck: boolean;
  aiGenerated: boolean;
  /** 화면에 그릴 순서대로(확인필요가 먼저 — 더 급하다) */
  labels: PosterBadgeLabel[];
}

/** 신뢰도가 숫자가 아니거나 0~1 밖이면 「신뢰도 없음」으로 본다 — 이상한 값이 기준을 넘는 것처럼 보이지 않게 */
const usableConfidence = (confidence: number | null): number | null =>
  confidence !== null && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null;

/**
 * 칸 하나의 딱지를 정한다. min 은 「확인필요」 기준 신뢰도(설정 poster.confidence_min, 기본 0.80).
 * mustFill 은 「비어서 채워야 하는 기간 칸」인가(posterMustFillKeys 결과) — 그러면 확인 여부와 상관없이 확인필요다.
 */
export function posterFieldBadges(field: PosterFieldDisplayInput, min: number = POSTER_CONFIDENCE_MIN, mustFill: boolean = false): PosterFieldBadges {
  // 채워야 하는 빈 기간 칸 — 값이 없으니 「AI 생성」은 아니고, 「맞아요」로도 풀리지 않는 확인필요다
  if (mustFill) return { needsCheck: true, aiGenerated: false, labels: [POSTER_BADGE_LABELS.needsCheck] };
  // 사람이 고치거나 직접 채운 칸은 사람 값 — 딱지 없음
  if (field.valueSource !== "ai") return { needsCheck: false, aiGenerated: false, labels: [] };

  // 확인필요: 사람이 아직 확인하지 않았고, 값·신뢰도 판정(poster-extraction.ts 의 needsCheckFor)에 걸릴 때
  const needsCheck = field.confirmedAt === null && needsCheckFor(field.value, usableConfidence(field.confidence), min);
  // AI 생성: 칸에 AI 가 만든 값이 실제로 들어 있을 때(못 읽은 빈 칸은 AI 가 만든 값이 없다)
  const aiGenerated = field.value !== null;

  const labels: PosterBadgeLabel[] = [];
  if (needsCheck) labels.push(POSTER_BADGE_LABELS.needsCheck);
  if (aiGenerated) labels.push(POSTER_BADGE_LABELS.aiGenerated);
  return { needsCheck, aiGenerated, labels };
}

/** 비어서 **채워야 하는** 기간 칸 키 목록(SX-2.6). 「맞아요」 체크를 보이지 않고, 값을 넣을 때까지 검토 끝·제출을 막는다 */
export function posterMustFillKeys(fields: readonly PosterFieldDisplayInput[]): PosterFieldKey[] {
  return missingPeriodKeys(Object.fromEntries(fields.map((f) => [f.key, f.value])));
}

/** 아직 「확인필요」인 칸 키 목록(원래 순서). 검토 화면의 「확인필요 N칸」 안내와 검토 버튼 막기에 쓴다 */
export function posterNeedsCheckKeys(fields: readonly PosterFieldDisplayInput[], min: number = POSTER_CONFIDENCE_MIN): PosterFieldKey[] {
  const mustFill = posterMustFillKeys(fields);
  return fields.filter((f) => posterFieldBadges(f, min, mustFill.includes(f.key)).needsCheck).map((f) => f.key);
}
