// S0-3.5(권한 판정 모듈) — 「이 사람이 이 학원의 이 자원에 이 동작을 해도 되나」를 한 함수(decide)가 답한다.
//   근거: 플랜 _workspace/06_master-plan.md 6-3(권한 표), spec FR-004(역할 구분)·FR-005(역할별 데이터 범위)·
//   FR-081a(강사 위임 범위), 계약 README 6-2(requireStaff 판정 순서) 7번.
//
// 왜 순수 함수인가:
//   DB 를 읽는 일(세션·소속·위임 행 조회)은 requireStaff 가드(S0-3.6)가 맡는다. 이 모듈은 이미 읽어 온
//   사실(Actor)만 받아 판정한다. 그래서 표 하나를 단위 테스트로 통째로 대조할 수 있고,
//   화면 판정과 API 판정이 같은 표를 본다(FR-300 「주소로 직접 들어가도 서버가 막는다」).
//
// 왜 표를 데이터로 두나:
//   if 문으로 흩어 두면 「위임 강사가 정산을 볼 수 있나」를 코드 여러 곳에서 찾아야 한다.
//   PERMISSION_TABLE 한 곳만 보면 플랜 6-3 표와 칸 단위로 맞대 볼 수 있다.
import type { StaffRoleName } from "./constants";

/** 관리자 웹 위임 2종(2026-11-20 사용자 결정 D3). 매출·정산·금액은 값 자체가 없다(FR-081a). */
export const DELEGATION_PERMISSIONS = ["roster_manage", "class_manage"] as const;
export type DelegationPermission = (typeof DELEGATION_PERMISSIONS)[number];

/**
 * 앱 위임 1종 — 앱 「수업 등록 권한」(O31·O38). S1-2.9(위임 권한 켜고 끄기 API)에서 더했다.
 * 왜 웹 2종과 따로 두나: 대표 앱이 이 토글을 웹 「수업·포스터 등록」(class_manage)과 따로 그렸다(08 열린 점 ①).
 * 그래서 이 값은 웹 메뉴를 열지 않는다 — 가드는 웹 판정(actor.delegations)에 웹 2종만 담는다.
 * 이 값으로 막는 앱 수업 등록 경로는 S2-2(수업 등록) 몫이다.
 */
export const APP_DELEGATION_PERMISSIONS = ["class_submit"] as const;
export type AppDelegationPermission = (typeof APP_DELEGATION_PERMISSIONS)[number];

/**
 * 대표가 켜고 끌 수 있는 위임 전부(웹 2종 + 앱 1종) = DB instructor_delegations.permission 의 값 집합.
 * 순서는 계약 enum DelegationPermission 과 같다(constants-contract 단위 테스트가 대조한다).
 */
export const ASSIGNABLE_DELEGATION_PERMISSIONS = [...DELEGATION_PERMISSIONS, ...APP_DELEGATION_PERMISSIONS] as const;
export type AssignableDelegationPermission = (typeof ASSIGNABLE_DELEGATION_PERMISSIONS)[number];

/**
 * 판정 대상 사람. 회원 계정과 직원 계정은 서로 다른 계정이다(FR-011a).
 * 직원의 소속·위임은 「지금 켜진 것」만 담아 넘긴다 — 꺼진 위임·끝난 소속은 넣지 않는다.
 */
export type Actor =
  | { type: "member"; memberId: string }
  | {
      type: "staff";
      accountId: string;
      /** role_grants 중 active 인 것 */
      roles: readonly StaffRoleName[];
      /** academy_owners(active) 로 가진 학원 */
      ownedAcademyIds: readonly string[];
      /** active 소속 학원별로 켜진 위임 */
      delegations: Readonly<Record<string, readonly DelegationPermission[]>>;
    };

/** 판정 대상 자원. academyId 는 자원이 속한 학원, ownerId 는 그 자원의 주인(회원 id 또는 직원 계정 id). */
export type Target = { academyId?: string; ownerId?: string };

