/**
 * SX-6.1(필수 4항목 검증·문장 채우기) — 홍보 이미지 만들기 전 「필수 칩 4항목」 판정과 문장 채우기
 *
 * 무엇을 하나: 강사·대표가 홍보 이미지를 만들 때 누가·분위기·장소·색감(조명) 네 칸을 칩으로 고른다(FR-061a).
 *   - `checkPromoRequiredChips` — 네 칸 중 빠진 칸이 있으면 거부하고 빠진 칸 이름을 돌려준다.
 *     `POST /api/ai/promo-images` 2단계의 422 `PROMO_REQUIRED_MISSING` + `missing` 이 이 결과를 그대로 쓴다(계약 16 §4-7).
 *   - `promoGenreChip` — 장르는 사람이 고르지 않는다. 등록 중인 수업의 장르 값으로 잠긴 칩을 만든다.
 *   - `fillPromoSentence` — 고른 칩으로 입력 칸 문장을 채운다(보드 I32B). 사람은 그 뒤에 자유롭게 덧붙인다.
 *
 * 왜 순수 함수인가: 화면(만들기 버튼 잠금)과 서버(422 거부)가 같은 판정을 써야 어긋나지 않는다. DB·시간·네트워크를 쓰지 않아
 *   양쪽에서 그대로 부를 수 있다.
 *
 * 칩 낱말은 코드에 박지 않고 설정 파일 `promo-image-chips.json` 에서 읽는다 — 낱말 목록은 아직 추천안(spec 「사용자 확인 대기」)이라
 *   바뀔 수 있기 때문이다. 설정 표(ai_settings `promo_image.chips`)가 생기면 이 파일이 그 기본값이 된다.
 */
import { z } from "zod";

import rawSettings from "./promo-image-chips.json";
import { GENRES, CLASS_SUB_GENRES, type ClassSubGenre, type Genre } from "./constants";

/** 필수 4항목의 키 — 화면에 보이는 순서와 같다 */
export const PROMO_REQUIRED_CHIP_KEYS = ["who", "mood", "place", "color"] as const;
export type PromoRequiredChipKey = (typeof PROMO_REQUIRED_CHIP_KEYS)[number];

// 설정 파일 모양 검사 — 파일을 잘못 고치면(항목 누락·빈 목록) 서버가 뜰 때 바로 알 수 있게 불러오는 순간 zod 로 확인한다
const chipSchema = z.object({
  key: z.enum(PROMO_REQUIRED_CHIP_KEYS),
  label: z.string().min(1),
  options: z.array(z.string().min(1)).min(1),
});
const danceWordsSchema = z.object({ default: z.string().min(1) }).catchall(z.string().min(1));
const settingsSchema = z.object({
  requiredChips: z
    .array(chipSchema)
    .refine(
      (chips) => chips.map((c) => c.key).join(",") === PROMO_REQUIRED_CHIP_KEYS.join(","),
      "requiredChips 는 who·mood·place·color 네 개를 이 순서로 둔다",
    ),
  genreDanceWords: z.record(z.enum(GENRES), danceWordsSchema),
});

export type PromoChipSettings = z.infer<typeof settingsSchema>;
export type PromoChipSetting = z.infer<typeof chipSchema>;

/** 설정 파일에서 읽은 칩 설정(검사를 통과한 값) */
export const PROMO_CHIP_SETTINGS: PromoChipSettings = settingsSchema.parse(rawSettings);

/** 한 칸의 값 — 칩 낱말 하나, 또는 `직접 쓰기` 로 넣은 글(`{ custom }`). 계약 16 §4-7 의 `chips` 값 모양 */
export type PromoChipValue = string | { custom: string };
export type PromoChipSelections = Partial<Record<PromoRequiredChipKey, PromoChipValue>>;

export type PromoRequiredCheck =
  | { ok: true }
  | {
      ok: false;
      code: "PROMO_REQUIRED_MISSING";
      /** 빠진 칸 키(계약의 `missing`) — 화면 순서대로 */
      missing: PromoRequiredChipKey[];
      /** 빠진 칸 이름(화면에 보일 글) */
      missingLabels: string[];
      /** 안내 문장 — 예: 「장소를 골라 주세요.」 */
      message: string;
    };

/**
 * 한 칸에 실제로 쓸 글을 꺼낸다. 채우지 않은 칸이면 null.
 * - 칩 값(문자열)은 그 칸의 칩 목록에 있는 낱말일 때만 인정한다. 칩에 없는 표현은 `직접 쓰기` 로만 들어온다(FR-061a).
 * - `직접 쓰기` 는 앞뒤 공백을 떼고 글자가 남으면 채운 것으로 본다.
 */
