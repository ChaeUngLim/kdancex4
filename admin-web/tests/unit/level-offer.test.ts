// S6-3.4(강사 레벨 조절과 평가 레벨 숨김) — 「최종 적용」 계획 함수와 안내 문구, 가짜 강사 멤버십(DB 없이).
import { describe, expect, test } from "vitest";

import { LEVEL_DETAIL_GENRES, GENRES } from "@/lib/domain/constants";
import { detailGenresOfGenre, levelOfferMessage, levelStageCode, planLevelApply } from "@/lib/domain/level-offer";
import { FakeInstructorMembership, parseInstructorIdList } from "@/lib/server/fakes/fake-instructor-membership";

describe("planLevelApply — 평가 저장 · 안내 보내기(계약 14 §6-1)", () => {
  test("회원 레벨보다 높고 열린 안내가 없으면 평가 저장 + 새 안내", () => {
    expect(planLevelApply({ memberLevel: 3, myEvaluation: null, openOffer: null }, 4)).toEqual({
      writeEvaluation: true,
      supersedeOpenOffer: false,
      sendOffer: true,
      offerSent: true,
      reason: null,
    });
  });

  test("같은 값 다시 — 평가·안내 모두 그대로(알림 중복 없음)", () => {
    expect(planLevelApply({ memberLevel: 3, myEvaluation: 4, openOffer: { mine: true, toLevel: 4 } }, 4)).toEqual({
      writeEvaluation: false,
      supersedeOpenOffer: false,
      sendOffer: false,
      offerSent: true,
      reason: null,
    });
  });

  test("다른 레벨로 다시 올리면 열린 안내를 닫고 새로 보낸다", () => {
    const plan = planLevelApply({ memberLevel: 3, myEvaluation: 4, openOffer: { mine: true, toLevel: 4 } }, 6);
    expect(plan).toMatchObject({ writeEvaluation: true, supersedeOpenOffer: true, sendOffer: true, offerSent: true });
  });

  test("다른 강사가 같은 레벨로 연 안내가 있어도 내 안내로 바꿔 보낸다(회원은 최신 안내 하나만 본다)", () => {
    const plan = planLevelApply({ memberLevel: 3, myEvaluation: null, openOffer: { mine: false, toLevel: 4 } }, 4);
    expect(plan).toMatchObject({ supersedeOpenOffer: true, sendOffer: true });
  });

  test("회원 레벨과 같거나 낮으면 평가만 저장하고 안내는 없다", () => {
    expect(planLevelApply({ memberLevel: 5, myEvaluation: null, openOffer: null }, 4)).toEqual({
      writeEvaluation: true,
      supersedeOpenOffer: false,
      sendOffer: false,
      offerSent: false,
      reason: "not_higher_than_member_level",
    });
    expect(planLevelApply({ memberLevel: 5, myEvaluation: null, openOffer: null }, 5).sendOffer).toBe(false);
  });

  test("내리면 내 열린 안내만 닫는다 — 다른 강사의 안내는 그대로", () => {
    expect(planLevelApply({ memberLevel: 3, myEvaluation: 6, openOffer: { mine: true, toLevel: 6 } }, 2).supersedeOpenOffer).toBe(true);
    expect(planLevelApply({ memberLevel: 3, myEvaluation: null, openOffer: { mine: false, toLevel: 6 } }, 2).supersedeOpenOffer).toBe(false);
  });

  test("0~10 밖 · 정수 아님은 거부", () => {
    const state = { memberLevel: 0, myEvaluation: null, openOffer: null };
    expect(() => planLevelApply(state, 11)).toThrow(RangeError);
    expect(() => planLevelApply(state, -1)).toThrow(RangeError);
    expect(() => planLevelApply(state, 2.5)).toThrow(RangeError);
  });
});

describe("levelOfferMessage — spec FR-169d ② 문장", () => {
  test("숫자 소리에 맞춰 「로/으로」", () => {
    expect(levelOfferMessage("이준호", "samba", 4)).toBe("이준호 강사님이 쌈바 레벨을 4(초중급)로 올려 줬어요");
    expect(levelOfferMessage("이준호", "salsa", 6)).toBe("이준호 강사님이 살사 레벨을 6(중급)으로 올려 줬어요");
    expect(levelOfferMessage("이준호", "salsa", 3)).toBe("이준호 강사님이 살사 레벨을 3(초급)으로 올려 줬어요");
    expect(levelOfferMessage("이준호", "salsa", 10)).toBe("이준호 강사님이 살사 레벨을 10(댄서)으로 올려 줬어요");
    expect(levelOfferMessage("이준호", "salsa", 7)).toBe("이준호 강사님이 살사 레벨을 7(중급)로 올려 줬어요");
    expect(levelOfferMessage("이준호", "salsa", 1)).toBe("이준호 강사님이 살사 레벨을 1(입문)로 올려 줬어요");
  });
});

describe("levelStageCode · detailGenresOfGenre", () => {
  test("단계 코드 6구간", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(levelStageCode)).toEqual([
      "entry", "entry", "beginner", "beginner", "novice_intermediate", "novice_intermediate",
      "intermediate", "intermediate", "advanced", "advanced", "dancer",
    ]);
    expect(() => levelStageCode(11)).toThrow(RangeError);
  });

  test("장르마다 세부 장르 — 합치면 14개 전부, 겹침 없음", () => {
    const all = GENRES.flatMap((g) => detailGenresOfGenre(g));
    expect([...all].sort()).toEqual([...LEVEL_DETAIL_GENRES].sort());
    expect(detailGenresOfGenre("salsa_bachata")).toEqual(["salsa", "bachata"]);
    expect(detailGenresOfGenre("dance_sport")).toHaveLength(10);
  });
});

describe("FakeInstructorMembership", () => {
  test("기본 멤버십 + 예외 목록 + set 으로 바꾸기", async () => {
    const fake = new FakeInstructorMembership({ defaultMember: true, except: ["b"] });
    expect(await fake.isInstructorMember("a")).toBe(true);
    expect(await fake.isInstructorMember("b")).toBe(false);
    fake.set("a", false).set("b", true);
    expect(await fake.isInstructorMember("a")).toBe(false);
    expect(await fake.isInstructorMember("b")).toBe(true);
    expect(fake.calls).toEqual(["a", "b", "a", "b"]);
  });

  test("환경 변수 목록 읽기 — 빈 칸·공백은 버린다", () => {
    expect(parseInstructorIdList(undefined)).toEqual([]);
    expect(parseInstructorIdList(" x , ,y,")).toEqual(["x", "y"]);
  });
});
