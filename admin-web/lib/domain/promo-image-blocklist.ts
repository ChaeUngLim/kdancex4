/**
 * SX-6.3(막는 입력 판정) — 홍보 이미지를 만들기 「전에」 막을 입력을 걸러 내는 판정 함수
 *
 * 무엇을 하나: FR-061a 「막는 입력」 — 선정적·폭력적 내용, 실존 인물(유명 댄서·연예인) 얼굴 흉내, 다른 회사 상표·로고가
 *   든 입력은 생성 전에 거부하고 **하루 횟수를 줄이지 않는다**.
 *   - `screenPromoInput(input)` — 문장과 칩(직접 쓰기 포함)을 보고 막을지 정한다.
 *   - `guardPromoGeneration(input, remaining, proceed)` — 판정을 생성 요청 「앞」에 세운다. 막히면 `proceed`(횟수 차감·생성 요청)를
 *     아예 부르지 않고 422 `PROMO_INPUT_BLOCKED` 본문(계약 16 §4-7 3단계)을 돌려준다. 통과하면 `proceed` 를 한 번 부른다.
 *
 * 왜 낱말 목록·정규식인가(FR-270 입력 지시문은 데이터): 입력 문장은 명령이 아니라 데이터다. 판정이 문장을 「해석」하면
 *   (예: 모델에게 판정을 맡기면) 문장 안의 「차단을 꺼라」 같은 지시가 판정을 바꿀 수 있다. 그래서 글자를 목록과 대조만 하고,
 *   문장이 무엇을 시키든 판정 규칙·요청 인자(장르·조건·글자 없음)는 바뀌지 않는다. 로컬 모델로 판정하면 느리고 오탐도 난다(계약 열린 점 ⑪).
 *
 * 목록은 코드에 박지 않고 `promo-image-blocklist.json` 에 둔다 — 실존 인물·상표 범위는 사용자 확인 대기라 바뀔 수 있다.
 *   설정 표(`ai_settings` 의 `promo_image.blocklist`)가 생기면 이 파일이 그 기본값이 된다. DB·시간·네트워크를 쓰지 않는다.
 */
import { z } from "zod";

import rawSettings from "./promo-image-blocklist.json";
import type { PromoChipSelections } from "./promo-image-chips";

/** 막는 갈래 — 계약의 `blockedKind` 값 */
export const PROMO_BLOCKED_KINDS = ["explicit", "violence", "real_person", "trademark"] as const;
export type PromoBlockedKind = (typeof PROMO_BLOCKED_KINDS)[number];

/** 막혔을 때 화면에 보일 첫 줄(spec FR-061a 문구 그대로) */
export const PROMO_BLOCKED_INPUT_MESSAGE = "이 내용은 만들 수 없어요. 다른 표현으로 적어 주세요.";

// 정규식 문자열이 잘못 들어오면 서버가 뜰 때 바로 알 수 있게 불러오는 순간 컴파일해 본다
const patternSchema = z.string().refine((p) => {
  try {
    new RegExp(p, "u");
    return true;
  } catch {
    return false;
  }
}, "정규식이 올바르지 않다");

const kindSchema = z.object({
  kind: z.enum(PROMO_BLOCKED_KINDS),
  /** 막힌 까닭 한 줄(보드 I43) — 걸린 낱말 자체는 싣지 않는다 */
  reason: z.string().min(1),
  // 두 글자 이상만 — 「총」「피」처럼 한 글자는 「총 8회」 같은 평범한 문장까지 막는다
  terms: z.array(z.string().min(2)),
  patterns: z.array(patternSchema),
});

const settingsSchema = z.object({
  kinds: z
    .array(kindSchema)
    // 네 갈래가 이 순서로 다 있어야 한다 — 하나가 빠진 채 배포되면 그 갈래가 통째로 안 막힌다
    .refine((ks) => ks.map((k) => k.kind).join(",") === PROMO_BLOCKED_KINDS.join(","), "네 갈래를 이 순서로 둔다"),
});

export type PromoBlocklistSettings = z.infer<typeof settingsSchema>;

/** 설정 파일에서 읽은 막는 목록(검사를 통과한 값) */
export const PROMO_BLOCKLIST_SETTINGS: PromoBlocklistSettings = settingsSchema.parse(rawSettings);

/**
 * 글자를 같은 꼴로 맞춘다 — 전각 글자·대문자·악센트(é→e)를 없애 「Ｎｕｄｅ」「Beyoncé」 같은 우회를 막는다.
 * NFKD 로 쪼개 결합 부호만 지우고 NFC 로 다시 붙인다(한글 자모는 결합 부호가 아니라 그대로 돌아온다).
 */
