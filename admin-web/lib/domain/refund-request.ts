// S4-1.2(환불 요청 생성·철회) — 환불 요청의 규칙 중 DB 없이 정해지는 것만 모은 순수 함수.
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §2-1(서버 순서 5·6-a 단계 · displayStatus · 철회) · §1-5(설정값)
//   spec: FR-098b(환불 요청 경로) · M-06(상태 4종 + 철회)
//
// 왜 따로 두나: 「이 요청은 정규인가 이벤트형인가」「지금 철회할 수 있나」「회원 화면에 무엇이라 보이나」는
// 요청 만들기·철회·대표 목록·기한 재알림 작업(S4-1.8)이 모두 같은 답을 내야 한다. 한 곳에 두어 판정이 갈리지 않게 한다.
// 모든 함수는 현재 시각을 직접 읽지 않고 인자로 받는다(같은 입력 → 같은 값).
import { addBusinessDays, type HolidayCalendar } from "./business-days";
import { isEventClassKind } from "./class-registration";
import type {
  ClassKind,
  PaymentMethod,
  RefundRequestDecisionKind,
  RefundRequestKind,
  RefundRequestStatus,
} from "./constants";
import { KST_TIME_ZONE } from "./time";

/**
 * 정규 환불 요청에 대표가 답할 기한 — 접수 뒤 3영업일(계약 §1-5 `REFUND_ANSWER_BUSINESS_DAYS`, 2026-11-20 결정 D6 · 추천값 O-09).
 * 「영업일」은 토·일·공휴일을 뺀 날이다(S0-4.8 의 addBusinessDays 를 그대로 쓴다).
 */
export const REFUND_ANSWER_BUSINESS_DAYS = 3;

/**
 * 계좌로 돌려받는 결제수단 — 간편 계좌이체·가상계좌. 이 돈은 플랫폼이 보내지 않고 대표가 회원 계좌로 직접 송금한다(FR-295 · D1).
 * 그래서 이 수단으로 결제한 요청에는 회원이 미리 넣은 환불 계좌가 있어야 한다.
 * 카드·간편결제는 원거래 취소라 계좌가 필요 없다.
 */
const ACCOUNT_REFUND_METHODS: readonly PaymentMethod[] = ["virtual_account", "easy_transfer"];

export function needsRefundAccount(method: PaymentMethod): boolean {
  return ACCOUNT_REFUND_METHODS.includes(method);
}

/**
 * 주문 스냅샷의 수업 구분 → 환불 요청 종류(계약 §2-1 서버 순서 5단계).
 *   정규·단기(베이직·레이디 스타일)·개인 레슨 → regular(대표가 금액을 정하는 요청)
 *   원데이·이벤트·파티·공연·대회           → event(수수료 표대로 바로 취소되는 신청)
 * 이벤트형 판정은 결제수단 판정·수업 등록과 같은 isEventClassKind 를 써서 「이벤트형」 정의가 갈리지 않게 한다.
 */
export function refundRequestKindFor(classKind: ClassKind): RefundRequestKind {
  return isEventClassKind(classKind) ? "event" : "regular";
}

/**
 * 답할 기한 — 접수 시각의 KST 날짜에서 영업일 `days` 개를 센 날의 **같은 시각**.
 * 예: 2026-11-05(목) 14:20 KST 접수 + 3영업일 → 11-06(금)·11-09(월)·11-10(화) → 2026-11-10 14:20 KST.
 * 시각까지 같게 두는 이유: 「접수 뒤 3영업일」을 날짜만으로 자르면 저녁에 접수한 요청이 하루 가까이 손해를 본다.
 */
export function refundAnswerDueAt(
  receivedAt: Temporal.Instant,
  calendar: HolidayCalendar,
  days: number = REFUND_ANSWER_BUSINESS_DAYS,
): Temporal.Instant {
  const zoned = receivedAt.toZonedDateTimeISO(KST_TIME_ZONE);
  const dueDate = addBusinessDays(zoned.toPlainDate(), days, calendar);
  // 날짜만 바꾸고 시·분·초는 접수 때 그대로 둔다
  return zoned.with({ year: dueDate.year, month: dueDate.month, day: dueDate.day }).toInstant();
}

/** 철회·표시 판정에 필요한 요청 칸 */
export interface RefundRequestState {
  readonly kind: RefundRequestKind;
  readonly status: RefundRequestStatus;
  readonly decisionKind: RefundRequestDecisionKind | null;
}

/**
 * 회원이 지금 철회할 수 있나(계약 §2-1 철회 · 열린 점 ③ 임시 확정).
 * 된다 = 정규 + 아직 대표 결정이 없음 + 접수·처리 중. 대표가 「처리하기」를 눌러 처리 중이 돼도 승인 전이면 철회된다.
 * 안 된다 = 이벤트형(신청과 동시에 자리가 풀려 되돌릴 수 없다) · 승인·거절이 이미 섬 · 끝난 요청.
 */
export function isRefundRequestWithdrawable(state: RefundRequestState): boolean {
  if (state.kind !== "regular") return false;
  if (state.decisionKind !== null) return false;
  return state.status === "received" || state.status === "in_progress";
}

/** 회원 화면 상태 — 저장 값 5개에 「처리 대기 중(pending_overdue)」 하나를 더한 계산값 */
export type RefundRequestDisplayStatus = RefundRequestStatus | "pending_overdue";

/**
 * 회원 화면(C15A·C15B)·내 예약 카드(M-06)가 보는 상태. 「처리 대기 중」은 저장하지 않고 여기서 계산한다:
 * 답할 기한이 지났는데 아직 접수·처리 중이면 pending_overdue, 그 밖은 저장 값 그대로.
 * 기한이 「딱 그 순간」이면 아직 지나지 않은 것으로 본다(기한 시각까지는 대표가 답할 수 있다).
 */
export function refundRequestDisplayStatus(
  state: { readonly status: RefundRequestStatus; readonly answerDueAt: Temporal.Instant },
  now: Temporal.Instant,
): RefundRequestDisplayStatus {
  const open = state.status === "received" || state.status === "in_progress";
  if (open && Temporal.Instant.compare(now, state.answerDueAt) > 0) return "pending_overdue";
  return state.status;
}
