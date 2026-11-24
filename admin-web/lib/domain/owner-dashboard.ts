// S1-4.5(대시보드 API) — 대표 대시보드(W29)의 규칙 중 DB·HTTP 를 모르는 순수한 부분.
//   계약: _workspace/03_contracts/10-owner-dashboard.md §1 · 「Phase 6(테스트) 목록」의 단위 3종
//   요구: FR-079b(대표 대시보드 지표) · 플랜 S1-4 열린 점(2026-11-19 확정: 정원 마감 임박 = 남은 자리가 정원의 10% 이하 또는 2자리 이하)
//
// 이 파일이 하는 일 세 가지:
//   ① 준비 안 된 타일의 모양 — 원천 테이블이 아직 없는 타일은 available:false 와 숫자 칸 null 로 내린다.
//      0 을 내리면 「진짜 0건」과 구별되지 않기 때문이다(계약 §1 「M1 의 뼈대 원칙」).
//   ② 할 일(todos) 정렬 — 기한이 있는 일부터 기한 오름차순, 기한 없는 일은 뒤(W29 「기한이 걸린 일부터」).
//   ③ 「마감 임박」 판정 — 판매 단위의 남은 자리가 정원의 10% 이하이거나 2자리 이하인가.
// 함수로 떼어 두면 경계값(남은 2자리 포함, 3자리 제외)을 DB 없이 표로 확인할 수 있다.
import type { TermsKind } from "./constants";
import { KST_TIME_ZONE } from "./time";

// ---- ① 준비 안 된 타일 --------------------------------------------------------------------------

/**
 * 타일마다 숫자가 채워지기 시작하는 슬라이스(계약 §1 응답 예시의 availableFrom 그대로).
 * 각 슬라이스가 원천 테이블을 만들면 그 타일의 available 을 true 로 바꾸고 이 표에서 뺀다.
 */
export const DASHBOARD_TILE_AVAILABLE_FROM = {
  todayOrders: "S3-3",
  refundRequests: "S4-1",
  pendingClassApprovals: "S2-2",
  nearlyFull: "S3-3",
  month: "S5-1",
  nextPayout: "S5-3",
  sessions: "S2-2",
  // 대표 앱 홈 O6 의 「신규 회원」 칸(계약 18 열린 점 ⑦) — 결제 뒤 보기 슬라이스가 채운다
  newMembers: "S3-5",
} as const;

/** 준비 안 된 타일 7개 + 신규 회원 칸. 숫자 칸은 전부 null, 목록 칸은 빈 배열이다(「0건」이 아니라 「아직 못 셈」) */
export function unavailableDashboardTiles() {
  const from = DASHBOARD_TILE_AVAILABLE_FROM;
  return {
    todayOrders: {
      available: false as const,
      availableFrom: from.todayOrders,
      applications: null,
      paidCount: null,
      paidAmount: null,
      awaitingDeposit: null,
    },
    refundRequests: { available: false as const, availableFrom: from.refundRequests, regular: null, event: null, overdue: null },
    pendingClassApprovals: { available: false as const, availableFrom: from.pendingClassApprovals, count: null, top: null },
    nearlyFull: { available: false as const, availableFrom: from.nearlyFull, items: [] },
    month: {
      available: false as const,
      availableFrom: from.month,
      revenue: null,
      paymentsCount: null,
      settlement: { completed: null, scheduled: null, hold: null },
    },
    nextPayout: {
      available: false as const,
      availableFrom: from.nextPayout,
      date: null,
      expectedNet: null,
      instructorPayoutPending: null,
    },
    sessions: { available: false as const, availableFrom: from.sessions, today: [], tomorrow: [] },
    newMembers: { available: false as const, availableFrom: from.newMembers, count: null },
  };
}

// ---- ② 할 일 정렬 -------------------------------------------------------------------------------

/** M1 에서 할 일이 나오는 원천 두 가지 — 소속 신청(대기)·약관 변경 통지(안 읽음) */
export const DASHBOARD_TODO_KINDS = ["affiliation_requested", "terms_change_notice"] as const;
export type DashboardTodoKind = (typeof DASHBOARD_TODO_KINDS)[number];

