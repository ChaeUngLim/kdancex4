// S6-3.5(개강 후보) — 대표 근거 고르기·세기 순수 함수와 「보기」 토큰(계약 14 §6-2)
import { describe, expect, test } from "vitest";

import { basisLabel, genreOfDetailGenre, pickCandidates, primaryBasis, summarizeCandidates, type CandidateFlags } from "@/lib/domain/new-class-candidates";
import { candidateRevealKey, signCandidateRevealToken, verifyCandidateRevealToken } from "@/lib/server/candidate-reveal-token";

const row = (memberId: string, gender: "male" | "female", flags: Partial<CandidateFlags>): CandidateFlags => ({
  memberId,
  gender,
  completedSameDetailGenre: false,
  attendingSameGenre: false,
  preferredTime: false,
  consented: false,
  ...flags,
});

describe("대표 근거와 세기", () => {
  test("여러 근거에 걸리면 앞 근거 하나만 — 완주 > 수강 중 > 시간", () => {
    expect(primaryBasis({ completedSameDetailGenre: true, attendingSameGenre: true, preferredTime: true })).toBe("completed_same_detail_genre");
    expect(primaryBasis({ completedSameDetailGenre: false, attendingSameGenre: true, preferredTime: true })).toBe("attending_same_genre");
    expect(primaryBasis({ completedSameDetailGenre: false, attendingSameGenre: false, preferredTime: true })).toBe("preferred_time");
    expect(primaryBasis({ completedSameDetailGenre: false, attendingSameGenre: false, preferredTime: false })).toBeNull();
  });

  test("근거가 없는 사람은 빠지고, 근거별 인원의 합은 total 과 같다(한 사람은 한 번만 센다)", () => {
    const candidates = pickCandidates([
      row("a", "female", { completedSameDetailGenre: true, preferredTime: true, consented: true }),
      row("b", "female", { attendingSameGenre: true }),
      row("c", "male", { preferredTime: true, consented: true }),
      row("d", "male", { preferredTime: true }),
      row("e", "female", { consented: true }),
    ]);
    const s = summarizeCandidates(candidates);
    expect(s).toEqual({
      total: 4,
      male: 2,
      female: 2,
      basis: [
        { kind: "completed_same_detail_genre", count: 1 },
        { kind: "attending_same_genre", count: 1 },
        { kind: "preferred_time", count: 2 },
      ],
      contactConsent: { consenting: 2, notConsenting: 2 },
    });
    expect(s.basis.reduce((n, b) => n + b.count, 0)).toBe(s.total);
  });

  test("후보가 없어도 근거 세 줄은 0 으로 있다", () => {
    expect(summarizeCandidates([]).basis.map((b) => b.count)).toEqual([0, 0, 0]);
  });

  test("세부 장르의 대분류와 근거 문장 — 「쌈바」 표기, 요일은 문장에 넣지 않는다", () => {
    expect(genreOfDetailGenre("samba")).toBe("dance_sport");
    expect(genreOfDetailGenre("bachata")).toBe("salsa_bachata");
    expect(genreOfDetailGenre("swing")).toBe("swing");
    expect(basisLabel("completed_same_detail_genre", "samba", null)).toBe("쌈바 정규 과정을 끝까지 마쳤어요");
    expect(basisLabel("attending_same_genre", "rumba", null)).toBe("댄스스포츠 수업을 듣고 있어요");
    expect(basisLabel("preferred_time", "salsa", { from: "20:30", to: "21:30" })).toBe("20:30~21:30 시간대를 선호 시간으로 골랐어요");
  });
});

describe("「보기」 토큰", () => {
  const key = candidateRevealKey("root-secret-for-test");
  const base = { key, instructorAccountId: "staff-1", memberId: "member-1" };
  const token = signCandidateRevealToken({ ...base, nowEpochSeconds: 1_000 });

  test("같은 강사·같은 회원·15분 안이면 맞다", () => {
    expect(verifyCandidateRevealToken(token, { ...base, nowEpochSeconds: 1_000 + 15 * 60 - 1 })).toBe(true);
  });

  test("만료·다른 회원·다른 강사·다른 키·위조·빈 키는 틀리다", () => {
    expect(verifyCandidateRevealToken(token, { ...base, nowEpochSeconds: 1_000 + 15 * 60 })).toBe(false);
    expect(verifyCandidateRevealToken(token, { ...base, memberId: "member-2", nowEpochSeconds: 1_001 })).toBe(false);
    expect(verifyCandidateRevealToken(token, { ...base, instructorAccountId: "staff-2", nowEpochSeconds: 1_001 })).toBe(false);
    expect(verifyCandidateRevealToken(token, { ...base, key: candidateRevealKey("other"), nowEpochSeconds: 1_001 })).toBe(false);
    expect(verifyCandidateRevealToken(`${token.split(".")[0]}.AAAA`, { ...base, nowEpochSeconds: 1_001 })).toBe(false);
    expect(verifyCandidateRevealToken("garbage", { ...base, nowEpochSeconds: 1_001 })).toBe(false);
    expect(verifyCandidateRevealToken(token, { ...base, key: "", nowEpochSeconds: 1_001 })).toBe(false);
  });

  test("용도 키는 원본 비밀값과 다르다(로그인 서명과 섞이지 않는다)", () => {
    expect(key).not.toBe("root-secret-for-test");
    expect(candidateRevealKey("")).toBe("");
  });
});
