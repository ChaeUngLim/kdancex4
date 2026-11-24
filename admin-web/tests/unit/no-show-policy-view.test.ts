// S1-3.10(관리자 웹 노쇼 안내 화면 W8B) — 노쇼 기준 응답 → 보드 W8B 글 바꾸기 확인.
import { describe, expect, test } from "vitest";

import { noShowPointViews } from "@/lib/no-show-policy-view";
import { readNoShowPolicy } from "@/lib/server/services/no-show-policy";

describe("noShowPointViews", () => {
  test("지금 기준의 규칙 넷은 모두 보드 제목·설명이 있다(빠진 번역 없음)", () => {
    const views = noShowPointViews(readNoShowPolicy());
    expect(views.map((v) => v.title)).toEqual([
      "결석 알림은 불이익이 아니에요",
      "노쇼 기록 · 대기 순번 불이익은 없어요",
      "휴강은 다른 규칙이에요",
      "분쟁이 생기면",
    ]);
    expect(views.every((v) => v.detail !== null)).toBe(true);
  });

  test("모르는 규칙 문장은 그대로 제목으로 보인다", () => {
    const views = noShowPointViews({ ...readNoShowPolicy(), points: ["새 규칙"] });
    expect(views).toEqual([{ title: "새 규칙", detail: null }]);
  });

  test("readNoShowPolicy 는 상수를 복사해 준다 — 받은 배열을 바꿔도 다음 값은 그대로", () => {
    const first = readNoShowPolicy();
    first.points.push("x");
    expect(readNoShowPolicy().points).toHaveLength(4);
  });
});
