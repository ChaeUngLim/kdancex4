// SX-6.8(AI 생성 표시·무료량 소진) — 순수 함수 둘을 확인한다.
//   ① AI 가 만든 이미지·문구에 「AI 생성」 표시(FR-258)가 붙고, 사람이 올린 사진·직접 쓴 글에는 붙지 않는다
//   ② 무료량이 바닥나면 「AI 이미지 만들기」만 막히고 사진 올리기·수업 저장·승인 요청(수업 등록)은 그대로 된다(FR-061a)
//   verify 의 이름은 tests/unit/sx-6-8.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { describe, expect, test } from "vitest";

import { AI_GENERATED_BADGE, aiGeneratedMark, introAiMark, coverAiMark, promoAiMarks } from "@/lib/domain/ai-generated-mark";
import { containsAiContent, promoAssetsPublishable } from "@/lib/domain/class-promo-assets";
import { PROMO_COVER_SOURCES, PROMO_INTRO_SOURCES } from "@/lib/domain/constants";
import { POSTER_BADGE_LABELS } from "@/lib/domain/poster-field-badges";
import {
  decidePromoFreeQuota,
  nextPromoMonthStartAt,
  PROMO_FREE_QUOTA_NOTICES,
  PROMO_STEP_ACTIONS,
  promoActionAllowed,
  promoFreeQuotaNotice,
  promoGenerateLock,
  promoMonthRange,
  providerExhaustedEngineCount,
} from "@/lib/domain/promo-image-free-quota";
import { PROMO_IMAGE_QUOTA_SETTINGS, type PromoImageEngineSetting } from "@/lib/domain/promo-image-quota";

const NOON = Temporal.Instant.from("2026-11-24T03:00:00Z"); // 2026-11-24 12:00 KST
const ENGINE: PromoImageEngineSetting = { id: "cloudflare_flux_schnell", label: "FLUX.1 [schnell]", speed: "빠름", etaSeconds: 5, enabled: true, engineDailyLimit: 100, monthlyFreeCap: 80 };

describe("AI 생성 표시(FR-258)", () => {
  test("AI 이미지 표지에는 표시가 붙고, 올린 사진·표지 없음에는 붙지 않는다", () => {
    expect(coverAiMark("ai_image")).toEqual({ aiGenerated: true, kind: "promo_image", badge: "AI 생성", note: "AI 가 만든 이미지예요" });
    expect(coverAiMark("uploaded_photo")).toBeNull();
    expect(coverAiMark(null)).toBeNull();
  });

  test("소개 문구 — AI 초안 그대로·고친 글은 표시, 직접 쓴 글은 표시 없음", () => {
    expect(introAiMark("ai")).toMatchObject({ aiGenerated: true, kind: "class_intro", badge: "AI 생성" });
    expect(introAiMark("ai_edited")).toMatchObject({ aiGenerated: true, kind: "class_intro_edited", note: "AI 초안을 고친 소개 문구예요" });
    expect(introAiMark("user")).toBeNull();
    expect(introAiMark(null)).toBeNull();
  });

  test("배지 글자는 포스터 칸의 「AI 생성」과 같다 — 화면마다 다른 말을 쓰지 않는다", () => {
    expect(AI_GENERATED_BADGE).toBe(POSTER_BADGE_LABELS.aiGenerated);
    for (const kind of ["promo_image", "class_intro", "class_intro_edited", "profile_image", "academy_photo"] as const) {
      const mark = aiGeneratedMark(kind);
      expect(mark.badge).toBe("AI 생성");
      expect(mark.note.length).toBeGreaterThan(0);
    }
  });

  test("모든 표지·문구 조합에서 「AI 가 만든 것이 있다」 판정과 표시가 어긋나지 않는다", () => {
    for (const cover of [...PROMO_COVER_SOURCES, null]) {
      for (const intro of [...PROMO_INTRO_SOURCES, null]) {
        const marks = promoAiMarks({ coverSource: cover, introSource: intro });
        // 게시 관문(SX-6.7)이 「검토가 필요하다」고 보는 것과 표시가 붙는 것이 늘 같다 — 표시 없이 게시되는 AI 산출물이 없다
        expect(marks.cover !== null || marks.intro !== null).toBe(containsAiContent(cover, intro));
      }
    }
  });

  test("사진이 먼저면 같은 수업에 AI 이미지를 만들어 두었어도 표지 표시는 없다", () => {
    expect(promoAiMarks({ coverSource: "uploaded_photo", introSource: "ai" })).toEqual({
      cover: null,
      intro: expect.objectContaining({ kind: "class_intro" }),
    });
  });
});

