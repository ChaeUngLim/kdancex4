// SX-6.8(AI 생성 표시·무료량 소진) — 홍보 이미지의 「무료량이 바닥났나」와 「바닥나면 무엇을 막나」를 DB 없이 정하는 순수 함수.
//   계약: _workspace/03_contracts/16-ai-agent.md §1-5(409 PROMO_FREE_QUOTA_EXHAUSTED — 생성만 막고 수업 등록은 막지 않는다) · §4-7 4단계
//   요구: FR-061a(홍보 이미지 생성 조건) — 「무료 사용량이 바닥나면 생성 버튼을 잠시 막고 "사진 올리기"로 안내한다. 수업 등록 자체는 막지 않는다」
//
// 무료량은 두 겹으로 본다(둘 다 엔진마다 따로 — 엔진을 바꾸면 다른 엔진은 그대로 쓸 수 있다):
//   ① 이달 무료량(monthly) — 그 엔진으로 이번 달(KST 달력) 만든 장수가 엔진 설정 monthlyFreeCap 이상. 다시 열리는 때 = 다음 달 1일 0시 KST
//   ② 엔진 하루 한도(engine_daily) — 그 엔진의 오늘 전체 사용 수가 engineDailyLimit 이상. 공급자가 「한도 끝」(PROVIDER_QUOTA_EXHAUSTED)을
//      알리면 서버가 오늘 줄을 한도까지 채워 이 상태로 만든다. 다시 열리는 때 = 다음 KST 0시
//   둘 다 걸리면 더 오래 막는 ①을 알린다 — 「내일 다시」라고 했다가 내일도 막히면 안내가 거짓말이 된다.
//
// 막는 것은 「AI 이미지 만들기」 하나뿐이다. 사진 올리기·소개 문구 쓰기·수업 저장·승인 요청은 무료량과 상관이 없다(promoActionAllowed).
// 사람 하루 횟수(N번)를 다 쓴 경우도 같다 — I42 「수업 등록 버튼은 막지 않는다」.
import { KST_TIME_ZONE, toKstDate } from "./time";
import { nextPromoResetAt, type PromoImageEngineSetting } from "./promo-image-quota";

/** 무료량이 어느 겹에서 바닥났나 — 409 본문의 quotaScope 로 나가고 화면이 안내 문구를 고른다 */
export const PROMO_FREE_QUOTA_SCOPES = ["monthly", "engine_daily"] as const;
export type PromoFreeQuotaScope = (typeof PROMO_FREE_QUOTA_SCOPES)[number];

export type PromoFreeQuotaState =
  | { readonly exhausted: false }
  | { readonly exhausted: true; readonly scope: PromoFreeQuotaScope; readonly engineId: string; readonly resetsAt: string };

/** 이번 달(KST) 날짜 범위 — from 이상 to 미만(「YYYY-MM-DD」). 생성 행의 usage_date(KST 날짜)를 이 범위로 센다 */
export function promoMonthRange(at: Temporal.Instant): { readonly from: string; readonly to: string } {
  const first = toKstDate(at).with({ day: 1 });
  return { from: first.toString(), to: first.add({ months: 1 }).toString() };
}

/** 다음 달 1일 0시 KST(UTC 시각). 예: 2026-11-30 23:00 KST → 2026-11-30T15:00:00Z(= 12-01 00:00 KST) */
export function nextPromoMonthStartAt(at: Temporal.Instant): Temporal.Instant {
  return Temporal.PlainDate.from(promoMonthRange(at).to).toZonedDateTime({ timeZone: KST_TIME_ZONE }).toInstant();
}

/**
 * 고른 엔진의 무료량이 남았나.
 *   monthUsed — 그 엔진으로 이번 달 만든(만드는 중 포함) 장수. engineUsedToday — 그 엔진의 오늘 전체 사용 수.
 * 한도가 null 인 겹은 보지 않는다. 경계는 「이상이면 소진」 — 한도 80 이면 80장째까지 만들고 81장째를 막는다.
 */
export function decidePromoFreeQuota(input: {
  readonly engine: PromoImageEngineSetting;
  readonly monthUsed: number;
  readonly engineUsedToday: number;
  readonly now: Temporal.Instant;
}): PromoFreeQuotaState {
  const { engine, now } = input;
  if (engine.monthlyFreeCap !== null && input.monthUsed >= engine.monthlyFreeCap) {
    return { exhausted: true, scope: "monthly", engineId: engine.id, resetsAt: nextPromoMonthStartAt(now).toString() };
  }
  if (engine.engineDailyLimit !== null && input.engineUsedToday >= engine.engineDailyLimit) {
    return { exhausted: true, scope: "engine_daily", engineId: engine.id, resetsAt: nextPromoResetAt(now).toString() };
  }
  return { exhausted: false };
}

/**
 * 공급자가 「한도 끝」을 알렸을 때 오늘 엔진 줄에 채워 넣을 값 — 엔진 하루 한도 그 자체.
 * 하루 한도가 없는 엔진(로컬 GPU)은 공급자 한도도 없으니 null(아무것도 쓰지 않는다).
 */
export function providerExhaustedEngineCount(engine: PromoImageEngineSetting): number | null {
  return engine.engineDailyLimit;
}

/** 화면 안내(spec FR-061a 문구 표). 두 경우 모두 「사진 올리기」로 이어 준다 */
export const PROMO_FREE_QUOTA_NOTICES: Readonly<Record<PromoFreeQuotaScope, string>> = {
  monthly: "이번 달 무료 생성량을 모두 썼어요. 사진을 올려 주세요.",
  engine_daily: "오늘은 이 엔진을 더 쓸 수 없어요",
};

export function promoFreeQuotaNotice(state: PromoFreeQuotaState): { readonly message: string; readonly uploadPhoto: true } | null {
  return state.exhausted ? { message: PROMO_FREE_QUOTA_NOTICES[state.scope], uploadPhoto: true } : null;
}

// ---- 무엇을 막나 -------------------------------------------------------------------------------------

/** 수업 등록 마지막 단계에서 강사·대표가 할 수 있는 일 */
export const PROMO_STEP_ACTIONS = ["generate_image", "upload_photo", "write_intro", "save_class", "submit_class"] as const;
export type PromoStepAction = (typeof PROMO_STEP_ACTIONS)[number];

/** 만들기 버튼이 잠겼나와 그 까닭. 사람 하루 횟수 소진이 먼저 보인다(I42 — 버튼에 「남은 횟수 0/3」) */
export type PromoGenerateLock =
  | { readonly locked: false }
  | { readonly locked: true; readonly reason: "daily_limit" | PromoFreeQuotaScope };

export function promoGenerateLock(input: { readonly remaining: number; readonly freeQuota: PromoFreeQuotaState }): PromoGenerateLock {
  if (input.remaining <= 0) return { locked: true, reason: "daily_limit" };
  if (input.freeQuota.exhausted) return { locked: true, reason: input.freeQuota.scope };
  return { locked: false };
}

/**
 * 그 일을 지금 해도 되나 — 잠김은 「AI 이미지 만들기」만 막는다.
 * 사진 올리기·소개 문구·수업 저장·승인 요청은 잠김과 상관없이 늘 된다(FR-061a 「수업 등록 자체는 막지 않는다」).
 */
export function promoActionAllowed(action: PromoStepAction, lock: PromoGenerateLock): boolean {
  if (action !== "generate_image") return true;
  return !lock.locked;
}
