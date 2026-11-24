/**
 * SX-6.2(장르별 기본 조건·글자 없음 조건) — 홍보 이미지 요청에 「자동으로 더해지는 조건」을 붙이는 순수 함수
 *
 * 무엇을 하나: 강사·대표가 쓴 문장 말고 시스템이 덧붙이는 조건을 정한다(FR-061a 「시스템이 덧붙이는 것은 세 가지뿐」).
 *   - ② 이미지 안 글자 없음(`no_text`) — 끌 수 없다. 요청에서 빼도 항상 붙는다.
 *   - ③ 수업 장르에 맞는 기본 조건 — 장르 자세(`genre_pose`)와 공통 구도(`full_body`). 화면에 한국어로 보이고 끌 수 있다.
 *   (① 영어로 옮기기는 에이전트의 대화 모델이 한다 — 여기서는 조건마다 영어 문장을 함께 실어 보낼 뿐이다.)
 *
 *   - `promoAutoConditionOptions(genre)` — 화면에 보일 조건 카드 목록(계약 16 §4-7 options 의 `autoConditions`).
 *   - `resolvePromoAutoConditions(genre, ids)` — 사람이 켠 id 로 실제 붙일 조건을 고른다. 글자 없음은 언제나 넣는다.
 *   - `buildPromoImageAgentPayload(...)` — 에이전트 `POST /v1/jobs`(`kind: promo_image`)의 payload(계약 16 §7-1).
 *
 * 왜 설정 파일인가: 장르별 문장은 아직 추천안이라(spec 「사용자 확인 대기」) 바뀔 수 있다. spec 이 「코드에 박지 않고 설정값으로」
 *   두라고 해서 `promo-image-conditions.json` 에 둔다. 설정 표(`ai_settings` 의 `promo_image.auto_conditions`)가 생기면 이 파일이
 *   그 기본값이 된다. 함수는 DB·시간·네트워크를 쓰지 않아 화면과 서버가 같은 결과를 낸다.
 */
import { z } from "zod";

import rawSettings from "./promo-image-conditions.json";
import { GENRES, type Genre } from "./constants";

/** 끌 수 없는 「이미지 안 글자 없음」 조건 id */
export const PROMO_NO_TEXT_CONDITION_ID = "no_text";

// 조건 하나의 문장 — 화면에 보일 한국어(label)와 에이전트에 보낼 영어(textEn)
const textSchema = z.object({ label: z.string().min(1), textEn: z.string().min(1) });

// 조건은 「장르마다 다른 문장(perGenre)」이거나 「모든 장르에 같은 문장(all)」 둘 중 하나만 갖는다
const conditionSchema = z
  .object({
    id: z.string().regex(/^[a-z_]+$/),
    removable: z.boolean(),
    // 네 장르를 모두 채워야 한다 — 한 장르가 빠진 채 배포되면 그 장르 수업만 조건이 사라지는 일을 막는다
    perGenre: z.record(z.enum(GENRES), textSchema).optional(),
    all: textSchema.optional(),
  })
  .refine((c) => (c.perGenre === undefined) !== (c.all === undefined), "조건은 perGenre 와 all 중 하나만 둔다");

const settingsSchema = z.object({
  conditions: z
    .array(conditionSchema)
    .min(1)
    .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, "조건 id 가 겹친다")
    // 글자 없음 조건은 설정을 고쳐도 빠지거나 끌 수 있게 되면 안 된다(FR-061a — 생성 모델은 한글을 못 그린다)
    .refine(
      (cs) => cs.some((c) => c.id === PROMO_NO_TEXT_CONDITION_ID && !c.removable),
      "no_text 조건이 있어야 하고 removable 은 false 여야 한다",
    ),
});

export type PromoAutoConditionSettings = z.infer<typeof settingsSchema>;
type PromoAutoConditionSetting = PromoAutoConditionSettings["conditions"][number];

/** 설정 파일에서 읽은 조건 설정(불러오는 순간 zod 검사를 통과한 값) */
export const PROMO_AUTO_CONDITION_SETTINGS: PromoAutoConditionSettings = settingsSchema.parse(rawSettings);

/** 화면 카드 한 장 — 계약 16 §4-7 `autoConditions[]` 모양 */
export interface PromoAutoConditionOption {
  id: string;
  label: string;
  /** 처음 화면을 열 때 켜져 있는가 — 지금 조건은 모두 켠 채로 시작한다 */
  defaultOn: boolean;
  removable: boolean;
}

/** 실제 요청에 붙는 조건 하나 */
export interface PromoAppliedCondition {
  id: string;
  label: string;
  textEn: string;
}

/** 그 장르에 쓸 문장을 꺼낸다 — 장르별 문장이 있으면 그것, 없으면 공통 문장 */
function textFor(setting: PromoAutoConditionSetting, genre: Genre): z.infer<typeof textSchema> {
  // 스키마가 perGenre(네 장르 전부) 또는 all 하나를 보장하므로 둘 중 하나는 반드시 있다
  return (setting.perGenre?.[genre] ?? setting.all)!;
}

/** 화면에 보일 「자동으로 더해지는 조건」 카드 목록 — 설정 순서 그대로 */
export function promoAutoConditionOptions(genre: Genre): PromoAutoConditionOption[] {
  return PROMO_AUTO_CONDITION_SETTINGS.conditions.map((c) => ({
    id: c.id,
    label: textFor(c, genre).label,
    defaultOn: true,
    removable: c.removable,
  }));
}

/**
 * 사람이 켠 조건 id 로 실제 붙일 조건을 고른다(수용 ②③).
 * - 끌 수 있는 조건은 `enabledIds` 에 있을 때만 붙는다 — 장르 조건을 끄면 붙지 않는다.
 * - 끌 수 없는 조건(글자 없음)은 `enabledIds` 에 없어도 언제나 붙는다.
 * - 알 수 없는 id 는 무시하고, 같은 id 가 여러 번 와도 한 번만, 순서는 설정 순서다. 받은 배열은 바꾸지 않는다.
 */
export function resolvePromoAutoConditions(
  genre: Genre,
  enabledIds: readonly string[],
): { applied: PromoAppliedCondition[]; appliedIds: string[] } {
  const enabled = new Set(enabledIds);
  const applied = PROMO_AUTO_CONDITION_SETTINGS.conditions
    .filter((c) => !c.removable || enabled.has(c.id))
    .map((c) => ({ id: c.id, ...textFor(c, genre) }));
  return { applied, appliedIds: applied.map((c) => c.id) };
}

/** 에이전트에 보내는 홍보 이미지 작업 payload — 계약 16 §7-1 `promo_image` */
export interface PromoImageAgentPayload {
  generationId: string;
  genre: Genre;
  /** 강사·대표가 쓴 문장 그대로 — 시스템은 문장을 고치지 않고 조건을 따로 싣는다(FR-061a) */
  sentenceKo: string;
  autoConditions: { id: string; textEn: string }[];
  /** 이미지 안 글자 없음 — 언제나 true. 에이전트도 이 표시를 보고 글자 금지 조건을 넣는다 */
  textless: true;
}

export function buildPromoImageAgentPayload(input: {
  generationId: string;
  genre: Genre;
  sentenceKo: string;
  autoConditionIds: readonly string[];
}): PromoImageAgentPayload {
  const { applied } = resolvePromoAutoConditions(input.genre, input.autoConditionIds);
  return {
    generationId: input.generationId,
    genre: input.genre,
    sentenceKo: input.sentenceKo,
    autoConditions: applied.map((c) => ({ id: c.id, textEn: c.textEn })),
    textless: true,
  };
}