function chipText(setting: PromoChipSetting, value: PromoChipValue | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value === "string") return setting.options.includes(value) ? value : null;
  const custom = value.custom.trim();
  return custom.length > 0 ? custom : null;
}

/** 필수 4항목 판정 — 하나라도 빠지면 거부하고 빠진 칸을 모두 알려 준다(수용 ①) */
export function checkPromoRequiredChips(chips: PromoChipSelections): PromoRequiredCheck {
  const missingSettings = PROMO_CHIP_SETTINGS.requiredChips.filter((s) => chipText(s, chips[s.key]) === null);
  if (missingSettings.length === 0) return { ok: true };

  const missingLabels = missingSettings.map((s) => s.label);
  const joined = missingLabels.join(" · ");
  return {
    ok: false,
    code: "PROMO_REQUIRED_MISSING",
    missing: missingSettings.map((s) => s.key),
    missingLabels,
    message: `${joined}${josa(joined, "을", "를")} 골라 주세요.`,
  };
}

/** 장르 칩(잠김) — 등록 중인 수업의 장르·세부 장르에서 만든다. 사람이 바꿀 수 없다 */
export interface PromoGenreChip {
  genre: Genre;
  /** 문장에 들어갈 춤 이름(예: 살사, 탱고) */
  label: string;
  locked: true;
}

export function promoGenreChip(cls: { genre: Genre; subGenre: ClassSubGenre | null }): PromoGenreChip {
  const words = PROMO_CHIP_SETTINGS.genreDanceWords[cls.genre];
  // 세부 장르가 이 장르의 짝일 때만 세부 이름을 쓰고, 아니면 장르 기본 이름
  const sub = cls.subGenre && CLASS_SUB_GENRES.includes(cls.subGenre) ? words[cls.subGenre] : undefined;
  return { genre: cls.genre, label: sub ?? words.default, locked: true };
}

/**
 * 고른 칩으로 문장을 채운다 — 「{누가}이/가 {장소}에서 {색감} 아래 {분위기 부사} {춤}을/를 추는 모습」.
 * 고른 칸만 넣고, 아무것도 안 골랐으면 빈 문장(입력 칸 안내 글이 보이게)이다.
 * 판정과는 따로다 — 일부만 골라도 고른 만큼 문장이 바로 채워져야 하기 때문이다.
 */
export function fillPromoSentence(chips: PromoChipSelections, genre: PromoGenreChip): string {
  const byKey = Object.fromEntries(
    PROMO_CHIP_SETTINGS.requiredChips.map((s) => [s.key, chipText(s, chips[s.key])]),
  ) as Record<PromoRequiredChipKey, string | null>;
  if (PROMO_REQUIRED_CHIP_KEYS.every((k) => byKey[k] === null)) return "";

  const parts = [
    byKey.who && `${byKey.who}${josa(byKey.who, "이", "가")}`,
    byKey.place && `${byKey.place}에서`,
    byKey.color && `${byKey.color} 아래`,
    byKey.mood && moodAdverb(byKey.mood),
    `${genre.label}${josa(genre.label, "을", "를")} 추는 모습`,
  ];
  return parts.filter((p): p is string => Boolean(p)).join(" ");
}

/**
 * 분위기 낱말(꾸미는 말)을 문장 속 부사로 바꾼다.
 * 「~적인」→「~적으로」(열정적인→열정적으로), 「~한」→「~하게」(우아한→우아하게).
 * 그 밖의 모양(직접 쓰기 「신나는」 등)은 뜻을 바꾸지 않도록 「~ 분위기로」를 붙인다.
 */
function moodAdverb(mood: string): string {
  if (mood.endsWith("적인")) return `${mood.slice(0, -1)}으로`;
  if (mood.endsWith("한")) return `${mood.slice(0, -1)}하게`;
  return `${mood} 분위기로`;
}

/**
 * 받침 있는 낱말 뒤에는 `withFinal`, 없으면 `withoutFinal` 을 붙인다(이/가, 을/를).
 * 한글 음절은 (글자 코드 - 0xAC00) % 28 이 0 이 아니면 받침이 있다.
 * 마지막 글자가 한글이 아니면(영어·숫자) 받침 없음으로 본다.
 */
function josa(word: string, withFinal: string, withoutFinal: string): string {
  const code = word.charCodeAt(word.length - 1);
  const isHangul = code >= 0xac00 && code <= 0xd7a3;
  return isHangul && (code - 0xac00) % 28 !== 0 ? withFinal : withoutFinal;
}
