// SX-5.6(신청하기는 수업 상세로만·쓰기 도구 0개) — 수업 카드의 버튼 값이 「수업 상세로 가기」뿐인지 본다(수용 ④ · FR-214(AI 쓰기 금지)).
//   ① 카드 버튼 값은 open_offering 하나이고 id 두 개 말고는 아무것도 담지 않는다.
//   ② 버튼이 가는 앱 경로는 수업 상세 경로(`/offering/…`)뿐이다.
//   ③ 에이전트가 카드에 예약·결제 값을 끼워 보내도 Next.js 스트림 번역을 지나면 사라진다.
//   ④ 검색 도구(SX-5.3)와 일반 검색 대체(SX-5.5)가 만드는 카드도 같은 규칙을 따른다(소스에 예약·결제 호출이 없다).
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  OFFERING_CARD_ACTION_TYPES,
  OFFERING_DETAIL_PATH_PREFIX,
  offeringCardActionSchema,
  offeringCardDestination,
  openOfferingAction,
  sanitizeOfferingCardItems,
} from "@/lib/domain/offering-card-action";
import { initialTranslateState, translateAgentEvent } from "@/lib/server/ai/agent-stream-translate";
import { offeringCardSchema } from "@/lib/server/services/offering-search";

const OFFERING_ID = "33333333-3333-4333-8333-333333333333";
const CLASS_ID = "44444444-4444-4444-8444-444444444444";
const PRIVATE_CLASS_ID = "55555555-5555-4555-8555-555555555555";

// 계약 16 §5-2 모양의 카드(쌈바 입문반 — SX-5.3 테스트와 같은 값)
const CARD = {
  offeringId: OFFERING_ID,
  classId: CLASS_ID,
  title: "쌈바 입문반",
  genre: "dance_sport",
  isPrivateLesson: false,
  academy: { id: "22222222-2222-4222-8222-222222222222", name: "라틴하우스 강남" },
  hall: "A홀",
  pattern: [{ weekday: "tue", startTime: "19:00", endTime: "20:00" }],
  firstSessionDate: "2026-12-01",
  lastSessionDate: "2026-12-24",
  sessionCount: 8,
  level: "entry",
  pools: [
    { seatKind: "male", remaining: 1 },
    { seatKind: "female", remaining: 6 },
  ],
  priceAmount: 120000,
  recruitStatus: "closing_soon",
  waitlistAvailable: false,
  action: { type: "open_offering", offeringId: OFFERING_ID, classId: CLASS_ID },
} as const;

const PRIVATE_CARD = {
  ...CARD,
  offeringId: null,
  classId: PRIVATE_CLASS_ID,
  title: "개인 레슨",
  isPrivateLesson: true,
  pools: [],
  level: null,
  action: { type: "open_offering", offeringId: null, classId: PRIVATE_CLASS_ID },
} as const;

/** 번역기에 카드 이벤트를 넣고 화면으로 나가는 data-cards 조각의 항목을 꺼낸다 */
function translatedItems(kind: "offering_cards" | "recommendations" | "instructor_candidates", items: Record<string, unknown>[]) {
  const { parts } = translateAgentEvent({ event: "cards", data: { kind, items } }, initialTranslateState("run-1"));
  expect(parts).toHaveLength(1);
  const part = parts[0] as { type: string; data: { kind: string; items: Record<string, unknown>[] } };
  expect(part.type).toBe("data-cards");
  return part.data.items;
}

describe("카드 버튼 값은 수업 상세로 가기 하나뿐", () => {
  test("버튼 종류는 open_offering 하나다", () => {
    expect(OFFERING_CARD_ACTION_TYPES).toEqual(["open_offering"]);
    expect(offeringCardActionSchema.safeParse({ type: "create_order", offeringId: OFFERING_ID, classId: CLASS_ID }).success).toBe(false);
    expect(offeringCardActionSchema.safeParse({ type: "reserve", offeringId: OFFERING_ID, classId: CLASS_ID }).success).toBe(false);
  });

  test("버튼 값에는 id 두 개 말고 아무것도 없다 — 금액·결제 칸을 넣으면 거부", () => {
    expect(openOfferingAction(OFFERING_ID, CLASS_ID)).toEqual({ type: "open_offering", offeringId: OFFERING_ID, classId: CLASS_ID });
    expect(Object.keys(openOfferingAction(null, PRIVATE_CLASS_ID)).sort()).toEqual(["classId", "offeringId", "type"]);
    const withPayment = { ...openOfferingAction(OFFERING_ID, CLASS_ID), paymentMethod: "card", amount: 120000 };
    expect(offeringCardActionSchema.safeParse(withPayment).success).toBe(false);
    // SX-5.3 카드 스키마의 action 도 같은 규칙이다
    expect(offeringCardSchema.safeParse({ ...CARD, action: withPayment }).success).toBe(false);
    expect(offeringCardSchema.safeParse(CARD).success).toBe(true);
  });

  test("정규 수업 카드는 홈 목록과 같은 수업 상세 경로로 간다", () => {
    expect(offeringCardDestination(CARD.action)).toBe(`/offering/${OFFERING_ID}`);
  });

  test("개인 레슨 카드(offeringId null)는 수업 상세 경로 아래의 개인 레슨 상세로 간다", () => {
    expect(offeringCardDestination(PRIVATE_CARD.action)).toBe(`/offering/private-lesson/${PRIVATE_CLASS_ID}`);
  });

  test("어떤 카드든 이동 경로는 수업 상세 경로뿐이다 — 예약·결제·주문 화면 경로가 나오지 않는다", () => {
    const destinations = [CARD, PRIVATE_CARD].map((card) => offeringCardDestination(card.action));
    for (const destination of destinations) {
      expect(destination.startsWith(OFFERING_DETAIL_PATH_PREFIX)).toBe(true);
      expect(destination).not.toMatch(/checkout|pay|order|reservation|\.\./);
    }
  });

  test("id 가 uuid 가 아니면 경로를 만들지 않는다 — '../checkout' 으로 다른 화면에 빠지지 않게", () => {
    expect(() =>
      offeringCardDestination({ type: "open_offering", offeringId: "../checkout/x", classId: CLASS_ID }),
    ).toThrow();
    expect(() => offeringCardDestination({ type: "open_offering", offeringId: null, classId: "../pay" })).toThrow();
  });
});