function normalize(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFC").toLowerCase();
}

/** 띄어쓰기·문장부호·기호를 다 뺀 글 — 「알 몸」「누.드」처럼 끊어 써서 피하는 것을 막는다(한국어 낱말·정규식용) */
function compact(normalized: string): string {
  return normalized.replace(/[\s\p{P}\p{S}]/gu, "");
}

const ASCII_TERM = /^[a-z0-9 ]+$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 갈래마다 대조 규칙을 한 번만 만들어 둔다
const COMPILED = PROMO_BLOCKLIST_SETTINGS.kinds.map((k) => {
  const latinTerms = k.terms.filter((t) => ASCII_TERM.test(t));
  const otherTerms = k.terms.filter((t) => !ASCII_TERM.test(t)).map((t) => compact(normalize(t)));
  // 영어는 낱말 단위로만 본다 — 「gunmetal」 속 gun, 「denuded」 속 nude 는 걸리지 않게. 여러 낱말 이름은 사이에 띄어쓰기·-·_·. 를 허용한다
  const latinRegexes = latinTerms.map(
    (t) => new RegExp(`(?<![a-z0-9])${t.split(" ").map(escapeRegExp).join("[\\s\\-_.]*")}(?![a-z0-9])`, "u"),
  );
  const patterns = k.patterns.map((p) => new RegExp(p, "u"));
  return { kind: k.kind, reason: k.reason, otherTerms, latinRegexes, patterns };
});

/** 판정할 입력 — 강사·대표가 쓴 문장과 고른 칩(직접 쓰기 글 포함) */
export interface PromoInputToScreen {
  sentence: string;
  chips: PromoChipSelections;
}

export type PromoInputScreenResult =
  | { ok: true }
  | {
      ok: false;
      code: "PROMO_INPUT_BLOCKED";
      blockedKind: PromoBlockedKind;
      /** 막힌 까닭 한 줄 */
      reason: string;
      message: typeof PROMO_BLOCKED_INPUT_MESSAGE;
    };

/** 칩 값(낱말 또는 `{ custom }`)에서 글자만 모은다 — 직접 쓰기 칸도 자유 입력이라 같이 본다 */
function chipTexts(chips: PromoChipSelections): string[] {
  return Object.values(chips).map((v) => (typeof v === "string" ? v : (v?.custom ?? "")));
}

/**
 * 막는 입력인지 판정한다. 여러 갈래에 걸리면 설정 순서상 앞 갈래 하나만 돌려준다.
 * 입력은 바꾸지 않고, 문장 내용을 실행·해석하지 않는다 — 목록과 대조만 한다.
 */
export function screenPromoInput(input: PromoInputToScreen): PromoInputScreenResult {
  const normalized = normalize([input.sentence, ...chipTexts(input.chips)].join("\n"));
  const squeezed = compact(normalized);

  for (const k of COMPILED) {
    const hit =
      k.otherTerms.some((t) => squeezed.includes(t)) ||
      k.latinRegexes.some((re) => re.test(normalized)) ||
      k.patterns.some((re) => re.test(squeezed));
    if (hit) {
      return { ok: false, code: "PROMO_INPUT_BLOCKED", blockedKind: k.kind, reason: k.reason, message: PROMO_BLOCKED_INPUT_MESSAGE };
    }
  }
  return { ok: true };
}

/** 422 `PROMO_INPUT_BLOCKED` 응답 본문(계약 16 §4-7 3단계) */
export interface PromoInputBlockedBody {
  code: "PROMO_INPUT_BLOCKED";
  blockedKind: PromoBlockedKind;
  /** 막혀도 횟수는 그대로 — 판정 전 남은 횟수를 그대로 싣는다 */
  remaining: number;
  message: string;
  reason: string;
}

export type PromoGenerationGuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 422; body: PromoInputBlockedBody };

/**
 * 판정을 생성 요청 앞에 세운다. `proceed` 에는 횟수 차감(계약 5단계)과 생성 요청(6단계)을 넣는다.
 * 막히면 `proceed` 를 부르지 않으므로 횟수가 줄 수 없다(FR-061a 「횟수를 차감하지 않는다」).
 */
export function guardPromoGeneration<T>(
  input: PromoInputToScreen,
  remaining: number,
  proceed: () => T,
): PromoGenerationGuardResult<T> {
  const screened = screenPromoInput(input);
  if (!screened.ok) {
    return {
      ok: false,
      status: 422,
      body: {
        code: screened.code,
        blockedKind: screened.blockedKind,
        remaining,
        message: screened.message,
        reason: screened.reason,
      },
    };
  }
  return { ok: true, value: proceed() };
}
