// SX-6.1(필수 4항목 검증·문장 채우기) — 홍보 이미지 만들기 전에 필수 칩 4항목을 판정하고 문장을 채우는 순수 함수 테스트
//   계약 16 §4-7(`POST /api/ai/promo-images` 2단계 · 422 PROMO_REQUIRED_MISSING + missing) · FR-061a(홍보 이미지 생성 조건)
import { describe, expect, test } from "vitest";

import {
  PROMO_CHIP_SETTINGS,
  PROMO_REQUIRED_CHIP_KEYS,
  checkPromoRequiredChips,
  fillPromoSentence,
  promoGenreChip,
  type PromoChipSelections,
} from "../../lib/domain/promo-image-chips";

// 보드 I32B 의 「필수 4 / 4」 상태 — 네 칸을 모두 칩으로 고름
const full: PromoChipSelections = { who: "커플", mood: "열정적인", place: "스튜디오", color: "빨간 조명" };

describe("설정 파일 — 칩 낱말 목록", () => {
  test("필수 항목은 누가·분위기·장소·색감 4개이고 순서가 화면 순서와 같다", () => {
    expect(PROMO_REQUIRED_CHIP_KEYS).toEqual(["who", "mood", "place", "color"]);
    expect(PROMO_CHIP_SETTINGS.requiredChips.map((c) => c.label)).toEqual(["누가", "분위기", "장소", "색감·조명"]);
  });

  test("칩 낱말은 spec FR-061a 추천안과 같다(코드가 아니라 설정 파일에서 읽는다)", () => {
    const byKey = Object.fromEntries(PROMO_CHIP_SETTINGS.requiredChips.map((c) => [c.key, c.options]));
    expect(byKey.who).toEqual(["커플", "단체", "솔로"]);
    expect(byKey.mood).toEqual(["열정적인", "우아한", "경쾌한", "로맨틱한", "편안한"]);
    expect(byKey.place).toEqual(["스튜디오", "무대", "파티 홀", "야외"]);
    expect(byKey.color).toEqual(["빨간 조명", "따뜻한 노을빛", "푸른 밤", "밝은 자연광"]);
  });
});

