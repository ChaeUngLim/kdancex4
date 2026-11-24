// SX-6.2(장르별 기본 조건·글자 없음 조건) — 홍보 이미지 요청에 붙는 「자동으로 더해지는 조건」 순수 함수 테스트
//   계약 16 §4-7(options 의 autoConditions · POST /api/ai/promo-images 의 autoConditionIds) · §7-1(에이전트 promo_image payload)
//   FR-061a(홍보 이미지 생성 조건) ②「이미지 안에 글자 넣지 않음」 ③「수업 장르에 맞는 기본 조건」(끌 수 있음)
import { describe, expect, test } from "vitest";

import { GENRES } from "../../lib/domain/constants";
import {
  PROMO_AUTO_CONDITION_SETTINGS,
  PROMO_NO_TEXT_CONDITION_ID,
  buildPromoImageAgentPayload,
  promoAutoConditionOptions,
  resolvePromoAutoConditions,
} from "../../lib/domain/promo-image-conditions";

const sentenceKo = "커플이 스튜디오에서 빨간 조명 아래 열정적으로 살사를 추는 모습";

describe("설정 파일 — 장르별 조건 문장", () => {
  test("조건은 장르 자세·온몸 구도·글자 없음 세 가지이고, 글자 없음만 끌 수 없다", () => {
    expect(PROMO_AUTO_CONDITION_SETTINGS.conditions.map((c) => [c.id, c.removable])).toEqual([
      ["genre_pose", true],
      ["full_body", true],
      ["no_text", false],
    ]);
  });

  test("네 장르 모두 장르 자세 문장(한글·영어)이 설정에 있다", () => {
    for (const genre of GENRES) {
      const [pose] = promoAutoConditionOptions(genre);
      expect(pose.id).toBe("genre_pose");
      expect(pose.label.length).toBeGreaterThan(0);
    }
  });

  test("장르마다 자세 문장이 다르다 — spec 추천안(살사/바차타 마주 선 커플 · 탱고 가까이 안은 · 스윙 경쾌한 커플 스텝 · 댄스스포츠 볼룸)", () => {
    const label = (g: (typeof GENRES)[number]) => promoAutoConditionOptions(g)[0].label;
    expect(label("salsa_bachata")).toBe("마주 선 커플 소셜댄스 자세");
    expect(label("argentine_tango")).toBe("가까이 안은 자세");
    expect(label("swing")).toBe("경쾌한 커플 스텝");
    expect(label("dance_sport")).toBe("볼룸 자세");
  });
});

describe("화면에 보일 조건 목록(options 의 autoConditions)", () => {
  test("계약 모양 그대로 — 모두 기본 켜짐, 글자 없음은 removable false", () => {
    expect(promoAutoConditionOptions("salsa_bachata")).toEqual([
      { id: "genre_pose", label: "마주 선 커플 소셜댄스 자세", defaultOn: true, removable: true },
      { id: "full_body", label: "온몸이 보이는 구도 · 다른 종류의 춤 아님", defaultOn: true, removable: true },
      { id: "no_text", label: "이미지 안에 글자 없음", defaultOn: true, removable: false },
    ]);
  });
});

describe("요청에 붙는 조건 — 수용 ②③", () => {
  test("장르 조건을 켠 요청에는 그 장르의 조건이 붙는다", () => {
    const r = resolvePromoAutoConditions("argentine_tango", ["genre_pose", "full_body"]);
    expect(r.appliedIds).toEqual(["genre_pose", "full_body", "no_text"]);
    expect(r.applied[0]).toMatchObject({ id: "genre_pose", label: "가까이 안은 자세" });
    expect(r.applied[0].textEn.length).toBeGreaterThan(0);
  });

  test("장르 조건을 끈 요청에는 붙지 않는다", () => {
    const r = resolvePromoAutoConditions("argentine_tango", ["full_body"]);
    expect(r.appliedIds).toEqual(["full_body", "no_text"]);
    expect(r.applied.some((c) => c.id === "genre_pose")).toBe(false);
  });

  test("다 끄면 글자 없음 하나만 남는다(쓴 문장과 ①②만으로 만든다)", () => {
    expect(resolvePromoAutoConditions("swing", []).appliedIds).toEqual(["no_text"]);
  });

  test("글자 없음은 요청에서 빼도 항상 붙는다 — 켠 경우·끈 경우 모두, 네 장르 모두", () => {
    for (const genre of GENRES) {
      for (const ids of [["genre_pose", "full_body"], ["full_body"], []]) {
        const r = resolvePromoAutoConditions(genre, ids);
        expect(r.appliedIds).toContain(PROMO_NO_TEXT_CONDITION_ID);
      }
    }
  });

  test("알 수 없는 id 는 무시하고, 겹친 id 는 한 번만, 순서는 설정 순서다", () => {
    const r = resolvePromoAutoConditions("salsa_bachata", ["no_text", "unknown", "full_body", "genre_pose", "full_body"]);
    expect(r.appliedIds).toEqual(["genre_pose", "full_body", "no_text"]);
  });

  test("받은 배열을 바꾸지 않는다", () => {
    const ids = ["full_body"];
    resolvePromoAutoConditions("swing", ids);
    expect(ids).toEqual(["full_body"]);
  });
});

describe("에이전트에 보내는 payload(§7-1 promo_image)", () => {
  test("켠 요청 — 장르 조건 영어 문장과 글자 없음이 들어가고 textless 는 true", () => {
    const p = buildPromoImageAgentPayload({
      generationId: "g-1",
      genre: "salsa_bachata",
      sentenceKo,
      autoConditionIds: ["genre_pose", "full_body"],
    });
    expect(p.generationId).toBe("g-1");
    expect(p.genre).toBe("salsa_bachata");
    expect(p.sentenceKo).toBe(sentenceKo);
    expect(p.textless).toBe(true);
    expect(p.autoConditions.map((c) => c.id)).toEqual(["genre_pose", "full_body", "no_text"]);
    for (const c of p.autoConditions) expect(c.textEn.length).toBeGreaterThan(0);
    expect(p.autoConditions.find((c) => c.id === "no_text")?.textEn).toMatch(/no text/i);
  });

  test("끈 요청 — 장르 조건이 없고 글자 없음은 그대로 있다", () => {
    const p = buildPromoImageAgentPayload({ generationId: "g-2", genre: "salsa_bachata", sentenceKo, autoConditionIds: [] });
    expect(p.autoConditions.map((c) => c.id)).toEqual(["no_text"]);
    expect(p.textless).toBe(true);
  });

  test("강사가 쓴 문장은 바꾸지 않고 그대로 보낸다(조건은 따로 싣는다)", () => {
    const p = buildPromoImageAgentPayload({ generationId: "g-3", genre: "swing", sentenceKo, autoConditionIds: ["genre_pose"] });
    expect(p.sentenceKo).toBe(sentenceKo);
  });
});
