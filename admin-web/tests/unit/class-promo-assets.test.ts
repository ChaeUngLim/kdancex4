// SX-6.7(검토 후 게시 경로) — 표지 고르기(사진이 먼저)와 「검토 확인이 있어야 하나」 판정. DB 없이 순수 함수만 본다.
import { describe, expect, test } from "vitest";

import { containsAiContent, decideCoverSource, promoAssetsPublishable } from "@/lib/domain/class-promo-assets";

describe("표지 고르기(사진이 먼저)", () => {
  test("사진과 AI 이미지가 둘 다 있으면 사진", () => {
    expect(decideCoverSource({ uploadedPhotoFileId: "p", aiImageGenerationId: "g" })).toBe("uploaded_photo");
  });
  test("사진이 없으면 AI 이미지, 둘 다 없으면 표지 없음", () => {
    expect(decideCoverSource({ uploadedPhotoFileId: null, aiImageGenerationId: "g" })).toBe("ai_image");
    expect(decideCoverSource({ uploadedPhotoFileId: null, aiImageGenerationId: null })).toBeNull();
  });
});

describe("검토 확인 판정", () => {
  test("AI 표지나 AI 문구(그대로·고침)가 있으면 AI 가 만든 것이다", () => {
    expect(containsAiContent("ai_image", null)).toBe(true);
    expect(containsAiContent(null, "ai")).toBe(true);
    expect(containsAiContent("uploaded_photo", "ai_edited")).toBe(true);
    expect(containsAiContent("uploaded_photo", "user")).toBe(false);
    expect(containsAiContent(null, null)).toBe(false);
  });
  test("AI 가 만든 것이 있는데 검토 확인이 없으면 게시 못 한다", () => {
    expect(promoAssetsPublishable({ coverSource: "ai_image", introSource: null, reviewed: false })).toBe(false);
    expect(promoAssetsPublishable({ coverSource: "ai_image", introSource: null, reviewed: true })).toBe(true);
    expect(promoAssetsPublishable({ coverSource: "uploaded_photo", introSource: "user", reviewed: false })).toBe(true);
  });
});
