// S0-3.5(권한 판정 모듈) — 역할 4종 × 학원 × 위임 범위 조합 표가 플랜 6-3(권한 표)과 같은지 본다.
//   로드맵 verify 의 파일 이름은 tests/unit/s0-3-5.test.ts 였는데, 기능 이름(permissions)으로 바꿨다.
import { describe, expect, test } from "vitest";

import {
  DELEGATION_PERMISSIONS,
  PERMISSION_TABLE,
  decide,
  type Actor,
  type Action,
} from "../../lib/domain/permissions";

// ── 등장인물 ──────────────────────────────────────────────────────────────
const A = "academy-A"; // 라틴하우스 강남
const B = "academy-B"; // 다른 학원

const member: Actor = { type: "member", memberId: "m-1" };
const ownerA: Actor = { type: "staff", accountId: "owner-a", roles: ["owner"], ownedAcademyIds: [A], delegations: {} };
const ownerB: Actor = { type: "staff", accountId: "owner-b", roles: ["owner"], ownedAcademyIds: [B], delegations: {} };
const instructor: Actor = { type: "staff", accountId: "ins-1", roles: ["instructor"], ownedAcademyIds: [], delegations: {} };
const delegateRoster: Actor = {
  type: "staff",
  accountId: "ins-2",
  roles: ["instructor"],
  ownedAcademyIds: [],
  delegations: { [A]: ["roster_manage"] },
};
const delegateClass: Actor = {
  type: "staff",
  accountId: "ins-3",
  roles: ["instructor"],
  ownedAcademyIds: [],
  delegations: { [A]: ["class_manage"] },
};
const admin: Actor = { type: "staff", accountId: "admin-1", roles: ["admin"], ownedAcademyIds: [], delegations: {} };

// 학원 A 의 자원(남의 것). 「본인」 판정에 걸리지 않게 주인 id 는 등장인물 누구와도 다르다.
const inA = { academyId: A, ownerId: "someone-else" };

describe("위임 범위", () => {
  test("관리자 웹 위임은 2종뿐이다(2026-11-20 사용자 결정 D3)", () => {
    expect([...DELEGATION_PERMISSIONS]).toEqual(["roster_manage", "class_manage"]);
  });
});

// ── 조합 표: [이름, 행위자, 동작, 대상, 기대] ──────────────────────────────
type Row = [string, Actor, Action, { academyId?: string; ownerId?: string }, boolean];
const rows: Row[] = [
  // 대표 — 자기 학원은 열리고 다른 학원은 닫힌다
  ["대표: 자기 학원 주문 목록", ownerA, "order.list", inA, true],
  ["대표: 자기 학원 명단", ownerA, "roster.read", inA, true],
  ["대표: 자기 학원 수업 등록·변경", ownerA, "class.write", inA, true],
  ["대표: 자기 학원 수업 승인", ownerA, "class.approve", inA, true],
  ["대표: 자기 학원 환불 실행", ownerA, "refund.execute", inA, true],
  ["대표: 자기 학원 정산", ownerA, "settlement.read", inA, true],
  ["대표: 자기 학원 지급 승인", ownerA, "payout.approve", inA, true],
  ["대표: 자기 학원 연락처 전체 열람", ownerA, "contact.full_view", inA, true],
  ["대표: 입점 심사는 못 한다", ownerA, "merchant.review", inA, false],
  ["대표: 수수료율 변경은 못 한다", ownerA, "fee_rate.change", {}, false],

  // 다른 학원 대표 — 학원 A 의 자원은 전부 닫힌다
  ["다른 학원 대표: A 주문 목록", ownerB, "order.list", inA, false],
  ["다른 학원 대표: A 명단", ownerB, "roster.read", inA, false],
  ["다른 학원 대표: A 수업 등록·변경", ownerB, "class.write", inA, false],
  ["다른 학원 대표: A 환불 실행", ownerB, "refund.execute", inA, false],
  ["다른 학원 대표: A 정산", ownerB, "settlement.read", inA, false],
  ["다른 학원 대표: A 지급 승인", ownerB, "payout.approve", inA, false],
  ["다른 학원 대표: 학원 없이 부르면 닫힌다", ownerB, "order.list", {}, false],

  // 위임 강사(roster_manage) — 켠 메뉴만, 돈은 절대 안 열린다(FR-081a)
  ["위임 강사(명단): A 명단", delegateRoster, "roster.read", inA, true],
  ["위임 강사(명단): A 수업 등록은 위임 없음", delegateRoster, "class.write", inA, false],
  ["위임 강사(명단): A 주문 목록", delegateRoster, "order.list", inA, false],
  ["위임 강사(명단): A 정산", delegateRoster, "settlement.read", inA, false],
  ["위임 강사(명단): A 환불 실행", delegateRoster, "refund.execute", inA, false],
  ["위임 강사(명단): A 지급 승인", delegateRoster, "payout.approve", inA, false],
  ["위임 강사(명단): A 연락처 전체 열람", delegateRoster, "contact.full_view", inA, false],
  ["위임 강사(명단): 다른 학원 B 명단", delegateRoster, "roster.read", { academyId: B, ownerId: "x" }, false],

  // 위임 강사(class_manage)
  ["위임 강사(수업): A 수업 등록·변경", delegateClass, "class.write", inA, true],
  ["위임 강사(수업): A 수업 승인은 대표만", delegateClass, "class.approve", inA, false],
  ["위임 강사(수업): A 명단은 위임 없음", delegateClass, "roster.read", inA, false],

  // 위임 없는 강사 — 본인 것만
  ["강사: 남의 수업 명단", instructor, "roster.read", inA, false],
  ["강사: 본인 수업 명단", instructor, "roster.read", { academyId: A, ownerId: "ins-1" }, true],
  ["강사: 본인 정산", instructor, "settlement.read", { academyId: A, ownerId: "ins-1" }, true],
  ["강사: 남의 정산", instructor, "settlement.read", inA, false],
  ["강사: 주문 목록", instructor, "order.list", inA, false],

  // 운영자
  ["운영자: 입점 심사", admin, "merchant.review", inA, true],
  ["운영자: 수수료율 변경", admin, "fee_rate.change", {}, true],
  ["운영자: 감사 기록 조회", admin, "audit_log.read", inA, true],
  ["운영자: 주문 목록(장애 처리용)", admin, "order.list", inA, true],
  ["운영자: 명단", admin, "roster.read", inA, false],
  ["운영자: 환불 실행", admin, "refund.execute", inA, false],
  ["운영자: 지급 승인", admin, "payout.approve", inA, false],
  ["운영자: 신고 처리", admin, "report.handle", {}, true],

  // 회원
  ["회원: 본인 주문", member, "order.list", { ownerId: "m-1" }, true],
  ["회원: 남의 주문", member, "order.list", { ownerId: "m-2" }, false],
  ["회원: 본인 환불 요청 생성", member, "refund_request.create", { ownerId: "m-1" }, true],
  ["회원: 명단", member, "roster.read", inA, false],
  ["회원: 수업 공개 목록", member, "class.public.read", {}, true],
  ["회원: 신고 처리", member, "report.handle", {}, false],
];

