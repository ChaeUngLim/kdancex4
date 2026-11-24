// SX-6.5(하루 횟수·생성 요청 API) — 하루 횟수 설정과 날짜 계산(순수 함수)을 확인한다.
//   하루는 한국 시간 0시에 바뀌고, 엔진 목록은 에이전트 서버의 image_engines.json 과 같아야 한다.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  nextPromoResetAt,
  PROMO_IMAGE_QUOTA_SETTINGS,
  promoRemaining,
  promoUsageDate,
  resolvePromoEngine,
} from "@/lib/domain/promo-image-quota";

describe("홍보 이미지 하루 횟수 설정", () => {
  test("베타 하루 횟수는 3이고 기본 엔진은 Cloudflare FLUX.1 [schnell]", () => {
    expect(PROMO_IMAGE_QUOTA_SETTINGS.dailyLimit).toBe(3);
    expect(PROMO_IMAGE_QUOTA_SETTINGS.betaPhase).toBe(true);
    expect(resolvePromoEngine(undefined)?.id).toBe("cloudflare_flux_schnell");
  });

  test("꺼진 로컬 엔진·목록 밖 엔진은 고를 수 없다", () => {
    expect(resolvePromoEngine("local_sana_sprint")).toBeNull();
    expect(resolvePromoEngine("local_flux2_klein")).toBeNull();
    expect(resolvePromoEngine("local_z_image_turbo")).toBeNull();
    expect(resolvePromoEngine("paid_engine")).toBeNull();
  });

  test("엔진 id·켜짐은 에이전트 서버 image_engines.json 과 같다", () => {
    const agent = JSON.parse(readFileSync(join(import.meta.dirname, "../../../agent-server/app/promo/image_engines.json"), "utf8")) as {
      engines: { id: string; enabled: boolean }[];
    };
    expect(PROMO_IMAGE_QUOTA_SETTINGS.engines.map((e) => [e.id, e.enabled])).toEqual(agent.engines.map((e) => [e.id, e.enabled]));
  });

  test("엔진 카드 이름·한 마디도 에이전트 서버 image_engines.json 과 같다(SX-6.9)", () => {
    const agent = JSON.parse(readFileSync(join(import.meta.dirname, "../../../agent-server/app/promo/image_engines.json"), "utf8")) as {
      engines: { id: string; label: string; speed: string }[];
    };
    expect(PROMO_IMAGE_QUOTA_SETTINGS.engines.map((e) => [e.id, e.label, e.speed])).toEqual(agent.engines.map((e) => [e.id, e.label, e.speed]));
  });
});

describe("한국 시간 날짜", () => {
  test("23:59:59 KST 와 00:00:00 KST 는 다른 날", () => {
    expect(promoUsageDate(Temporal.Instant.from("2026-11-21T14:59:59Z"))).toBe("2026-11-21");
    expect(promoUsageDate(Temporal.Instant.from("2026-11-21T15:00:00Z"))).toBe("2026-11-22");
  });

  test("다음 초기화는 다음 KST 0시", () => {
    expect(nextPromoResetAt(Temporal.Instant.from("2026-11-21T03:00:00Z")).toString()).toBe("2026-11-21T15:00:00Z");
    expect(nextPromoResetAt(Temporal.Instant.from("2026-11-21T15:00:00Z")).toString()).toBe("2026-11-22T15:00:00Z");
  });

  test("남은 횟수는 0 밑으로 내려가지 않는다", () => {
    expect(promoRemaining(1, 3)).toBe(2);
    expect(promoRemaining(3, 3)).toBe(0);
    expect(promoRemaining(5, 1)).toBe(0);
  });
});
