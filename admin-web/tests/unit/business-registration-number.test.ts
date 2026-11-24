// S2-1.2(강사 가입 API) — 사업자등록번호 모양·체크섬(계약 11 Phase 6 단위 「사업자번호 체크섬」)
import { describe, expect, test } from "vitest";

import {
  hasValidBusinessNumberChecksum,
  normalizeBusinessRegistrationNumber,
  parseBusinessRegistrationNumber,
} from "@/lib/domain/business-registration-number";

describe("사업자등록번호", () => {
  test("체크섬이 맞는 번호는 통과, 한 자리만 바꿔도 거부", () => {
    expect(hasValidBusinessNumberChecksum("1208147521")).toBe(true);
    expect(hasValidBusinessNumberChecksum("2208162517")).toBe(true);
    expect(hasValidBusinessNumberChecksum("1208147522")).toBe(false);
    expect(hasValidBusinessNumberChecksum("1234567890")).toBe(false);
  });

  test("하이픈 넣은 입력은 10자리로 맞춘다, 다른 글자·자릿수는 모양부터 거부", () => {
    expect(normalizeBusinessRegistrationNumber("120-81-47521")).toBe("1208147521");
    expect(normalizeBusinessRegistrationNumber(" 1208147521 ")).toBe("1208147521");
    for (const bad of ["120814752", "12081475211", "120 81 47521", "12a8147521", ""]) {
      expect(normalizeBusinessRegistrationNumber(bad)).toBeNull();
    }
  });

  test("parse = 모양 + 체크섬", () => {
    expect(parseBusinessRegistrationNumber("120-81-47521")).toBe("1208147521");
    expect(parseBusinessRegistrationNumber("120-81-47522")).toBeNull();
    expect(parseBusinessRegistrationNumber("abc")).toBeNull();
  });
});
