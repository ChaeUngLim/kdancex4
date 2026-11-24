// S6-3.8(앱 회원 레벨 카드 화면) — 등급 카드 그림 열쇠(lib/domain/level-card-art.ts)
import { describe, expect, test } from "vitest";

import { LEVEL_DETAIL_GENRES } from "@/lib/domain/constants";
import { levelArtBundle, levelArtStep, levelCharacterKey } from "@/lib/domain/level-card-art";

describe("등급 카드 그림 열쇠", () => {
  test("레벨 두 칸이 그림 한 장, 10 은 따로", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(levelArtStep)).toEqual([
      "l01", "l01", "l23", "l23", "l45", "l45", "l67", "l67", "l89", "l89", "l10",
    ]);
  });

  test("범위 밖 레벨은 던진다", () => {
    expect(() => levelArtStep(-1)).toThrow(RangeError);
    expect(() => levelArtStep(11)).toThrow(RangeError);
    expect(() => levelArtStep(2.5)).toThrow(RangeError);
  });

  test("라틴은 samba, 스탠다드는 viennese, 아르헨티나 탱고는 tango 묶음", () => {
    expect(["cha_cha_cha", "samba", "rumba", "paso_doble", "jive"].map((g) => levelArtBundle(g as never))).toEqual(Array(5).fill("samba"));
    expect(["waltz", "tango", "viennese_waltz", "slow_foxtrot", "quickstep"].map((g) => levelArtBundle(g as never))).toEqual(Array(5).fill("viennese"));
    expect(levelArtBundle("argentine_tango")).toBe("tango");
    expect(levelArtBundle("swing")).toBe("swing");
    expect(levelArtBundle("salsa")).toBe("salsa");
    expect(levelArtBundle("bachata")).toBe("bachata");
  });

  test("열쇠 모양 「묶음/성별_단계」 — 모든 세부 장르·레벨·성별", () => {
    expect(levelCharacterKey("salsa", 1, "male")).toBe("salsa/m_l01");
    expect(levelCharacterKey("samba", 10, "female")).toBe("samba/f_l10");
    for (const g of LEVEL_DETAIL_GENRES) {
      for (let l = 0; l <= 10; l += 1) {
        expect(levelCharacterKey(g, l, "female")).toMatch(/^(samba|viennese|tango|swing|salsa|bachata)\/f_l(01|23|45|67|89|10)$/);
      }
    }
  });
});