describe("조합 표 — 대표·위임 강사·다른 학원 대표·운영자", () => {
  test.each(rows)("%s", (_name, actor, action, target, expected) => {
    expect(decide(actor, action, target).allowed).toBe(expected);
  });
});

describe("조건 표시 — 허용해도 붙는 꼬리표", () => {
  test("강사 본인 수업 명단은 결제 완료만 보인다", () => {
    const d = decide(instructor, "roster.read", { academyId: A, ownerId: "ins-1" });
    expect(d).toMatchObject({ allowed: true, via: "instructor", scope: "self", conditions: ["paid_only"] });
  });
  test("운영자 주문 목록은 개인정보를 가린다", () => {
    expect(decide(admin, "order.list", inA)).toMatchObject({ allowed: true, conditions: ["pii_masked"] });
  });
  test("대표 연락처 전체 열람은 사유를 남겨야 한다", () => {
    expect(decide(ownerA, "contact.full_view", inA)).toMatchObject({ allowed: true, conditions: ["reason_required"] });
  });
  test("위임 강사는 delegate 경로로 열린다", () => {
    expect(decide(delegateRoster, "roster.read", inA)).toMatchObject({ allowed: true, via: "delegate", scope: "delegated" });
  });
});

describe("누구도 열리지 않는 것", () => {
  test("AI 에이전트 쓰기는 모두 불가(FR-214)", () => {
    for (const actor of [member, instructor, delegateRoster, ownerA, admin]) {
      expect(decide(actor, "ai_agent.write", inA).allowed).toBe(false);
    }
  });
  test("표에 동작마다 행이 있고, 위임 칸은 roster.read·class.write 에만 있다", () => {
    const withDelegate = Object.entries(PERMISSION_TABLE)
      .filter(([, cells]) => cells.delegate !== undefined)
      .map(([action]) => action)
      .sort();
    expect(withDelegate).toEqual(["class.write", "roster.read"]);
  });
  test("정지된 직원 판정은 이 모듈 밖(requireStaff)이지만, 역할이 없으면 아무것도 열리지 않는다", () => {
    const nobody: Actor = { type: "staff", accountId: "z", roles: [], ownedAcademyIds: [A], delegations: { [A]: ["roster_manage"] } };
    expect(decide(nobody, "order.list", inA).allowed).toBe(false);
    expect(decide(nobody, "roster.read", inA).allowed).toBe(false);
  });
});