describe("필수 4항목 판정 — 수용 ①", () => {
  test("네 항목을 다 고르면 통과한다", () => {
    expect(checkPromoRequiredChips(full)).toEqual({ ok: true });
  });

  test("하나라도 빠지면 거부하고 빠진 항목 이름을 알려 준다", () => {
    for (const key of PROMO_REQUIRED_CHIP_KEYS) {
      const chips = { ...full };
      delete chips[key];
      const r = checkPromoRequiredChips(chips);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.code).toBe("PROMO_REQUIRED_MISSING");
      expect(r.missing).toEqual([key]);
      const label = PROMO_CHIP_SETTINGS.requiredChips.find((c) => c.key === key)!.label;
      expect(r.missingLabels).toEqual([label]);
    }
  });

  test("장소가 빠지면 계약 예시 그대로 missing: [\"place\"]", () => {
    const r = checkPromoRequiredChips({ who: "커플", mood: "열정적인", color: "빨간 조명" });
    expect(r).toEqual({
      ok: false,
      code: "PROMO_REQUIRED_MISSING",
      missing: ["place"],
      missingLabels: ["장소"],
      message: "장소를 골라 주세요.",
    });
  });

  test("여러 개가 빠지면 화면 순서(누가→분위기→장소→색감)로 모두 알려 준다", () => {
    const r = checkPromoRequiredChips({ place: "무대" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(["who", "mood", "color"]);
    expect(r.missingLabels).toEqual(["누가", "분위기", "색감·조명"]);
    expect(r.message).toBe("누가 · 분위기 · 색감·조명을 골라 주세요.");
  });

  test("아무것도 안 고르면 4개 모두 빠짐", () => {
    const r = checkPromoRequiredChips({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(["who", "mood", "place", "color"]);
  });

  test("직접 쓰기로 넣은 항목은 채운 것으로 본다", () => {
    const r = checkPromoRequiredChips({ ...full, place: { custom: "한강 공원" } });
    expect(r).toEqual({ ok: true });
  });

  test("직접 쓰기가 빈 칸·공백뿐이면 빠진 것으로 본다", () => {
    for (const custom of ["", "   "]) {
      const r = checkPromoRequiredChips({ ...full, color: { custom } });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.missing).toEqual(["color"]);
    }
  });

  test("칩 목록에 없는 낱말을 칩 값으로 보내면 빠진 것으로 본다(칩에 없는 표현은 직접 쓰기로만)", () => {
    const r = checkPromoRequiredChips({ ...full, who: "커플 세 쌍" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(["who"]);
  });

  test("다른 항목의 칩 낱말을 넣어도 빠진 것으로 본다", () => {
    const r = checkPromoRequiredChips({ ...full, mood: "스튜디오" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(["mood"]);
  });

  test("입력 객체를 바꾸지 않는다", () => {
    const chips: PromoChipSelections = { who: "커플" };
    const copy = JSON.parse(JSON.stringify(chips));
    checkPromoRequiredChips(chips);
    expect(chips).toEqual(copy);
  });
});

describe("장르 칩 — 등록 중인 수업에서 가져온다", () => {
  test("살사·바차타 + 세부 장르 살사 → 잠긴 칩 「살사」", () => {
    expect(promoGenreChip({ genre: "salsa_bachata", subGenre: "salsa" })).toEqual({
      genre: "salsa_bachata",
      label: "살사",
      locked: true,
    });
  });

  test("세부 장르가 없는 장르와 세부 장르 없는 경우", () => {
    expect(promoGenreChip({ genre: "argentine_tango", subGenre: null }).label).toBe("탱고");
    expect(promoGenreChip({ genre: "swing", subGenre: null }).label).toBe("스윙");
    expect(promoGenreChip({ genre: "salsa_bachata", subGenre: "bachata" }).label).toBe("바차타");
    expect(promoGenreChip({ genre: "salsa_bachata", subGenre: null }).label).toBe("살사·바차타");
    expect(promoGenreChip({ genre: "dance_sport", subGenre: "latin" }).label).toBe("라틴 댄스");
    expect(promoGenreChip({ genre: "dance_sport", subGenre: null }).label).toBe("댄스스포츠");
  });
});

describe("문장 채우기 — 칩을 고르면 입력 칸에 문장이 채워진다", () => {
  const salsa = promoGenreChip({ genre: "salsa_bachata", subGenre: "salsa" });

  test("네 칩을 다 고르면 spec 예시 문장과 같다", () => {
    expect(fillPromoSentence(full, salsa)).toBe("커플이 스튜디오에서 빨간 조명 아래 열정적으로 살사를 추는 모습");
  });

  test("받침에 따라 조사가 바뀌고 분위기 낱말은 부사로 바뀐다", () => {
    const tango = promoGenreChip({ genre: "argentine_tango", subGenre: null });
    expect(fillPromoSentence({ who: "솔로", mood: "우아한", place: "무대", color: "푸른 밤" }, tango)).toBe(
      "솔로가 무대에서 푸른 밤 아래 우아하게 탱고를 추는 모습",
    );
  });

  test("고른 칩만으로 부분 문장을 채운다", () => {
    expect(fillPromoSentence({ who: "단체" }, salsa)).toBe("단체가 살사를 추는 모습");
    expect(fillPromoSentence({ place: "파티 홀", mood: "편안한" }, salsa)).toBe("파티 홀에서 편안하게 살사를 추는 모습");
  });

  test("아무 칩도 안 고르면 빈 문장(입력 칸 안내 글이 보인다)", () => {
    expect(fillPromoSentence({}, salsa)).toBe("");
  });

  test("직접 쓰기 값도 문장에 들어가고 앞뒤 공백은 뗀다", () => {
    expect(fillPromoSentence({ ...full, place: { custom: " 한강 공원 " }, mood: { custom: "신나는" } }, salsa)).toBe(
      "커플이 한강 공원에서 빨간 조명 아래 신나는 분위기로 살사를 추는 모습",
    );
  });

  test("채운 문장은 판정을 통과한 칩과 같은 내용이고, 판정과 상관없이 장르는 수업 값이다", () => {
    const swing = promoGenreChip({ genre: "swing", subGenre: null });
    expect(fillPromoSentence({ who: "커플", mood: "경쾌한", place: "야외", color: "밝은 자연광" }, swing)).toBe(
      "커플이 야외에서 밝은 자연광 아래 경쾌하게 스윙을 추는 모습",
    );
  });
});
