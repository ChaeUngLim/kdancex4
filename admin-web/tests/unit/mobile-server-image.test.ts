// 앱 홍보 이미지 버그 수정(2026-11-25) — 서버 사진 바이트를 data URI 로 바꾸는 앱 순수 함수(mobile/lib/server-image.ts)와
// 처음 받을 표지 주소 고르기(mobile/lib/instructor/promo-cover.ts initialCoverPath)를 본다.
//   안드로이드 <Image> 가 Authorization 헤더를 싣지 않아 401 이 나던 것을, 앱이 바이트를 직접 받아 data URI 로 넣게 바꿨다.
import { describe, expect, test } from "vitest";

import { bytesToBase64, imageContentType, toImageDataUri } from "../../../mobile/lib/server-image";
import type { PromoAssets, PromoOptions } from "../../../mobile/lib/instructor/promo-api";
import { initialCoverPath } from "../../../mobile/lib/instructor/promo-cover";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("bytesToBase64 — Node Buffer 와 같은 결과", () => {
  test.each(["", "f", "fo", "foo", "foob", "fooba", "foobar"])("RFC 4648 예시 %j", (s) => {
    expect(bytesToBase64(bytes(s))).toBe(Buffer.from(s).toString("base64"));
  });

  test("0~255 모든 바이트(이진 사진 조각)", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(bytesToBase64(all)).toBe(Buffer.from(all).toString("base64"));
  });

  test("JPEG 머리(FF D8 FF E0)", () => {
    expect(bytesToBase64(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("/9j/4A==");
  });
});

describe("imageContentType — 이미지 형식만 통과", () => {
  test("jpeg · 매개변수 · 대문자", () => {
    expect(imageContentType("image/jpeg")).toBe("image/jpeg");
    expect(imageContentType("Image/PNG; charset=binary")).toBe("image/png");
    expect(imageContentType("image/webp")).toBe("image/webp");
  });
  test("이미지가 아니면 null(HTML 오류 페이지 · JSON · 헤더 없음)", () => {
    expect(imageContentType("text/html; charset=utf-8")).toBeNull();
    expect(imageContentType("application/json")).toBeNull();
    expect(imageContentType("image/svg+xml")).toBeNull();
    expect(imageContentType(null)).toBeNull();
  });
});

test("toImageDataUri — data:형식;base64,본문", () => {
  expect(toImageDataUri("image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("data:image/jpeg;base64,/9j/4A==");
});

describe("initialCoverPath — PromoFlow 처음 값과 같은 순서", () => {
  const assets = (over: Partial<PromoAssets>): PromoAssets => ({
    classId: "c1", coverSource: null, coverUrl: null, introText: null, introSource: null,
    aiImageGenerationId: null, introDraftId: null, reviewedAt: null, ...over,
  });
  const options = (last: PromoOptions["lastGeneration"]): PromoOptions => ({ lastGeneration: last } as PromoOptions);
  const last = (status: "succeeded" | "running" | "failed", imageUrl: string | null) => ({
    generationId: "g1", status, imageUrl, engine: "cloudflare_flux_schnell", sentence: "s", chips: {}, autoConditionIds: [], createdOn: "2026-11-25",
  });

  test("올린 사진이 먼저", () => {
    expect(initialCoverPath(options(last("succeeded", "/api/files/ai")), assets({ coverSource: "uploaded_photo", coverUrl: "/api/files/photo" }))).toBe("/api/files/photo");
  });
  test("마지막 생성이 성공이면 그 사진", () => {
    expect(initialCoverPath(options(last("succeeded", "/api/files/ai")), assets({}))).toBe("/api/files/ai");
  });
  test("마지막 생성이 아직 만드는 중·실패면 받을 사진 없음", () => {
    expect(initialCoverPath(options(last("running", null)), assets({}))).toBeNull();
    expect(initialCoverPath(options(last("failed", null)), assets({}))).toBeNull();
  });
  test("생성 기록이 없으면 저장해 둔 AI 표지", () => {
    expect(initialCoverPath(options(null), assets({ coverSource: "ai_image", coverUrl: "/api/files/saved", aiImageGenerationId: "g0" }))).toBe("/api/files/saved");
    expect(initialCoverPath(options(null), assets({}))).toBeNull();
  });
});