describe("에이전트가 보낸 카드는 버튼 값을 다시 만든다", () => {
  const tampered = {
    ...CARD,
    action: { type: "create_order", offeringId: OFFERING_ID, classId: CLASS_ID, seatKind: "male" },
    checkoutUrl: "/checkout/abc",
    orderId: "66666666-6666-4666-8666-666666666666",
  };

  test("sanitize: 예약·결제 버튼 값은 open_offering 으로 바뀌고 약속 밖 칸은 빠진다", () => {
    const [safe] = sanitizeOfferingCardItems([tampered]);
    expect(safe?.action).toEqual({ type: "open_offering", offeringId: OFFERING_ID, classId: CLASS_ID });
    expect(safe).not.toHaveProperty("checkoutUrl");
    expect(safe).not.toHaveProperty("orderId");
    expect(offeringCardSchema.parse(safe)).toEqual(CARD);
  });

  test("sanitize: id 가 망가진 카드는 빼고, 입력 배열은 바꾸지 않는다", () => {
    const input = [tampered, { ...CARD, classId: "not-a-uuid" }, { title: "id 없음" }];
    const before = JSON.stringify(input);
    expect(sanitizeOfferingCardItems(input)).toHaveLength(1);
    expect(JSON.stringify(input)).toBe(before);
  });

  test("스트림 번역: offering_cards 카드의 버튼 값이 수업 상세로 가기로 바뀌어 나간다", () => {
    const items = translatedItems("offering_cards", [tampered, { ...PRIVATE_CARD }]);
    expect(items.map((item) => item.action)).toEqual([
      { type: "open_offering", offeringId: OFFERING_ID, classId: CLASS_ID },
      { type: "open_offering", offeringId: null, classId: PRIVATE_CLASS_ID },
    ]);
    expect(items[0]).not.toHaveProperty("checkoutUrl");
    const destinations = items.map((item) => offeringCardDestination(offeringCardActionSchema.parse(item.action)));
    expect(destinations.every((d) => d.startsWith(OFFERING_DETAIL_PATH_PREFIX))).toBe(true);
  });

  test("스트림 번역: 추천 카드(recommendations)도 같은 규칙이고 근거 두 칸은 남는다", () => {
    const reason = "취향 장르와 18시 이후 가능 시간이 맞아요";
    const reasonSources = [{ kind: "profile", label: "가입 때 고른 관심 장르" }];
    const [item] = translatedItems("recommendations", [{ ...tampered, reason, reasonSources }]);
    expect(item?.action).toEqual({ type: "open_offering", offeringId: OFFERING_ID, classId: CLASS_ID });
    expect(item?.reason).toBe(reason);
    expect(item?.reasonSources).toEqual(reasonSources);
    expect(item).not.toHaveProperty("orderId");
  });

  test("스트림 번역: 강사 후보 카드(instructor_candidates)는 수업 카드 규칙을 타지 않는다", () => {
    const candidate = { instructorId: CLASS_ID, displayName: "김하나", action: { type: "select_instructor", instructorId: CLASS_ID } };
    expect(translatedItems("instructor_candidates", [candidate])).toEqual([candidate]);
  });
});

describe("카드를 만드는 Next.js 소스에 예약·결제 호출이 없다", () => {
  const root = path.resolve(__dirname, "../..");
  const files = [
    "lib/server/services/offering-search.ts",
    "lib/server/ai/planner-plain-search.ts",
    "lib/server/ai/agent-stream-translate.ts",
    "lib/domain/offering-card-action.ts",
  ];

  test.each(files)("%s 는 주문·결제·예약 서비스를 import 하지 않는다", (file) => {
    const source = readFileSync(path.join(root, file), "utf8");
    const imports = source.match(/^import[^;]+;/gm) ?? [];
    for (const line of imports) {
      expect(line).not.toMatch(/checkout|order|payment|reservation|cancellation|refund/i);
    }
  });

  test("검색 도구는 카드 버튼 값을 openOfferingAction 으로만 만든다", () => {
    const source = readFileSync(path.join(root, "lib/server/services/offering-search.ts"), "utf8");
    expect(source).not.toMatch(/action:\s*\{\s*type:/);
    expect(source.match(/openOfferingAction\(/g)?.length).toBe(2);
  });
});
