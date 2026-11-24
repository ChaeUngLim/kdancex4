/**
 * SX-6.9(앱 홍보 이미지·소개 문구 화면) — 「홍보 이미지 만들기」 화면(보드 I32B·I32C)이 처음 열릴 때 받을 값을 모으는 순수 함수
 *
 * 무엇을 하나: `GET /api/ai/promo-image/options?classId=…`(계약 16 §4-7) 응답 중 DB 를 보지 않는 부분을 만든다.
 *   - `promoExamplesFor(genre)` — 완성 예시(I32C). 이 수업 장르의 예시를 맨 앞에, 나머지는 설정 순서대로.
 *   - `promoEngineCards(...)` — 엔진 카드(I32B 엔진 줄). 켜진 엔진만 보이고(로컬 3개는 실측 전이라 꺼져 있어 카드에 안 나온다),
 *     엔진 하루 한도·이달 무료량이 바닥난 카드는 `available: false` + 까닭. 마지막에 고른 엔진에 표시를 단다.
 *   - `promoUsageSummary(...)` — 남은 횟수 n/N 과 다음 초기화 시각, 켜진 엔진이 모두 막혔는지(이달 무료량 소진 안내).
 *
 * 왜 따로 두나: 판정(무료량 소진·하루 횟수)은 만들기 요청(promo-image-generations.ts)과 같은 함수(decidePromoFreeQuota·promoRemaining)를
 *   써야 「카드는 쓸 수 있다는데 누르면 막히는」 어긋남이 없다. 그 판정을 카드 모양으로 바꾸는 일만 여기서 한다.
 * 예시 문장은 코드에 박지 않고 설정 파일 `promo-image-examples.json` 에 둔다(spec FR-061a 예시 세 문장, 추천안·사용자 확인 대기).
 *
 * DB·네트워크를 쓰지 않는다. 시각과 사용 수는 밖에서 받는다.
 */
import { z } from "zod";

import { GENRES, type Genre } from "./constants";
import { PROMO_REQUIRED_CHIP_KEYS } from "./promo-image-chips";
import rawExamples from "./promo-image-examples.json";
import { decidePromoFreeQuota, type PromoFreeQuotaScope } from "./promo-image-free-quota";
import { nextPromoResetAt, promoRemaining, type PromoImageQuotaSettings } from "./promo-image-quota";

// 예시 설정 파일 모양 — 네 칩이 모두 든 문장만 예시가 될 수 있다(「필수 정보가 다 든 문장」, FR-061a)
const exampleSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]+$/),
  genre: z.enum(GENRES),
  genreLabel: z.string().min(1),
  text: z.string().min(1).max(200),
  chips: z.strictObject(Object.fromEntries(PROMO_REQUIRED_CHIP_KEYS.map((k) => [k, z.string().min(1)])) as Record<
    (typeof PROMO_REQUIRED_CHIP_KEYS)[number],
    z.ZodString
  >),
});
const examplesSchema = z.strictObject({ examples: z.array(exampleSchema).min(1) });

export type PromoExample = z.infer<typeof exampleSchema>;

/** 설정 파일 값(검사 통과). 잘못 고치면 서버가 뜰 때 바로 멈춘다 */
export const PROMO_EXAMPLES: readonly PromoExample[] = examplesSchema.parse(rawExamples).examples;

/** 완성 예시 — 이 수업 장르의 예시가 맨 앞(같은 장르끼리는 설정 순서). 받은 배열은 바꾸지 않는다 */
export function promoExamplesFor(genre: Genre, examples: readonly PromoExample[] = PROMO_EXAMPLES): PromoExample[] {
  return [...examples.filter((e) => e.genre === genre), ...examples.filter((e) => e.genre !== genre)];
}

