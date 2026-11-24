// SX-6.9(앱 홍보 이미지·소개 문구 화면) — 화면이 처음 받는 값(예시 순서·엔진 카드·남은 횟수)을 만드는 순수 함수 시험.
//   카드 판정이 만들기 요청(POST /api/ai/promo-images)의 무료량 판정과 같은지, 꺼진 로컬 엔진이 카드에 안 나오는지 본다.
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import { checkPromoRequiredChips } from "@/lib/domain/promo-image-chips";
import {
  PROMO_EXAMPLES,
  promoEngineCards,
  promoExamplesFor,
  promoPreselectedEngineId,
  promoUsageSummary,
} from "@/lib/domain/promo-image-options";
import { PROMO_IMAGE_QUOTA_SETTINGS, type PromoImageQuotaSettings } from "@/lib/domain/promo-image-quota";

const NOW = Temporal.Instant.from("2026-11-24T03:00:00Z"); // 11-24 12:00 KST

describe("완성 예시(I32C)", () => {
  test("예시 세 개 모두 필수 4항목이 다 들어 있다", () => {
    expect(PROMO_EXAMPLES).toHaveLength(3);
    for (const e of PROMO_EXAMPLES) expect(checkPromoRequiredChips(e.chips).ok).toBe(true);
  });

  test("이 수업 장르의 예시가 맨 앞, 나머지는 설정 순서", () => {
    expect(promoExamplesFor("argentine_tango").map((e) => e.genre)).toEqual(["argentine_tango", "salsa_bachata", "dance_sport"]);
    expect(promoExamplesFor("salsa_bachata").map((e) => e.genre)).toEqual(["salsa_bachata", "argentine_tango", "dance_sport"]);
    // 예시가 없는 장르는 설정 순서 그대로
    expect(promoExamplesFor("swing").map((e) => e.id)).toEqual(PROMO_EXAMPLES.map((e) => e.id));
  });
});

describe("엔진 카드(I32B)", () => {
  test("켜진 엔진만 카드가 되고 로컬 3개(실측 전, 꺼짐)는 안 나온다", () => {
    const cards = promoEngineCards({ settings: PROMO_IMAGE_QUOTA_SETTINGS, usage: [], lastEngineId: null, now: NOW });
    expect(cards.map((c) => c.id)).toEqual(["cloudflare_flux_schnell"]);
    expect(cards[0]).toMatchObject({ label: "FLUX.1 [schnell]", speed: "빠름", etaSeconds: 5, available: true, blockedScope: null, lastPicked: false });
  });

  test("엔진 하루 한도에 닿으면 그 카드만 막히고 다음 KST 0시에 열린다 — 만들기 요청의 engine_daily 와 같은 판정", () => {
    const cards = promoEngineCards({
      settings: PROMO_IMAGE_QUOTA_SETTINGS,
      usage: [{ engineId: "cloudflare_flux_schnell", usedToday: 100, monthUsed: 100 }],
      lastEngineId: "cloudflare_flux_schnell",
      now: NOW,
    });
    expect(cards[0]).toMatchObject({ available: false, blockedScope: "engine_daily", resetsAt: "2026-11-24T15:00:00Z", lastPicked: true });
    // 99 는 아직 된다(경계: 이상이면 소진)
    const open = promoEngineCards({ settings: PROMO_IMAGE_QUOTA_SETTINGS, usage: [{ engineId: "cloudflare_flux_schnell", usedToday: 99, monthUsed: 0 }], lastEngineId: null, now: NOW });
    expect(open[0]!.available).toBe(true);
  });

  test("처음 골라 둘 엔진: 지난번 엔진 → 기본 엔진 → 쓸 수 있는 첫 카드, 다 막혔으면 null", () => {
    const settings: PromoImageQuotaSettings = {
      ...PROMO_IMAGE_QUOTA_SETTINGS,
      engines: PROMO_IMAGE_QUOTA_SETTINGS.engines.map((e) => (e.id === "local_flux2_klein" ? { ...e, enabled: true, monthlyFreeCap: 10 } : e)),
    };
    const last = promoEngineCards({ settings, usage: [], lastEngineId: "local_flux2_klein", now: NOW });
    expect(promoPreselectedEngineId(last, settings.defaultEngineId)).toBe("local_flux2_klein");
    const none = promoEngineCards({ settings, usage: [], lastEngineId: null, now: NOW });
    expect(promoPreselectedEngineId(none, settings.defaultEngineId)).toBe("cloudflare_flux_schnell");
    const defaultBlocked = promoEngineCards({
      settings,
      usage: [{ engineId: "cloudflare_flux_schnell", usedToday: 100, monthUsed: 0 }],
      lastEngineId: null,
      now: NOW,
    });
    expect(promoPreselectedEngineId(defaultBlocked, settings.defaultEngineId)).toBe("local_flux2_klein");
    const allBlocked = promoEngineCards({
      settings,
      usage: [
        { engineId: "cloudflare_flux_schnell", usedToday: 100, monthUsed: 0 },
        { engineId: "local_flux2_klein", usedToday: 0, monthUsed: 10 },
      ],
      lastEngineId: null,
      now: NOW,
    });
    expect(promoPreselectedEngineId(allBlocked, settings.defaultEngineId)).toBeNull();
    // 둘 다 막히면 더 오래 막는 monthly 를 앞세운다
    expect(promoUsageSummary({ settings, usedToday: 0, cards: allBlocked, now: NOW })).toMatchObject({ freeQuotaExhausted: true, freeQuotaScope: "monthly" });
  });
});

describe("남은 횟수(I32 · I42)", () => {
  test("3번 중 1번 썼으면 남은 2, 다 쓰면 0(밑으로 안 내려감), 초기화는 다음 KST 0시", () => {
    const cards = promoEngineCards({ settings: PROMO_IMAGE_QUOTA_SETTINGS, usage: [], lastEngineId: null, now: NOW });
    expect(promoUsageSummary({ settings: PROMO_IMAGE_QUOTA_SETTINGS, usedToday: 1, cards, now: NOW })).toEqual({
      dailyLimit: 3,
      used: 1,
      remaining: 2,
      resetsAt: "2026-11-24T15:00:00Z",
      betaPhase: true,
      freeQuotaExhausted: false,
      freeQuotaScope: null,
    });
    expect(promoUsageSummary({ settings: PROMO_IMAGE_QUOTA_SETTINGS, usedToday: 4, cards, now: NOW }).remaining).toBe(0);
  });
});
