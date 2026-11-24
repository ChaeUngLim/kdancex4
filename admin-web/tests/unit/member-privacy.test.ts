// S3-5.2(명단 API) — 회원을 보여 줄 때의 가림 순수 함수(계약 18 §1-2). DB 없이 돈다.
//   verify: 마스킹 형식(가운데 네 자리를 **** 로, 앞 세 자리·끝 네 자리만) · 연령대 경계(생일 전날·당일, KST 날짜)
// 이름: verify 의 tests/unit/s3-5-2.test.ts 는 Task 번호 이름이라 기능 이름(member-privacy)으로 바꿨다(증거 EVIDENCE.md 에 기록).
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import { AGE_BANDS, ageBandOf, maskPhone } from "@/lib/domain/member-privacy";
import { toKstDate } from "@/lib/domain/time";

const d = (iso: string) => Temporal.PlainDate.from(iso);

describe("연락처 가림 maskPhone(FR-187)", () => {
  test("하이픈 없는 11자리 → 010-****-끝 네 자리", () => {
    expect(maskPhone("01012345678")).toBe("010-****-5678");
  });
  test("하이픈 있는 번호도 같은 모양", () => {
    expect(maskPhone("010-2222-1234")).toBe("010-****-1234");
  });
  test("가운데가 세 자리인 10자리 번호도 **** 네 개 — 자릿수를 드러내지 않는다", () => {
    expect(maskPhone("0111234567")).toBe("011-****-4567");
  });
  test("가운데 숫자는 결과 어디에도 없다", () => {
    const masked = maskPhone("010-9876-5432");
    expect(masked).not.toContain("9876");
    expect(masked).toMatch(/^\d{3}-\*{4}-\d{4}$/);
  });
  test("너무 짧거나 숫자가 아닌 값은 통째로 가린다", () => {
    expect(maskPhone("12345")).toBe("***");
    expect(maskPhone("")).toBe("***");
  });
});

describe("연령대 ageBandOf(FR-168)", () => {
  test("5종만 있다 — 20대부터", () => {
    expect(AGE_BANDS).toEqual(["20s", "30s", "40s", "50s", "60s_plus"]);
  });
  test("만 19세는 20대로 묶는다(회원은 만 19세 이상)", () => {
    expect(ageBandOf(d("2007-11-23"), d("2026-11-23"))).toBe("20s");
  });
  test("30번째 생일 전날은 20대, 당일부터 30대", () => {
    expect(ageBandOf(d("1996-11-24"), d("2026-11-23"))).toBe("20s");
    expect(ageBandOf(d("1996-11-23"), d("2026-11-23"))).toBe("30s");
  });
  test("40·50대 경계", () => {
    expect(ageBandOf(d("1986-11-23"), d("2026-11-23"))).toBe("40s");
    expect(ageBandOf(d("1977-01-01"), d("2026-11-23"))).toBe("40s");
    expect(ageBandOf(d("1976-11-23"), d("2026-11-23"))).toBe("50s");
  });
  test("60세부터는 한 칸(60s_plus)", () => {
    expect(ageBandOf(d("1966-11-24"), d("2026-11-23"))).toBe("50s");
    expect(ageBandOf(d("1966-11-23"), d("2026-11-23"))).toBe("60s_plus");
    expect(ageBandOf(d("1940-05-05"), d("2026-11-23"))).toBe("60s_plus");
  });
  test("KST 날짜 기준 — UTC 로는 아직 생일 전날이어도 한국 새벽이면 생일 당일이다", () => {
    // 2026-11-22T16:00Z = 한국 11/23 01:00. 1996-11-23 생은 KST 로는 오늘 30번째 생일
    const today = toKstDate(Temporal.Instant.from("2026-11-22T16:00:00Z"));
    expect(today.toString()).toBe("2026-11-23");
    expect(ageBandOf(d("1996-11-23"), today)).toBe("30s");
  });
});