describe("무료량 소진 판정", () => {
  test("이번 달 범위는 KST 달력 — 11월 30일 23:59 KST 는 11월, 12월 1일 0시 KST 는 12월", () => {
    expect(promoMonthRange(Temporal.Instant.from("2026-11-30T14:59:59Z"))).toEqual({ from: "2026-11-01", to: "2026-12-01" });
    expect(promoMonthRange(Temporal.Instant.from("2026-11-30T15:00:00Z"))).toEqual({ from: "2026-12-01", to: "2027-01-01" });
    expect(nextPromoMonthStartAt(NOON).toString()).toBe("2026-11-30T15:00:00Z");
  });

  test("이달 한도 80 — 79장까지는 남음, 80장이면 소진(다음 달 1일 0시 KST 에 다시 열림)", () => {
    expect(decidePromoFreeQuota({ engine: ENGINE, monthUsed: 79, engineUsedToday: 0, now: NOON })).toEqual({ exhausted: false });
    expect(decidePromoFreeQuota({ engine: ENGINE, monthUsed: 80, engineUsedToday: 0, now: NOON })).toEqual({
      exhausted: true,
      scope: "monthly",
      engineId: "cloudflare_flux_schnell",
      resetsAt: "2026-11-30T15:00:00Z",
    });
  });

  test("엔진 하루 한도 — 100 에 닿으면 소진(다음 KST 0시에 다시 열림)", () => {
    expect(decidePromoFreeQuota({ engine: ENGINE, monthUsed: 10, engineUsedToday: 99, now: NOON }).exhausted).toBe(false);
    expect(decidePromoFreeQuota({ engine: ENGINE, monthUsed: 10, engineUsedToday: 100, now: NOON })).toEqual({
      exhausted: true,
      scope: "engine_daily",
      engineId: "cloudflare_flux_schnell",
      resetsAt: "2026-11-24T15:00:00Z",
    });
  });

  test("둘 다 바닥나면 더 오래 막는 이달 무료량을 알린다", () => {
    const both = decidePromoFreeQuota({ engine: ENGINE, monthUsed: 80, engineUsedToday: 100, now: NOON });
    expect(both).toMatchObject({ exhausted: true, scope: "monthly" });
  });

  test("한도가 null 인 겹은 보지 않는다 — 출시 설정의 Cloudflare 는 달 한도 없음·하루 한도 100", () => {
    const shipped = PROMO_IMAGE_QUOTA_SETTINGS.engines.find((e) => e.id === "cloudflare_flux_schnell")!;
    expect(shipped.monthlyFreeCap).toBeNull();
    expect(decidePromoFreeQuota({ engine: shipped, monthUsed: 10_000, engineUsedToday: 0, now: NOON }).exhausted).toBe(false);
    const noLimits: PromoImageEngineSetting = { id: "local_sana_sprint", label: "Sana Sprint 0.6B", speed: "빠름", etaSeconds: null, enabled: true, engineDailyLimit: null, monthlyFreeCap: null };
    expect(decidePromoFreeQuota({ engine: noLimits, monthUsed: 10_000, engineUsedToday: 10_000, now: NOON }).exhausted).toBe(false);
  });

  test("공급자 「한도 끝」 신호는 오늘 엔진 줄을 하루 한도까지 채운다 — 하루 한도가 없는 엔진은 채우지 않는다", () => {
    expect(providerExhaustedEngineCount(ENGINE)).toBe(100);
    const filled = decidePromoFreeQuota({ engine: ENGINE, monthUsed: 3, engineUsedToday: providerExhaustedEngineCount(ENGINE)!, now: NOON });
    expect(filled).toMatchObject({ exhausted: true, scope: "engine_daily" });
    expect(providerExhaustedEngineCount({ ...ENGINE, engineDailyLimit: null })).toBeNull();
  });

  test("안내 문구는 spec FR-061a 표 그대로이고 언제나 「사진 올리기」로 이어진다", () => {
    expect(PROMO_FREE_QUOTA_NOTICES.monthly).toBe("이번 달 무료 생성량을 모두 썼어요. 사진을 올려 주세요.");
    const notice = promoFreeQuotaNotice(decidePromoFreeQuota({ engine: ENGINE, monthUsed: 80, engineUsedToday: 0, now: NOON }));
    expect(notice).toEqual({ message: "이번 달 무료 생성량을 모두 썼어요. 사진을 올려 주세요.", uploadPhoto: true });
    expect(promoFreeQuotaNotice({ exhausted: false })).toBeNull();
  });
});

describe("무료량 소진 상태에서 생성 거부와 수업 등록 통과", () => {
  const exhausted = decidePromoFreeQuota({ engine: ENGINE, monthUsed: 80, engineUsedToday: 0, now: NOON });
  const lock = promoGenerateLock({ remaining: 3, freeQuota: exhausted });

  test("무료량이 바닥나면 오늘 횟수가 남아 있어도 만들기가 잠긴다", () => {
    expect(lock).toEqual({ locked: true, reason: "monthly" });
    expect(promoActionAllowed("generate_image", lock)).toBe(false);
  });

  test("같은 상태에서 사진 올리기·소개 문구·수업 저장·승인 요청은 모두 된다", () => {
    const others = PROMO_STEP_ACTIONS.filter((a) => a !== "generate_image");
    expect(others).toEqual(["upload_photo", "write_intro", "save_class", "submit_class"]);
    for (const action of others) expect(promoActionAllowed(action, lock)).toBe(true);
  });

  test("수업 등록 관문(SX-6.7)은 무료량과 상관없다 — 사진·직접 쓴 글이면 바로, AI 산출물은 검토 확인 뒤 통과", () => {
    expect(promoAssetsPublishable({ coverSource: "uploaded_photo", introSource: "user", reviewed: false })).toBe(true);
    expect(promoAssetsPublishable({ coverSource: null, introSource: null, reviewed: false })).toBe(true);
    expect(promoAssetsPublishable({ coverSource: "ai_image", introSource: "ai", reviewed: true })).toBe(true);
  });

  test("하루 횟수 소진이 먼저 보이고(I42), 둘 다 아니면 잠기지 않는다", () => {
    expect(promoGenerateLock({ remaining: 0, freeQuota: exhausted })).toEqual({ locked: true, reason: "daily_limit" });
    expect(promoActionAllowed("submit_class", promoGenerateLock({ remaining: 0, freeQuota: exhausted }))).toBe(true);
    const open = promoGenerateLock({ remaining: 1, freeQuota: { exhausted: false } });
    expect(open).toEqual({ locked: false });
    expect(promoActionAllowed("generate_image", open)).toBe(true);
  });
});