/**
 * 칸 하나의 범위. 플랜 6-3 의 기호와 1대1이다.
 *   all = ○ · self = 본인 · academy = 소속 · delegated = 위임(그 학원에서 켠 메뉴일 때만)
 */
export type Scope = "all" | "self" | "academy" | "delegated";

/** 허용하더라도 호출하는 쪽이 지켜야 하는 꼬리표(가리기·사유 기록 등). */
export type Condition =
  | "paid_only" // 결제 완료 수강생만
  | "pii_masked" // 개인정보를 가린다
  | "reason_required" // 사유를 입력하고 기록한다
  | "order_snapshot" // 주문에 고정된 판본만
  | "aggregate_no_pii" // 집계만, 개인정보 없음
  | "reverify" // 본인 재확인
  | "second_factor" // 2단계 인증 재확인
  | "system_only" // 시스템 문의만
  | "read_only" // 수정·삭제 불가
  | "future_only"; // 미래 날짜만 변경

/** 표의 열(누구 자격으로). delegate 는 instructor 역할 + 그 학원 위임이 있을 때의 열이다. */
export type Column = "member" | "instructor" | "delegate" | "owner" | "admin";

type Cell = { scope: Scope; conditions?: readonly Condition[]; delegation?: DelegationPermission };
type RowCells = Partial<Record<Column, Cell>>;

const all: Cell = { scope: "all" };
const self: Cell = { scope: "self" };
const academy: Cell = { scope: "academy" };

// 플랜 6-3 권한 표. 표의 한 행에 동작이 여럿 섞인 곳(예: 「소속 승인·반려·변경」)은 동작별로 나눴다.
// 칸이 없으면 「-」(불가)다.
const TABLE = {
  // 수업 공개 목록·상세 — 모두 조회 ○
  "class.public.read": { member: all, instructor: all, owner: all, admin: all },
  // 수업 등록·변경 — 강사는 본인 등록·변경 요청, 위임(class_manage), 대표는 소속
  "class.write": {
    instructor: self,
    delegate: { scope: "delegated", delegation: "class_manage" },
    owner: academy,
  },
  // 수업 승인·반려 — 대표만(FR-050a(수업 등록 승인))
  "class.approve": { owner: academy },
  // 환불·취소 공지·노쇼 기준
  "refund_notice.read": { member: { scope: "self", conditions: ["order_snapshot"] }, instructor: all, owner: academy },
  "refund_notice.write": { owner: academy },
  // 주문·결제 목록 — 위임 강사는 불가(S3-5 수용 ①)
  "order.list": { member: self, owner: academy, admin: { scope: "all", conditions: ["pii_masked"] } },
  // 명단(이름·가린 연락처)
  "roster.read": {
    instructor: { scope: "self", conditions: ["paid_only"] },
    delegate: { scope: "delegated", delegation: "roster_manage" },
    owner: academy,
  },
  // 연락처 전체 열람 — 대표만, 사유 기록
  "contact.full_view": { owner: { scope: "academy", conditions: ["reason_required"] } },
  // 환불 요청
  "refund_request.create": { member: self },
  "refund_request.withdraw": { member: self },
  "refund_request.read": { member: self, instructor: self, owner: academy },
  "refund.execute": { owner: academy }, // 금액 입력·실행·거절
  // 정산 내역·CSV
  "settlement.read": { instructor: self, owner: academy, admin: { scope: "all", conditions: ["aggregate_no_pii"] } },
  // 지급 승인·지급 완료
  "payout.approve": { owner: academy },
  // 정산 계좌
  "payout_account.manage": {
    instructor: { scope: "self", conditions: ["reverify"] },
    owner: { scope: "academy", conditions: ["second_factor"] },
  },
  // 강사 소속·위임 — 강사는 본인 신청·해제 요청, 대표는 소속
  "affiliation.manage": { instructor: self, owner: academy },
  // 입점 심사·이용 제한
  "merchant.apply": { owner: self },
  "merchant.review": { admin: all },
  // 문의
  "inquiry.access": { member: self, instructor: self, owner: academy, admin: { scope: "all", conditions: ["system_only"] } },
  // 신고
  "report.create": { member: all, instructor: all, owner: all },
  "report.handle": { admin: all },
  // 감사 기록 — 대표 소속 조회는 플랜의 「제안」
  "audit_log.read": { owner: academy, admin: { scope: "all", conditions: ["read_only"] } },
  // 수수료율·결산
  "academy_settlement_summary.read": { owner: academy, admin: all },
  "fee_rate.change": { admin: { scope: "all", conditions: ["future_only"] } },
  // AI 에이전트 — 읽기만, 쓰기는 누구도 없다(FR-214(AI 쓰기 금지))
  "ai_agent.read": { member: self, instructor: self, owner: academy },
  "ai_agent.write": {},
} as const satisfies Record<string, RowCells>;