export type DashboardTodo = {
  kind: DashboardTodoKind;
  title: string;
  /** 기한(ISO 순간). 기한이 없는 일은 null */
  dueAt: string | null;
  /** 누르면 갈 관리자 웹 화면 주소 */
  link: string;
};

/**
 * 기한이 있는 일 → 기한 오름차순, 기한 없는 일 → 뒤.
 * 기한이 같거나 둘 다 없으면 들어온 순서를 지킨다(Array.prototype.sort 는 안정 정렬이다).
 * 원본 배열은 고치지 않고 새 배열을 돌려준다.
 */
export function sortDashboardTodos(todos: readonly DashboardTodo[]): DashboardTodo[] {
  return [...todos].sort((a, b) => {
    if (a.dueAt === null && b.dueAt === null) return 0;
    if (a.dueAt === null) return 1; // 기한 없는 a 는 뒤로
    if (b.dueAt === null) return -1;
    // 글자 비교가 아니라 순간으로 비교한다(소수점 자릿수가 달라도 같은 시각은 같게)
    return Temporal.Instant.compare(Temporal.Instant.from(a.dueAt), Temporal.Instant.from(b.dueAt));
  });
}

/** 할 일 줄의 화면 주소 — 소속 신청은 강사 관리(W3a)의 대기 탭, 약관 변경은 설정(W2b)의 약관 칸 */
export const DASHBOARD_TODO_LINKS = {
  affiliation_requested: "/staff/instructors?status=pending",
  terms_change_notice: "/settings#terms",
} as const satisfies Record<DashboardTodoKind, string>;

/** 약관 변경 할 일의 항목 이름. 입점 동의 화면(W2a·W2b)과 같은 이름을 쓴다 */
export const TERMS_KIND_LABELS = {
  merchant_terms: "입점 약관",
  merchant_privacy_collection: "개인정보 수집·이용 동의",
  privacy_policy: "개인정보 처리방침",
  platform_fee_notice: "플랫폼 수수료",
  card_fee_notice: "결제·카드 수수료",
  content_license: "콘텐츠 이용 허락",
  one_plus_one_notice: "1+1 할인권",
} as const satisfies Record<TermsKind, string>;

/** 「아이유 강사 소속 신청」 — 강사 표시 이름만 쓴다(연락처는 넣지 않는다, 계약 §1) */
export function affiliationTodoTitle(displayName: string): string {
  return `${displayName} 강사 소속 신청`;
}

/** 「입점 약관 1.1 · 12월 10일 적용」 — 시행일은 KST 달력 날짜로 읽는다(자정 무렵 UTC 로 읽으면 하루가 밀린다) */
export function termsTodoTitle(kind: TermsKind, version: string, effectiveAt: Temporal.Instant): string {
  const date = effectiveAt.toZonedDateTimeISO(KST_TIME_ZONE);
  return `${TERMS_KIND_LABELS[kind]} ${version} · ${date.month}월 ${date.day}일 적용`;
}

// ---- ③ 마감 임박 --------------------------------------------------------------------------------

/** 남은 자리가 이 수 이하면 마감 임박(2026-11-19 확정) */
export const NEARLY_FULL_MAX_REMAINING = 2;
/** 남은 자리가 정원의 이 퍼센트 이하여도 마감 임박(2026-11-19 확정) */
export const NEARLY_FULL_MAX_PERCENT = 10;

/**
 * 판매 단위(자리 종류 하나)가 마감 임박인가.
 *   - 남은 자리 ≤ 2 이거나 남은 자리 ≤ 정원의 10% 면 임박이다. 정원 20 이하에서는 10% 가 2 이하라 「2자리 이하」가 기준이 된다.
 *   - 10% 비교는 나눗셈 대신 곱셈(remaining × 100 ≤ capacity × 10)으로 해서 소수점 오차가 끼지 않게 한다.
 *   - 남은 자리가 0 이면 이미 마감이라 「임박」에 넣지 않는다(구현에서 고른 값 — 계약에는 0 에 대한 말이 없다).
 */
export function isNearlyFull(capacity: number, remaining: number): boolean {
  if (remaining <= 0 || capacity <= 0) return false;
  return remaining <= NEARLY_FULL_MAX_REMAINING || remaining * 100 <= capacity * NEARLY_FULL_MAX_PERCENT;
}