/** 엔진 카드 한 장(보드 I32B) */
export interface PromoEngineCard {
  id: string;
  label: string;
  /** 「빠름」 「보통」 「화질 우선」 한 마디 */
  speed: string;
  /** 예상 시간(초). 실측 전이면 null — 화면은 시간 없이 한 마디만 보인다 */
  etaSeconds: number | null;
  /** 지금 이 엔진으로 만들 수 있나(엔진 하루 한도·이달 무료량) */
  available: boolean;
  /** 막혔을 때 까닭 — 만들기 요청의 409 quotaScope 와 같은 값 */
  blockedScope: PromoFreeQuotaScope | null;
  /** 막혔으면 다시 열리는 때 */
  resetsAt: string | null;
  /** 지난번에 고른 엔진인가(다음에 미리 골라 둔다, FR-061a) */
  lastPicked: boolean;
}

/** 엔진마다 지금까지 쓴 양 — 서비스가 DB 에서 읽어 넘긴다 */
export interface PromoEngineUsage {
  engineId: string;
  monthUsed: number;
  usedToday: number;
}

/**
 * 켜진 엔진만 카드로 만든다. 판정은 만들기 요청과 같은 decidePromoFreeQuota.
 * 사용 수가 넘어오지 않은 엔진은 0 으로 본다(아직 한 번도 안 썼다).
 */
export function promoEngineCards(input: {
  settings: PromoImageQuotaSettings;
  usage: readonly PromoEngineUsage[];
  lastEngineId: string | null;
  now: Temporal.Instant;
}): PromoEngineCard[] {
  return input.settings.engines
    .filter((engine) => engine.enabled)
    .map((engine) => {
      const used = input.usage.find((u) => u.engineId === engine.id);
      const quota = decidePromoFreeQuota({ engine, monthUsed: used?.monthUsed ?? 0, engineUsedToday: used?.usedToday ?? 0, now: input.now });
      return {
        id: engine.id,
        label: engine.label,
        speed: engine.speed,
        etaSeconds: engine.etaSeconds,
        available: !quota.exhausted,
        blockedScope: quota.exhausted ? quota.scope : null,
        resetsAt: quota.exhausted ? quota.resetsAt : null,
        lastPicked: engine.id === input.lastEngineId,
      };
    });
}

/** 처음 골라 둘 엔진 — 지난번 엔진이 쓸 수 있으면 그것, 아니면 기본 엔진, 그것도 막혔으면 쓸 수 있는 첫 카드. 다 막혔으면 null */
export function promoPreselectedEngineId(cards: readonly PromoEngineCard[], defaultEngineId: string): string | null {
  const usable = cards.filter((c) => c.available);
  return (usable.find((c) => c.lastPicked) ?? usable.find((c) => c.id === defaultEngineId) ?? usable[0])?.id ?? null;
}

/** 남은 횟수 요약 — 계약 16 §4-7 `usage` 모양 */
export interface PromoUsageSummary {
  dailyLimit: number;
  used: number;
  remaining: number;
  resetsAt: string;
  betaPhase: boolean;
  /** 켜진 엔진이 모두 막혔나 — 「이번 달 무료 생성량을 모두 썼어요」 안내와 만들기 잠금에 쓴다 */
  freeQuotaExhausted: boolean;
  /** 모두 막혔을 때 그 까닭(엔진마다 다르면 더 오래 막는 monthly 를 앞세운다). 안 막혔으면 null */
  freeQuotaScope: PromoFreeQuotaScope | null;
}

export function promoUsageSummary(input: {
  settings: PromoImageQuotaSettings;
  usedToday: number;
  cards: readonly PromoEngineCard[];
  now: Temporal.Instant;
}): PromoUsageSummary {
  const allBlocked = input.cards.length > 0 && input.cards.every((c) => !c.available);
  const scope = !allBlocked ? null : input.cards.some((c) => c.blockedScope === "monthly") ? "monthly" : "engine_daily";
  return {
    dailyLimit: input.settings.dailyLimit,
    used: input.usedToday,
    remaining: promoRemaining(input.usedToday, input.settings.dailyLimit),
    resetsAt: nextPromoResetAt(input.now).toString(),
    betaPhase: input.settings.betaPhase,
    freeQuotaExhausted: allBlocked,
    freeQuotaScope: scope,
  };
}