export type Action = keyof typeof TABLE;

/** 밖에서 볼 때는 모든 행을 같은 모양(열 → 칸)으로 본다. 테스트가 표 전체를 훑을 수 있게. */
export const PERMISSION_TABLE: Readonly<Record<Action, RowCells>> = TABLE;

export type Decision =
  | { allowed: true; via: Column; scope: Scope; conditions: readonly Condition[] }
  | { allowed: false; reason: "no_rule" | "out_of_scope" };

// 이 사람이 표의 어느 열 자격을 가졌나. 한 직원이 강사이면서 대표일 수도 있어 여러 열이 나온다.
// 순서가 곧 우선순위다 — 대표 열이 먼저 맞으면 대표 자격으로 열린다(계약 6-2 ⑦ 「대표는 자동 통과」).
function columnsOf(actor: Actor): Column[] {
  if (actor.type === "member") return ["member"];
  const cols: Column[] = [];
  if (actor.roles.includes("admin")) cols.push("admin");
  if (actor.roles.includes("owner")) cols.push("owner");
  if (actor.roles.includes("instructor")) cols.push("delegate", "instructor");
  return cols;
}

// 칸 하나의 범위가 이 대상에 맞는지 본다.
function scopeMatches(actor: Actor, cell: Cell, target: Target): boolean {
  switch (cell.scope) {
    case "all":
      return true;
    case "self": {
      // 본인 = 자원의 주인이 나. 주인을 모르면 열지 않는다(닫힌 쪽으로 실패).
      const myId = actor.type === "member" ? actor.memberId : actor.accountId;
      return target.ownerId !== undefined && target.ownerId === myId;
    }
    case "academy":
      // 소속 = 자원의 학원이 내가 대표인 학원. 학원을 모르면 열지 않는다.
      return actor.type === "staff" && target.academyId !== undefined && actor.ownedAcademyIds.includes(target.academyId);
    case "delegated": {
      // 위임 = 그 학원에서 대표가 켠 그 메뉴가 있다. 다른 학원의 위임은 쓰이지 않는다.
      if (actor.type !== "staff" || target.academyId === undefined || cell.delegation === undefined) return false;
      return (actor.delegations[target.academyId] ?? []).includes(cell.delegation);
    }
  }
}

/**
 * 허용 여부를 판정한다. 열린 칸이 하나라도 맞으면 허용하고, 어느 자격으로 열렸는지와 꼬리표를 같이 돌려준다.
 *   - no_rule     : 이 사람의 어느 열에도 칸이 없다(표의 「-」)
 *   - out_of_scope: 칸은 있지만 범위 밖이다(다른 학원·남의 것·위임이 꺼짐)
 */
export function decide(actor: Actor, action: Action, target: Target = {}): Decision {
  const row: RowCells = PERMISSION_TABLE[action];
  let hadCell = false;
  for (const col of columnsOf(actor)) {
    const cell = row[col];
    if (cell === undefined) continue;
    hadCell = true;
    if (scopeMatches(actor, cell, target)) {
      return { allowed: true, via: col, scope: cell.scope, conditions: cell.conditions ?? [] };
    }
  }
  return { allowed: false, reason: hadCell ? "out_of_scope" : "no_rule" };
}
