// S1-1.32(학원 설정 화면 W2b·W22) — 화면 순수 함수: 바뀐 칸만 보내기 · 계좌 칸 검사 · 사진 10장 상한.
import { describe, expect, test } from "vitest";

import {
  buildProfilePatch,
  isTotpCode,
  payoutFormProblems,
  photoLimitProblem,
  withoutPhoto,
  type ProfileForm,
} from "../../lib/academy-settings-form";

const BRANCH = "0193a0d0-0000-7000-8000-000000000001";
const base: ProfileForm = {
  address: "서울 강남구 테헤란로 000, 3층",
  phone: "020000000",
  openingHours: "평일 14:00–23:00",
  facilities: "",
  parking: "",
  accessibility: "",
  businessName: "라틴하우스",
  representativeName: "김대표",
  businessAddress: "서울 강남구 테헤란로 000",
  sellerPhone: "020000000",
  mailOrderReportNumber: "",
};

describe("buildProfilePatch — 바뀐 칸만 보낸다", () => {
  test("아무것도 안 바꿨으면 null(서버를 부르지 않는다)", () => {
    expect(buildProfilePatch(base, { ...base, parking: "  " }, BRANCH)).toBeNull();
  });

  test("지점 칸만 바꾸면 branches 하나에 그 칸만", () => {
    const patch = buildProfilePatch(base, { ...base, openingHours: "평일 14:00–23:00 · 주말 12:00–20:00", parking: "건물 지하 1시간 무료" }, BRANCH);
    expect(patch).toEqual({
      branches: [{ branchId: BRANCH, openingHours: "평일 14:00–23:00 · 주말 12:00–20:00", parking: "건물 지하 1시간 무료" }],
    });
  });

  test("판매자 전화는 seller.phone 으로, 지점 전화와 섞이지 않는다", () => {
    expect(buildProfilePatch(base, { ...base, sellerPhone: "0212345678" }, BRANCH)).toEqual({ seller: { phone: "0212345678" } });
  });

  test("지점이 없으면 지점 칸은 보내지 않는다", () => {
    expect(buildProfilePatch(base, { ...base, address: "다른 주소" }, null)).toBeNull();
  });
});

describe("payoutFormProblems — 인증 앱 코드를 받기 전에 계좌 칸을 본다", () => {
  test("맞는 칸이면 빈 배열(하이픈은 걷어 낸다)", () => {
    expect(payoutFormProblems({ bankCode: "004", accountNumber: "110-000-000999", holderName: "라틴하우스" })).toEqual([]);
  });

  test("은행 안 고름 · 짧은 번호 · 빈 예금주 → 세 줄", () => {
    expect(payoutFormProblems({ bankCode: "", accountNumber: "1234", holderName: " " })).toEqual([
      "은행을 골라 주세요",
      "계좌번호는 숫자 10~16자리예요",
      "예금주를 적어 주세요",
    ]);
  });

  test("인증 앱 코드는 숫자 6자리만", () => {
    expect(isTotpCode("123456")).toBe(true);
    expect(isTotpCode("12345")).toBe(false);
    expect(isTotpCode("12a456")).toBe(false);
  });
});

describe("photoLimitProblem — 사진 10장 상한", () => {
  test("10장까지는 통과", () => {
    expect(photoLimitProblem(0, 10)).toBeNull();
    expect(photoLimitProblem(7, 3)).toBeNull();
  });

  test("10장에서 1장 더 → 먼저 빼라는 안내", () => {
    expect(photoLimitProblem(10, 1)).toBe("사진은 10장까지 올릴 수 있어요 · 지금 10장이라 더 올리려면 먼저 한 장을 빼 주세요");
  });

  test("8장에서 3장 고름 → 2장만 더", () => {
    expect(photoLimitProblem(8, 3)).toBe("사진은 10장까지 올릴 수 있어요 · 지금 8장이라 2장만 더 고를 수 있어요");
  });

  test("한 장 빼기는 새 배열을 돌려주고 원래 배열은 그대로", () => {
    const ids = ["a", "b", "c"];
    expect(withoutPhoto(ids, "b")).toEqual(["a", "c"]);
    expect(ids).toEqual(["a", "b", "c"]);
  });
});
