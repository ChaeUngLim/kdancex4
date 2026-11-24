// S2-2.6(환불 마감일 필수) — 이벤트형 수업의 환불 마감일 판정(DB 없이 도는 순수 코드).
//   계약: _workspace/03_contracts/11-instructor.md §4-2(refundDeadlineOn) · §4-4 ①(422 REFUND_DEADLINE_REQUIRED · REFUND_DEADLINE_AFTER_START)
//   요구: FR-099d(환불 마감일 필수 입력·결제 적용) · 플랜 S2-2 수용 ② 「이벤트형은 환불 마감일 없이 등록되지 않고 개최일 뒤 날짜는 고를 수 없다」
//   데이터: data-model §8-2 class_offerings.refund_deadline_on
//
// 왜 필요한가: 이벤트형(원데이·이벤트·파티·공연·대회)은 「이 날까지 취소하면 수수료 표대로 돌려준다」가 환불 규칙의 기준선이다.
// 마감일이 비어 있으면 회원이 언제까지 취소할 수 있는지 아무도 모르고, 개최일 뒤 날짜면 행사가 끝난 뒤에도 환불을 받아야 한다.
// 그래서 승인 요청(submit) 때 이 판정을 통과해야 회차·판매 단위가 만들어진다.
//
// 규칙
//   - 마감일이 필요한 수업 = 이벤트형 + 금액 0 초과. 0원 행사는 돌려줄 돈이 없어 받지 않는다(보내도 저장하지 않는다)
//   - 정규 계열(정규·베이직·레이디 스타일 등)은 보내도 무시한다 — 정규는 환불 템플릿(학원 공지)으로 계산한다
//   - 마감일 ≤ 개최일(첫 회차 시작의 **KST 날짜**). 당일은 되고 다음 날부터 안 된다
import type { ClassKind } from "./constants";
import { isEventClassKind } from "./class-registration";
import { parseKstDate, toKstDate } from "./time";

export type RefundDeadlineCode = "REFUND_DEADLINE_REQUIRED" | "REFUND_DEADLINE_AFTER_START";

export type RefundDeadlineInput = {
  classKind: ClassKind;
  priceAmount: number;
  /** 강사·대표가 고른 마감일(KST 달력 YYYY-MM-DD). 안 골랐으면 null */
  refundDeadlineOn: string | null;
  /** 첫 회차 시작 순간 — 개최일은 이 순간의 KST 날짜다 */
  firstSessionStartsAt: Temporal.Instant;
};

/** 통과하면 판매 단위(class_offerings.refund_deadline_on)에 저장할 값을 함께 준다 — 필요 없는 수업은 null */
export type RefundDeadlineVerdict =
  | { ok: true; deadlineOn: string | null }
  | { ok: false; code: RefundDeadlineCode; message: string };

/** 이 수업에 환불 마감일이 꼭 있어야 하나 — 이벤트형이고 금액이 0 보다 클 때만 */
export function refundDeadlineRequired(classKind: ClassKind, priceAmount: number): boolean {
  return isEventClassKind(classKind) && priceAmount > 0;
}

/** 승인 요청 때의 환불 마감일 판정(계약 11 §4-4 ①). 실패하면 계약의 422 코드와 화면 안내문을 돌려준다 */
export function checkRefundDeadline(input: RefundDeadlineInput): RefundDeadlineVerdict {
  // 마감일이 필요 없는 수업은 보낸 값이 있어도 버린다(정규 계열·0원 행사)
  if (!refundDeadlineRequired(input.classKind, input.priceAmount)) return { ok: true, deadlineOn: null };

  if (input.refundDeadlineOn === null) {
    return { ok: false, code: "REFUND_DEADLINE_REQUIRED", message: "환불 마감일을 골라 주세요" };
  }

  // 날짜끼리 견준다. 개최일은 UTC 가 아니라 KST 달력 날짜다(00:30 KST 행사는 UTC 로는 전날이다)
  const eventDay = toKstDate(input.firstSessionStartsAt);
  const deadline = parseKstDate(input.refundDeadlineOn);
  if (Temporal.PlainDate.compare(deadline, eventDay) > 0) {
    return { ok: false, code: "REFUND_DEADLINE_AFTER_START", message: "환불 마감일은 개최일 당일이나 그 전이어야 해요" };
  }
  return { ok: true, deadlineOn: input.refundDeadlineOn };
}
