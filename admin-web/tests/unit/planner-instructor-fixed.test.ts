// SX-5.7(앱 말로 찾기 화면·강사 프로필 입구) — 「강사가 정해진 채」 여는 AI 플래너의 서버 쪽 규칙.
//
// 강사 프로필(M15)의 「이 강사 수업 물어보기」와 강사 후보 카드(M10G)의 「선택」은 같은 `POST /api/ai/chat` 을
// `context.instructorId` 를 채워 부른다(계약 16 §3 · §5-2). 에이전트가 응답하지 않아 일반 검색(SX-5.5)으로 대체될 때도
// 그 강사가 그대로 쓰여야 한다 — 그렇지 않으면 「선택」을 눌러도 같은 후보 카드가 다시 나온다.
import { describe, expect, test } from "vitest";

import { createAiChatRoute } from "../../lib/server/ai/ai-chat-route";
import { runPlainSearch, type PlainSearchFinders } from "../../lib/server/ai/planner-plain-search";
import type { InstructorCandidate } from "../../lib/server/services/name-candidates";
import type { OfferingCard, SearchOfferingsInput } from "../../lib/server/services/offering-search";

const KIM_A = "11111111-1111-4111-8111-111111111111";
const KIM_B = "22222222-2222-4222-8222-222222222222";
const ACADEMY = "33333333-3333-4333-8333-333333333333";

function card(id: string): InstructorCandidate {
  return {
    instructorId: id,
    displayName: "김하나",
    photoUrl: null,
    genres: ["salsa_bachata"],
    academies: [{ id: ACADEMY, name: "라틴하우스 강남" }],
    publishedOfferingCount: 2,
    action: { type: "select_instructor", instructorId: id },
  };
}

// 카드 내용은 이 테스트의 관심이 아니다 — 검색 입력만 본다
const ONE_CARD = [{ offeringId: "o" }] as unknown as OfferingCard[];

function finders(options: { byId?: boolean } = {}) {
  const searched: SearchOfferingsInput[] = [];
  const value: PlainSearchFinders = {
    // 「김하나」는 동명이인 둘
    findInstructors: async ({ name }) =>
      name === "김하나"
        ? { resolution: "ambiguous", resolved: null, candidates: [card(KIM_A), card(KIM_B)] }
        : { resolution: "none", resolved: null, candidates: [] },
    findAcademies: async () => ({ resolution: "none", resolved: null, candidates: [] }),
    searchOfferings: async (input) => {
      searched.push(input);
      return ONE_CARD;
    },
    ...(options.byId === false
      ? {}
      : { findInstructorById: async (id: string) => ([KIM_A, KIM_B].includes(id) ? card(id) : null) }),
  };
  return { value, searched };
}

describe("일반 검색 — 정해진 강사(context.instructorId)", () => {
  test("동명이인 이름이어도 정해진 강사로 바로 찾는다(후보 카드를 다시 내지 않는다, M10G 선택)", async () => {
    const { value, searched } = finders();
    const reply = await runPlainSearch(value, "김하나 강사 수업 정보 모두 알려줘", { instructorId: KIM_B });

    expect(reply.kind).toBe("offering_cards");
    expect(searched[0]?.instructor).toEqual({ name: "김하나", id: KIM_B });
  });

  test("질문에 이름이 없어도 정해진 강사로 찾는다(M15 입구 뒤 「주말 수업 있어?」)", async () => {
    const { value, searched } = finders();
    const reply = await runPlainSearch(value, "주말 수업 있어?", { instructorId: KIM_A });

    expect(reply.kind).toBe("offering_cards");
    expect(searched[0]?.instructor).toEqual({ name: "김하나", id: KIM_A });
    // 찾은 조건이 함께 나와 화면의 조건 칩이 된다
    expect(reply.kind === "offering_cards" && reply.conditions.instructor).toEqual({ name: "김하나", id: KIM_A });
  });

  test("공개 강사가 아닌 id 면 정해진 값을 버리고 글자로 찾는다 — 동명이인이면 후보 카드", async () => {
    const { value, searched } = finders();
    const reply = await runPlainSearch(value, "김하나 강사 수업", { instructorId: "99999999-9999-4999-8999-999999999999" });

    expect(reply.kind).toBe("instructor_candidates");
    expect(searched).toHaveLength(0);
  });

  test("정해진 강사가 없으면 예전과 같다(동명이인 → 후보 카드)", async () => {
    const { value } = finders();
    expect((await runPlainSearch(value, "김하나 강사 수업")).kind).toBe("instructor_candidates");
  });
});

describe("POST /api/ai/chat — 대체 경로가 context.instructorId 를 일반 검색에 넘긴다", () => {
  test("에이전트가 꺼져 있어도 정해진 강사의 수업 카드로 답한다", async () => {
    const seen: { message?: string; instructorId?: string | null } = {};
    const route = createAiChatRoute({
      requireMember: async () => ({ authUserId: "u1", memberId: "m1" }),
      agent: null,
      newRunId: () => "run-1",
      issueAgentSessionToken: () => "t",
      plainSearch: async (message, context) => {
        seen.message = message;
        seen.instructorId = context.instructorId;
        return runPlainSearch(finders().value, message, { instructorId: context.instructorId });
      },
    });
    const body = {
      conversationId: null,
      context: { kind: "planner", academyId: null, offeringId: null, instructorId: KIM_A },
      message: "이 강사님 수업 알려줘",
    };
    const response = await route(
      new Request("http://localhost/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      undefined,
    );
    const text = await response.text();

    expect(seen).toEqual({ message: "이 강사님 수업 알려줘", instructorId: KIM_A });
    expect(text).toContain('"type":"data-conditions"');
    expect(text).toContain('"type":"data-cards"');
  });
});
