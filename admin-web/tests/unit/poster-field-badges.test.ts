// SX-2.4(낮은 신뢰도·AI 생성 표시) — 포스터 읽기 칸마다 붙일 표시(「확인필요」 · 「AI 생성」) 판정 단위 테스트
//   계약 16 §4-6(needsCheck · valueSource) · FR-075(확인필요 표시) · FR-258(AI 생성 표시)
import { describe, expect, test } from "vitest";

import {
  POSTER_BADGE_LABELS,
  posterFieldBadges,
  posterNeedsCheckKeys,
  type PosterFieldDisplayInput,
} from "../../lib/domain/poster-field-badges";

// 기본은 「AI 가 높은 신뢰도로 채운, 아직 확인 안 한 칸」
const field = (over: Partial<PosterFieldDisplayInput> = {}): PosterFieldDisplayInput => ({
  key: "price_amount",
  value: 180000,
  confidence: 0.95,
  valueSource: "ai",
  confirmedAt: null,
  ...over,
});

describe("표시 문구", () => {
  test("화면에 붙는 글자는 「확인필요」 와 「AI 생성」 이다", () => {
    expect(POSTER_BADGE_LABELS).toEqual({ needsCheck: "확인필요", aiGenerated: "AI 생성" });
  });
});

describe("「확인필요」 — 신뢰도 기준(0.80) 밑", () => {
  test("O2 보드 71% 칸은 확인필요 + AI 생성", () => {
    const b = posterFieldBadges(field({ confidence: 0.71 }));
    expect(b.needsCheck).toBe(true);
    expect(b.aiGenerated).toBe(true);
    expect(b.labels).toEqual(["확인필요", "AI 생성"]);
  });

  test("O2 보드 87%·92% 칸은 확인필요가 아니고 AI 생성만", () => {
    for (const confidence of [0.87, 0.92]) {
      const b = posterFieldBadges(field({ confidence }));
      expect(b.needsCheck).toBe(false);
      expect(b.labels).toEqual(["AI 생성"]);
    }
  });

  test("기준값 0.80 과 같으면 확인필요가 아니고, 0.799 는 확인필요", () => {
    expect(posterFieldBadges(field({ confidence: 0.8 })).needsCheck).toBe(false);
    expect(posterFieldBadges(field({ confidence: 0.799 })).needsCheck).toBe(true);
  });

  test("기준값을 바꿔 넘기면 그 값으로 판정한다(설정 poster.confidence_min 자리)", () => {
    expect(posterFieldBadges(field({ confidence: 0.87 }), 0.9).needsCheck).toBe(true);
  });

  test("신뢰도가 없거나 숫자가 아니거나 0~1 밖이면 확인필요", () => {
    for (const confidence of [null, Number.NaN, 1.5, -0.1]) {
      expect(posterFieldBadges(field({ confidence })).needsCheck).toBe(true);
    }
  });

  test("AI 가 못 읽은 빈 칸은 확인필요, AI 가 채운 값이 없으니 AI 생성은 붙지 않는다", () => {
    const b = posterFieldBadges(field({ key: "capacity_total", value: null, confidence: null }));
    expect(b).toEqual({ needsCheck: true, aiGenerated: false, labels: ["확인필요"] });
  });
});

describe("사람이 손댄 칸", () => {
  test("검토에서 「맞다」고 확인한 칸은 확인필요가 사라지고 AI 생성은 남는다(값은 여전히 AI 것)", () => {
    const b = posterFieldBadges(field({ confidence: 0.71, confirmedAt: "2026-11-23T03:00:00.000Z" }));
    expect(b).toEqual({ needsCheck: false, aiGenerated: true, labels: ["AI 생성"] });
  });

  test("비어 있는 게 맞다고 확인한 빈 칸은 표시가 없다", () => {
    const b = posterFieldBadges(field({ value: null, confidence: null, confirmedAt: "2026-11-23T03:00:00.000Z" }));
    expect(b.labels).toEqual([]);
  });

  test("AI 값을 사람이 고친 칸(ai_edited)은 신뢰도가 낮아도 표시가 없다", () => {
    const b = posterFieldBadges(field({ valueSource: "ai_edited", confidence: 0.4 }));
    expect(b).toEqual({ needsCheck: false, aiGenerated: false, labels: [] });
  });

  test("사람이 직접 채운 칸(user)은 표시가 없다", () => {
    const b = posterFieldBadges(field({ valueSource: "user", confidence: null }));
    expect(b.labels).toEqual([]);
  });
});

describe("posterNeedsCheckKeys — 아직 확인필요인 칸 목록", () => {
  test("확인필요인 칸 키만 원래 순서대로 돌려준다", () => {
    const keys = posterNeedsCheckKeys([
      field({ key: "title", confidence: 0.95 }),
      field({ key: "price_amount", confidence: 0.71 }),
      field({ key: "capacity_total", value: null, confidence: null }),
      field({ key: "room_name", confidence: 0.5, valueSource: "ai_edited" }),
      field({ key: "level", confidence: 0.6, confirmedAt: "2026-11-23T03:00:00.000Z" }),
    ]);
    expect(keys).toEqual(["price_amount", "capacity_total"]);
  });

  test("받은 배열을 바꾸지 않는다", () => {
    const list = [field({ confidence: 0.5 })];
    const copy = structuredClone(list);
    posterNeedsCheckKeys(list);
    expect(list).toEqual(copy);
  });
});
